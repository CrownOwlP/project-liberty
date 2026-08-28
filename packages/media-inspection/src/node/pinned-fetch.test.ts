import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  createServer as createTcpServer,
  type Server as TcpServer,
  type Socket
} from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PinnedRequestInit, PinnedTarget } from "../pin";
import { nodePinnedFetch } from "./pinned-fetch";

/**
 * The Node transport, exercised over LOOPBACK ONLY.
 *
 * WHY THESE ARE HERE AND NOT MOCKED. `pin.test.ts` proves that the authorised
 * addresses reach the transport and that the pinned lookup answers from them and
 * nothing else. Neither of those proves the thing that actually matters: that
 * NODE USES OUR LOOKUP when it opens the socket. That is a claim about a runtime
 * API, and the only honest way to test a claim about a runtime is to make the
 * runtime do it. A double would assert our belief about `net.connect` back to
 * us.
 *
 * The negative test is the load-bearing one, and it is constructed so that the
 * defect and the fix give opposite results. The server listens on 127.0.0.1. The
 * request is for `localhost`, which every system resolver in existence answers
 * with 127.0.0.1. The pin says 127.0.0.2. If Node consulted DNS -- if `lookup`
 * were ignored, dropped by an option merge, or silently unsupported on this
 * path -- the request would arrive at the server. It must not arrive.
 *
 * NO EXTERNAL NETWORK IS USED OR REQUIRED. Everything binds to 127.0.0.1 on an
 * ephemeral port. A suite that needed the internet would be a suite that gets
 * disabled the first time CI is offline.
 */

const BODY = "#EXTM3U\n#EXT-X-VERSION:7\n";
/** Comfortably more than one TCP segment, so the streaming path really streams. */
const LARGE_BODY = "x".repeat(512 * 1024);

interface Received {
  readonly host: string | undefined;
  readonly path: string | undefined;
  readonly accept: string | undefined;
}

const received: Received[] = [];
let server: Server;
let port = 0;

