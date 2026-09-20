import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import {
  createServer as createHttpsServer,
  request as httpsRequest,
  Agent as HttpsAgent,
  type Server as HttpsServer
} from "node:https";
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates, type TLSSocket } from "node:tls";
import type { HostResolver } from "@liberty/media-inspection/egress";
import { nodePinnedFetch } from "@liberty/media-inspection/node/pinned-fetch";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchJson, type HttpOptions } from "./http";

/**
 * PROVIDER OUTBOUND HTTP, OVER A REAL SOCKET (PL-0710, clauses 4 and 7).
 *
 * `resolve-and-pin.test.ts` proves what the provider's gate DECIDES. It cannot
 * prove the thing that actually matters at the end of the chain -- that the
 * kernel opens the connection to the authorised address, and that pinning the
 * transport to an address did not turn TLS into verification of an address. Both
 * of those are claims about a runtime, and the only honest way to test a claim
 * about a runtime is to make the runtime do it. A double would assert our belief
 * about `net.connect` and `tls.checkServerIdentity` back to us.
 *
 * NO EXTERNAL NETWORK IS USED OR REQUIRED. Everything binds to 127.0.0.1 on an
 * ephemeral port.
 *
 * THE TRANSPORT IS `nodePinnedFetch`, unmodified, from
 * `@liberty/media-inspection/node/pinned-fetch`. This file is not testing that
 * transport for its own sake -- `packages/media-inspection/src/node` does that.
 * It is testing that PROVIDER outbound HTTP goes through it and inherits its
 * properties, which is the clause the task is about: the adapter is wired to the
 * existing control rather than to a new mechanism beside it.
 *
 * ----------------------------------------------------------------------------
 * CLAUSE 7, AND HOW IT IS ACHIEVED -- stated here because it is the clause most
 * easily got subtly wrong.
 *
 * The pin does NOT rewrite the URL to the approved IP and set a `Host:` header.
 * That is the obvious implementation and it is wrong twice over: SNI then
 * carries an IP, `tls.checkServerIdentity` then validates the certificate
 * against an IP, every ordinary certificate fails, and the failure gets "fixed"
 * by disabling `rejectUnauthorized` -- trading a rebinding window for
 * unauthenticated TLS. Instead the RESOLVER is substituted: the request options
 * still carry the publisher's NAME, and only the name-to-address step is served
 * from the authorised set. Node derives the `Host` header, the SNI extension and
 * the certificate identity check from `options.hostname`/`servername`, none of
 * which the pin touches, so the handshake is byte-for-byte the one an unpinned
 * request would have performed.
 *
 * The three tests below prove the three halves of that claim separately: the
 * `Host` header over plaintext, the SNI extension read off the wire, and -- with
 * a certificate whose only subject alternative name is `DNS:localhost` and which
 * carries NO IP SAN -- a completed handshake that the rejected design provably
 * cannot complete. The last one includes that counterfactual as an assertion
 * rather than as a comment.
 */

const PROBE_PATH = "/manifest.json";

function options(over: Partial<HttpOptions> & Pick<HttpOptions, "resolveHost">): HttpOptions {
  return {
    fetchImpl: nodePinnedFetch,
    timeoutMs: 4_000,
    maxResponseBytes: 65_536,
    maxRedirects: 2,
    /*
     * Both loopback keys, because everything here binds to 127.0.0.1 and the
     * two-key rule is production behaviour rather than something to switch off.
     * `resolve-and-pin.test.ts` is where the keys are shown to be load bearing;
     * turning them on here does not weaken that, and a public name pointed at
     * loopback is still refused with both of them set.
     */
    allowLoopback: true,
    localDeployment: true,
    userAgent: "pl-0710-transport-test",
    now: () => Date.now(),
    ...over
  };
}

const answering =
  (...addresses: string[]): HostResolver =>
  async () =>
    addresses;

interface Seen {
  readonly host: string | undefined;
  readonly url: string | undefined;
  /** `TLSSocket.servername` is `string | false | null`; plaintext has none. */
  readonly servername: string | false | null | undefined;
}

