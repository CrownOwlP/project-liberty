/* -------------------------------------------------------------------------
 * What the watchlist control shows, decided away from the component (PW-0304).
 *
 * THE DEFECT THIS FILE EXISTS TO PREVENT IS NAMED IN THE ACCEPTANCE: "a refused
 * write must not render as a success, which is the shape of defect the
 * harnesses in this repository have caught four times." An optimistic control
 * is exactly where that happens -- the button flips the moment it is pressed,
 * and if nothing reconciles the flip against the answer, a refusal looks
 * identical to an acceptance until the page is reloaded.
 *
 * So the decision is a pure function of (what the list said before, what the
 * user asked for, what the server answered), and the component does nothing but
 * call it. `apps/web` runs Vitest in a `node` environment with no DOM --
 * `components/title/title-styles.test.ts` says so in its own header -- so logic
 * left inside a component is logic no unit test can reach. This is the half
 * that can be tested, and `watchlist-state.test.ts` tests it.
 *
 * ==========================================================================
 * THE VOCABULARY IS THE API'S, AND IT IS BOUND AT COMPILE TIME
 * ==========================================================================
 *
 * `/api/v1/watchlist/[contentId]` does not answer with a boolean. It answers
 * with one of four outcomes, and a `mutated` carries which of four mutation
 * reasons applied. `WATCHLIST_PRESENCE_AFTER` maps all four, and the type
 * annotation is what makes it a CLOSED set: the contract's
 * `watchlistOutcomeReason` exists so that a fifth outcome fails to compile
 * rather than reaching a client as an unlisted code, and the same must be true
 * here or the client quietly gains a default.
 *
 * THE PRESENCE COMES FROM THE REASON, NEVER FROM `changed`. `changed` says
 * whether THIS request did anything; it is false for `already_present` and
 * `not_present`, both of which are successes -- the API is idempotent on
 * purpose, because the client is "a button on a remote control behind an
 * unreliable network". A control that read `changed` as "did it work" would
 * show a failure every time a retry converged.
 *
 * THE IMPORT IS TYPE-ONLY. Pulling the contract module into a client bundle
 * would drag zod and the persistence types across a boundary they have no
 * business crossing; `import type` is erased, so the binding costs nothing at
 * runtime and still fails the build if the vocabulary moves.
 * ---------------------------------------------------------------------- */
import type { WatchlistReasonCode } from "../../app/api/v1/watchlist/contract";

/**
 * Whether the title is on this profile's list.
 *
 * `unknown` IS A REAL STATE AND NOT A LOADING FLAG. These controls render on
 * server components -- a title page, a catalog rail -- and reading a profile's
 * list on the server would make every page that shows a card dynamic, which is
 * the exact cost `account-region.tsx` already refused to pay for the session.
 * So the control is rendered before its answer exists, and the honest first
 * paint is "I do not know yet" rather than "Add to My List", which would be a
 * lie to anyone whose list already holds this title.
 */
export type WatchlistPresence = "on-list" | "off-list" | "unknown";

/** What the person asked for. */
export type WatchlistIntent = "add" | "remove";

/** The four mutation reasons, and what each means the list now holds. */
const WATCHLIST_PRESENCE_AFTER = {
  added: "on-list",
  already_present: "on-list",
  removed: "off-list",
  not_present: "off-list"
} as const satisfies Record<
  Extract<WatchlistReasonCode, "added" | "already_present" | "removed" | "not_present">,
  WatchlistPresence
>;

type MutationReason = keyof typeof WATCHLIST_PRESENCE_AFTER;

function isMutationReason(code: string): code is MutationReason {
  return Object.hasOwn(WATCHLIST_PRESENCE_AFTER, code);
}

export interface WatchlistControlState {
  /** What the control draws. */
  readonly presence: WatchlistPresence;
  /** Non-null while a request is in flight, so the control can disable itself. */
  readonly pending: WatchlistIntent | null;
  /**
   * What went wrong, in words, or `null`. NEVER set on a success -- including
   * the two idempotent successes, which are not warnings.
   */
  readonly notice: string | null;
}

export function restingState(presence: WatchlistPresence): WatchlistControlState {
  return { presence, pending: null, notice: null };
}

/**
 * The optimistic flip.
 *
 * It clears any previous notice, because a stale refusal sitting beside a fresh
 * attempt reads as a refusal of the fresh one.
 */
export function optimisticState(
  intent: WatchlistIntent
): WatchlistControlState {
  return {
    presence: intent === "add" ? "on-list" : "off-list",
    pending: intent,
    notice: null
  };
}

/**
 * What a response actually says, parsed defensively.
 *
 * `fetch` hands back `unknown`, and this runs against whatever a proxy, a
 * captive portal or a future version of the route returns. The schema in
 * `contract.ts` is the authority on the wire format and is NOT imported at
 * runtime for the reason in the header; this reads the three fields the control
 * needs and treats anything else as unusable rather than as a success.
 */
export interface ParsedWatchlistAnswer {
  readonly outcome: "mutated" | "refused" | "unavailable" | "listed";
  readonly firstReason: string | null;
}

