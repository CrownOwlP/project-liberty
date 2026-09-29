/* The listener boundary's rules, each paired with the attack it exists to stop
 * (PW-0101, amended by PW-0105). A guard whose tests only show it accepting a
 * good request proves nothing; every case below is a refusal, with the one
 * acceptance as its pair.
 *
 * THE HOST CONTRACT CHANGED IN ROUND 95 AND THESE TESTS CHANGED WITH IT.
 * `LIBERTY_SIDECAR_HOST` used to be compared to the whole incoming `Host`
 * literal, port included -- a rule the shell could not satisfy, because the
 * kernel chooses the port after the shell has finished building the
 * environment. It is now the expected HOSTNAME, and the port is checked
 * separately against the port the process is really listening on. */
import { describe, expect, it } from "vitest";

import {
  LOOPBACK_HOSTS,
  LOOPBACK_HOST_LITERALS,
  SIDECAR_HOST_VAR,
  SIDECAR_TOKEN_MIN_CHARS,
  SIDECAR_TOKEN_VAR,
  authorizeRequest,
  checkBindSafety,
  constantTimeEquals,
  contentSecurityPolicy,
  isSidecarMode,
  parseHostHeader,
  readSidecarEnvironment
} from "./policy";

const TOKEN = "a".repeat(SIDECAR_TOKEN_MIN_CHARS);
/** The sidecar's IDENTITY: a hostname, never an authority. */
const IDENTITY = "127.0.0.1";
/** The port the kernel chose this run. Known only after the bind. */
const PORT = 3100;
const HOST = `${IDENTITY}:${PORT}`;

const armed = readSidecarEnvironment({
  [SIDECAR_TOKEN_VAR]: TOKEN,
  [SIDECAR_HOST_VAR]: IDENTITY,
  HOSTNAME: IDENTITY
});

const ask = (host: string | null, port: number | null = PORT, token: string | null = TOKEN) =>
  authorizeRequest(armed, { presentedToken: token, host }, port);

describe("sidecar mode is armed by a secret, never by a build flag", () => {
  it("is off when no token is present, so a hosted deployment is unaffected", () => {
    const web = readSidecarEnvironment({ HOSTNAME: "0.0.0.0" });
    expect(isSidecarMode(web)).toBe(false);
    expect(
      authorizeRequest(web, { presentedToken: null, host: "liberty.example" }, null).ok
    ).toBe(true);
  });

  it("is on when a token is present, even an empty one, so an empty value cannot disarm it", () => {
    /* `Object.hasOwn`, not truthiness. An empty string is a deliberate value
     * elsewhere in this repository and reading it as absent here would turn a
     * misconfigured shell into an open listener. */
    const empty = readSidecarEnvironment({ [SIDECAR_TOKEN_VAR]: "" });
    expect(isSidecarMode(empty)).toBe(true);
    expect(authorizeRequest(empty, { presentedToken: "", host: HOST }, PORT).ok).toBe(false);
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
      [SIDECAR_HOST_VAR]: IDENTITY,
      HOSTNAME: IDENTITY
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
      HOSTNAME: IDENTITY
    });
    const decision = checkBindSafety(noHost);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.code).toBe("host_not_stated");
  });

  it("refuses an IDENTITY that is a name rather than an address", () => {
    /*
     * PW-0105. `LIBERTY_SIDECAR_HOST` is the literal every incoming Host is
     * compared against, so it IS the rebinding defence. A name cannot play that
     * role: pointing a name at 127.0.0.1 is what the attack consists of. This is
     * refused at startup rather than left to refuse every request at runtime,
     * which is the difference between a configuration error and a mystery.
     */
    for (const name of ["localhost", "liberty.local", "127.0.0.1:3100"]) {
      const env = readSidecarEnvironment({
        [SIDECAR_TOKEN_VAR]: TOKEN,
        [SIDECAR_HOST_VAR]: name,
        HOSTNAME: IDENTITY
      });
      const decision = checkBindSafety(env);
      expect(decision.ok, `${name} must be refused as an identity`).toBe(false);
      if (!decision.ok) expect(decision.code).toBe("host_not_loopback_literal");
    }
    for (const literal of LOOPBACK_HOST_LITERALS) {
      const env = readSidecarEnvironment({
        [SIDECAR_TOKEN_VAR]: TOKEN,
        [SIDECAR_HOST_VAR]: literal,
        HOSTNAME: IDENTITY
      });
      expect(checkBindSafety(env).ok, `${literal} must be accepted as an identity`).toBe(true);
    }
  });

  it("refuses an UNSET HOSTNAME, which is the one that silently serves the LAN", () => {
    /* Next binds 0.0.0.0 when HOSTNAME is unset. A sidecar that inherited a
     * container's environment, or a shell that forgot, would serve the whole
     * network with a token the user's own browser holds. Defaulting would hide
     * exactly this. */
    const unset = readSidecarEnvironment({
      [SIDECAR_TOKEN_VAR]: TOKEN,
      [SIDECAR_HOST_VAR]: IDENTITY
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
        [SIDECAR_HOST_VAR]: IDENTITY,
        HOSTNAME: bad
      });
      expect(checkBindSafety(env).ok, `${bad} must be refused`).toBe(false);
    }
    for (const good of LOOPBACK_HOSTS) {
      const env = readSidecarEnvironment({
        [SIDECAR_TOKEN_VAR]: TOKEN,
        [SIDECAR_HOST_VAR]: IDENTITY,
        HOSTNAME: good
      });
      expect(checkBindSafety(env).ok, `${good} must be accepted`).toBe(true);
    }
  });
});

