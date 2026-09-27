import { readFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { Server } from "node:net";
import type { BackendConfiguration } from "./config";
import { routeRequest } from "./router";
import type { SessionEndpointDependencies } from "./session-endpoint";

/* -------------------------------------------------------------------------
 * The socket half (PW-0401)
 *
 * The ONLY module in this service that binds a port, reads a file or touches
 * Node's HTTP types. Everything a decision depends on lives in `router.ts`,
 * `session-endpoint.ts`, `authentication.ts` and `config.ts`, all of which are
 * functions over values -- so the suite exercises the service's behaviour
 * without a socket, and this file's job is small enough to read in one sitting.
 * ---------------------------------------------------------------------- */

/**
 * The largest request line, headers and body this service will accept.
 *
 * The body bound that matters is `handler.ts`'s `MAX_REQUEST_BODY_BYTES`, which
 * answers an oversized body with a well-formed `request_body_too_large` in the
 * published contract. This is the cruder bound underneath it: a socket that
 * streams forever never reaches a handler at all, so the limit has to exist on
 * this side too. It is deliberately LOOSER than the contract's, so that a body
 * just over the contract's limit still arrives and is answered with the
 * contract's reason rather than with a dropped connection.
 */
const MAX_BODY_BYTES = 256 * 1024;
const HEADERS_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Node's `IncomingMessage`, as a `Request`.
 *
 * THE URL IS BUILT FROM A FIXED AUTHORITY, NOT FROM THE `Host` HEADER. Nothing
 * downstream reads the origin -- `routeRequest` reads only `pathname`, and the
 * decision reads only the body and the identity headers -- so the authority is
 * a placeholder that exists because `new URL` requires one. Taking it from
 * `Host` would import a caller-controlled value into a URL for no benefit,
 * which is how an absolute-URL bug becomes a routing bug.
 *
 * EVERY INBOUND HEADER IS CARRIED. This is the far side of the forwarder's
 * allowlist, not a second one: the forwarder already decided what leaves the
 * desktop, and a second allowlist here would silently drop whatever the first
 * one is later taught to send. What protects this service is that only
 * `resolveRequestAccount` reads headers at all, and it reads the session cookie
 * and the two development headers and nothing else.
 */
async function toRequest(incoming: IncomingMessage): Promise<Request | null> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }

  const method = incoming.method ?? "GET";
  const url = new URL(incoming.url ?? "/", "http://backend.invalid");

  if (method === "GET" || method === "HEAD") {
    return new Request(url, { method, headers });
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of incoming) {
    const buffer = chunk as Buffer;
    size += buffer.byteLength;
    /* Refused rather than truncated: half a body parsed as a whole one is a
     * corruption the caller cannot detect. `null` becomes a 413 above. */
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }

  return new Request(url, { method, headers, body: Buffer.concat(chunks) });
}

async function writeResponse(response: Response, outgoing: ServerResponse): Promise<void> {
  const body = Buffer.from(await response.arrayBuffer());
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  headers["content-length"] = String(body.byteLength);
  outgoing.writeHead(response.status, headers);
  outgoing.end(body);
}

export interface BackendServerDependencies extends SessionEndpointDependencies {
  /** Injected so a test can build a server without reading a certificate. */
  readonly readFile?: (path: string) => Buffer;
}

/**
 * A server for this configuration. NOT LISTENING YET.
 *
 * Returning an unbound server rather than a listening one keeps the failure of
 * `listen` -- a port in use, a permission refused -- with the caller that chose
 * the port, and lets a test bind to an ephemeral port without this module
 * knowing about tests.
 */
export function createBackendServer(
  configuration: BackendConfiguration,
  dependencies: BackendServerDependencies = {}
): Server {
  const read = dependencies.readFile ?? readFileSync;

  const onRequest = (incoming: IncomingMessage, outgoing: ServerResponse): void => {
    void (async () => {
      const request = await toRequest(incoming);
      if (request === null) {
        await writeResponse(
          new Response(JSON.stringify({ error: "request_body_too_large", detail: "the request body exceeded this service's transport limit" }), {
            status: 413,
            headers: { "content-type": "application/json", "cache-control": "no-store" }
          }),
          outgoing
        );
        return;
      }
      await writeResponse(await routeRequest(request, dependencies), outgoing);
    })().catch(() => {
      /*
       * The last resort, and it says nothing. A failure this far out is a
       * failure of the bridge above rather than a decision, and the one thing
       * it must not do is describe itself: `String(cause)` here is how a
       * connection string reaches a caller.
       */
      if (!outgoing.headersSent) {
        outgoing.writeHead(500, { "content-type": "application/json", "cache-control": "no-store" });
      }
      outgoing.end(JSON.stringify({ error: "backend_failed" }));
    });
  };

  const server =
    configuration.transport.kind === "tls"
      ? createHttpsServer(
          {
            cert: read(configuration.transport.certificatePath),
            key: read(configuration.transport.keyPath)
          },
          onRequest
        )
      : createHttpServer(onRequest);

  /*
   * A caller that opens a socket and sends nothing holds a connection open for
   * as long as the defaults allow. Both bounds are stated here rather than left
   * to whatever the running Node version defaults to, so the service's
   * behaviour under that case is a property of this repository.
   */
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;

  return server;
}
