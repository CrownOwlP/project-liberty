/**
 * Outbound URL policy (PL-0301).
 *
 * Every URL this package is about to hand to `fetch`, or about to publish as a
 * playable candidate, passes through here first -- the operator's configured
 * manifest URL, every redirect target, and every stream URL an addon returns.
 * The addon is a third party on the network; its response is attacker-shaped
 * input in exactly the same sense a request body is.
 *
 * The threat is SSRF. Project Liberty resolves playback SERVER-side, so an
 * addon that returns `http://169.254.169.254/latest/meta-data/iam/...` is asking
 * our server to fetch cloud instance credentials and hand the body back to a
 * client, and one that returns `http://10.0.0.5:9200/_search` is asking it to
 * read an internal service. Neither request is unusual-looking at the fetch
 * layer; the only place they can be stopped is a policy that runs before the
 * socket is opened.
 *
 * The rules, and why each one exists:
 *
 *   1. `https:` only, with `http:` allowed ONLY for a loopback host. Plaintext
 *      to a remote host is both a transport problem and the shape almost every
 *      internal-service pivot takes, since internal services rarely speak TLS.
 *      A local media server on `http://127.0.0.1:8096` is a legitimate,
 *      operator-chosen source and is not on any network, so it is exempt.
 *      Every other scheme -- `magnet:`, `file:`, `data:`, `ftp:`, `ws:` -- is
 *      rejected here as well as at the mapping layer.
 *
 *   2. Loopback requires TWO independent permissions, never either one alone:
 *      the SOURCE opted in, AND this Project Liberty instance is running as a
 *      local/development deployment. The host must also be a literal loopback
 *      address, never a DNS name we hope resolves to one. See the check itself
 *      for why the source's opt-in is not sufficient on its own.
 *
 *   3. Private, link-local, CGNAT, multicast and reserved ranges are rejected
 *      unconditionally -- including when loopback is permitted. Allowing a local
 *      library addon is a statement about THIS machine, not about the operator's
 *      LAN or their cloud VPC.
 *
 *   4. Embedded credentials are rejected. `https://addon.example.com@evil.test/`
 *      is a host of `evil.test`, and userinfo is the oldest way to make a URL
 *      read as one origin to a human reviewer and resolve as another.
 *
 * KNOWN RESIDUAL RISK, deliberately not solved here: this validates the host
 * LITERAL, not the address the host resolves to. A public name with an A record
 * of 10.0.0.5, or a name that answers differently between the check and the
 * connect (DNS rebinding), still passes. Closing that requires resolving the
 * name ourselves and pinning the connection to the resolved address, which the
 * WHATWG `fetch` API gives no hook for -- it needs a custom dispatcher/agent.
 *
 * Documenting the limitation rather than closing it is acceptable ONLY while
 * this is what it is today: a controlled adapter pointed at a small set of
 * operator-fixed endpoints, where the set of names ever passed to `fetch` is
 * known at configuration time and can be reviewed by a human. The moment this
 * becomes the general server-side client for arbitrary operator- or
 * user-configured addons, host-string checks are no longer a control at all --
 * an attacker chooses the name, so checking the name proves nothing -- and
 * resolve-and-pin has to land BEFORE that ships to production, not as a later
 * hardening pass. It is recorded here rather than left as an unstated
 * assumption, because the check below looks complete enough to be mistaken for
 * one.
 *
 * THE DEFERRAL IS CLOSED (PL-0710, second half), and the paragraph that used to
 * sit here saying "this adapter has not adopted it" is gone because it is no
 * longer true. `http.ts` -- the only place this package opens a connection --
 * now runs `checkUrl` below AND `@liberty/media-inspection`'s
 * `authoriseResolvedTarget`: the name is resolved before the connection, every
 * returned address is classified, any disallowed answer refuses the target, and
 * the surviving addresses travel to the transport inside a `PinnedTarget` so no
 * second resolution can choose the destination. Every redirect hop repeats all
 * of it.
 *
 * WHICH MEANS THIS FILE'S OWN LIMITATION IS UNCHANGED AND NO LONGER MATTERS ON
 * ITS OWN, and both halves of that are worth stating. `checkUrl` is still a pure
 * host-literal gate; it still cannot see that `cdn.example.test` has an A record
 * of 10.0.0.5, and nothing here should try to, because a gate that resolved
 * would be a second resolution and a second SSRF control. What changed is that
 * it is no longer the LAST word: it is the first of two halves, it decides the
 * things that are decidable without a resolver -- scheme, credentials, host
 * class, plaintext, and the two-key loopback rule -- and the half that classifies
 * a real resolver answer runs immediately after it and is shared with the other
 * package rather than copied into this one. docs/SECURITY.md records the change
 * against R1.
 *
 * WHERE THE CLASSIFIER WENT (PL-0710, first half). `classifyHost` and every
 * range table, address expander and canonicaliser behind it used to be declared
 * in this file. They are now `@liberty/net-policy`'s, and this module RE-EXPORTS
 * the shared function so that no consumer's import path changed.
 *
 * The move is not tidying. `@liberty/media-inspection` needed this exact
 * function and could not import it: this package publishes a bare
 * `./src/index.ts` exports field with no subpaths, so PL-0709's agreement test
 * had to reach in by deep relative path -- accepted by the reviewer for that one
 * test at that one tree and ruled not an acceptable permanent boundary. Making
 * either package depend on the other would create or invite a workspace cycle,
 * because PL-0710's second half points the arrow the other way. A dependency
 * leaf that neither package can import back is the shape that works.
 *
 * AND THE ARGUMENT FOR THE EXTRACTION IS THE SAME ONE THAT ARGUES FOR
 * RESOLVE-AND-PIN. Three defects of ONE SHAPE were found in the classifier while
 * it lived here: an unbracketed IPv6 literal classified as public (F1), a
 * trailing DNS root label defeating every name comparison at once (F7), and an
 * IPv4 address wearing a translation prefix the zero-prefix test did not match
 * (F8). Each was a host SPELLING the comparisons did not anticipate, each read
 * as `"public"`, and each was invisible to a reading pass -- all three were found
 * by running a differential probe over hostile spellings. That is evidence about
 * the technique, not about any one branch: a check that compares a string
 * against literals is only ever as complete as the list of spellings whoever
 * wrote it happened to think of. One copy of such a check is the least bad
 * number, and until PL-0710 there were three. See
 * docs/SECURITY_REVIEW_PROVIDER_URL.md for the register and the method.
 */

