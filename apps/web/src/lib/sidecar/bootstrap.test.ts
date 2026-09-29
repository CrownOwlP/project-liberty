/* The sidecar startup path, end to end, without a socket (PW-0105).
 *
 * THIS FILE IS THE ANSWER TO INVARIANT 8 -- "No sidecar security control may
 * exist only as an unused helper". `checkBindSafety` and `formatHandshake` were
 * both written, tested and called by nothing. Testing them again would not have
 * found that; what finds it is a test of the STARTUP PATH, asserting that the
 * path refuses, exits and emits. Every case below drives `runSidecarBootstrap`
 * rather than the helpers underneath it. */
import { beforeEach, describe, expect, it } from "vitest";

import { HANDSHAKE_PREFIX, parseHandshake } from "./handshake";
import { SIDECAR_ACTUAL_PORT_VAR } from "./listener";
import { SIDECAR_HOST_VAR, SIDECAR_TOKEN_MIN_CHARS, SIDECAR_TOKEN_VAR } from "./policy";
import {
  planSidecarBootstrap,
  resetSidecarBootstrapState,
  runSidecarBootstrap,
  type SidecarBootstrapIO
} from "./bootstrap";

const TOKEN = "a".repeat(SIDECAR_TOKEN_MIN_CHARS);
const IDENTITY = "127.0.0.1";

const server = (address: string, port: number) => ({
  address: () => ({ address, port, family: address.includes(":") ? "IPv6" : "IPv4" }),
  listen: () => undefined
});

interface Harness {
  readonly io: SidecarBootstrapIO;
  readonly out: string[];
  readonly err: string[];
  readonly exits: number[];
  readonly env: Record<string, string | undefined>;
}

function harness(
  env: Record<string, string | undefined>,
  handles: readonly unknown[]
): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const exits: number[] = [];
  return {
    env,
    out,
    err,
    exits,
    io: {
      env,
      handles: () => handles,
      stdout: (line) => void out.push(line),
      stderr: (line) => void err.push(line),
      /* DELIBERATELY DOES NOT STOP EXECUTION. The real `process.exit` does; a
       * fake that threw would hide whether the code AFTER the exit call is
       * capable of emitting a handshake, which is precisely what these tests
       * need to be able to see. */
      exit: (code) => void exits.push(code)
    }
  };
}

const sidecarEnv = (overrides: Record<string, string | undefined> = {}) => ({
  [SIDECAR_TOKEN_VAR]: TOKEN,
  [SIDECAR_HOST_VAR]: IDENTITY,
  HOSTNAME: IDENTITY,
  /* The launch contract. Never the source of the reported port. */
  PORT: "0",
  ...overrides
});

beforeEach(() => {
  resetSidecarBootstrapState();
});

describe("a hosted deployment is untouched", () => {
  it("does not check, diagnose, exit or emit when there is no launch token", () => {
    const h = harness({ HOSTNAME: "0.0.0.0", PORT: "3000" }, [server("0.0.0.0", 3000)]);
    const outcome = runSidecarBootstrap(h.io);
    expect(outcome.status).toBe("not-a-sidecar");
    expect(h.out).toEqual([]);
    expect(h.err).toEqual([]);
    expect(h.exits).toEqual([]);
    expect(h.env[SIDECAR_ACTUAL_PORT_VAR]).toBeUndefined();
  });
});

describe("the bind check now runs on the real startup path", () => {
  it("refuses a short token, exits non-zero, and emits NO handshake", () => {
    const h = harness(sidecarEnv({ [SIDECAR_TOKEN_VAR]: "abc" }), [server(IDENTITY, 52341)]);
    const outcome = runSidecarBootstrap(h.io);
    expect(outcome.status).toBe("refused");
    if (outcome.status === "refused") expect(outcome.code).toBe("token_too_short");
    expect(h.exits).toEqual([1]);
    expect(h.out).toEqual([]);
    expect(h.err).toHaveLength(1);
  });

  it("writes an ACTIONABLE diagnostic that names the variable and never the token", () => {
    const secret = "s".repeat(10);
    const h = harness(sidecarEnv({ [SIDECAR_TOKEN_VAR]: secret }), [server(IDENTITY, 52341)]);
    runSidecarBootstrap(h.io);
    const line = h.err[0] ?? "";
    expect(line).toContain(SIDECAR_TOKEN_VAR);
    expect(line).toContain(String(SIDECAR_TOKEN_MIN_CHARS));
    expect(line, "a diagnostic must not put the secret in the log").not.toContain(secret);
  });

  it("refuses an unset HOSTNAME, the one that silently serves the LAN", () => {
    const h = harness(sidecarEnv({ HOSTNAME: undefined }), [server(IDENTITY, 52341)]);
    /* `undefined` in a spread still creates the key; remove it the way an
     * unset variable really is absent. */
    delete h.env["HOSTNAME"];
    const outcome = runSidecarBootstrap(h.io);
    expect(outcome.status).toBe("refused");
    if (outcome.status === "refused") expect(outcome.code).toBe("bind_not_loopback");
    expect(h.exits).toEqual([1]);
  });

  it("refuses an identity that is a name rather than an address", () => {
    const h = harness(sidecarEnv({ [SIDECAR_HOST_VAR]: "localhost" }), [server(IDENTITY, 52341)]);
    const outcome = runSidecarBootstrap(h.io);
    expect(outcome.status).toBe("refused");
    if (outcome.status === "refused") expect(outcome.code).toBe("host_not_loopback_literal");
    expect(h.exits).toEqual([1]);
  });
});

