/* -------------------------------------------------------------------------
 * The desktop listener boundary (PW-0101; docs/DESKTOP_PLAYBACK.md §7).
 *
 * WHAT THIS OWNS, AND WHAT IT DELIBERATELY DOES NOT. This module answers ONE
 * question: may this process talk to the sidecar at all. It does NOT answer
 * "may this caller perform this operation" — that is route and profile
 * authorization, it is PW-0402, and conflating the two would mean every process
 * on the user's PC, and every page the webview ever loads, holds full authority
 * over every profile the moment it learns one machine-wide secret. gpt-architect
 * ruled the separation explicitly and this file is one half of it.
 *
 * WHY A LOOPBACK LISTENER NEEDS A GUARD AT ALL. "It is only on 127.0.0.1" is the
 * assumption that makes a local listener a privilege-escalation surface. Two
 * attacks defeat it and each needs a different control:
 *
 *   - ANY LOCAL PROCESS can connect to a loopback port. There is no OS boundary
 *     between a browser tab's helper, a game launcher and this server. The
 *     control is the per-launch bearer token: a secret the shell generated this
 *     run and handed to the sidecar through the environment.
 *   - DNS REBINDING defeats the token by making the VICTIM'S OWN BROWSER issue
 *     the request from a page that already holds it. A token cannot help; the
 *     control is Host-header validation against the exact expected literal, so
 *     a request arriving as `Host: evil.test` is refused however it was routed.
 *
 * Both, or neither is worth having.
 *
 * PURE. Every function here takes what it needs and returns a decision. Nothing
 * reads `process`, nothing reads a clock, nothing throws for control flow. The
 * one place that touches the environment is `readSidecarEnvironment`, which is
 * the composition root's job to call — the same split `server-bootstrap.ts`
 * already uses, and the reason this module is unit-testable without a server.
 * ---------------------------------------------------------------------- */

/**
 * The variables the shell sets. Named here once so the shell, the sidecar and
 * the tests cannot drift into three spellings.
 */
export const SIDECAR_TOKEN_VAR = "LIBERTY_SIDECAR_TOKEN";
export const SIDECAR_HOST_VAR = "LIBERTY_SIDECAR_HOST";
export const NODE_HOSTNAME_VAR = "HOSTNAME";
export const NODE_PORT_VAR = "PORT";

/** The header the shell presents. Not `Authorization`: see `authorizeRequest`. */
export const SIDECAR_TOKEN_HEADER = "x-liberty-sidecar-token";

/** Minimum entropy, in bytes, for a per-launch token. 32 bytes = 256 bits. */
export const SIDECAR_TOKEN_MIN_BYTES = 32;
/** A hex-encoded 256-bit token is 64 characters. Shorter is refused outright. */
export const SIDECAR_TOKEN_MIN_CHARS = SIDECAR_TOKEN_MIN_BYTES * 2;

/** The only addresses a sidecar may bind. Not a preference; a refusal list's inverse. */
export const LOOPBACK_HOSTS: readonly string[] = ["127.0.0.1", "::1", "localhost"];

/**
 * The only values that may be a sidecar's IDENTITY, which is a narrower thing
 * than the addresses it may bind.
 *
 * WHY THE TWO LISTS DIFFER, since a reader will otherwise assume one of them is
 * a mistake. `HOSTNAME` is consumed by Next and decides which interface the
 * socket lands on; `localhost` there still produces a loopback bind, and that
 * check is about reachability. `LIBERTY_SIDECAR_HOST` is consumed by
 * `authorizeRequest` and is the literal every incoming `Host` is compared
 * against -- it is the whole of the DNS-rebinding defence. A NAME cannot play
 * that role, because a name is exactly what the attacker supplies: rebinding is
 * the act of pointing a name at 127.0.0.1. So the identity must be an address.
 *
 * A deployment that states a name is refused AT STARTUP with a diagnostic rather
 * than left to refuse every request at runtime, which is the difference between
 * a configuration error and a mystery.
 */
export const LOOPBACK_HOST_LITERALS: readonly string[] = ["127.0.0.1", "::1"];

export interface SidecarEnvironment {
  readonly token: string | null;
  readonly expectedHost: string | null;
  readonly bindHostname: string | null;
}

/**
 * The environment, read once, at the composition root.
 *
 * `Object.hasOwn` rather than truthiness: an empty string is a deliberate value
 * elsewhere in this repository (`DATABASE_URL: ""` in the e2e harness means "no
 * database", not "unset") and reading it as absent here would let an empty token
 * disarm the guard.
 */
export function readSidecarEnvironment(
  env: Readonly<Record<string, string | undefined>>
): SidecarEnvironment {
  const read = (name: string): string | null =>
    Object.hasOwn(env, name) ? (env[name] ?? "") : null;
  return {
    token: read(SIDECAR_TOKEN_VAR),
    expectedHost: read(SIDECAR_HOST_VAR),
    bindHostname: read(NODE_HOSTNAME_VAR)
  };
}

