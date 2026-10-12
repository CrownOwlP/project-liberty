/* -------------------------------------------------------------------------
 * ONE PROFILE'S LIBRARY, AS ONE VALUE (W132-F)
 *
 * ==========================================================================
 * THE DEFECT CLASS THIS FILE REMOVES: PER-PROFILE STATE IN FOUR PLACES
 * ==========================================================================
 *
 * Before this module, the four things a profile owns were loaded by four
 * unrelated functions with four unrelated result shapes:
 * `loadWatchlistPage` (`ok | no-profile | unavailable`),
 * `loadContinueWatching`, `loadEpisodeProgress`, and `loadMediaPreferences`
 * (never fails, answers a neutral value). Every one of them is correct on its
 * own. Together they are a screen that can show PROFILE A'S WATCHLIST BESIDE
 * PROFILE B'S CONTINUE-WATCHING, because nothing in any of their return types
 * says which profile the answer belongs to -- so a consumer holding two
 * snapshots has no way to notice that one of them is stale, and the symptom is
 * a household seeing a sibling's half-watched episode under their own name.
 *
 * `profile-ui.test.tsx` already pins the fix for the ONE case somebody thought
 * of: "switching profiles must not leave another profile's rows on screen",
 * enforced by making the picker call `router.refresh()` so every server
 * component re-renders. That works and must stay. What it cannot do is make
 * the hazard STRUCTURALLY VISIBLE -- it is a rule about one component,
 * remembered, and the next surface to hold per-profile state will not know
 * about it.
 *
 * This module makes it a type. A `ProfileLibrarySnapshot` NAMES THE PROFILE IT
 * DESCRIBES, so "is this still the right profile's data" is a question a
 * caller can ask (`librarySnapshotStaleness`) rather than a question nobody
 * thought to ask.
 *
 * ==========================================================================
 * THE PORT TAKES NO PROFILE ID. THAT IS THE SECURITY PROPERTY, NOT A STYLE
 * ==========================================================================
 *
 * The obvious port is `listWatchlist(profileId)`. IT MUST NOT BE, and PL-0405
 * recorded why: a profile id that a CALLER supplies is a client-held scope, and
 * the whole profile model exists to keep the scope on the server. Every
 * existing read in this application obeys that -- `loadWatchlistPage`'s own
 * header says "there is no parameter on this path through which a caller could
 * supply one" -- and a port with an id parameter would be the first door back
 * in, reachable from a client bundle, with a plausible-looking signature.
 *
 * So EVERY METHOD ON `ProfileLibraryPort` TAKES NO ARGUMENTS. An implementation
 * is constructed where the scope already is -- a server component holding
 * `headers()`, which resolves the active profile from the session -- and is
 * handed to this model already scoped. The `profileId` on a snapshot is then a
 * LABEL THE SERVER PUT THERE, never an input: it exists so a consumer can
 * detect staleness, and there is no code path by which writing a different
 * value into it would read a different profile's rows.
 *
 * `profile-library.test.ts` asserts this against the source, because it is the
 * kind of property that is obvious while it is being written and invisible six
 * months later.
 *
 * ==========================================================================
 * NO DATABASE TYPE APPEARS IN THIS FILE, AND NO DATABASE IS IMPORTED
 * ==========================================================================
 *
 * Workers B, C and D need per-profile state from a catalog card, a rail and a
 * player. If this module imported `lib/db/request-context`, every one of those
 * surfaces would statically reach Drizzle, `@liberty/persistence` and the
 * schema -- which is the exact import-graph cost `lib/viewer-preferences.ts`
 * documents refusing to pay, and which several suites in this repository
 * assert against by reading import lists.
 *
 * The facet shapes below are therefore STRUCTURAL: plain strings, numbers and
 * `null`. A `Date` does not appear -- instants are ISO strings, as
 * `WatchlistPageEntry.addedAt` already publishes them -- so a snapshot is
 * JSON-serialisable and can cross from a server component to a client one
 * without a serialisation boundary rejecting it.
 *
 * ==========================================================================
 * FAVOURITES ARE DECLARED `not-implemented` AND ARE NOT FAKED
 * ==========================================================================
 *
 * The mission asks for favourites. THERE IS NO FAVOURITES STORAGE IN THIS
 * REPOSITORY: `packages/persistence/src/schema/` has `watchlistEntry` and
 * `playbackProgress` and nothing else a favourite could live in, and
 * `LibertyRepository` has no method for one. The two dishonest options are an
 * empty array -- which renders as "you have no favourites", a claim about this
 * viewer that is actually a fact about the schema -- and a client-side list,
 * which this repository forbids by rule (no `localStorage`, no
 * `sessionStorage`; the server owns the session).
 *
 * So the facet exists, is typed, and reports `not-implemented` with a detail
 * naming what is missing. A screen renders that as "favourites are not
 * available in this build" rather than as an empty shelf. It is the same rule
 * the catalog follows for media availability -- an empty list is a truthful
 * empty state only when the store really was asked -- and the proposed
 * persistence diff is in this round's report.
 * ---------------------------------------------------------------------- */

