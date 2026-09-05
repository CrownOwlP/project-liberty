import type { Metadata } from "next";
import {
  titleDetailResponseSchema,
  type TitleDetail,
  type TitleDetailResponse,
  type TitleEpisodeSummary,
  type TitleRightsBasis
} from "@liberty/contracts/domains/title";
import { normalizedContentIdSchema } from "@liberty/contracts/shared/ids";
import { PLAYABLE_CONTENT_RIGHTS } from "@liberty/contracts/shared/rights";
import { formatRuntime } from "../../lib/catalog";
import {
  CatalogMetadataSourceNotConfiguredError,
  findDemoTitleDetail
} from "./demo-title-details";

/*
 * Colocated with the route that consumes it rather than placed beside
 * `lib/catalog.ts`. PL-0103 owns `app/title/**`, and `src/lib` is being edited
 * by other lanes in parallel; Next.js only treats reserved filenames in `app/`
 * as routes, so a plain module here is not routable. It should join
 * `lib/catalog.ts` when PL-0301 replaces the fixtures with a provider adapter
 * and the two loaders start sharing a source.
 */

/**
 * Explicit result union, for the same reason `CatalogLoadResult` is one, plus a
 * state the catalog does not have.
 *
 * "This id names nothing", "the source failed" and "this series has no
 * episodes" have three different remedies — correct the link, retry, wait for
 * the episodes to be published — and collapsing any two of them produces a page
 * that tells the reader to do the wrong thing. Only the first two are decided
 * here; the third belongs to the episode list, because a series with no
 * episodes is a successfully loaded title.
 */
export type TitleLoadResult =
  | { status: "ok"; response: TitleDetailResponse }
  | { status: "not-found"; contentId: string }
  | { status: "error"; reason: string };

/**
 * Where a title detail comes from. Injectable so the loader's failure paths are
 * testable, and so the planned `GET /api/v1/titles/:id` can replace the
 * fixtures without the page changing.
 *
 * `null` means not-found. A source that cannot answer throws instead, which is
 * what keeps "does not exist" and "could not be reached" distinguishable at the
 * boundary rather than inferred from an empty-looking payload.
 */
export type TitleDetailSource = (
  contentId: string
) => TitleDetailResponse | null | Promise<TitleDetailResponse | null>;

/** In-process fixture source. Injectable `now` so tests are not time-dependent. */
export function getTitleDetail(
  contentId: string,
  now: Date = new Date()
): TitleDetailResponse | null {
  const detail = findDemoTitleDetail(contentId);
  return detail === null ? null : { detail, generatedAt: now.toISOString() };
}

/**
 * Loader used by the title route.
 *
 * Validates against the published contract so a malformed fixture or provider
 * payload becomes a handled error state instead of a crash mid-render.
 */
export async function loadTitleDetail(
  contentId: string,
  source: TitleDetailSource = (id) => getTitleDetail(id)
): Promise<TitleLoadResult> {
  /*
   * Checked before the source is consulted. An id that is not normalized cannot
   * name a title — every id in the system is lower-case and hyphen-separated —
   * so this is not-found rather than a source error. Doing it first also keeps
   * raw URL path input from reaching the provider boundary at all.
   */
  if (!normalizedContentIdSchema.safeParse(contentId).success) {
    return { status: "not-found", contentId };
  }

  try {
    const payload = await source(contentId);
    if (payload === null) return { status: "not-found", contentId };

    const parsed = titleDetailResponseSchema.safeParse(payload);
    if (!parsed.success) {
      return { status: "error", reason: "title_response_failed_validation" };
    }

    /*
     * A source that answers with a different title than the one asked for is a
     * bug that would otherwise render silently and convincingly: the reader
     * gets a complete, correct-looking page for the wrong work, and its play
     * affordance reflects that work's rights rather than the requested one's.
     */
    if (parsed.data.detail.id !== contentId) {
      return { status: "error", reason: "title_response_id_mismatch" };
    }

    return { status: "ok", response: parsed.data };
  } catch (error) {
    /*
     * TWO SOURCE FAILURES, AND THEY ARE NOT THE SAME FACT.
     *
     * `title_source_unavailable` says a source that exists did not answer:
     * something transient, and "try again in a moment" is honest advice. A
     * process with NO catalog metadata source configured is not that. Nothing is
     * going to change on a retry, and the remedy belongs to an operator rather
     * than to the reader — the same distinction `loadHomeCatalog` and
     * `loadSearchResults` already draw, which is why both of them publish this
     * exact string.
     *
     * The reason is taken from the error rather than restated, so this branch
     * cannot drift from the class that raises it. `demo-title-details.ts` exports
     * the class precisely so this is an `instanceof` and not a comparison against
     * a message. In shipped code nothing but the default source raises it, and an
     * injected source that throws anything else still lands below.
     *
     * BOTH BRANCHES STAY `error`, and that is deliberate. Not-found already means
     * "no title has this id", which is false here — nothing was looked up.
     * `describeTitleMetadata` therefore answers `TITLE_UNAVAILABLE_METADATA` for
     * both, so the page keeps `robots: index false` at its 200 either way. What
     * changes is only the reason code, and `[titleId]/page.tsx` renders that code
     * verbatim in the panel, so the refusal now names itself instead of arriving
     * disguised as a flaky provider.
     */
    if (error instanceof CatalogMetadataSourceNotConfiguredError) {
      return { status: "error", reason: error.reason };
    }

    return { status: "error", reason: "title_source_unavailable" };
  }
}