describe("the kernel's answer is checked, not the environment's claim", () => {
  it("REFUSES A NON-LOOPBACK BIND even when the environment claimed loopback", () => {
    /*
     * Invariant 5, and the failure `checkBindSafety` structurally cannot see:
     * it reads what the shell asked for, and this is what the socket did.
     */
    const h = harness(sidecarEnv(), [server("0.0.0.0", 3000)]);
    const outcome = runSidecarBootstrap(h.io);
    expect(outcome.status).toBe("bind-not-loopback");
    expect(h.exits).toEqual([1]);
    expect(h.out).toEqual([]);
    expect(h.err[0]).toContain("0.0.0.0");
  });

  it("refuses when the bound port cannot be established at all", () => {
    const h = harness(sidecarEnv(), []);
    const outcome = runSidecarBootstrap(h.io);
    expect(outcome.status).toBe("listener-unknown");
    expect(h.exits).toEqual([1]);
    expect(h.out).toEqual([]);
    /* And it says why the obvious fallback is not one. */
    expect(h.err[0]).toContain("PORT");
  });

  it("refuses when two servers make the answer ambiguous", () => {
    const h = harness(sidecarEnv(), [server(IDENTITY, 52341), server(IDENTITY, 52342)]);
    expect(runSidecarBootstrap(h.io).status).toBe("listener-unknown");
    expect(h.exits).toEqual([1]);
    expect(h.out).toEqual([]);
  });
});

describe("the handshake", () => {
  it("carries the ACTUAL bound port, never the requested PORT", () => {
    /*
     * The launch contract is `PORT=0`. A handshake that reported the request
     * would tell the shell to point a webview at port 0. This is the property
     * the ruling states in its own words: "obtain the actual bound port from
     * the listening server".
     */
    const h = harness(sidecarEnv({ PORT: "0" }), [server(IDENTITY, 52341)]);
    runSidecarBootstrap(h.io);
    expect(h.out).toHaveLength(1);
    const parsed = parseHandshake(h.out[0] ?? "");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.handshake.port).toBe(52341);
      expect(parsed.handshake.host).toBe(IDENTITY);
    }
    expect(h.out[0]).not.toContain('"port":0');
  });

  it("is emitted EXACTLY ONCE, even if the startup path runs twice", () => {
    const h = harness(sidecarEnv(), [server(IDENTITY, 52341)]);
    runSidecarBootstrap(h.io);
    runSidecarBootstrap(h.io);
    expect(h.out).toHaveLength(1);
  });

  it("is the only line on stdout, and starts with the prefix the shell scans for", () => {
    const h = harness(sidecarEnv(), [server(IDENTITY, 52341)]);
    runSidecarBootstrap(h.io);
    expect(h.out).toHaveLength(1);
    expect(h.out[0]?.startsWith(HANDSHAKE_PREFIX)).toBe(true);
    expect(h.err).toEqual([]);
    expect(h.exits).toEqual([]);
  });

  it("round-trips through the parser the desktop shell's contract is written against", () => {
    const h = harness(sidecarEnv(), [server("::1", 49152)]);
    runSidecarBootstrap(h.io);
    const parsed = parseHandshake(h.out[0] ?? "");
    expect(parsed).toEqual({ ok: true, handshake: { host: "::1", port: 49152 } });
  });

  it("publishes the port for the request path BEFORE the line is printed", () => {
    /* The shell may act on the handshake immediately. A request arriving
     * against an unpublished port would be judged under the reduced contract. */
    const order: string[] = [];
    const env: Record<string, string | undefined> = sidecarEnv();
    const io: SidecarBootstrapIO = {
      env,
      handles: () => [server(IDENTITY, 52341)],
      stdout: () => void order.push(`printed:${env[SIDECAR_ACTUAL_PORT_VAR]}`),
      stderr: () => undefined,
      exit: () => undefined
    };
    runSidecarBootstrap(io);
    expect(order).toEqual(["printed:52341"]);
  });
});

describe("planning is separable from doing", () => {
  it("decides without writing anything, so every branch is reachable in a test", () => {
    expect(planSidecarBootstrap(sidecarEnv(), [server(IDENTITY, 1)]).status).toBe("ready");
    expect(planSidecarBootstrap({}, []).status).toBe("not-a-sidecar");
  });
});