/**
 * One entry a viewer deliberately put somewhere.
 *
 * Matches `WatchlistPageEntry`'s first two fields on purpose, minus `item`: a
 * `CatalogItem` is metadata this model has no business resolving, and
 * `selectWatchlistPage` already owns that join. This is the stored FACT; what
 * the catalog will say about it is a separate question with separate rights
 * rules.
 */
export interface LibraryEntry {
  readonly contentId: string;
  /** ISO 8601 UTC, which is also the list's order (newest first). */
  readonly addedAt: string;
}

/**
 * One title this profile has watched some of, and where it stopped.
 *
 * `positionSeconds` AND `runtimeSeconds` ARE BOTH NULLABLE, because the stored
 * columns are (`position_seconds` and `runtime_seconds` are nullable `integer`
 * in `schema/progress.ts`). A model that declared them `number` would be
 * asserting something about the database that is not true, and the first `null`
 * would be a `NaN` in whatever arithmetic a consumer did -- which is how a
 * resume point becomes a seek to `NaN`.
 */
export interface HistoryEntry {
  readonly contentId: string;
  readonly positionSeconds: number | null;
  readonly runtimeSeconds: number | null;
  /** ISO 8601 UTC. */
  readonly updatedAt: string;
}

/**
 * One part of the library, and whether it could be read at all.
 *
 * ==========================================================================
 * THREE STATES, AND NONE OF THEM COLLAPSES INTO ANOTHER
 * ==========================================================================
 *
 * `ok` WITH NO ENTRIES IS NOT A FAILURE and is not the same as either failure.
 * It is the state every new profile is in, and `loadWatchlistPage` says it in
 * terms: "it is the one case where 'nothing here yet' is the honest sentence".
 *
 * `unavailable` IS A FAILURE OF THIS READ, with a reason CODE rather than a
 * message. The repository can throw with a value carrying a connection string,
 * and every existing loader in this application publishes the code and
 * discards the text for that reason.
 *
 * `not-implemented` IS A FACT ABOUT THE BUILD, not about this viewer and not
 * about this request. Retrying changes nothing and neither does signing in.
 * Collapsing it into `unavailable` would send a household to check their
 * network for a feature that does not exist; collapsing it into `ok` with an
 * empty list would tell them they have no favourites.
 */
export type LibraryFacet<T> =
  | { readonly status: "ok"; readonly entries: readonly T[] }
  | { readonly status: "unavailable"; readonly reason: string }
  | { readonly status: "not-implemented"; readonly detail: string };

/** The shared `not-implemented` facet, so the sentence is written once. */
export const FAVOURITES_NOT_IMPLEMENTED: LibraryFacet<LibraryEntry> = Object.freeze({
  status: "not-implemented",
  detail:
    "this build has no favourites storage, so nothing was read; a watchlist is the list it does keep"
});

