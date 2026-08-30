import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  createServer as createTcpServer,
  type Server as TcpServer,
  type Socket
} from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authoriseFetchTarget, type EgressPolicy, type PinnedTarget } from "../egress";
import type { PinnedRequestInit } from "../pin";
import { testClassifyHost } from "../testing/fixtures";
import { nodePinnedFetch } from "./pinned-fetch";

/**
 * The Node transport, exercised over LOOPBACK ONLY.
 *
 * EVERY PIN IN THIS FILE COMES OUT OF `authoriseFetchTarget`. It used to write
 * `PinnedTarget` literals, and the review of PL-0304 was right that this was not
 * merely inconvenient but self-defeating: a suite that fabricates its own pin is
 * not exercising the path production uses, and its existence disproved the
 * security claim it was written to support. Pins are now obtained the way
 * `http.ts` obtains them, which makes the tests stronger in two ways -- the
 * transport is fed objects the authorisation path really produces, and the
 * classification of every pinned address is part of the setup rather than
 * something the test asserts around.
 *
 * WHERE A TEST NEEDS AN ADDRESS THE REAL WORLD WOULD NOT HAVE GIVEN IT, it says
 * so through `resolveHost`, which is an injected port with no default. Answering
 * `localhost` with 127.0.0.2 is a resolver the composition root could legally
 * supply; the URL, the policy, the allowlist, the loopback keys and the
 * per-address classification are all still the production ones. That is a
 * different thing from bypassing the gate, and it is the only steering these
 * tests do.
 *
 * WHERE A TEST NEEDS SOMETHING AUTHORISATION WOULD REFUSE OUTRIGHT -- an `ftp:`
 * target, a target nothing ever issued -- there is no honest way to obtain it,
 * so those two tests cast, say that they are casting, and assert that the
 * transport refuses anyway. The cast IS the adversary being modelled.
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
/**
 * TCP connections accepted, as distinct from requests served.
 *
 * The two diverge in exactly one interesting case: a client that connects and
 * then never sends a request line. That is what the transport used to do when
 * handed an already-aborted signal, and counting only requests is why nobody
 * noticed -- the abandoned connection was invisible to `received` while being
 * the thing that later emitted an unowned `ECONNRESET` and failed the run.
 */