/**
 * ARMED BY THE PRESENCE OF A TOKEN, and by nothing else.
 *
 * Not by a build target: `build-target.test.ts` forbids any module under
 * `apps/web/src` from naming `LIBERTY_BUILD_TARGET`, and it is right to —
 * docs/DESKTOP_PLAYBACK.md §8 requires the target be a compile-time fact with no
 * runtime switch. So the sidecar decides it is a sidecar because the shell gave
 * it a secret, which is a fact about how it was launched rather than about how
 * it was built. A hosted web deployment sets no token and is unaffected.
 */
export function isSidecarMode(environment: SidecarEnvironment): boolean {
  return environment.token !== null;
}

export type BindRefusalCode =
  | "token_too_short"
  | "host_not_stated"
  | "host_not_loopback_literal"
  | "bind_not_loopback";

export type BindDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: BindRefusalCode; readonly detail: string };

/**
 * Whether this process is safe to start as a sidecar. Checked BEFORE the
 * listener exists, because every control below is worthless on a socket that is
 * already accepting connections from the LAN.
 *
 * THE HOSTNAME CHECK IS THE ONE THAT MATTERS AND IT IS EASY TO MISS. Next reads
 * `HOSTNAME` from the environment, and `next start` binds `0.0.0.0` when it is
 * unset. A sidecar inheriting a container's `HOSTNAME`, or launched by a shell
 * that forgot to set it, would therefore serve the whole network — with a valid
 * token that the user's own browser holds. So an absent value is refused here
 * rather than defaulted: the shell must state it.
 */
export function checkBindSafety(environment: SidecarEnvironment): BindDecision {
  const token = environment.token ?? "";
  if (token.length < SIDECAR_TOKEN_MIN_CHARS) {
    return {
      ok: false,
      code: "token_too_short",
      /* The LENGTH is reported, never the value. */
      detail: `${SIDECAR_TOKEN_VAR} is ${token.length} characters; at least ${SIDECAR_TOKEN_MIN_CHARS} are required (${SIDECAR_TOKEN_MIN_BYTES} bytes of CSPRNG output, hex-encoded)`
    };
  }
  if (environment.expectedHost === null || environment.expectedHost === "") {
    return {
      ok: false,
      code: "host_not_stated",
      detail: `${SIDECAR_HOST_VAR} must name the loopback address this sidecar answers as (${LOOPBACK_HOST_LITERALS.join(" or ")}), without a port -- the kernel chooses the port and the handshake reports it; a bearer token does not stop DNS rebinding`
    };
  }
  if (!LOOPBACK_HOST_LITERALS.includes(environment.expectedHost.toLowerCase())) {
    return {
      ok: false,
      code: "host_not_loopback_literal",
      detail: `${SIDECAR_HOST_VAR} is ${JSON.stringify(environment.expectedHost)}; it must be a literal loopback address (${LOOPBACK_HOST_LITERALS.join(" or ")}) because it is the value every incoming Host header is compared against, and a name is what a rebinding attacker supplies`
    };
  }
  const bind = environment.bindHostname;
  if (bind === null || !LOOPBACK_HOSTS.includes(bind)) {
    return {
      ok: false,
      code: "bind_not_loopback",
      detail:
        bind === null
          ? `${NODE_HOSTNAME_VAR} is unset, and an unset HOSTNAME makes Next bind 0.0.0.0 — a sidecar must state 127.0.0.1`
          : `${NODE_HOSTNAME_VAR} is ${JSON.stringify(bind)}, which is not a loopback address`
    };
  }
  return { ok: true };
}

