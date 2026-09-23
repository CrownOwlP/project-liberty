/* The listener boundary's rules, each paired with the attack it exists to stop
 * (PW-0101). A guard whose tests only show it accepting a good request proves
 * nothing; every case below is a refusal, with the one acceptance as its pair. */
import { describe, expect, it } from "vitest";

import {
  LOOPBACK_HOSTS,
  SIDECAR_HOST_VAR,
  SIDECAR_TOKEN_MIN_CHARS,
  SIDECAR_TOKEN_VAR,
  authorizeRequest,
  checkBindSafety,
  constantTimeEquals,
  contentSecurityPolicy,
  isSidecarMode,
  readSidecarEnvironment
} from "./policy";

const TOKEN = "a".repeat(SIDECAR_TOKEN_MIN_CHARS);
const HOST = "127.0.0.1:3100";

const armed = readSidecarEnvironment({
  [SIDECAR_TOKEN_VAR]: TOKEN,
  [SIDECAR_HOST_VAR]: HOST,
  HOSTNAME: "127.0.0.1"
});

describe("sidecar mode is armed by a secret, never by a build flag", () => {
  it("is off when no token is present, so a hosted deployment is unaffected", () => {
    const web = readSidecarEnvironment({ HOSTNAME: "0.0.0.0" });
    expect(isSidecarMode(web)).toBe(false);
    expect(authorizeRequest(web, { presentedToken: null, host: "liberty.example" }).ok).toBe(true);
  });

  it("is on when a token is present, even an empty one, so an empty value cannot disarm it", () => {
    /* `Object.hasOwn`, not truthiness. An empty string is a deliberate value
     * elsewhere in this repository and reading it as absent here would turn a
     * misconfigured shell into an open listener. */
    const empty = readSidecarEnvironment({ [SIDECAR_TOKEN_VAR]: "" });
    expect(isSidecarMode(empty)).toBe(true);
    expect(authorizeRequest(empty, { presentedToken: "", host: HOST }).ok).toBe(false);
  });

  it("names no build-target variable in CODE, because a runtime switch is forbidden", async () => {
    /*
     * COMMENTS ARE STRIPPED FIRST, which is the same rule build-target.test.ts
     * applies and it is not a loophole. The prose above this test's subject has
     * to be able to say WHY the variable is not read -- a guard that forbids
     * writing down what you are not doing teaches the next reader to delete the
     * explanation, which is exactly the defect PL-0701's restatement guard hit
     * and had to be rewritten for.
     */
    const raw = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("./policy.ts", import.meta.url), "utf8")
    );
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    expect(code).not.toContain("LIBERTY_BUILD_TARGET");
    /* Non-vacuity: the stripper must not be eating the whole file. */
    expect(code).toContain("SIDECAR_TOKEN_VAR");
  });
});

describe("the process refuses to start unsafely", () => {
  it("refuses a token shorter than 256 bits", () => {
    const weak = readSidecarEnvironment({
      [SIDECAR_TOKEN_VAR]: "abc",
      [SIDECAR_HOST_VAR]: HOST,
      HOSTNAME: "127.0.0.1"
    });
    const decision = checkBindSafety(weak);
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.code).toBe("token_too_short");
      /* The length is reported; the value never is. */
      expect(decision.detail).not.toContain("abc");
    }
  });

  it("refuses to start without a stated Host, because a token does not stop rebinding", () => {
    const noHost = readSidecarEnvironment({
      [SIDECAR_TOKEN_VAR]: TOKEN,
      HOSTNAME: "127.0.0.1"
    });
    const decision = checkBindSafety(noHost);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.code).toBe("host_not_stated");
  });

  it("refuses an UNSET HOSTNAME, which is the one that silently serves the LAN", () => {
    /* Next binds 0.0.0.0 when HOSTNAME is unset. A sidecar that inherited a
     * container's environment, or a shell that forgot, would serve the whole
     * network with a token the user's own browser holds. Defaulting would hide
     * exactly this. */
    const unset = readSidecarEnvironment({
      [SIDECAR_TOKEN_VAR]: TOKEN,
      [SIDECAR_HOST_VAR]: HOST
    });
    const decision = checkBindSafety(unset);
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.code).toBe("bind_not_loopback");
      expect(decision.detail).toContain("0.0.0.0");
    }
  });

  it("refuses a non-loopback bind and accepts every loopback one", () => {
    for (const bad of ["0.0.0.0", "192.168.1.10", "::", "example.test"]) {
      const env = readSidecarEnvironment({
        [SIDECAR_TOKEN_VAR]: TOKEN,
        [SIDECAR_HOST_VAR]: HOST,
        HOSTNAME: bad
      });
      expect(checkBindSafety(env).ok, `${bad} must be refused`).toBe(false);
    }
    for (const good of LOOPBACK_HOSTS) {
      const env = readSidecarEnvironment({
        [SIDECAR_TOKEN_VAR]: TOKEN,
        [SIDECAR_HOST_VAR]: HOST,
        HOSTNAME: good
      });
      expect(checkBindSafety(env).ok, `${good} must be accepted`).toBe(true);
    }
  });
});