describe("the Host header is parsed, not pattern-matched", () => {
  it("reads an ordinary authority, with and without a port", () => {
    expect(parseHostHeader("127.0.0.1:3100")).toEqual({ hostname: "127.0.0.1", port: 3100 });
    expect(parseHostHeader("127.0.0.1")).toEqual({ hostname: "127.0.0.1", port: null });
    expect(parseHostHeader("[::1]:3100")).toEqual({ hostname: "::1", port: 3100 });
    expect(parseHostHeader("[::1]")).toEqual({ hostname: "::1", port: null });
  });

  it("lower-cases the hostname, because host names are case-insensitive on the wire", () => {
    expect(parseHostHeader("LocalHost:80")?.hostname).toBe("localhost");
  });

  it("refuses userinfo, the oldest authority-confusion trick", () => {
    expect(parseHostHeader("127.0.0.1@evil.test")).toBeNull();
    expect(parseHostHeader("evil.test@127.0.0.1:3100")).toBeNull();
  });

  it("refuses anything carrying a URL delimiter, whitespace or a control character", () => {
    for (const raw of [
      "127.0.0.1/",
      "127.0.0.1?x=1",
      "127.0.0.1#f",
      "127.0.0.1\\evil.test",
      "127.0.0.1 ",
      " 127.0.0.1",
      "127.0.0.1\r\nX: y",
      "127.0.0.1\t"
    ]) {
      expect(parseHostHeader(raw), `${JSON.stringify(raw)} must be refused`).toBeNull();
    }
  });

  it("refuses an unbracketed authority with more than one colon", () => {
    /* `::1:80` has no unambiguous reading, and guessing one is how two parsers
     * come to disagree about the same bytes. */
    expect(parseHostHeader("::1")).toBeNull();
    expect(parseHostHeader("::1:3100")).toBeNull();
    expect(parseHostHeader("127.0.0.1:3100:3101")).toBeNull();
  });

  it("refuses a port that is not a bare decimal in range", () => {
    for (const raw of [
      "127.0.0.1:",
      "127.0.0.1:0",
      "127.0.0.1:080",
      "127.0.0.1:65536",
      "127.0.0.1:999999",
      "127.0.0.1:31e2",
      "127.0.0.1:+80",
      "127.0.0.1:-80"
    ]) {
      expect(parseHostHeader(raw), `${JSON.stringify(raw)} must be refused`).toBeNull();
    }
  });

  it("refuses a trailing dot, which is a free suffix bypass of an exact match", () => {
    expect(parseHostHeader("localhost.")).toBeNull();
    expect(parseHostHeader("127.0.0.1.:3100")).toBeNull();
  });

  it("refuses a malformed or zone-scoped IP-literal", () => {
    for (const raw of ["[::1", "[]", "[::1]x", "[fe80::1%eth0]", "[127.0.0.1]", "]::1["]) {
      expect(parseHostHeader(raw), `${JSON.stringify(raw)} must be refused`).toBeNull();
    }
  });

  it("refuses an empty header and an absent one", () => {
    expect(parseHostHeader("")).toBeNull();
    expect(parseHostHeader(null)).toBeNull();
  });
});