/**
 * Constant-time string comparison.
 *
 * `===` on a secret leaks its prefix through timing. `node:crypto`'s
 * `timingSafeEqual` is the right primitive and is deliberately NOT used here:
 * it throws on unequal lengths, which reintroduces the leak as an exception, and
 * this module is pure by design. Comparing over the longer of the two lengths
 * keeps the work independent of where the first difference falls.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const length = Math.max(a.length, b.length);
  let difference = a.length ^ b.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return difference === 0;
}

/**
 * The `Host` header, taken apart safely.
 *
 * WHY A PARSER AND NOT A COMPARISON. The previous guard compared the raw header
 * to a configured literal that included a port. It could not survive PW-0101's
 * own contract -- the kernel chooses the port, so no value the shell computes
 * before spawning the child can contain it -- and gpt-architect's round-95
 * ruling resolved that by making `LIBERTY_SIDECAR_HOST` the expected HOSTNAME
 * rather than a precomputed `<host>:<unknown-port>` authority. Comparing a
 * hostname means extracting one, and extracting one from an attacker-controlled
 * header is the kind of parsing that is wrong by default.
 *
 * SO THIS REFUSES RATHER THAN REPAIRS. Every shape below returns `null`; none is
 * normalised into something acceptable:
 *
 *   - userinfo (`evil.test@127.0.0.1`) -- the oldest authority-confusion trick,
 *     and the one a naive "does it contain 127.0.0.1" check falls to.
 *   - anything carrying a delimiter that belongs to a URL rather than an
 *     authority (`/`, `?`, `#`, `\`), whitespace, or a control character.
 *   - an unbracketed authority with more than one colon, because `::1:80` has no
 *     unambiguous reading and guessing one is how two parsers come to disagree.
 *   - a port that is not a bare decimal in 1..65535. Leading zeros are refused
 *     rather than accepted, because `:080` and `:80` reading the same in one
 *     parser and differently in another is precisely the disagreement that makes
 *     a smuggled authority useful.
 *   - a trailing dot (`localhost.`), which is a distinct FQDN spelling of the
 *     same name and therefore a free suffix bypass of an exact comparison.
 *   - an IPv6 zone identifier (`[fe80::1%eth0]`), which names an interface and
 *     has no business reaching a loopback listener.
 *
 * The hostname is lower-cased because host names are case-insensitive on the
 * wire and an exact comparison against a lower-case literal would otherwise be
 * bypassed by `Host: 127.0.0.1` in different case -- for a name, not an address.
 * Nothing else is rewritten.
 */
export interface ParsedHost {
  /** Lower-cased, brackets removed. Never empty. */
  readonly hostname: string;
  /** The stated port, or `null` when the authority stated none. */
  readonly port: number | null;
}