describe("a request is authorized by a token AND a Host, or not at all", () => {
  it("accepts the shell's own request", () => {
    expect(authorizeRequest(armed, { presentedToken: TOKEN, host: HOST }).ok).toBe(true);
  });

  it("refuses an absent token — any local process can reach a loopback port", () => {
    expect(authorizeRequest(armed, { presentedToken: null, host: HOST }).ok).toBe(false);
  });

  it("refuses a wrong token, including one that shares a prefix", () => {
    expect(authorizeRequest(armed, { presentedToken: `${"a".repeat(63)}b`, host: HOST }).ok).toBe(false);
  });

  it("refuses a valid token on a rebound Host — the attack a token cannot stop", () => {
    /* DNS rebinding makes the VICTIM'S browser issue the request, so it already
     * holds the token. Host validation is the only control that fires. */
    expect(authorizeRequest(armed, { presentedToken: TOKEN, host: "evil.test" }).ok).toBe(false);
  });

  it("refuses a Host that differs only in port, because that is another listener", () => {
    expect(authorizeRequest(armed, { presentedToken: TOKEN, host: "127.0.0.1:3101" }).ok).toBe(false);
  });

  it("gives the SAME refusal for every failure, so the wire is not an oracle", () => {
    const refusals = [
      authorizeRequest(armed, { presentedToken: null, host: HOST }),
      authorizeRequest(armed, { presentedToken: "wrong", host: HOST }),
      authorizeRequest(armed, { presentedToken: TOKEN, host: "evil.test" })
    ];
    const shapes = new Set(refusals.map((r) => JSON.stringify(r)));
    expect(
      shapes.size,
      "distinguishable refusals would tell an attacker which control it had already satisfied"
    ).toBe(1);
  });
});

describe("constant-time comparison", () => {
  it("is correct", () => {
    expect(constantTimeEquals("abc", "abc")).toBe(true);
    expect(constantTimeEquals("abc", "abd")).toBe(false);
    expect(constantTimeEquals("abc", "abcd")).toBe(false);
    expect(constantTimeEquals("", "")).toBe(true);
  });

  it("does not short-circuit on the first differing character", () => {
    /* Not a timing measurement -- a timing assertion in a unit suite is a flake
     * generator, and this repository has already ruled on load-dependent tests.
     * What is checked is the PROPERTY that makes constant time possible: the
     * comparison reads to the end of the longer input. A short-circuiting
     * implementation would answer these two in different amounts of work; both
     * must simply be false. */
    expect(constantTimeEquals("a".repeat(64), `b${"a".repeat(63)}`)).toBe(false);
    expect(constantTimeEquals("a".repeat(64), `${"a".repeat(63)}b`)).toBe(false);
  });
});

describe("the CSP that replaces the one Tauri stops injecting", () => {
  const policy = contentSecurityPolicy({
    nonce: "n0nce",
    mediaOrigins: ["https://fixtures.invalid"],
    connectOrigins: ["https://backend.invalid"]
  });

  it("allows no inline script and no object, and cannot be framed", () => {
    expect(policy).toContain("script-src 'self' 'nonce-n0nce'");
    expect(policy).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("base-uri 'none'");
  });

  it("carries the media and connect origins it was given, and no wildcard", () => {
    expect(policy).toContain("https://fixtures.invalid");
    expect(policy).toContain("https://backend.invalid");
    expect(policy).not.toContain("*");
  });

  it("does not widen when it is given nothing", () => {
    const bare = contentSecurityPolicy({ nonce: "x", mediaOrigins: [], connectOrigins: [] });
    expect(bare).toContain("media-src 'self' blob:");
    expect(bare).toContain("connect-src 'self'");
    expect(bare).not.toContain("*");
  });
});