let connections = 0;
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

  server.on("connection", () => {
    connections += 1;
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

/**
 * The policy these tests authorise under.
 *
 * Both loopback keys are turned on because everything here binds to 127.0.0.1,
 * and `egress.ts` requires BOTH -- the source opting in and the instance being a
 * local deployment. Stated here rather than borrowed from `permissiveEgress`,
 * which deliberately has them off: that fixture's job is to prove the keys are
 * load bearing, and quietly flipping them for this suite's convenience would
 * make it stop doing that job for `pin.test.ts` too.
 */
const LOOPBACK_POLICY: EgressPolicy = {
  allowedHosts: ["localhost"],
  allowLoopback: true,
  localDeployment: true
};

/**
 * A pin, obtained the way `http.ts` obtains one.
 *
 * `resolveHost` answers with the addresses the caller names. That is the only
 * steering: the URL, the policy, the protocol allowlist, the credential check,
 * the host classification, the allowlist match, the loopback keys and the
 * classification of each resolved address all run exactly as they do in
 * production, and a set this refuses is a set that never becomes a pin -- which
 * a couple of these tests rely on.
 */
async function authorise(raw: string, addresses: readonly string[]): Promise<PinnedTarget> {
  const verdict = await authoriseFetchTarget(raw, LOOPBACK_POLICY, {
    classifyHost: testClassifyHost,
    resolveHost: async () => addresses
  });
  if (!verdict.ok) throw new Error(`expected an authorisation, got ${verdict.reason}`);
  return verdict.pin;
}

/** Always requests the NAME `localhost`; only the pinned address varies. */
function target(addresses: readonly string[], path = "/manifest"): Promise<PinnedTarget> {
  return authorise(`http://localhost:${port}${path}`, addresses);
}

describe("the socket opens to the authorised address", () => {
  it("fetches through the pin and preserves the hostname in the Host header", async () => {
    const response = await nodePinnedFetch(await target(["127.0.0.1"]), init());

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
    const response = await nodePinnedFetch(await target(["127.0.0.1"], "/large"), init());
    await expect(response.text()).resolves.toHaveLength(LARGE_BODY.length);
  });

  it("returns a null body for a null-body status rather than throwing", async () => {
    // `new Response(body, { status: 204 })` throws if a body is attached, so a
    // publisher answering 204 would otherwise surface as a spurious network
    // fault instead of as the 204 it is.
    const response = await nodePinnedFetch(await target(["127.0.0.1"], "/empty"), init());
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });
});

describe("the socket cannot open to an address that was not authorised", () => {
  it("does not reach a server that real DNS would have found", async () => {
    const before = received.length;

    /*
     * `localhost` resolves to 127.0.0.1 everywhere, and that is where the server
     * is listening. The pin says 127.0.0.2, where nothing is. If this request
     * arrives, the lookup was not honoured and the DNS rebinding window is open
     * again -- which is the entire finding this work closes.
     *
     * The pin comes from `authoriseFetchTarget` like every other one here, via a
     * resolver that answers 127.0.0.2 for `localhost`. That is not a way around
     * the gate: 127/8 classifies as loopback, the name classifies as loopback,
     * both loopback keys are set, so the address is one the policy genuinely
     * authorises. The test then asks the only remaining question -- whether Node
     * connects to the address that was authorised or to the one DNS would have
     * given it.
     */
    await expect(nodePinnedFetch(await target(["127.0.0.2"]), init(2_000))).rejects.toThrow();

    expect(received.length).toBe(before);
  });

  /*
   * REPLACES "refuses a target with no authorised address instead of falling
   * back to DNS".
   *
   * That test passed `target([])`, which is now unobtainable twice over: the
   * literal it was built from no longer type-checks, and `authoriseFetchTarget`
   * refuses an empty resolution with `dns_resolved_no_addresses` before a pin
   * exists. The empty-address case therefore cannot reach the transport at all,
   * and the question that replaces it is the one the reviewer asked -- whether
   * the PRODUCTION transport will accept a structurally fabricated target
   * carrying an address nothing classified. It is the same test with the
   * interesting input restored.
   */
  it("refuses a fabricated target carrying an address nothing classified", async () => {
    const before = received.length;

    /*
     * The cast is the point, and it is the only way to write this line: without
     * `as unknown as`, an object literal is not a `PinnedTarget` and this file
     * does not compile. That is the compile-time half of the fix. The runtime
     * half is that `createPinnedLookup` checks the target against the registry
     * of pins `authoriseFetchTarget` actually issued, so even a caller willing
     * to cast gets nothing -- which is what makes this a control rather than a
     * convention. The address is the cloud metadata endpoint on purpose: it is
     * the exact payload the review named.
     */
    const fabricated = {
      url: `http://localhost:${port}/manifest`,
      hostname: "localhost",
      addresses: ["169.254.169.254"]
    } as unknown as PinnedTarget;

    await expect(nodePinnedFetch(fabricated, init())).rejects.toThrow(TypeError);
    expect(received.length).toBe(before);
  });

  it("refuses a spread of a real pin with the addresses swapped", async () => {
    const before = received.length;
    // No cast at all here: a spread copies the brand, so this type-checks. It is
    // the case a brand alone would have let through, and the reason the registry
    // is keyed on object identity.
    const genuine = await target(["127.0.0.1"]);
    const copied: PinnedTarget = { ...genuine, addresses: ["169.254.169.254"] };

    await expect(nodePinnedFetch(copied, init())).rejects.toThrow(TypeError);
    expect(received.length).toBe(before);
  });

  it("refuses a scheme outside http and https", async () => {
    // Cast for the same reason as above, and additionally because
    // `authoriseFetchTarget` refuses `ftp:` at the protocol allowlist, so no
    // authorisation could ever produce this target. The transport's own scheme
    // guard is documented as unreachable through the gate and kept for a caller
    // who arrives some other way; this is that caller.
    await expect(
      nodePinnedFetch(
        {
          url: "ftp://localhost/master.m3u8",
          hostname: "localhost",
          addresses: ["127.0.0.1"]
        } as unknown as PinnedTarget,
        init()
      )
    ).rejects.toThrow();
  });

  it("opens nothing at all when the deadline has already passed", async () => {
    const beforeRequests = received.length;
    // The connection count, not just the request count, and that distinction is
    // the regression this assertion exists for. The transport used to construct
    // the `ClientRequest` before checking the signal, which opened a socket and
    // then walked away from it without sending a request line -- invisible to
    // `received`, fatal to the run when the abandoned connection later closed
    // with no error listener attached. `received` alone called that behaviour
    // correct for four rounds.
    const beforeConnections = connections;

    await expect(
      nodePinnedFetch(await target(["127.0.0.1"]), {
        method: "GET",
        headers: {},
        signal: AbortSignal.abort()
      })
    ).rejects.toThrow();

    // Settled for a moment before asserting, because `connection` is emitted by
    // the SERVER and would arrive after this promise rejected. Asserting
    // immediately would pass whether or not a socket had been opened, which is a
    // test that reports the bug as fixed while it is still there. A loopback
    // connect completes in single-digit milliseconds; this is two orders of
    // magnitude of headroom, spent only on the passing path.
    await new Promise((settle) => setTimeout(settle, 100));

    expect(received.length).toBe(beforeRequests);
    expect(connections).toBe(beforeConnections);
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
         * until our own deadline aborted it. Both were changed while hunting a
         * stray "socket hang up" that failed the run with every assertion green,
         * and NEITHER WAS THE CAUSE: the emit came from the already-aborted test
         * above, whose request opened a connection and walked away from it before
         * any listener existed. Chasing it through this file did find one real
         * transport leak on the way (`release()` now closes the in-flight socket
         * that `agent.destroy()` cannot), which is why that fix stayed.
         *
         * This shape is kept anyway, on its own merits rather than on a repair it
         * turned out not to be: a definite fatal alert settles the client through
         * the transport's ordinary error path in milliseconds, where going silent
         * left the test waiting out a deadline for a connection nobody wanted.
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
     * The handshake cannot complete against a server with no certificate, and it
     * does not need to: the ClientHello is the client's FIRST write and is
     * already captured by the time the server answers. The server answers with a
     * fatal `handshake_failure` alert, so this settles through the transport's
     * ordinary error path in milliseconds; the 400ms deadline is the fallback for
     * a server that says nothing at all, not the mechanism.
     */
    await expect(
      nodePinnedFetch(
        await authorise(`https://localhost:${tlsPort}/master.m3u8`, ["127.0.0.1"]),
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
     * Let this connection finish dying inside the test's own lifetime.
     *
     * AN HONEST CORRECTION. An earlier version of this comment claimed the wait
     * was what fixed the suite's non-zero exit -- that the stray "socket hang up"
     * was "an emit with no owner because the test returned first". That was
     * wrong, and it was the third of four wrong diagnoses that all landed on this
     * test. The emit came from a different test entirely: the already-aborted
     * one, where the transport used to build a `ClientRequest` before checking
     * the signal, opening a connection it then abandoned with no error listener
     * on it. See the deadline check in `pinned-fetch.ts`.
     *
     * The wait stays, for the smaller reason it was always good for: the
     * transport ends this connection through its own abort path, and keeping the
     * close inside the test means the transport's listeners are demonstrably the
     * ones handling it rather than something later in the run. It is not load
     * bearing for the exit code, and this comment no longer claims it is.
     */
    await new Promise((settle) => setTimeout(settle, 250));
  });
});