/**
 * Everything one profile owns, in one value, labelled with whose it is.
 *
 * `profileId` IS `null` FOR "NO PROFILE IS ACTIVE", which is a real state and
 * not an error: a signed-in household that has not chosen who is watching has
 * no library, and `no_active_profile_selected` is the reason every existing
 * loader answers for it -- the one refusal on this path that is nobody's fault.
 */
export interface ProfileLibrarySnapshot {
  readonly profileId: string | null;
  readonly watchlist: LibraryFacet<LibraryEntry>;
  readonly favourites: LibraryFacet<LibraryEntry>;
  readonly history: LibraryFacet<HistoryEntry>;
}

/**
 * The narrow persistence port.
 *
 * NO METHOD TAKES AN ARGUMENT. See the header: an implementation is built where
 * the scope already is, and a caller holding this interface cannot ask it about
 * another profile because there is nowhere to put the question.
 *
 * `activeProfileId` IS A READ, NOT A SETTER. It reports which profile the
 * server resolved for this request, so the snapshot can be labelled. An
 * implementation that returned something a client had supplied would be the
 * forgeable scope this design exists to prevent, which is why the only
 * implementations are server-side.
 *
 * EVERY METHOD RETURNS A FACET RATHER THAN THROWING. A port whose methods
 * reject puts a `try` around every call site, and the one call site that
 * forgets it takes down a page -- the failure mode `loadWatchlistPage`'s
 * "NEVER THROWS" header is about. `loadProfileLibrary` still wraps each call,
 * because an implementation is somebody else's code and a contract is not an
 * enforcement.
 */
export interface ProfileLibraryPort {
  readonly activeProfileId: () => Promise<string | null>;
  readonly watchlist: () => Promise<LibraryFacet<LibraryEntry>>;
  readonly history: () => Promise<LibraryFacet<HistoryEntry>>;
  /**
   * Optional, and absent is the normal case today.
   *
   * An implementation that cannot offer favourites LEAVES THE METHOD OFF rather
   * than returning an empty list, and `loadProfileLibrary` fills in
   * `FAVOURITES_NOT_IMPLEMENTED`. The alternative -- requiring the method and
   * having every implementation return `{ status: "not-implemented" }` -- puts
   * the same sentence in every adapter and makes the real one indistinguishable
   * from an adapter that forgot.
   */
  readonly favourites?: () => Promise<LibraryFacet<LibraryEntry>>;
}

/** The snapshot for a request with no profile chosen. */
export function noProfileSnapshot(): ProfileLibrarySnapshot {
  return {
    profileId: null,
    watchlist: { status: "ok", entries: [] },
    favourites: FAVOURITES_NOT_IMPLEMENTED,
    history: { status: "ok", entries: [] }
  };
}

/**
 * The reason code published when a port method throws.
 *
 * ONE CODE FOR EVERY THROW, and the thrown value's text is discarded. The same
 * decision `loadWatchlistPage` and `loadContinueWatching` both document: a
 * repository exception can carry a connection string, and a reason trail is
 * not a place to put one.
 */
export const PORT_THREW = "profile_library_port_failed";

async function facetOf<T>(
  read: (() => Promise<LibraryFacet<T>>) | undefined,
  absent: LibraryFacet<T>
): Promise<LibraryFacet<T>> {
  if (read === undefined) return absent;
  try {
    const facet = await read();
    /*
     * A PORT THAT ANSWERED SOMETHING THAT IS NOT A FACET IS A FAILED READ, not
     * a successful empty one. An implementation returning `undefined` -- a
     * forgotten `return`, a half-written adapter -- would otherwise reach a
     * consumer as `snapshot.watchlist.status === undefined` and fall through
     * every branch to whatever the last `else` rendered.
     */
    if (facet === null || typeof facet !== "object" || typeof facet.status !== "string") {
      return { status: "unavailable", reason: PORT_THREW };
    }
    return facet;
  } catch {
    return { status: "unavailable", reason: PORT_THREW };
  }
}

