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
import { findDemoTitleDetail } from "./demo-title-details";

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
  } catch {
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
    parts.push(formatEpisodeCount(detail.episodes.length));
  } else {
    if (detail.kind === "episode") parts.push(formatEpisodeLabel(detail));
    parts.push(formatRuntime(detail.runtimeMinutes));
  }

  return parts.join(" · ");
}
