/* -------------------------------------------------------------------------
 * The one place a URL or a path is allowed to become loggable
 *
 * `docs/RESEARCH_PLAYBACK.md` names two instances of the same leak through
 * different pipes: the CMCD `url` and `nor` keys carry media URLs including
 * signed query strings into telemetry, and ffprobe's `format.filename` carries
 * the user's filesystem into media inspection. The research asks for one shared
 * helper rather than two, so this module is it and neither caller writes its
 * own.
 *
 * WHY STRIPPING RATHER THAN HASHING. The research allows either. Stripping is
 * chosen because a digest is a claim that invites trust it cannot support: a
 * digest of a HIGH-entropy signed URL is genuinely one-way, but a digest of
 * `https://cdn/movies/the-northstar-affair/1080p.m3u8` is a dictionary lookup
 * away from the plaintext, and the two are indistinguishable in a log. There is
 * also nothing to correlate ACROSS with — CMCD already carries `sid` and `cid`,
 * which are non-URL identifiers designed for exactly that job. So the raw value
 * is destroyed and nothing that looks like a reversible token replaces it.
 *
 * WHAT SURVIVES, AND WHY IT IS SAFE. Scheme and host, for `http`/`https` only.
 * CDN attribution is the whole diagnostic value of these keys — "the Fastly
 * edge is slow" is actionable, "some URL was slow" is not — and a hostname is
 * not user content. Everything identifying lives in the path, the query, the
 * fragment and the userinfo, and all four are discarded before this function
 * returns. Every other scheme collapses to the marker with no host at all:
 * `data:` embeds the content itself, `blob:` and `file:` name the local
 * machine, and `javascript:` is not a URL anybody should be storing.
 *
 * These functions are pure and total. They never throw, because their callers
 * are a request-time telemetry boundary and a media probe, and neither has a
 * sensible answer to "redaction failed" other than dropping real diagnostics.
 * ---------------------------------------------------------------------- */

/**
 * The marker written in place of anything removed.
 *
 * A constant rather than an inline literal so that "does this log line contain
 * a real URL" is a search for the ABSENCE of this string, which is a check a
 * test can make over a whole payload without knowing which keys were involved.
 */
export const REDACTED = "[redacted]";

/**
 * Schemes whose host is kept. An allowlist, not a denylist: the failure mode of
 * a denylist here is a scheme nobody thought of leaking in full, and new URL
 * schemes are invented far more often than this file is edited.
 */
const HOST_BEARING_SCHEMES: ReadonlySet<string> = new Set(["http:", "https:"]);

/**
 * A scheme prefix of at least TWO characters before the colon.
 *
 * The second character is load-bearing: `D:\media\the-northstar-affair.mkv` is
 * a Windows path, not a URL with scheme `d`, and treating it as one would send
 * it down the URL branch where the extension is lost. Real schemes are longer
 * than one character, so the length requirement separates them cleanly.
 */
const SCHEME_PREFIX = /^[A-Za-z][A-Za-z0-9+.-]+:/;

/** Trailing extension, kept from a path because a container mismatch is a real bug. */
const PATH_EXTENSION = /\.([A-Za-z0-9]{1,8})$/;

/**
 * `new URL` throws on anything it does not recognise, including every relative
 * URL and the empty string. A separate function rather than an inline
 * `try`/`catch` so that the caller reads as a total function over a value.
 */
function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * Reduce a URL to scheme and host, destroying path, query, fragment and
 * userinfo.
 *
 * A RELATIVE URL collapses entirely, and that is correct rather than a
 * limitation: CMCD's `nor` key is specified as a relative URL, so its whole
 * content is the object path — the exact thing being removed.
 */
export function redactUrl(value: string): string {
  const parsed = parseUrl(value);
  if (parsed === null) return REDACTED;

  if (!HOST_BEARING_SCHEMES.has(parsed.protocol)) return REDACTED;
  // `data:` and `file:` parse successfully with an empty host, so the scheme
  // allowlist above and this check are not redundant — a future addition to the
  // allowlist would still be caught here.
  if (parsed.host === "") return REDACTED;

  // `parsed.host` excludes userinfo by construction and includes the port,
  // which is the part of the authority worth keeping. `parsed.href` is never
  // read, because reading it once is how the query string gets back in.
  return `${parsed.protocol}//${parsed.host}/${REDACTED}`;
}

/**
 * Reduce a filesystem path or a `file:`-style locator to its extension.
 *
 * ffprobe reports `format.filename` verbatim, which for a user library is a
 * directory tree, a naming scheme and often a title. None of that is
 * diagnostic. The extension is: a container that disagrees with the codec is a
 * real class of playback failure and it cannot be guessed from anything else in
 * the probe output.
 */
export function redactFilePath(value: string): string {
  if (SCHEME_PREFIX.test(value)) return redactUrl(value);

  const extension = PATH_EXTENSION.exec(value);
  return extension === null ? REDACTED : `${REDACTED}.${extension[1] ?? ""}`;
}

/**
 * Whether a string is URL-SHAPED, for values whose type does not say.
 *
 * Used for CMCD custom-key values, which the specification types as opaque
 * strings. Ours are ours, but they arrive over the wire from an untrusted
 * client, and a client that puts a signed manifest URL in a custom key
 * reproduces the leak this module exists to close through a key the registry
 * cannot classify in advance.
 */
export function looksLikeUrl(value: string): boolean {
  return SCHEME_PREFIX.test(value) || value.includes("://");
}