/* -------------------------------------------------------------------------
 * Play affordance
 * ---------------------------------------------------------------------- */

export type PlayBlockedReason =
  | "rights_not_declared"
  | "rights_not_playable"
  | "no_playable_episode";

export type PlayAvailability =
  | { status: "playable"; href: string }
  | { status: "blocked"; reason: PlayBlockedReason };

/** Anything the play gate can be asked about: a title detail or an episode row. */
export interface PlayTarget {
  id: string;
  rights: TitleRightsBasis;
}

/**
 * Ids are validated as normalized before they reach here, so this encoding is a
 * no-op today. It stays because the guarantee is a schema's, not this
 * function's: a caller that skips the loader must not be able to turn an id
 * into path segments.
 */
export function watchHref(contentId: string): string {
  return `/watch/${encodeURIComponent(contentId)}`;
}

export function titleHref(contentId: string): string {
  return `/title/${encodeURIComponent(contentId)}`;
}

/**
 * The rights gate, stated once.
 *
 * Product invariant 1: only licensed, user-owned or public-domain content may
 * enter playback resolution. Two failures are kept apart on purpose:
 *
 *   - `rights_not_declared` — nobody has said anything. This is the state that
 *     must never be rendered as available, because "undeclared" and "cleared"
 *     look identical to a reader if the UI only decides between play and
 *     no-play. It is not a defect in the title; it is an unanswered question.
 *   - `rights_not_playable` — a basis exists and it is not one we may play
 *     from. Unreachable while `PLAYABLE_CONTENT_RIGHTS` covers every value of
 *     the rights vocabulary, and kept anyway: the allowlist exists so a value
 *     added later is non-surfaceable until reviewed, and that only holds if
 *     something checks it.
 *
 * Note what is NOT gated here: the detail page itself. Reading metadata is not
 * playback, and a title whose rights are undeclared is exactly the title a
 * reader most needs an honest page for. The gate belongs on the affordance that
 * would start playback, not on the ability to look something up.
 */
function rightsBlock(rights: TitleRightsBasis): PlayBlockedReason | null {
  if (rights === null) return "rights_not_declared";
  if (!PLAYABLE_CONTENT_RIGHTS.includes(rights)) return "rights_not_playable";
  return null;
}

export function resolvePlayAvailability(target: PlayTarget): PlayAvailability {
  const blocked = rightsBlock(target.rights);
  return blocked === null
    ? { status: "playable", href: watchHref(target.id) }
    : { status: "blocked", reason: blocked };
}

/**
 * The first episode that may actually be played, in the order the list renders.
 *
 * Sorted rather than taken from the source order so the CTA and the list cannot
 * disagree about which episode is "first", and so the same series always
 * produces the same target.
 */
export function resolveSeriesPlayTarget(
  episodes: readonly TitleEpisodeSummary[]
): TitleEpisodeSummary | null {
  return sortEpisodes(episodes).find((episode) => rightsBlock(episode.rights) === null) ?? null;
}

/**
 * The play affordance for a whole title.
 *
 * A series is not itself a playable unit — playback resolves an episode — so
 * its CTA points at an episode. It is gated twice, deliberately conservatively:
 * the series' own basis must clear the gate AND an episode must be playable. A
 * series-level control asserts that the series is playable, and we do not make
 * that claim on the strength of one episode's paperwork. The episode stays
 * reachable from its own row, where the claim being made is only about it.
 */
