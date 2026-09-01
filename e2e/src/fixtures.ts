/* -------------------------------------------------------------------------
 * Fixtures for the harness
 *
 * NOTHING IN THIS FILE IS A MEDIA URL, and nothing in `e2e/**` may become one.
 * Product invariant 1 admits only licensed, user-owned or public-domain content
 * into playback resolution, and a media address checked into a test fixture is
 * a rights claim that no rights review ever saw. `docs/RESEARCH_PLAYBACK.md`
 * records the legitimate route -- package public-domain sources (Blender open
 * movies, Internet Archive) into DASH and HLS yourself -- and that packaging is
 * a task of its own, not something this harness may shortcut by pasting a link
 * of unknown provenance.
 *
 * The addresses this harness DOES send are deliberately hostile and
 * deliberately unfetchable: `.test` and `.invalid` are reserved by RFC 2606, so
 * a regression that made the server follow one still cannot reach anybody.
 * They exist to be REFUSED, and the assertion is always that they were.
 * ---------------------------------------------------------------------- */

/**
 * Content ids from `apps/web/src/lib/demo-catalog.ts`.
 *
 * Restated rather than imported: `e2e` is outside the npm workspaces (see
 * docs/E2E.md), and an end-to-end harness that reads the server's own fixture
 * module would follow a rename instead of noticing one. These ids are part of
 * what the routes publish, so they are pinned here on purpose.
 */
export const DEMO = {
  movie: { id: "aurora-fall", title: "Aurora Fall", genre: "Sci-fi" },
  series: { id: "northstar", title: "Northstar", genre: "Drama" }
} as const;

/** A content id no fixture defines, for the not-found paths. */
export const UNKNOWN_CONTENT_ID = "no-such-title-pl0701";

/**
 * A device profile the fixture candidates can actually satisfy, so a refusal in
 * a test means what the test says it means rather than "the profile was too
 * narrow". Mirrors the conservative profile the watch route states.
 */
export const CAPABLE_DEVICE = {
  maxHeight: 1080,
  supportedVideoCodecs: ["h264"],
  supportedAudioCodecs: ["aac"],
  preferredAudioLanguages: ["en"]
} as const;

/**
 * A ceiling no real stream would clear.
 *
 * It used to be described as "a profile nothing 720p-or-better can satisfy, for
 * the eligibility path", and that stopped being what it does. The fixture
 * candidates state `height: null` -- nothing has opened those files -- and
 * `ranking.ts` will not compare a ceiling against a measurement that does not
 * exist, so this profile no longer rejects anything the fixture provider emits.
 *
 * That is exactly why it is still here. A device this narrow is the sharpest
 * available probe for a fixture that has started stating facts again: the
 * session it produces must be granted and unverified, and the moment a height
 * reappears it is refused instead. See `playback-session.api.spec.ts`.
 */
export const TINY_DEVICE = {
  maxHeight: 144,
  supportedVideoCodecs: ["h264"],
  supportedAudioCodecs: ["aac"],
  preferredAudioLanguages: ["en"]
} as const;

/**
 * An address the server must never fetch, follow or echo.
 *
 * `.test` is reserved by RFC 2606. If any assertion that looks for this string
 * in a response ever fails, the finding is not "the test is stale" -- it is that
 * a client-supplied address survived into a server response.
 */
export const SMUGGLED_URI = "https://smuggled.test/pl0701/manifest.mpd";

export function sessionRequest(contentId: string, capabilities: unknown = CAPABLE_DEVICE) {
  return { contentId, capabilities };
}

/**
 * A candidate for `/api/v1/playback/resolve`, which is the ONLY route that
 * accepts client-supplied candidates and is a testing-only scaffold: it answers
 * 404 under a production build, so a spec sending one of these has to guard on
 * the mode. `rights` is a parameter so a spec can hand it a basis that is not
 * on the playable allowlist.
 */
export function resolveCandidate(overrides: Record<string, unknown> = {}) {
  return {
    id: "pl0701-candidate",
    providerId: "pl0701",
    rights: "owned",
    protocol: "https",
    height: 720,
    bitrateKbps: 2800,
    estimatedLatencyMs: 120,
    healthScore: 0.9,
    videoCodec: "h264",
    audioCodec: "aac",
    ...overrides
  };
}