/**
 * Read the whole library through a port.
 *
 * NEVER THROWS, for the reason every loader in this application gives: this
 * runs inside a render, and the failure mode of a throw is a stack trace where
 * a household's list should be.
 *
 * THE FACETS ARE READ CONCURRENTLY AND FAIL INDEPENDENTLY. `Promise.all` would
 * be shorter and is wrong twice over: it rejects on the first rejection, which
 * would discard a watchlist that read perfectly because history did not, and
 * it would make the slowest facet the latency of the screen in a way nothing
 * could degrade around. Each facet carries its own status for exactly this.
 *
 * THE PROFILE IS RESOLVED FIRST AND SHORT-CIRCUITS. Reading rows before
 * knowing whether a profile is active would be a query with no scope, and the
 * answer for "nobody has chosen" is the empty snapshot rather than an error.
 */
export async function loadProfileLibrary(
  port: ProfileLibraryPort
): Promise<ProfileLibrarySnapshot> {
  let profileId: string | null;
  try {
    profileId = await port.activeProfileId();
  } catch {
    return {
      profileId: null,
      watchlist: { status: "unavailable", reason: PORT_THREW },
      favourites: FAVOURITES_NOT_IMPLEMENTED,
      history: { status: "unavailable", reason: PORT_THREW }
    };
  }

  if (typeof profileId !== "string" || profileId.length === 0) return noProfileSnapshot();

  const [watchlist, favourites, history] = await Promise.all([
    facetOf(port.watchlist, { status: "unavailable", reason: PORT_THREW }),
    facetOf(port.favourites, FAVOURITES_NOT_IMPLEMENTED),
    facetOf(port.history, { status: "unavailable", reason: PORT_THREW })
  ]);

  return { profileId, watchlist, favourites, history };
}

/**
 * Whether a snapshot still describes the profile that is active now.
 *
 * ==========================================================================
 * THIS IS THE FUNCTION THE WHOLE MODULE EXISTS FOR
 * ==========================================================================
 *
 * "Switching profile must switch all of it" is an acceptance clause, and the
 * only enforcement it has today is that the picker calls `router.refresh()`.
 * That is a rule about one component. This is the same requirement as a
 * question any consumer holding a snapshot can ask before rendering it, and
 * `stale` is the answer that must never be drawn.
 *
 * `unknown` IS A THIRD ANSWER AND IS NOT `stale`. A consumer that has not yet
 * established who is active -- a first paint, a failed identity read -- knows
 * nothing, and treating that as `stale` would blank a correct screen every time
 * an unrelated read failed. It is also not `fresh`: a consumer must not draw
 * rows it cannot attribute. The honest rendering for `unknown` is the loading
 * or unavailable state, which is what `ActiveProfileBadge` already does for the
 * identity it cannot yet name.
 */
export type SnapshotStaleness = "fresh" | "stale" | "unknown";

export function librarySnapshotStaleness(
  snapshot: ProfileLibrarySnapshot,
  activeProfileId: string | null | undefined
): SnapshotStaleness {
  /* `undefined` means "nobody has told me", which is not the same fact as
   * `null`, which means "the server says no profile is active". */
  if (activeProfileId === undefined) return "unknown";
  if (snapshot.profileId === null) {
    /* A no-profile snapshot is fresh only while no profile is active. Once one
     * is, it describes a state that has been left behind. */
    return activeProfileId === null ? "fresh" : "stale";
  }
  if (activeProfileId === null) return "stale";
  return snapshot.profileId === activeProfileId ? "fresh" : "stale";
}