/*
 * THE SHARED CLASSIFIER, RE-EXPORTED RATHER THAN RESTATED.
 *
 * `stremio/index.ts` and this package's root barrel both publish `classifyHost`
 * and `HostClass`, and `apps/web` imports `classifyHost` from
 * `@liberty/provider-sdk` to decide whether a fixture origin is loopback. None
 * of those import paths changed, and none of them should have: the function
 * moved, the surface did not.
 *
 * It is a re-export and not a wrapper on purpose. A wrapper -- even a one-line
 * one -- would be a second function object, which is the thing
 * `net-policy-boundary.test.ts` asserts against by identity. A copy passes every
 * behavioural test anybody writes.
 */
import { classifyHost, type HostClass } from "@liberty/net-policy/classify";

export { classifyHost };
export type { HostClass };

/**
 * Rejection reasons carry the `url_` prefix so they can be surfaced verbatim in
 * a candidate's reason trail without translation. A reason that gets rewritten
 * on the way out is a reason that eventually stops matching what the code did.
 */
export type UrlRejectionReason =
  | "url_unparseable"
  | "url_scheme_not_http"
  | "url_credentials_present"
  | "url_host_missing"
  | "url_host_unparseable"
  | "url_plaintext_http_not_loopback"
  | "url_loopback_not_permitted"
  | "url_loopback_not_local_deployment"
  | "url_private_address";

