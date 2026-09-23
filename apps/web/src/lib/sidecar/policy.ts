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
      detail: `${SIDECAR_HOST_VAR} must name the exact Host this sidecar will answer to; a bearer token does not stop DNS rebinding`
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
export function authorizeRequest(
  environment: SidecarEnvironment,
  request: IncomingRequestFacts
): RequestDecision {
  const refused: RequestDecision = {
    ok: false,
    code: "sidecar_request_refused",
    detail: "this request was not accepted by the local listener"
  };
  if (!isSidecarMode(environment)) return { ok: true };

  const expectedToken = environment.token ?? "";
  const presented = request.presentedToken;
  if (presented === null) return refused;
  if (!constantTimeEquals(expectedToken, presented)) return refused;

  const expectedHost = environment.expectedHost;
  if (expectedHost === null || expectedHost === "") return refused;
  /* EXACT literal. Not a suffix match, not a parsed hostname with the port
   * dropped: `127.0.0.1:3000` and `127.0.0.1:3001` are different listeners and a
   * comparison that ignored the port would accept a request meant for another. */
  if (request.host !== expectedHost) return refused;

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