beforeAll(async () => {
  server = createServer((request: IncomingMessage, response: ServerResponse) => {
    received.push({
      host: request.headers.host,
      path: request.url,
      accept: request.headers.accept
    });
    if (request.url === "/empty") {
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.url === "/large") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(LARGE_BODY);
      return;
    }
    response.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" });
    response.end(BODY);
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

function init(timeoutMs = 4_000): PinnedRequestInit {
  return {
    method: "GET",
    headers: { accept: "application/vnd.apple.mpegurl", "user-agent": "pin-test" },
    signal: AbortSignal.timeout(timeoutMs)
  };
}

/** Always requests the NAME `localhost`; only the pinned address varies. */
function target(addresses: readonly string[], path = "/manifest"): PinnedTarget {
  return { url: `http://localhost:${port}${path}`, hostname: "localhost", addresses };
}

describe("the socket opens to the authorised address", () => {
  it("fetches through the pin and preserves the hostname in the Host header", async () => {
    const response = await nodePinnedFetch(target(["127.0.0.1"]), init());

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(BODY);

    const last = received.at(-1);
    // The Host header is the NAME, not the pinned address. A transport that
    // rewrote the URL to the IP would send `127.0.0.1:port` here and would break
    // every virtual host on the internet -- the defect this design avoids by
    // substituting the resolver instead of the host.
    expect(last?.host).toBe(`localhost:${port}`);
    expect(last?.path).toBe("/manifest");
    expect(last?.accept).toBe("application/vnd.apple.mpegurl");
  });

  it("streams a body larger than one segment without truncating it", async () => {
    // Exercises the pause-per-chunk backpressure in `bodyStream`. A pull that
    // never resumed would hang here; a stream that never paused would still
    // pass, which is why the cancellation behaviour is asserted through
    // `http.ts`'s size cap rather than here.
    const response = await nodePinnedFetch(target(["127.0.0.1"], "/large"), init());
    await expect(response.text()).resolves.toHaveLength(LARGE_BODY.length);
  });

  it("returns a null body for a null-body status rather than throwing", async () => {
    // `new Response(body, { status: 204 })` throws if a body is attached, so a
    // publisher answering 204 would otherwise surface as a spurious network
    // fault instead of as the 204 it is.
    const response = await nodePinnedFetch(target(["127.0.0.1"], "/empty"), init());
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });
});

describe("the socket cannot open to an address that was not authorised", () => {
  it("does not reach a server that real DNS would have found", async () => {
    const before = received.length;

    // `localhost` resolves to 127.0.0.1 everywhere, and that is where the server
    // is listening. The pin says 127.0.0.2, where nothing is. If this request
    // arrives, the lookup was not honoured and the DNS rebinding window is open
    // again -- which is the entire finding this work closes.
    await expect(nodePinnedFetch(target(["127.0.0.2"]), init(2_000))).rejects.toThrow();

    expect(received.length).toBe(before);
  });

  it("refuses a target with no authorised address instead of falling back to DNS", async () => {
    const before = received.length;
    await expect(nodePinnedFetch(target([]), init())).rejects.toThrow(TypeError);
    expect(received.length).toBe(before);
  });

  it("refuses a scheme outside http and https", async () => {
    await expect(
      nodePinnedFetch(
        { url: "ftp://localhost/master.m3u8", hostname: "localhost", addresses: ["127.0.0.1"] },
        init()
      )
    ).rejects.toThrow();
  });

  it("opens nothing at all when the deadline has already passed", async () => {
    const before = received.length;
    await expect(
      nodePinnedFetch(target(["127.0.0.1"]), {
        method: "GET",
        headers: {},
        signal: AbortSignal.abort()
      })
    ).rejects.toThrow();
    expect(received.length).toBe(before);
  });
});

describe("TLS is offered the hostname, never the pinned address", () => {
  let tcp: TcpServer;
  let tlsPort = 0;
  const hellos: Buffer[] = [];
  const open: Socket[] = [];

  beforeAll(async () => {
    /*
     * A raw TCP listener rather than a TLS one, on purpose. Standing up a real
     * TLS server needs a certificate, and the two ways to get one are to check a
     * private key into the repository or to generate one at test time with an
     * API Node does not expose. Neither is worth it, because the property under
     * test is visible without completing a handshake: the SNI extension travels
     * in the ClientHello, which is the client's FIRST write and is not
     * encrypted. Reading that one segment answers the question directly.
     */
    tcp = createTcpServer((socket) => {
      /*
       * The server RECORDS and then does nothing. It deliberately does not close.
       *
       * It used to `destroy()` here, which reset the connection the instant the
       * ClientHello arrived. That made the test pass and the SUITE fail: the
       * reset raced the transport's own teardown, and Node emitted a stray
       * "socket hang up" after this promise had already settled, which vitest
       * correctly reported as an unhandled error. Whoever closes first decides
       * whether that race exists, so the client closes first now -- the deadline
       * below expires, the transport aborts its own request, and every error on
       * the path is one the transport is already holding a listener for.
       *
       * Sockets are collected so `afterAll` can close them; an open connection
       * keeps `tcp.close()` waiting forever otherwise.
       */
      open.push(socket);
      socket.on("error", () => undefined);
      socket.once("data", (chunk: Buffer) => {
        hellos.push(chunk);
        /*
         * Answer like a server that refuses the handshake, rather than going
         * silent.
         *
         * Seven bytes of TLS record: content type 21 (alert), version 3.3,
         * length 2, level 2 (fatal), description 40 (handshake_failure). Then a
         * FIN. The client gets a DEFINITE handshake failure and settles through
         * the transport's ordinary error path.
         *
         * The two things this replaces both left the connection ABANDONED --
         * either the server destroyed it mid-handshake, or it stayed silent
         * until our own deadline aborted it. In both cases the close arrived
         * after the promise had settled and Node emitted a stray "socket hang
         * up" at a point where no listener could exist, which failed the run
         * even though all eight assertions passed. Chasing that found a genuine
         * leak in the transport (`release()` now closes the in-flight socket
         * that `agent.destroy()` cannot), but the emit outlived that fix too.
         *
         * The property under test never needed an abandoned connection: the
         * ClientHello is the client's FIRST write and is already captured above.
         * Everything after it was incidental, so this stops producing it.
         */
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
    // Sockets first: `close()` stops new connections but waits on established
    // ones, and this server never hangs up on its own.
    for (const socket of open) socket.destroy();
    await new Promise<void>((resolve) => {
      tcp.close(() => {
        resolve();
      });
    });
  });

  it("names the publisher's host in the ClientHello, so the certificate is checked against it", async () => {
    /*
     * The handshake cannot complete against a socket that answers with nothing,
     * and it does not need to: the ClientHello is the client's first write and
     * has already been sent by the time the deadline expires. A short deadline
     * on purpose -- it is the whole mechanism by which the CLIENT ends this
     * connection rather than the server, which is what keeps a late socket error
     * from escaping after the assertion has run.
     */
    await expect(
      nodePinnedFetch(
        {
          url: `https://localhost:${tlsPort}/master.m3u8`,
          hostname: "localhost",
          addresses: ["127.0.0.1"]
        },
        init(400)
      )
    ).rejects.toThrow();

    const hello = hellos.at(-1)?.toString("latin1") ?? "";
    // SNI carries the NAME. Node derives it, `tls.checkServerIdentity` validates
    // the presented certificate against the same name, and neither reads an
    // address -- which is why replacing the resolver leaves TLS untouched.
    expect(hello).toContain("localhost");
    // And the address we pinned is nowhere in the handshake. Had the URL been
    // rewritten to the IP -- the alternative `pin.ts` rejects -- this is where it
    // would show, along with a certificate check against an IP that no ordinary
    // certificate satisfies.
    expect(hello).not.toContain("127.0.0.1");

    /*
     * Wait for the connection to finish dying BEFORE the test returns.
     *
     * The transport holds an `error` listener for every socket it opens, so the
     * teardown emit is handled during normal operation. What it cannot cover is
     * an emit that arrives after the runner has torn this module's context down
     * -- at that point vitest's own uncaught handler is the only one left, and it
     * reports a "socket hang up" that nothing in the product could have caught.
     * Two rounds were spent treating that as a defect in the transport and then
     * in the server; it is neither. It is an emit with no owner because the test
     * returned first.
     *
     * So the test does not return first. A macrotask is enough: the abort has
     * already run by the time the assertion above passes, and the close it
     * causes is queued behind it.
     */
    await new Promise((settle) => setTimeout(settle, 250));
  });
});