export interface UrlPolicyOptions {
  /**
   * Whether this SOURCE is allowed to address the machine Liberty runs on.
   * Defaults to false everywhere it is derived from configuration: a source that
   * did not say it was local is not local. Necessary for loopback; not
   * sufficient -- see `localDeployment`.
   */
  readonly allowLoopback: boolean;
  /**
   * Whether this INSTANCE of Project Liberty is a local or development
   * deployment rather than a hosted one.
   *
   * A property of the running deployment, not of a source, and deliberately not
   * readable from source configuration: if the config file could set it, it
   * would be the same switch as `allowLoopback` wearing a second name. It is
   * threaded in from the process boundary, and defaults to false everywhere it
   * is not stated, so an instance that never says it is local is treated as
   * hosted.
   */
  readonly localDeployment: boolean;
}

export type UrlCheckResult =
  | { readonly ok: true; readonly url: URL; readonly hostClass: HostClass }
  | { readonly ok: false; readonly reason: UrlRejectionReason; readonly detail: string };

/*
 * EVERYTHING THAT DECIDED WHAT A HOST IS USED TO BE HERE.
 *
 * `PRIVATE_HOST_SUFFIXES`, `isLoopbackName`, `parseIPv4`, `classifyIPv4`,
 * `expandIPv6`, `classifyIPv6`, `embeddedIPv4`, `classifyHost` and
 * `withoutRootLabel` were all declared between this line and `checkUrl` below.
 * They are now in `@liberty/net-policy` -- `./classify` for the ranges, `./host`
 * for the spelling -- and are imported at the top of this file.
 *
 * Nothing about the BEHAVIOUR changed in the move, and that is a requirement
 * rather than an observation: F1, F7 and F8 are approved fixes and
 * `url-policy.test.ts` still drives every one of them through `checkUrl` and
 * through the re-exported `classifyHost`, from this package, unchanged.
 *
 * What did change is that there is now one implementation instead of three.
 * `@liberty/media-inspection` had a character-for-character copy of
 * `withoutRootLabel` in `egress.ts` (PL-0709 wrote it, named the duplication,
 * and pinned it with an agreement test because there was no shared home to put
 * it in) and a third, subtly different canonicaliser in `pin.ts` that did not
 * fold the root label at all.
 */

/**
 * The scheme of a string that did NOT parse, or the fact that it has none.
 *
 * Everything after the scheme is discarded. A `detail` here reaches a candidate's
 * reason trail verbatim through `mapping.ts`, and unlike every other branch of
 * `checkUrl` this one has no parsed URL to reduce -- so echoing the input meant
 * echoing up to 120 characters of addon-authored string, query included. Both
 * strings this function is ever handed can be chosen by an addon: a stream URL,
 * where `//cdn.example.test/f.mp4?token=...` is protocol-relative and so is
 * refused outright by `new URL()`, and a `Location:` header, which resolves
 * against its base and therefore reaches this branch less often but reaches it
 * with `http.ts` waiting to re-report it as a rejected redirect target.
 *
 * The scheme is the one part that can be named safely: RFC 3986 bounds its
 * charset, and telling "the operator typed a relative path" apart from "the
 * addon offered `http://` with no host" is the whole diagnostic value of the
 * message. It is length-capped as well, because a bounded charset does not stop
 * anyone encoding a token in a very long scheme-shaped prefix. The character
 * count replaces the string itself: it distinguishes an empty config field from
 * a mangled URL without reproducing either.
 */
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*(?=:)/i;

function describeUnparseable(raw: string): string {
  const scheme = SCHEME_PATTERN.exec(raw)?.[0];
  const named = scheme === undefined ? "(no scheme)" : `scheme ${truncate(scheme, 16)}:`;
  return `${named}, ${raw.length} characters`;
}

/**
 * The single gate. Pure: no DNS, no sockets, no clock.
 *
 * `base` lets a relative `Location:` header be resolved against the URL that
 * produced it, so redirect targets go through exactly the same checks as the
 * original -- validating only the first URL of a redirect chain is the classic
 * way an SSRF filter is bypassed.
 */
