import type { ZodIssue } from "zod";

/* -------------------------------------------------------------------------
 * The shape every reason trail in the profile, progress and watchlist routes
 * has
 *
 * Product invariant 4 says a playback decision must expose a reason trail
 * sufficient to debug it, and `v1/playback/session/contract.ts` argues at length
 * why that has to be a NON-EMPTY list enforced by the type rather than a
 * convention: a denial with no trail is as unanswerable as a grant with none,
 * and an invariant nothing checks is one a later refactor drops.
 *
 * The three route groups in PL-0402/0403/0404 need exactly that property and
 * differ only in their reason VOCABULARY, so the vocabulary stays per-group --
 * a closed `z.enum` in each `contract.ts`, so an exhaustive `switch` over one
 * group's codes is possible -- and the two things that are genuinely identical
 * live here: what a line looks like, and what makes a list non-empty.
 *
 * WHY THIS FILE IS UNDER `lib/db/`. Because the FIRST line of every one of those
 * trails is which storage adapter answered, and that is decided by the
 * composition root next door. A trail primitive with no home tends to acquire
 * one per consumer; putting it beside the thing that produces its first entry
 * gives it exactly one.
 *
 * NO SCHEMA IS BUILT HERE, deliberately. Each group builds its own over its own
 * enum, which keeps the inferred response types concrete and readable; a generic
 * zod helper would make every group's response type an inference puzzle for the
 * sake of one saved line. Zod appears below only as the `ZodIssue` TYPE, in the
 * one function that turns a failed parse into trail lines -- which is trail
 * construction, not schema construction, and is shared for the same reason the
 * rest of this file is.
 * ---------------------------------------------------------------------- */

/**
 * One line of a trail.
 *
 * `code` is machine-readable and closed per group; `detail` is for humans and is
 * never parsed. That split is the rule `domains/failover.ts` argues for: the
 * moment a consumer decides anything by matching substrings of prose, a reworded
 * message becomes a behaviour change no type, test or review can see.
 *
 * There is no `candidateId` here, unlike the playback trail. These routes make
 * one decision about one request; there is nothing to attribute a line to.
 */
export interface ReasonLine<Code extends string> {
  readonly code: Code;
  /** Never empty. See `reason` for what guarantees that. */
  readonly detail: string;
}

/**
 * A trail that cannot be empty.
 *
 * A mutable tuple rather than a `readonly` one, because zod's `.nonempty()`
 * infers `[T, ...T[]]` and a readonly tuple is not assignable to it. The arrays
 * this produces are freshly built and handed straight to a response, so nothing
 * observable depends on their mutability.
 */
export type NonEmptyReasons<Code extends string> = [ReasonLine<Code>, ...ReasonLine<Code>[]];

/**
 * Builds a line.
 *
 * The empty-`detail` fallback is not defensive clutter, and it is the same one
 * `playbackReason` carries: `detail` is `.min(1)` in every schema below, the
 * schema is enforced on the way out, and several details are strings produced by
 * other packages -- `ProfileCreationRefusal.detail`, `ListLimitRejection.detail`.
 * One of those returning `""` some day would turn a correct refusal into a 500.
 * The code is always a truthful minimum, so falling back to it costs legibility
 * rather than correctness.
 */
export function reason<Code extends string>(code: Code, detail: string): ReasonLine<Code> {
  return { code, detail: detail.trim() === "" ? code : detail };
}

/**
 * `[head, ...rest]` typed as the non-empty tuple the schemas require.
 *
 * The assertion states the tuple rather than leaning on inference. A spread
 * literal in a return position is one of the few places where whether an array
 * widens to `ReasonLine[]` or stays `[ReasonLine, ...ReasonLine[]]` depends on
 * inference rules rather than on anything written down. It cannot be wrong:
 * `head` is non-optional and the spread follows it.
 */
export function trail<Code extends string>(
  head: ReasonLine<Code>,
  rest: readonly ReasonLine<Code>[]
): NonEmptyReasons<Code> {
  return [head, ...rest] as NonEmptyReasons<Code>;
}

/**
 * Code-point order, so a sorted trail is a function of the SET of things being
 * reported rather than of the order a client happened to serialise them in.
 *
 * `localeCompare` would be locale-dependent, which would make the response body
 * a function of the server's ICU data.
 */
function compareCodePoint(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

/**
 * Turns a failed `safeParse` into a trail.
 *
 * AN UNRECOGNISED KEY GETS ITS OWN CODE rather than being folded into
 * "malformed", and it is ordered FIRST. `issue-session.ts` makes the same choice
 * for the same reason: an unaccepted field is a client trying to hand an
 * endpoint something the endpoint refuses to honour, and it has to be visible as
 * itself in logs and metrics rather than averaged into typos. If a missing field
 * spoke first, that refusal would be buried in a trail nobody reads past the
 * first line of.
 *
 * Ties break on the detail text by code point, so the whole list is a function
 * of the request rather than of zod's traversal order.
 *
 * ALWAYS NON-EMPTY. Zod does not report a failure with zero issues, but its type
 * does not say so, and a `!` here would make the trail depend on a library's
 * undocumented behaviour. `fallbackDetail` is what a zero-issue failure would
 * publish instead.
 */
export function requestIssueTrail<Code extends string>(
  issues: readonly ZodIssue[],
  codes: { readonly malformed: Code; readonly fieldNotPermitted: Code },
  fallbackDetail: string
): NonEmptyReasons<Code> {
  const rank = (line: ReasonLine<Code>): number =>
    line.code === codes.fieldNotPermitted ? 0 : 1;

  const lines = issues
    .map((issue): ReasonLine<Code> => {
      if (issue.code === "unrecognized_keys") {
        const keys = [...issue.keys].sort(compareCodePoint).join(", ");
        const where = issue.path.length === 0 ? "the request" : issue.path.join(".");
        return reason(
          codes.fieldNotPermitted,
          `${where} carries field(s) this endpoint does not accept: ${keys}`
        );
      }
      const where = issue.path.length === 0 ? "request" : issue.path.join(".");
      return reason(codes.malformed, `${where}: ${issue.message}`);
    })
    .sort((left, right) => rank(left) - rank(right) || compareCodePoint(left.detail, right.detail));

  const [primary, ...rest] = lines;
  if (primary === undefined) return trail(reason(codes.malformed, fallbackDetail), []);
  return trail(primary, rest);
}