describe("a request is authorized by a token AND a hostname AND a port, or not at all", () => {
  it("accepts the shell's own request", () => {
    expect(ask(HOST).ok).toBe(true);
  });

  it("refuses an absent token — any local process can reach a loopback port", () => {
    expect(ask(HOST, PORT, null).ok).toBe(false);
  });

  it("refuses a wrong token, including one that shares a prefix", () => {
    expect(ask(HOST, PORT, `${"a".repeat(63)}b`).ok).toBe(false);
  });

  it("refuses a valid token on a rebound Host — the attack a token cannot stop", () => {
    /* DNS rebinding makes the VICTIM'S browser issue the request, so it already
     * holds the token. Host validation is the only control that fires. */
    expect(ask("evil.test").ok).toBe(false);
    expect(ask(`evil.test:${PORT}`).ok).toBe(false);
  });

  it("refuses a SUFFIX or PREFIX of the identity, not only an unrelated name", () => {
    /* The rule the ruling names twice: "Do NOT weaken this to suffix matching or
     * includes(\"127.0.0.1\")". Every one of these contains the literal. */
    for (const host of [
      `127.0.0.1.evil.test:${PORT}`,
      `evil127.0.0.1:${PORT}`,
      `x.127.0.0.1:${PORT}`,
      `127.0.0.1-evil.test:${PORT}`
    ]) {
      expect(ask(host).ok, `${host} must be refused`).toBe(false);
    }
  });

  it("refuses 0.0.0.0, a LAN address and every other alternate route to this machine", () => {
    for (const host of [`0.0.0.0:${PORT}`, `192.168.1.10:${PORT}`, `10.0.0.5:${PORT}`,
      `localhost:${PORT}`, `[::1]:${PORT}`, `127.0.0.2:${PORT}`]) {
      expect(ask(host).ok, `${host} must be refused against an identity of ${IDENTITY}`).toBe(false);
    }
  });

  it("refuses a malformed authority rather than repairing it", () => {
    for (const host of [`evil.test@127.0.0.1:${PORT}`, "127.0.0.1:", "127.0.0.1/x", null]) {
      expect(ask(host).ok, `${JSON.stringify(host)} must be refused`).toBe(false);
    }
  });

  it("refuses a Host that differs only in port, because that is another listener", () => {
    expect(ask(`${IDENTITY}:${PORT + 1}`).ok).toBe(false);
    /* An omitted port means 80 on the wire, and this listener is not on 80. */
    expect(ask(IDENTITY).ok).toBe(false);
  });

  it("still enforces hostname and token when the real port is UNKNOWN, and does not fall open", () => {
    /*
     * The documented minimum. `null` is what a process that could not establish
     * its own listening port reports; the port comparison is skipped and
     * nothing else is.
     */
    expect(ask(HOST, null).ok).toBe(true);
    expect(ask(`${IDENTITY}:59999`, null).ok).toBe(true);
    expect(ask("evil.test", null).ok).toBe(false);
    expect(ask(HOST, null, null).ok).toBe(false);
    expect(ask(HOST, null, "wrong").ok).toBe(false);
  });

  it("refuses everything when the environment itself fails the bind check", () => {
    /*
     * PW-0105 requirement A, enforced at the request boundary because it cannot
     * be enforced before the bind. A 20-character token is refused here even
     * though the caller presents it exactly.
     */
    const unsafe = readSidecarEnvironment({
      [SIDECAR_TOKEN_VAR]: "short-token",
      [SIDECAR_HOST_VAR]: IDENTITY,
      HOSTNAME: IDENTITY
    });
    expect(
      authorizeRequest(unsafe, { presentedToken: "short-token", host: HOST }, PORT).ok
    ).toBe(false);

    const laxIdentity = readSidecarEnvironment({
      [SIDECAR_TOKEN_VAR]: TOKEN,
      [SIDECAR_HOST_VAR]: "localhost",
      HOSTNAME: IDENTITY
    });
    expect(
      authorizeRequest(laxIdentity, { presentedToken: TOKEN, host: `localhost:${PORT}` }, PORT).ok
    ).toBe(false);
  });

  it("gives the SAME refusal for every failure, so the wire is not an oracle", () => {
    const refusals = [
      ask(HOST, PORT, null),
      ask(HOST, PORT, "wrong"),
      ask("evil.test"),
      ask(`${IDENTITY}:${PORT + 1}`),
      ask(`evil.test@${IDENTITY}:${PORT}`),
      ask(null)
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