export function checkUrl(raw: string, options: UrlPolicyOptions, base?: string): UrlCheckResult {
  let url: URL;
  try {
    url = base === undefined ? new URL(raw) : new URL(raw, base);
  } catch {
    return {
      ok: false,
      reason: "url_unparseable",
      detail: `not an absolute URL: ${describeUnparseable(raw)}`
    };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return {
      ok: false,
      reason: "url_scheme_not_http",
      detail: `scheme ${url.protocol} is not fetchable by this adapter`
    };
  }

  if (url.username !== "" || url.password !== "") {
    return {
      ok: false,
      reason: "url_credentials_present",
      detail: "URL carries embedded credentials"
    };
  }

  if (url.hostname === "") {
    return { ok: false, reason: "url_host_missing", detail: "URL has no host" };
  }

  const hostClass = classifyHost(url.hostname);

  /*
   * The host is CAPPED everywhere it is named below.
   *
   * `detail` is copied verbatim into a candidate's reason trail by `mapping.ts`,
   * and on a stream URL the host is chosen by the addon. The WHATWG URL parser
   * enforces no length limit on a hostname -- the 253-byte DNS bound is a
   * resolver rule, not a parsing one -- so `https://<128KiB>.local/` parses,
   * fails the private-suffix check, and used to write all 128 KiB of it into
   * every log line and response that carries the trail. A host cannot hold a
   * signed query string, so this is a flooding problem rather than a secret
   * one, but 64 characters is enough to identify a host to a human and the
   * remainder was never diagnostic. Matches what `@liberty/media-inspection`
   * already does with the same five messages, so the two SSRF gates cannot
   * disagree about how much of a hostile host they repeat.
   */
  const host = truncate(url.hostname, 64);

  if (hostClass === "unparseable") {
    return {
      ok: false,
      reason: "url_host_unparseable",
      detail: `host ${host} is neither a valid name nor a valid address`
    };
  }

  if (hostClass === "private") {
    return {
      ok: false,
      reason: "url_private_address",
      detail: `host ${host} is in a private, link-local or reserved range`
    };
  }

  if (hostClass === "loopback") {
    /*
     * TWO conditions, both required, neither sufficient.
     *
     * `allowLoopback` alone used to open loopback, and that is wrong in the one
     * deployment that matters most. On a hosted Project Liberty instance,
     * 127.0.0.1 is the Liberty SERVER -- its admin endpoints, its metrics port,
     * its database bound to localhost, its sidecars. A source config saying "I
     * am a local addon" is a claim about the operator's laptop; honouring it in
     * a hosted process turns this package into a general request-forgery
     * capability aimed at ourselves, reachable by whoever can add or edit a
     * source (and, through redirects, by any addon that source talks to). The
     * private-address rules above deliberately do not save us here, because
     * loopback is exactly the class they exempt.
     *
     * So the deployment must ALSO say it is local. The two facts have different
     * owners -- a source config file and the process environment -- and
     * requiring both means neither owner can grant loopback by themselves.
     *
     * The source's opt-in is checked first so the reasons stay distinct and each
     * one names the thing to fix: "this source is not declared local" is a
     * config error, "this instance is not a local deployment" is a statement
     * that no config change can satisfy in production.
     */
    if (!options.allowLoopback) {
      return {
        ok: false,
        reason: "url_loopback_not_permitted",
        detail: `host ${host} is loopback and this source is not configured as local`
      };
    }
    if (!options.localDeployment) {
      return {
        ok: false,
        reason: "url_loopback_not_local_deployment",
        detail:
          `host ${host} is loopback and this instance is not a local deployment; ` +
          "a source opt-in alone never makes this machine reachable"
      };
    }
    return { ok: true, url, hostClass };
  }

  if (url.protocol === "http:") {
    return {
      ok: false,
      reason: "url_plaintext_http_not_loopback",
      detail: `plaintext http is only permitted for loopback, not ${host}`
    };
  }

  return { ok: true, url, hostClass };
}

/** Keeps a hostile URL from turning a log line or an error message into a wall. */
export function truncate(value: string, max = 120): string {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}
