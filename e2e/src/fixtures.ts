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

import { randomUUID } from "node:crypto";

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
 * Strings that only the demo catalog can put on a discovery surface.
 *
 * The ids and titles come from `lib/demo-catalog.ts`; `Films` and `Series` are
 * the two rail titles `buildHomeCatalog` composes, and they are in the list on
 * purpose rather than by accident of naming: a rail with no surfaceable items is
 * omitted entirely, so on a build with no metadata source neither rail title is
 * in the response either.
 *
 * ONE LIST, ITERATED WHOLE BY BOTH HALVES OF THE CATALOG PAIRING. A build that
 * can construct `demoCatalogSource` must publish every one of these; a build that
 * cannot must publish none of them. Two hand-maintained lists are how the session
 * spec's two halves came to differ while the file described them as the same, so
 * this is the array both sides read.
 *
 * IT IS THE ARRAY FOR THE SURFACES THAT SHOW THE WHOLE CATALOG, which is
 * `catalog.api.spec.ts` at the wire and `critical-journey.spec.ts` on the home
 * page (through the derived subset below). It is deliberately NOT used by
 * `search.spec.ts` or by the title-route tests: a search for one word returns one
 * title and a title page shows one work, so requiring every string here to be
 * present under `development` would be false on both. Each of those specs
 * declares its own smaller pairing array and states which strings it leaves out
 * and why -- a subset that is argued for, rather than this array quietly
 * weakened for everybody.
 *
 * DELIBERATELY NOT HERE: `Drama`, `Sci-fi` and the other genres. They are
 * catalog data too, but they are also ordinary English words that appear in
 * copy -- `search/page.tsx` tells the reader to try "a genre such as Drama" in
 * its EMPTY state -- so requiring their absence would fail on a page that
 * correctly rendered no catalog at all.
 */
export const CATALOG_ARTEFACTS: readonly string[] = [
  DEMO.movie.id,
  DEMO.movie.title,
  DEMO.series.id,
  DEMO.series.title,
  "Films",
  "Series"
];

/**
 * The artefacts above that are safe to require the ABSENCE of in a rendered
 * DOCUMENT, as opposed to in an API response.
 *
 * Two of them are not, and both are static page copy rather than catalog data:
 * `app/page.tsx` puts `Series` in the primary navigation and `aurora-fall` in the
 * hero's "Open demo player" href, on every build. Requiring their absence from
 * the HTML would fail on a page that correctly rendered no catalog at all --
 * which is the class of assertion this whole pairing exists to avoid, pointed the
 * other way.
 *
 * DERIVED rather than written out as a second list, for the reason the session
 * spec derives its paired half: a hand-maintained counterpart is how two halves
 * that a file describes as the same list come to differ. The exclusions are named
 * here so the difference between the two arrays is a stated fact about the page
 * and not something a reader has to discover by diffing them.
 */
const CATALOG_ARTEFACTS_IN_STATIC_COPY: readonly string[] = ["Series", DEMO.movie.id];

export const CATALOG_ARTEFACTS_ON_PAGE: readonly string[] = CATALOG_ARTEFACTS.filter(
  (artefact) => !CATALOG_ARTEFACTS_IN_STATIC_COPY.includes(artefact)
);

/**
 * The headers that name which development household a request acts as.
 *
 * Restated rather than imported, for the reason the content ids are: `e2e` is
 * outside the npm workspaces, and a harness that read the server's own constants
 * would follow a rename instead of noticing one. `lib/session/account.ts`
 * declares them, and the value shape it enforces is a lower-case,
 * hyphen-separated token of at most 64 characters.
 *
 * THEY ARE NOT AN AUTHENTICATION BYPASS AND CANNOT BECOME ONE. `resolveRequestAccount`
 * reaches `developmentAccount` only for a `NonDeploymentEnvironment`, whose
 * constructor is private and whose only producer refuses every `NODE_ENV` outside
 * `development` and `test`. On a production build these headers are read by
 * nothing: the request is refused before identity is even attempted. That is
 * asserted rather than assumed -- see the production half of
 * `tests/progress.api.spec.ts`.
 */
export const DEVELOPMENT_ACCOUNT_HEADER = "x-liberty-development-account";
export const DEVELOPMENT_SESSION_HEADER = "x-liberty-development-session";

export interface DevelopmentIdentity {
  readonly accountId: string;
  readonly headers: Record<string, string>;
}

/**
 * A household nothing else in this suite shares.
 *
 * `fullyParallel` is on and the in-memory store is one map per SERVER process,
 * so two tests that both acted as the default `development-account` would race on
 * one row of `active_profile_selection` -- one test's profile selection would
 * silently become the other's, and the failure would look like an authorization
 * defect in the product. A per-test account and session make every progress test
 * independent without serialising anything, which is the arrangement
 * `playwright.config.ts` says parallelism is supposed to expose rather than hide.
 *
 * The suffix is eight hex characters of a v4 UUID, which is already a valid
 * development identifier: lower-case, hyphen-separated, alphanumeric. `label`
 * must be too, and short -- the whole value is bounded at 64 characters by
 * `lib/session/account.ts` and a longer one is REFUSED rather than truncated.
 */
export function developmentIdentity(label: string): DevelopmentIdentity {
  const accountId = `e2e-${label}-${randomUUID().slice(0, 8)}`;
  return {
    accountId,
    headers: {
      [DEVELOPMENT_ACCOUNT_HEADER]: accountId,
      /* Named explicitly rather than left to the server's `<account>-session`
       * default, so the pair this run acts as is one this file can state. */
      [DEVELOPMENT_SESSION_HEADER]: `${accountId}-session`
    }
  };
}

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