/*
 * WHAT THIS AFFORDANCE ASSERTS, AND WHAT IT DOES NOT.
 *
 * It asserts one thing: a rights basis has been recorded and it is on the
 * allowlist, so this title MAY be sent to playback resolution. It does not
 * assert that playback will succeed. The authorization decision is
 * `POST /api/v1/playback/session`, which answers `granted | denied |
 * unavailable` against the candidates a provider actually resolved, their own
 * rights, and the device's capabilities — none of which this surface has.
 *
 * The alternative was requesting a session per title (and per episode row) just
 * to label a link. That was rejected: it would issue playback sessions nobody
 * asked to start, put a provider round-trip per row in the render path, and
 * still be stale by the time the link was clicked. The honest arrangement is the
 * one here — withhold the control when the metadata already disqualifies it, and
 * let `/watch/:id` state the reason trail when the real decision refuses. That
 * refusal is rendered, with its reasons, rather than dead-ending.
 */
export function resolveTitlePlayAvailability(detail: TitleDetail): PlayAvailability {
  if (detail.kind !== "series") return resolvePlayAvailability(detail);

  const blocked = rightsBlock(detail.rights);
  if (blocked !== null) return { status: "blocked", reason: blocked };

  const target = resolveSeriesPlayTarget(detail.episodes);
  return target === null
    ? { status: "blocked", reason: "no_playable_episode" }
    : { status: "playable", href: watchHref(target.id) };
}

/* -------------------------------------------------------------------------
 * Ordering
 * ---------------------------------------------------------------------- */

/**
 * Deterministic episode order: season ascending, then episode ascending, then
 * id as a final tiebreak.
 *
 * The tiebreak is not decoration. `Array.prototype.sort` preserves the input
 * order for equal elements, so without it two rows sharing a (season, episode)
 * pair — which two providers, or a provider and a fixture, can absolutely
 * produce — would render in whatever order the source happened to return, and
 * the same series would list differently on two requests.
 *
 * Compared by CODE POINT rather than `localeCompare`: without an explicit
 * locale `localeCompare` uses the host's collation, so two devices can order
 * the same list differently. That defect was already removed from the playback
 * ranking and the audio policy, and it is still outstanding in the catalog's
 * title ordering; it is not being introduced again here.
 *
 * Returns a new array: sorting the caller's list in place would mutate a
 * validated contract payload.
 */