export function parseWatchlistAnswer(body: unknown): ParsedWatchlistAnswer | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  const outcome = record["outcome"];
  if (
    outcome !== "mutated" &&
    outcome !== "refused" &&
    outcome !== "unavailable" &&
    outcome !== "listed"
  ) {
    return null;
  }
  const reasons = record["reasons"];
  const first = Array.isArray(reasons) ? reasons[0] : undefined;
  const code =
    typeof first === "object" && first !== null && typeof (first as { code?: unknown }).code === "string"
      ? ((first as { code: string }).code)
      : null;
  return { outcome, firstReason: code };
}

/**
 * Sentences for the refusals a person can actually act on.
 *
 * A code the user cannot do anything about gets the generic line rather than
 * its own wording -- `unexpected_repository_failure` is not more actionable for
 * being spelled out, and inventing twelve sentences would mean twelve chances
 * to describe a state wrongly.
 */
const NOTICE_BY_REASON: Readonly<Partial<Record<string, string>>> = {
  not_authenticated: "Sign in to use your list.",
  authentication_not_configured: "This installation has no sign-in configured, so lists are unavailable.",
  no_active_profile_selected: "Choose a profile first.",
  profile_unavailable: "That profile is unavailable.",
  profile_archived: "That profile is archived.",
  requested_profile_is_not_active: "That profile is not the one in use.",
  storage_not_configured: "This installation has no storage configured, so lists are unavailable.",
  database_url_malformed: "This installation's storage is misconfigured, so lists are unavailable."
};

const GENERIC_REFUSAL = "Your list could not be updated. Nothing changed.";
const GENERIC_UNAVAILABLE = "Your list is unavailable right now. Nothing changed.";
const UNREADABLE = "Your list could not be updated: the server's answer was not understood.";

/**
 * Reconcile the optimistic flip against what the server said.
 *
 * @param before the presence BEFORE the optimistic flip -- what a refusal rolls
 * back to. Taking it as an argument rather than inferring it from the intent is
 * deliberate: the two agree today, and a control that inferred it would silently
 * start lying the first time the list could be in a third state.
 */
export function settleState(
  before: WatchlistPresence,
  answer: ParsedWatchlistAnswer | null
): WatchlistControlState {
  if (answer === null) {
    return { presence: before, pending: null, notice: UNREADABLE };
  }

  if (answer.outcome === "mutated") {
    const code = answer.firstReason;
    if (code !== null && isMutationReason(code)) {
      /* THE SERVER'S REASON IS THE AUTHORITY, not the intent. If an `add`
       * somehow comes back `removed`, the list holds what the server says it
       * holds and the control must show that rather than what was asked for. */
      return { presence: WATCHLIST_PRESENCE_AFTER[code], pending: null, notice: null };
    }
    /* `mutated` with a reason this client does not know is NOT a success to
     * render: the list's state is genuinely unknown to us. Roll back and say so
     * rather than guessing from the intent. */
    return { presence: before, pending: null, notice: UNREADABLE };
  }

  if (answer.outcome === "listed") {
    /* A list response to a mutation request is a contract violation, not a
     * success. Treated as unreadable for the same reason as above. */
    return { presence: before, pending: null, notice: UNREADABLE };
  }

  const notice =
    (answer.firstReason === null ? undefined : NOTICE_BY_REASON[answer.firstReason]) ??
    (answer.outcome === "refused" ? GENERIC_REFUSAL : GENERIC_UNAVAILABLE);

  /* THE ROLLBACK. This is the line the acceptance is about. */
  return { presence: before, pending: null, notice };
}

/**
 * The request a given intent makes. Here so the component states no routes.
 *
 * ADDING IS A `PUT`, NOT A `POST`, AND THIS LINE WAS WRONG UNTIL THE E2E GATE
 * CAUGHT IT. The first draft of this module sent `POST` -- the reflex verb for
 * "create" -- and `watchlist-state.test.ts` asserted `POST` beside it, so the
 * unit layer confirmed the mistake rather than finding it. What the route
 * actually exports is `PUT` and `DELETE`, and `[contentId]/route.ts` says why
 * in its own header: "PUT rather than POST because the path already names the
 * entry and the operation is idempotent". A `POST` to it answers 405, which is
 * the server being right.
 *
 * It cost one browser run to find and is the reason `watchlist-ui.test.tsx`
 * now reads the route module and asserts that the verbs this function produces
 * are verbs that module exports. A test that restates the implementation's
 * belief is not a check on it.
 */
export function watchlistRequest(contentId: string, intent: WatchlistIntent): {
  readonly url: string;
  readonly method: "PUT" | "DELETE";
} {
  return {
    url: `/api/v1/watchlist/${encodeURIComponent(contentId)}`,
    method: intent === "add" ? "PUT" : "DELETE"
  };
}

/** The label a control shows for a presence, and the action pressing it takes. */
export function controlAffordance(presence: WatchlistPresence): {
  readonly label: string;
  readonly intent: WatchlistIntent;
  /** False while the answer is unknown: a toggle with no state cannot be pressed. */
  readonly actionable: boolean;
} {
  if (presence === "unknown") {
    return { label: "My List", intent: "add", actionable: false };
  }
  return presence === "on-list"
    ? { label: "Remove from My List", intent: "remove", actionable: true }
    : { label: "Add to My List", intent: "add", actionable: true };
}

/** Where a control's starting presence comes from, given the list it was told about. */
export function presenceFromList(
  contentIds: readonly string[] | null,
  contentId: string
): WatchlistPresence {
  if (contentIds === null) return "unknown";
  return contentIds.includes(contentId) ? "on-list" : "off-list";
}