/**
 * What a consumer may draw from a snapshot.
 *
 * A FUNCTION RATHER THAN A RULE IN A COMMENT, so the decision is made in one
 * place and the same way on every surface. A stale or unattributable snapshot
 * yields nothing, which is the behaviour the acceptance requires and which no
 * amount of remembering produces reliably across nine surfaces.
 */
export function visibleSnapshot(
  snapshot: ProfileLibrarySnapshot,
  activeProfileId: string | null | undefined
): ProfileLibrarySnapshot | null {
  return librarySnapshotStaleness(snapshot, activeProfileId) === "fresh" ? snapshot : null;
}

/**
 * Whether a facet was read successfully and holds nothing.
 *
 * NOT `entries.length === 0`, because that is `false` for the two failure
 * states and would make "we could not read your list" indistinguishable from
 * "your list is empty" to anything that asked. Onboarding copy turns on this
 * answer, and showing a new household "add your first title" because the
 * database was down is the defect.
 */
export function facetIsTrulyEmpty<T>(facet: LibraryFacet<T>): boolean {
  return facet.status === "ok" && facet.entries.length === 0;
}

/**
 * Whether this profile has genuinely nothing yet.
 *
 * FAVOURITES ARE DELIBERATELY NOT CONSULTED. The facet is `not-implemented` in
 * every build today, so including it would make this function answer `false`
 * forever and the first-run onboarding would never appear -- a feature
 * disabled by an unrelated missing feature. What "nothing yet" means is the
 * two things this build really keeps, both read, both empty.
 */
export function libraryIsFirstRun(snapshot: ProfileLibrarySnapshot): boolean {
  return (
    snapshot.profileId !== null &&
    facetIsTrulyEmpty(snapshot.watchlist) &&
    facetIsTrulyEmpty(snapshot.history)
  );
}

/**
 * The content ids on the watchlist, for `presenceFromList`.
 *
 * THE PORT WORKER B ASKED FOR. `watchlist-state.ts` already takes
 * `readonly string[] | null` and treats `null` as "I do not know yet", which is
 * exactly the three facet states collapsed correctly: a successful read is the
 * ids, and BOTH failures are `null` rather than `[]`. Returning `[]` for a
 * failed read would paint "Add to My List" on a title the viewer's list already
 * holds -- the lie that file's `unknown` state exists to avoid.
 */
export function watchlistContentIds(
  snapshot: ProfileLibrarySnapshot
): readonly string[] | null {
  return snapshot.watchlist.status === "ok"
    ? snapshot.watchlist.entries.map((entry) => entry.contentId)
    : null;
}

/**
 * Where this profile stopped in one title, or `null`.
 *
 * THE PORT WORKER D ASKED FOR, and it returns `null` for three different facts
 * on purpose: no history, no row for this title, or a row with no position. A
 * player cannot resume differently for any of them -- all three mean "start at
 * the beginning" -- and distinguishing them here would put a storage detail in
 * front of a seek.
 *
 * A LINEAR SCAN AND NOT AN INDEX. The history facet is one profile's rows under
 * a query limit, so this is a walk over tens of items inside a render that
 * already did I/O. `lib/episode-progress.ts` builds a `Map` because it looks up
 * every episode of a season in one pass; a single lookup does not earn one, and
 * an index built per call would be slower than the scan it replaced.
 */
export function resumePositionFor(
  snapshot: ProfileLibrarySnapshot,
  contentId: string
): number | null {
  if (snapshot.history.status !== "ok") return null;
  for (const entry of snapshot.history.entries) {
    if (entry.contentId !== contentId) continue;
    const seconds = entry.positionSeconds;
    /*
     * A STORED POSITION IS CHECKED FOR BEING A USABLE NUMBER HERE, at the point
     * it leaves this model, rather than trusted. The column is nullable and the
     * row may have been written by a build that no longer exists; a `NaN` or a
     * negative reaching `currentTime` is a player that never starts, which is
     * the same defect class `migrateViewerPreferences` removes for rates.
     */
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return null;
    return seconds;
  }
  return null;
}