export function sortEpisodes(episodes: readonly TitleEpisodeSummary[]): TitleEpisodeSummary[] {
  return [...episodes].sort((a, b) => {
    if (a.seasonNumber !== b.seasonNumber) return a.seasonNumber - b.seasonNumber;
    if (a.episodeNumber !== b.episodeNumber) return a.episodeNumber - b.episodeNumber;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export interface EpisodeSeason {
  seasonNumber: number;
  episodes: TitleEpisodeSummary[];
}

/**
 * Groups episodes into seasons for rendering. Built from the sorted list, so
 * seasons come out ascending and contiguous even if the source interleaved
 * them — a season that appeared twice in the output would look like duplicated
 * data rather than an ordering bug.
 */
export function groupEpisodesBySeason(episodes: readonly TitleEpisodeSummary[]): EpisodeSeason[] {
  const seasons: EpisodeSeason[] = [];

  for (const episode of sortEpisodes(episodes)) {
    const current = seasons[seasons.length - 1];

    if (current && current.seasonNumber === episode.seasonNumber) {
      current.episodes.push(episode);
    } else {
      seasons.push({ seasonNumber: episode.seasonNumber, episodes: [episode] });
    }
  }

  return seasons;
}

/* -------------------------------------------------------------------------
 * Display
 * ---------------------------------------------------------------------- */

/**
 * Two labels for two different absences, and neither of them is a value.
 *
 * `null` is "the source did not tell us" and `[]` is "the source told us there
 * are none". Rendering both as "None" would be the UI half of the mistake
 * PL-0205 is fixing in the playback path: it reads as a fact, so nobody ever
 * goes looking for the missing data.
 */
export const NOT_REPORTED_LABEL = "Not reported";
export const NONE_LABEL = "None";

/** No synopsis was supplied. Stated, rather than left as blank space. */
export const NO_SYNOPSIS_LABEL = "No synopsis has been supplied for this title.";

export function formatMaxHeight(maxHeight: number | null): string {
  return maxHeight === null ? NOT_REPORTED_LABEL : `${maxHeight}p`;
}

/**
 * Language lists keep their source order rather than being sorted: for audio
 * the order is the provider's own preference and re-sorting it would discard
 * information the playback policy still reads.
 */
export function formatLanguageList(languages: readonly string[] | null): string {
  if (languages === null) return NOT_REPORTED_LABEL;
  if (languages.length === 0) return NONE_LABEL;
  return languages.join(", ");
}

export function formatEpisodeCount(count: number): string {
  return `${count} ${count === 1 ? "episode" : "episodes"}`;
}

/**
 * A series whose episode list is empty, described without counting to zero.
 *
 * `seriesTitleDetailSchema` says outright that `[]` is "a series whose episodes
 * are not listed yet". "0 episodes" is therefore the same defect as rendering an
 * unreported runtime as `0`: it reads as a stated fact — someone checked, there
 * are none — when what actually happened is that nothing was stated. It also
 * contradicted the panel `EpisodeList` renders three lines further down, which
 * says the episodes appear as soon as they are published.
 *
 * Deliberately not "None". `NONE_LABEL` is reserved for a source that reported
 * an empty list on purpose, which is a claim nothing in the title contract is
 * currently able to make about episodes.
 */
export const EPISODES_NOT_LISTED_LABEL = "Episodes not listed";

export function formatEpisodeLabel(episode: {
  seasonNumber: number;
  episodeNumber: number;
}): string {
  return `S${episode.seasonNumber}E${episode.episodeNumber}`;
}

/**
 * The meta line under the title, derived from structured fields rather than
 * stored. A series is described by how many episodes it has, everything else by
 * how long it runs — the discriminated union guarantees the relevant field is
 * there, so there is no unknown case to fall back to.
 */
export function formatTitleMeta(detail: TitleDetail): string {
  const parts: string[] = [detail.genre, String(detail.releaseYear)];

  if (detail.kind === "series") {
    parts.push(
      detail.episodes.length === 0
        ? EPISODES_NOT_LISTED_LABEL
        : formatEpisodeCount(detail.episodes.length)
    );
  } else {
    if (detail.kind === "episode") parts.push(formatEpisodeLabel(detail));
    parts.push(formatRuntime(detail.runtimeMinutes));
  }

  return parts.join(" · ");
}

/* -------------------------------------------------------------------------
 * Page metadata
 * ---------------------------------------------------------------------- */

/**
 * The site name, written out here rather than inherited.
 *
 * `app/layout.tsx` declares a plain `title` string and no `title.template`, so a
 * page-level title REPLACES it instead of extending it — a title route that set
 * only `"Northstar"` would produce a tab and a shared link that never say where
 * the reader is. Declaring a template in the root layout is the tidier fix and
 * belongs to whoever owns `app/layout.tsx`; that file is outside this task's
 * allowed paths, and duplicating one string is a smaller cost than an
 * out-of-scope edit to a file two other surfaces render inside.
 */
const SITE_NAME = "Project Liberty";

/**
 * Metadata for a route whose title could not be identified.
 *
 * Exported so the tests can assert the exact strings, and so nothing can quietly
 * start deriving a name for a title we do not have. The rule the whole surface
 * runs on applies to the `<head>` as much as to the body: the id from the URL is
 * NOT a title, and echoing it here would put an invented name in a browser tab,
 * a bookmark, and every link preview of a page that says the title is unknown.
 *
 * `robots: index false`, and it stays even though PL-0704 makes this route
 * answer a real 404. When this was written it did not: a `loading.tsx` put the
 * page inside Suspense, React flushed the shell at HTTP 200 while the loader was
 * still pending, and an executed Playwright run captured the "Loading title…"
 * skeleton at 200 for an id nothing knows about. The repair removes every
 * Suspense boundary above the decision — see `[titleId]/page.tsx` — so
 * `notFound()` escapes the render and Next sets the status.
 *
 * THE DIRECTIVE IS NOT NOW REDUNDANT, and the argument that it would be is the
 * one that produced the original asymmetry with the unavailable branch below:
 * "a 404 is dropped without indexing, so nothing else is needed". Three things
 * keep it earning its place. It says `follow`, which the status does not, and
 * the one link out of the page — the catalog — is worth following. Next emits a
 * bare `noindex` of its own for any status above 400, so agreeing with it costs
 * nothing and disagreeing would be the surprise. And it is what remains true if
 * this route is ever served through something that rewrites the status, or has
 * to answer 200 again for a reason nobody has thought of yet; the supply of
 * dead addresses here is unbounded, since every string matching the
 * normalized-id pattern passes the loader's format check and lands on this
 * metadata.
 *
 * What did NOT survive the repair is this route's loading skeleton, and it was
 * not traded away for the status: whether a title exists IS the load here, so
 * there was never anything to stream before the decision. `[titleId]/page.tsx`
 * carries that argument in full.
 */
export const TITLE_NOT_FOUND_METADATA: Metadata = {
  title: `Title not found · ${SITE_NAME}`,
  description: "Nothing in the catalog matches this address.",
  robots: { index: false, follow: true }
};

/**
 * Metadata for a title the source could not return.
 *
 * `robots: index false` because this branch renders at HTTP 200 — a real title
 * that was temporarily unreachable is still a real title, so answering 404 would
 * be a lie in the other direction. That leaves a 200 page reading "We couldn't
 * load this title", which without this is indexable and would be cached by
 * crawlers as the content of a title that is fine. `follow` stays on: the links
 * out of the page (the catalog) are still worth following.
 *
 * This is no longer the only branch carrying the directive. Not-found carries the
 * identical one — for its own reasons now that it answers 404, set out above.
 * Nothing here is an argument for restoring the asymmetry.
 */
export const TITLE_UNAVAILABLE_METADATA: Metadata = {
  title: `Title unavailable · ${SITE_NAME}`,
  description: "This title could not be loaded.",
  robots: { index: false, follow: true }
};

/**
 * Page metadata derived from the load result, not from the URL.
 *
 * Takes the already-resolved `TitleLoadResult` rather than an id so it cannot
 * disagree with the body: the same load answers both, and the three outcomes get
 * the three different heads they need instead of every title in the catalog
 * sharing the root layout's "Project Liberty".
 *
 * The description falls back to the structured meta line rather than to an empty
 * string or to invented prose. `formatTitleMeta` is built only from fields the
 * source actually stated, so a title with no synopsis gets a description that is
 * short and true instead of a `<meta>` tag asserting the title has no story.
 *
 * AN EPISODE IS NOT NAMED BY ITS OWN TITLE ALONE. `detail.title` for an episode is
 * whatever the series called that slot — for the fixtures, literally "Episode 3" —
 * so `${detail.title} · ${SITE_NAME}` produced "Episode 3 · Project Liberty" for
 * the third episode of every series in the catalog. That is the exact defect this
 * function exists to remove, only worse than the original: the root layout's
 * "Project Liberty" was at least visibly a site name, whereas "Episode 3" looks
 * like an answer. The description did not rescue it either, because fixture
 * episodes carry a `null` synopsis and the meta line it falls through to names the
 * genre, the year and `S1E3` but never the series.
 *
 * The series title and the season/episode label are already on
 * `EpisodeTitleDetail`, parsed and validated — `components/title/title-hero.tsx`
 * renders `seriesTitle` in the body of this very page — so the head needs no new
 * data, only a branch.
 *
 * The series leads because a browser tab and a link preview both truncate from the
 * RIGHT: "Northstar S1E3 · …" still identifies the work, "…3 · Project Liberty"
 * does not. Putting the label immediately after the series and keeping
 * `detail.title` last means a generic fixture name reads as mild redundancy
 * ("Northstar S1E3 · Episode 3") while a real episode name is carried in full.
 * Dropping `detail.title` when it looks generic was rejected: that is a guess about
 * a string the source supplied, and the same heuristic would eat a real episode
 * genuinely called "Episode 3".
 */
export function describeTitleMetadata(result: TitleLoadResult): Metadata {
  if (result.status === "not-found") return TITLE_NOT_FOUND_METADATA;
  if (result.status === "error") return TITLE_UNAVAILABLE_METADATA;

  const { detail } = result.response;

  const name =
    detail.kind === "episode"
      ? `${detail.seriesTitle} ${formatEpisodeLabel(detail)} · ${detail.title}`
      : detail.title;

  /*
   * The same absence, in the description. `formatTitleMeta` is series-less by
   * design — it describes the item, and the item is an episode — so the series is
   * prefixed here rather than pushed into the meta line, which the hero also
   * renders directly beneath a heading that already says which series this is.
   */
  const fallbackDescription =
    detail.kind === "episode"
      ? `${detail.seriesTitle} · ${formatTitleMeta(detail)}`
      : formatTitleMeta(detail);

  return {
    title: `${name} · ${SITE_NAME}`,
    description: detail.synopsis ?? fallbackDescription
  };
}
