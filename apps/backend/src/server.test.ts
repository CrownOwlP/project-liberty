import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createBackendServer } from "./server";
import type { BackendConfiguration } from "./config";
import { HEALTH_PATH, SESSION_PATH } from "./router";

/**
 * The socket half, over a real socket (PW-0401).
 *
 * A REAL LISTENER ON AN EPHEMERAL PORT, not a mocked one. Everything above this
 * file is a function over values and is tested as one; what is left for this
 * file is the bridge -- Node's `IncomingMessage` becoming a `Request` and a
 * `Response` becoming bytes -- and a bridge is exactly the thing a fake cannot
 * check. Cleartext rather than TLS because the transport choice is `config.ts`'s
 * and is tested there; what is under test here is the same code path either way.
 */

const configuration: BackendConfiguration = {
  host: "127.0.0.1",
  /* Port 0 asks the kernel for a free one, so this suite never collides with a
   * developer's running service or with another test file. */
  port: 0,
  transport: { kind: "plaintext-behind-terminator" }
};

const server = createBackendServer(configuration, {
  authenticate: async () => ({ ok: false, reason: "not_authenticated", detail: "no session" }),
  decide: async () => new Response("unreachable", { status: 500 })
});

let origin = "";

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

describe("the bridge between Node's HTTP types and the router", () => {
  it("serves the liveness endpoint", async () => {
    const response = await fetch(`${origin}${HEALTH_PATH}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("carries a POST body and the method through to the router", async () => {
    const response = await fetch(`${origin}${SESSION_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contentId: "aurora-fall" })
    });
    /* The injected authenticator refuses, which proves the request reached the
     * endpoint with its method intact rather than falling through to 404/405. */
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("sets a content-length that matches the bytes it sent", async () => {
    /*
     * Worth asserting because the bridge computes it rather than inheriting it:
     * a `Response` built from a string has no `content-length` until something
     * adds one, and a wrong one is a hung client rather than a visible error.
     */
    const response = await fetch(`${origin}${HEALTH_PATH}`);
    const body = await response.arrayBuffer();
    expect(response.headers.get("content-length")).toBe(String(body.byteLength));
  });

  it("routes an unknown path to 404 and a wrong method to 405", async () => {
    expect((await fetch(`${origin}/api/v1/catalog/home`)).status).toBe(404);
    expect((await fetch(`${origin}${SESSION_PATH}`)).status).toBe(405);
  });

  it("refuses an oversized body rather than reading it into memory", async () => {
    /*
     * The transport bound underneath `handler.ts`'s `MAX_REQUEST_BODY_BYTES`.
     * It is deliberately looser than the contract's, so a body just over the
     * CONTRACT's limit still arrives and is answered with the contract's own
     * `request_body_too_large` reason rather than with a dropped connection --
     * this one only catches a stream that would never end.
     */
    const response = await fetch(`${origin}${SESSION_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(512 * 1024)
    });
    expect(response.status).toBe(413);
    expect((await response.json()).error).toBe("request_body_too_large");
  });

  it("does not build its URL from the Host header a caller sent", async () => {
    /*
     * Nothing downstream reads the origin, so the authority is a placeholder.
     * Taking it from `Host` would import a caller-controlled value into a URL
     * for no benefit -- the shape of mistake that turns a router into a
     * confused deputy.
     */
    const response = await fetch(`${origin}${HEALTH_PATH}`, {
      headers: { host: "evil.example" }
    });
    expect(response.status).toBe(200);
  });
});