const FORBIDDEN_IN_AUTHORITY = /[\s/?#\\@\u0000-\u001f\u007f]/;

function parsePort(raw: string): number | null {
  if (raw.length === 0 || raw.length > 5) return null;
  if (!/^[0-9]+$/.test(raw)) return null;
  if (raw.length > 1 && raw.startsWith("0")) return null;
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

export function parseHostHeader(raw: string | null): ParsedHost | null {
  if (raw === null) return null;
  /* No trim. A header the peer padded is a header this process should not be
   * repairing on the peer's behalf. */
  if (raw === "" || raw !== raw.trim()) return null;
  if (FORBIDDEN_IN_AUTHORITY.test(raw)) return null;

  let hostname: string;
  let portText: string | null;

  if (raw.startsWith("[")) {
    const close = raw.indexOf("]");
    if (close < 0) return null;
    hostname = raw.slice(1, close);
    const rest = raw.slice(close + 1);
    if (rest === "") portText = null;
    else if (rest.startsWith(":")) portText = rest.slice(1);
    else return null;
    /* An IP-literal must look like one. Hex, colons, dots (for the IPv4-mapped
     * form) and nothing else -- in particular no `%` zone id. */
    if (hostname === "" || !/^[0-9a-fA-F:.]+$/.test(hostname)) return null;
    if (!hostname.includes(":")) return null;
  } else {
    const colon = raw.indexOf(":");
    if (colon < 0) {
      hostname = raw;
      portText = null;
    } else {
      /* Unbracketed, so at most one colon may appear and it introduces the
       * port. `::1` unbracketed is malformed per RFC 3986 and is refused here
       * rather than guessed at. */
      if (raw.indexOf(":", colon + 1) >= 0) return null;
      hostname = raw.slice(0, colon);
      portText = raw.slice(colon + 1);
    }
    if (hostname === "" || hostname.endsWith(".")) return null;
    if (!/^[0-9a-zA-Z._-]+$/.test(hostname)) return null;
  }

  if (portText === null) return { hostname: hostname.toLowerCase(), port: null };
  const port = parsePort(portText);
  if (port === null) return null;
  return { hostname: hostname.toLowerCase(), port };
}

export type RequestRefusalCode = "sidecar_request_refused";

export type RequestDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: RequestRefusalCode; readonly detail: string };

export interface IncomingRequestFacts {
  /** The value of `x-liberty-sidecar-token`, or `null` when absent. */
  readonly presentedToken: string | null;
  /** The `Host` header exactly as received, or `null`. */
  readonly host: string | null;
}

/**
 * May this request be served.
 *
 * THREE CONTROLS, ALL OF THEM REQUIRED: the per-launch bearer token, an exact
 * hostname match against the configured loopback literal, and -- when the real
 * listening port is available -- the port. See `parseHostHeader` for why the
 * second one needs a parser.
 *
 * ONE REFUSAL CODE AND ONE MESSAGE, WHATEVER FAILED. A refusal that distinguished
 * "no token" from "wrong token" from "wrong Host" would be an oracle: an
 * attacker could discover which control it had already satisfied and attack the
 * remaining one in isolation. The operator learns which control fired from the
 * server's own log, not from the wire.
 *
 * Not `Authorization: Bearer`, deliberately. That header is where a USER's
 * credential belongs, and PW-0402 puts one there. Two different authorities in
 * one header is how a launch token comes to be accepted as a login — the exact
 * confusion gpt-architect's ruling separates these tasks to prevent.
 */
/** The port a browser omits from `Host`. A sidecar never listens here. */
export const IMPLIED_HTTP_PORT = 80;

/**
 * @param listeningPort the port the process is ACTUALLY listening on, or `null`
 * when it could not be established. It is a parameter rather than something
 * this module reads, because this module reads nothing; `lib/sidecar/listener.ts`
 * establishes it from the live server and `proxy.ts` passes it in. It is
 * REQUIRED rather than defaulted so that a call site which cannot supply it has
 * to say so in its own source, instead of a defaulted `null` quietly turning the
 * port comparison off wherever somebody forgot -- the silent downgrade
 * gpt-architect's round-95 ruling forbids by name.
 */
export function authorizeRequest(
  environment: SidecarEnvironment,
  request: IncomingRequestFacts,
  listeningPort: number | null
): RequestDecision {
  const refused: RequestDecision = {
    ok: false,
    code: "sidecar_request_refused",
    detail: "this request was not accepted by the local listener"
  };
  if (!isSidecarMode(environment)) return { ok: true };

  /*
   * THE BIND VERDICT IS ENFORCED HERE TOO, and this is not belt-and-braces.
   *
   * Requirement A wants `checkBindSafety` to run before the listener is
   * externally usable. It cannot, in this process: Next's generated entry calls
   * `listen()` and only afterwards awaits `instrumentation.register()` --
   * measured, not assumed. So the startup path refuses and exits non-zero, and
   * THIS closes the window between the bind and the exit. Without it a sidecar
   * launched with a 20-character token would accept every request that
   * presented that token during the milliseconds before the process died.
   */
  if (!checkBindSafety(environment).ok) return refused;

  const expectedToken = environment.token ?? "";
  const presented = request.presentedToken;
  if (presented === null) return refused;
  if (!constantTimeEquals(expectedToken, presented)) return refused;

  /* Established by `checkBindSafety` above; re-read rather than assumed. */
  const expectedHostname = (environment.expectedHost ?? "").toLowerCase();
  if (!LOOPBACK_HOST_LITERALS.includes(expectedHostname)) return refused;

  const parsed = parseHostHeader(request.host);
  if (parsed === null) return refused;

  /*
   * HOSTNAME-EXACT. Not a suffix match, not `includes("127.0.0.1")`, not a
   * parsed URL's `hostname` with a library's normalisation rules in between.
   * `127.0.0.1.evil.test`, `evil.test`, `0.0.0.0`, a LAN address and every
   * other name that resolves to this machine differ from the configured
   * literal, and differing is the whole test.
   */
  if (parsed.hostname !== expectedHostname) return refused;

  /*
   * AND THE PORT, WHEN THE PORT IS A FACT.
   *
   * `listeningPort` comes from the live server, never from `PORT` -- a
   * pre-spawn environment guess is exactly what the ruling excludes, and under
   * `PORT=0` it would be the number zero. When it is known, a request
   * addressed to some other listener on this machine is refused even though it
   * arrived here; when it is not, the hostname match plus the per-launch token
   * is the documented minimum and the guard does not fall open.
   */
  if (listeningPort !== null && (parsed.port ?? IMPLIED_HTTP_PORT) !== listeningPort) {
    return refused;
  }

  return { ok: true };
}

/**
 * The Content-Security-Policy the application emits for itself.
 *
 * WHY THIS EXISTS AT ALL. Tauri injects a CSP when it serves bundled assets, and
 * docs/DESKTOP_PLAYBACK.md §2 records that the injection STOPS APPLYING the
 * moment the frontend is a URL rather than a bundle — which is exactly what the
 * sidecar makes it. That is a real control lost in exchange for keeping the
 * application, and nothing replaced it until now.
 *
 * `'unsafe-inline'` is present for styles and absent for scripts. Next emits
 * inline style attributes that cannot be nonced without rewriting the framework;
 * it does NOT require inline script when a nonce is supplied, and allowing one
 * would defeat the directive's only real purpose. `media-src` is left to the
 * caller because the authorized media origin is a deployment fact this module
 * must not guess.
 */
export function contentSecurityPolicy(options: {
  readonly nonce: string;
  readonly mediaOrigins: readonly string[];
  readonly connectOrigins: readonly string[];
}): string {
  const media = ["'self'", "blob:", ...options.mediaOrigins].join(" ");
  const connect = ["'self'", ...options.connectOrigins].join(" ");
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${options.nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    `media-src ${media}`,
    `connect-src ${connect}`,
    "worker-src 'self' blob:",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests"
  ].join("; ");
}
