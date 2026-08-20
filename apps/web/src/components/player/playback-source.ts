/* -------------------------------------------------------------------------
 * What this element is allowed to play
 *
 * THE RIGHTS BOUNDARY IS NOT HERE. `<liberty-video>` plays what an already
 * authorized playback session handed it. It does not fetch a session, it does
 * not evaluate rights, and it must never be wired to a URL that arrived from
 * the client — a `src` that a page can set to anything turns the player into an
 * open proxy for arbitrary media and quietly relocates product invariant 1 into
 * whatever code sets the attribute. The session response defined by PL-0501 is
 * the only intended producer of these values.
 *
 * What IS here is a transport backstop, and it is deliberately a backstop
 * rather than a check that means anything about rights: an `https:` URL is not
 * a licensed one. It exists because `docs/RESEARCH_PLAYBACK.md` records that
 * every manifest and segment URL must be `https:` for provider adapters to work
 * at all, and because a mixed-content or `data:`/`blob:` source reaching Shaka
 * produces a generic network error that looks identical to a dead CDN.
 * ---------------------------------------------------------------------- */

export interface PlaybackSource {
  /**
   * Absolute URL of a manifest or progressive file, produced by an authorized
   * session. Relative URLs are rejected rather than resolved against the page:
   * resolving them would make the meaning of a source depend on which route the
   * player happens to be mounted under.
   */
  readonly uri: string;
  /**
   * Passed to Shaka when the session knows it. Worth supplying: without an
   * extension or a usable `Content-Type` Shaka issues a HEAD request to guess,
   * and fails with `UNABLE_TO_GUESS_MANIFEST_TYPE` if the origin rejects it.
   */
  readonly mimeType?: string | undefined;
  /** Seconds, matching Shaka's `load()`. `null` means "engine default". */
  readonly startTimeSeconds?: number | null | undefined;
}

export type SourceRejectionReason = "empty_uri" | "unparsable_uri" | "insecure_transport";

export type SourceCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: SourceRejectionReason };

/**
 * Loopback is carved out so DASH/HLS fixtures served by a local test rig are
 * playable during development. Nothing else gets a plaintext exemption — a
 * private-range or `.local` host would let a misconfigured deployment think it
 * was fine.
 */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function checkPlaybackSource(source: PlaybackSource): SourceCheck {
  const uri = source.uri.trim();
  if (uri === "") return { ok: false, reason: "empty_uri" };

  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    /* Not a URL at all, or relative. Either way we will not guess at it. */
    return { ok: false, reason: "unparsable_uri" };
  }

  if (url.protocol === "https:") return { ok: true };
  if (url.protocol === "http:" && LOOPBACK_HOSTNAMES.has(url.hostname)) return { ok: true };

  /*
   * Everything else — `http:` to a real host, `data:`, `blob:`, `file:`, and
   * every peer-to-peer scheme this project forbids outright — lands here.
   */
  return { ok: false, reason: "insecure_transport" };
}

export function describeSourceRejection(reason: SourceRejectionReason): string {
  switch (reason) {
    case "empty_uri":
      return "Playback source has no URI.";
    case "unparsable_uri":
      return "Playback source is not an absolute URL.";
    case "insecure_transport":
      return "Playback source is not served over https.";
  }
}