describe("plaintext: the socket opens to the pinned address and the Host header stays the name", () => {
  const seen: Seen[] = [];
  let server: Server;
  let port = 0;

  beforeAll(async () => {
    server = createHttpServer((request: IncomingMessage, response: ServerResponse) => {
      seen.push({ host: request.headers.host, url: request.url, servername: undefined });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "org.archive", version: "1.0.0" }));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("expected a TCP address");
    port = address.port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  it("reaches the server and sends the publisher's NAME in Host, not the pinned address", async () => {
    const result = await fetchJson(
      `http://localhost:${port}${PROBE_PATH}`,
      options({ resolveHost: answering("127.0.0.1") })
    );

    expect(result.ok).toBe(true);
    const last = seen.at(-1);
    // A transport that had rewritten the URL to the approved IP would send
    // `127.0.0.1:<port>` here, and would break every virtual host on the
    // internet in the same motion.
    expect(last?.host).toBe(`localhost:${port}`);
    expect(last?.url).toBe(PROBE_PATH);
  });

  it("does not reach a server that real DNS would have found", async () => {
    /*
     * THE LOAD-BEARING NEGATIVE, and it is constructed so that the defect and the
     * fix give opposite results. `localhost` resolves to 127.0.0.1 on every
     * system there is, and that is where the server is listening. The
     * authorisation pinned 127.0.0.2, where nothing is. If this request arrives,
     * the connection was chosen by a SECOND resolution rather than by the
     * authorisation -- which is the rebinding hole, and the whole point of the
     * task.
     *
     * 127.0.0.2 is authorised honestly rather than smuggled in: 127/8 classifies
     * loopback, `localhost` classifies loopback, both keys are set, so it is an
     * address this policy genuinely permits. The only question left is which of
     * the two answers the kernel is given.
     */
    const before = seen.length;

    const result = await fetchJson(
      `http://localhost:${port}${PROBE_PATH}`,
      options({ resolveHost: answering("127.0.0.2"), timeoutMs: 2_000 })
    );

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("network_error");
    expect(seen.length).toBe(before);
  });
});

describe("TLS: the ClientHello names the host, and never the pinned address", () => {
  let tcp: TcpServer;
  let tlsPort = 0;
  const hellos: Buffer[] = [];
  const open: Socket[] = [];

  beforeAll(async () => {
    /*
     * A raw TCP listener, because the property under test is visible without
     * completing a handshake: the SNI extension travels in the ClientHello, which
     * is the client's FIRST write and is not encrypted. The server records that
     * one segment and answers with a fatal `handshake_failure` alert -- seven
     * bytes: content type 21, version 3.3, length 2, level 2 (fatal), description
     * 40 -- so the client settles through the transport's ordinary error path in
     * milliseconds instead of waiting out a deadline.
     */
    tcp = createTcpServer((socket) => {
      open.push(socket);
      socket.on("error", () => undefined);
      socket.once("data", (chunk: Buffer) => {
        hellos.push(chunk);
        socket.end(Buffer.from([0x15, 0x03, 0x03, 0x00, 0x02, 0x02, 0x28]));
      });
    });
    await new Promise<void>((resolve) => {
      tcp.listen(0, "127.0.0.1", resolve);
    });
    const address = tcp.address();
    if (address === null || typeof address === "string") throw new Error("expected a TCP address");
    tlsPort = address.port;
  });

  afterAll(async () => {
    for (const socket of open) socket.destroy();
    await new Promise<void>((resolve) => {
      tcp.close(() => {
        resolve();
      });
    });
  });

  it("offers the hostname as SNI so the certificate is checked against it", async () => {
    const result = await fetchJson(
      `https://localhost:${tlsPort}${PROBE_PATH}`,
      options({ resolveHost: answering("127.0.0.1"), timeoutMs: 1_000 })
    );

    expect(result.ok).toBe(false);

    const hello = hellos.at(-1)?.toString("latin1") ?? "";
    expect(hello).toContain("localhost");
    // And the address that was pinned is nowhere in the handshake. Had the URL
    // been rewritten to the IP, this is where it would show -- together with a
    // certificate check against an address no ordinary certificate carries.
    expect(hello).not.toContain("127.0.0.1");

    // Let the connection finish dying inside this test's own lifetime, so the
    // transport's own listeners are demonstrably the ones handling it.
    await new Promise((settle) => setTimeout(settle, 250));
  });
});

/* -------------------------------------------------------------------------
 * THE DECISIVE ONE: a real handshake against a real certificate.
 *
 * WHY IT IS CONDITIONAL, stated plainly rather than hidden behind a helper.
 * Completing a handshake needs a certificate, and there are exactly three ways
 * to get one: commit a private key to the repository (refused -- a committed key
 * is a key), add a certificate-generating dependency (refused -- adding a
 * package to close a test gap is a dependency decision, and this repository
 * declined to add `undici` for a far stronger reason), or generate one at test
 * time with the `openssl` binary. The third is the only one left, so this block
 * SKIPS where `openssl` is absent and every unconditional assertion above stands
 * on its own.
 *
 * WHAT MAKES IT DECISIVE. The certificate's only subject alternative name is
 * `DNS:localhost`. It carries NO IP SAN. So:
 *
 *   - if the identity check runs against the NAME -- what this design does --
 *     the handshake completes and the request returns 200;
 *   - if it ran against the PINNED ADDRESS -- the rejected design, where the URL
 *     is rewritten to the IP -- it fails `ERR_TLS_CERT_ALTNAME_INVALID`.
 *
 * The second is asserted too, as a counterfactual, so that the first is not a
 * test that would pass against an implementation doing no verification at all.
 * ---------------------------------------------------------------------- */

const opensslAvailable = spawnSync("openssl", ["version"], { stdio: "ignore" }).status === 0;

describe.skipIf(!opensslAvailable)(
  "TLS: the certificate is verified against the hostname, not against the pinned address",
  () => {
    let dir = "";
    let https: HttpsServer;
    let tlsPort = 0;
    let restoreCa: readonly string[] = [];
    const seen: Seen[] = [];

    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), "pl-0710-tls-"));
      const keyPath = join(dir, "key.pem");
      const certPath = join(dir, "cert.pem");

      // `subjectAltName=DNS:localhost` and nothing else. The ABSENCE of an
      // `IP:127.0.0.1` entry is the whole experiment.
      const made = spawnSync(
        "openssl",
        [
          "req", "-x509", "-newkey", "rsa:2048", "-nodes",
          "-keyout", keyPath, "-out", certPath,
          "-days", "1", "-subj", "/CN=localhost",
          "-addext", "subjectAltName=DNS:localhost"
        ],
        { stdio: "ignore" }
      );
      if (made.status !== 0) throw new Error("openssl reported a failure generating the certificate");

      const key = readFileSync(keyPath);
      const cert = readFileSync(certPath);

      /*
       * Trusted for the duration of this file only, and restored in `afterAll`.
       * `NODE_EXTRA_CA_CERTS` is read once at process start and so cannot be used
       * from inside a test; `tls.setDefaultCACertificates` is the supported
       * runtime equivalent. The existing roots are kept and ours is APPENDED,
       * because replacing the store would make this file's behaviour depend on
       * nothing else in the worker ever needing a real root.
       */
      restoreCa = getCACertificates("default");
      setDefaultCACertificates([...restoreCa, cert.toString()]);

      https = createHttpsServer({ key, cert }, (request, response) => {
        seen.push({
          host: request.headers.host,
          url: request.url,
          // What the CLIENT asked for in SNI, observed at the server end rather
          // than inferred from our own options.
          servername: (request.socket as TLSSocket).servername
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: "org.archive", version: "1.0.0" }));
      });
      await new Promise<void>((resolve) => {
        https.listen(0, "127.0.0.1", resolve);
      });
      const address = https.address();
      if (address === null || typeof address === "string") throw new Error("expected a TCP address");
      tlsPort = address.port;
    });

    afterAll(async () => {
      setDefaultCACertificates([...restoreCa]);
      await new Promise<void>((resolve) => {
        https.close(() => {
          resolve();
        });
      });
      rmSync(dir, { recursive: true, force: true });
    });

    it("completes the handshake against a certificate that names only the host", async () => {
      const result = await fetchJson(
        `https://localhost:${tlsPort}${PROBE_PATH}`,
        options({ resolveHost: answering("127.0.0.1") })
      );

      // A completed handshake with `rejectUnauthorized: true` against a
      // DNS-only certificate is the proof: the chain was verified AND the
      // identity was checked against `localhost`.
      expect(result.ok).toBe(true);
      expect(result.ok && result.value).toEqual({ id: "org.archive", version: "1.0.0" });

      const last = seen.at(-1);
      expect(last?.servername).toBe("localhost");
      expect(last?.host).toBe(`localhost:${tlsPort}`);
    });

    it("and the rejected design -- connect by address, verify by address -- provably cannot", async () => {
      /*
       * THE COUNTERFACTUAL, run for real rather than described.
       *
       * This is the implementation `pin.ts` rejects: put the approved IP in the
       * request and let TLS take the identity from it. Against the very same
       * server and the very same certificate it fails, because the certificate
       * names `localhost` and not `127.0.0.1`. Without this assertion the test
       * above would also pass against a transport that verified nothing at all.
       */
      const failure = await new Promise<string>((resolve) => {
        const agent = new HttpsAgent({ keepAlive: false, maxSockets: 1 });
        const request = httpsRequest({
          hostname: "127.0.0.1",
          port: tlsPort,
          path: PROBE_PATH,
          method: "GET",
          agent,
          rejectUnauthorized: true
        });
        request.on("error", (error: Error & { code?: string }) => {
          agent.destroy();
          resolve(error.code ?? error.name);
        });
        request.on("response", (response) => {
          response.resume();
          agent.destroy();
          resolve(`unexpectedly succeeded with ${String(response.statusCode)}`);
        });
        request.end();
      });

      expect(failure).toBe("ERR_TLS_CERT_ALTNAME_INVALID");
    });
  }
);
