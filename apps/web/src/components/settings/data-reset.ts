/* -------------------------------------------------------------------------
 * DATA RESET AND DELETION, AND WHAT THIS BUILD CAN ACTUALLY REMOVE (W132-F)
 *
 * ==========================================================================
 * THE DEFECT CLASS THIS FILE EXISTS TO PREVENT: A BUTTON THAT OVER-PROMISES
 * ==========================================================================
 *
 * "Delete all my data" is the single easiest control in a product to ship
 * dishonestly. It is one button, it returns 200, and the thing a viewer cannot
 * check is the only thing they wanted. The failure is not a crash: it is a
 * household that believes a sibling's viewing history is gone when it is still
 * in the database, and nothing anywhere reports a discrepancy.
 *
 * So this module does not describe an intention. It ENUMERATES THE REQUESTS a
 * reset will actually make, from the endpoints that actually exist, and the
 * confirmation sentence is GENERATED FROM THAT ENUMERATION rather than written
 * beside it. A target with no endpoint cannot produce a plan, so there is no
 * code path by which a viewer is shown a confirmation for something that will
 * not happen.
 *
 * ==========================================================================
 * WHAT THIS BUILD CAN AND CANNOT DELETE, ESTABLISHED BY READING THE ROUTES
 * ==========================================================================
 *
 * Checked against the exported verbs under `app/api/v1/`, not against memory:
 *
 *   PREFERENCES -- `DELETE /api/v1/profiles/preferences` EXISTS. It is a real
 *     delete and not a blank: `forgetMediaPreferences` removes the row, which
 *     is the distinction `preferences.ts` goes to the trouble of preserving
 *     ("clearing is not the same as leaving the lists empty").
 *
 *   WATCHLIST -- `DELETE /api/v1/watchlist/[contentId]` EXISTS, per entry.
 *     There is NO bulk delete, so clearing a list is N requests and this module
 *     says so: the plan holds one request per entry, the confirmation names the
 *     count, and a partial failure is reported as partial rather than as a
 *     success. A bulk endpoint is a proposed diff in this round's report.
 *
 *   WATCH HISTORY / RESUME POSITIONS -- THERE IS NO DELETE. `app/api/v1/
 *     progress/[contentId]/route.ts` exports `GET` and `PUT` and nothing else.
 *     So this build CANNOT delete a viewing history, and the honest control
 *     says that rather than offering a button that clears the screen.
 *
 *   A PROFILE ITSELF -- THERE IS NO DELETE. `archiveProfile` exists in
 *     `@liberty/persistence` and is deliberately absent from
 *     `LibertyRepository` -- that file names it in its "WHAT IS DELIBERATELY
 *     NOT HERE" list, with the reason: "A port method with no caller is a
 *     method whose in-memory implementation is never executed." There is no
 *     route either. Profile deletion is therefore NOT DONE in this build, and
 *     the proposed diff for the port, the route and the control is in this
 *     round's report rather than a half-wired button here.
 *
 *   EVERYTHING -- there is no whole-app wipe, because it would be the union of
 *     the two above plus the account, and two of the four parts have no
 *     endpoint. A control that deleted the parts it could and stayed quiet
 *     about the rest is the exact over-promise this module exists to prevent.
 *
 * ==========================================================================
 * IT NAMES WHAT STAYS, NOT ONLY WHAT GOES
 * ==========================================================================
 *
 * Every target carries `keeps` as well as `removes`. A confirmation that lists
 * only what it will remove is read as "and nothing else survives", which is
 * how a viewer comes to believe their history went with their watchlist. The
 * sentence a household reads is the one place in the product where an omission
 * is itself a false statement.
 *
 * NOTHING HERE PERFORMS A REQUEST. This module builds plans and verdicts; the
 * component sends them. That split is what lets every rule below be a unit test
 * in a `node` environment with no DOM, which is the only place logic in this
 * application can be tested at all.
 * ---------------------------------------------------------------------- */
import {
  facetIsTrulyEmpty,
  type ProfileLibrarySnapshot
} from "../profiles/profile-library";

/** The things a viewer can ask to have removed, including the ones we cannot. */
export type ResetTargetId = "preferences" | "watchlist" | "history" | "profile" | "everything";

/**
 * One request a plan will make.
 *
 * A METHOD AND A URL AND NOTHING ELSE -- no body, no headers, no profile id.
 * Every endpoint below derives the scope from the session, so there is nothing
 * for a caller to supply and no field in which a client-held scope could
 * appear. PL-0405's forgeable-scope defect is structurally unreachable from
 * here because the shape has nowhere to put one.
 */
export interface ResetRequest {
  readonly method: "DELETE";
  readonly url: string;
  /** What this one request removes, for a per-request failure report. */
  readonly describes: string;
}

/**
 * Whether a target can be acted on at all, and why not when it cannot.
 *
 * `no-endpoint` IS A FACT ABOUT THE BUILD, not about this viewer and not about
 * this request. Retrying does not help and neither does signing in, which is
 * why it is not folded into a generic failure: sending a household to check
 * their network for a feature that does not exist is worse than telling them
 * the truth.
 */
export type ResetAvailability = "available" | "no-endpoint";

export interface ResetTarget {
  readonly id: ResetTargetId;
  /** What a household calls it. */
  readonly label: string;
  readonly availability: ResetAvailability;
  /** Exactly what goes. One clause per thing, in a viewer's words. */
  readonly removes: readonly string[];
  /** Exactly what STAYS. See the header: an omission here is a false claim. */
  readonly keeps: readonly string[];
  /** Why it cannot be done, naming the missing endpoint. `null` when it can. */
  readonly unavailableBecause: string | null;
}

/**
 * The catalogue of targets, with the truth about each.
 *
 * THESE SENTENCES ARE CHECKED AGAINST THE ROUTES BY `data-reset.test.ts`,
 * which reads the route files and asserts that a target marked `available` has
 * a `DELETE` export behind it and a target marked `no-endpoint` does not. The
 * defect that guards against is the one this whole module is about: prose about
 * deletion drifting from the deletion that exists, silently.
 */
export const RESET_TARGETS: readonly ResetTarget[] = Object.freeze([
  Object.freeze({
    id: "preferences" as const,
    label: "Your playback settings",
    availability: "available" as const,
    removes: Object.freeze([
      "your preferred audio and subtitle languages",
      "your subtitle mode and your subtitles-for-the-deaf-and-hard-of-hearing choice",
      "your playback diagnostics choice"
    ]),
    keeps: Object.freeze([
      "your list",
      "where you got to in anything you have watched",
      "this profile itself"
    ]),
    unavailableBecause: null
  }),
  Object.freeze({
    id: "watchlist" as const,
    label: "Your list",
    availability: "available" as const,
    removes: Object.freeze(["every title you have added to your list"]),
    keeps: Object.freeze([
      "where you got to in anything you have watched",
      "your playback settings",
      "this profile itself"
    ]),
    unavailableBecause: null
  }),
  Object.freeze({
    id: "history" as const,
    label: "What you have watched",
    availability: "no-endpoint" as const,
    removes: Object.freeze([]),
    keeps: Object.freeze([]),
    unavailableBecause:
      "this build has no way to delete watch history: /api/v1/progress/[contentId] offers GET and PUT and no DELETE, so there is no request this screen could send"
  }),
  Object.freeze({
    id: "profile" as const,
    label: "This profile",
    availability: "no-endpoint" as const,
    removes: Object.freeze([]),
    keeps: Object.freeze([]),
    unavailableBecause:
      "this build has no way to delete a profile: there is no DELETE route under /api/v1/profiles and the repository port carries no archive or delete method"
  }),
  Object.freeze({
    id: "everything" as const,
    label: "Everything on this installation",
    availability: "no-endpoint" as const,
    removes: Object.freeze([]),
    keeps: Object.freeze([]),
    unavailableBecause:
      "two of the four things a full reset would remove -- watch history and profiles -- have no delete endpoint in this build, and a control that removed the other two while staying quiet about those would be telling you your data was gone when it was not"
  })
]);

export function resetTarget(id: ResetTargetId): ResetTarget {
  const found = RESET_TARGETS.find((target) => target.id === id);
  /*
   * A `ResetTargetId` that is not in the table is a programming error rather
   * than a runtime state -- the type is closed and the table is exhaustive, and
   * `data-reset.test.ts` asserts that. A throw here would be a crash on a
   * settings screen for a typo; the unavailable target is the answer that keeps
   * the screen up and says something true.
   */
  return found ?? {
    id,
    label: "Unknown",
    availability: "no-endpoint",
    removes: [],
    keeps: [],
    unavailableBecause: "this screen does not know what that is, so it will not delete anything"
  };
}

/** A plan that can be carried out, or a statement of why there is none. */
export type ResetPlan =
  | {
      readonly kind: "plan";
      readonly target: ResetTarget;
      readonly requests: readonly ResetRequest[];
      /** The sentence a viewer confirms. Generated, never written beside this. */
      readonly confirmation: string;
    }
  | {
      readonly kind: "nothing-to-do";
      readonly target: ResetTarget;
      readonly detail: string;
    }
  | {
      readonly kind: "unavailable";
      readonly target: ResetTarget;
      readonly detail: string;
    };

const PREFERENCES_ENDPOINT = "/api/v1/profiles/preferences";

function watchlistEntryEndpoint(contentId: string): string {
  /* ENCODED, because a content id reaches this from a stored row and a row can
   * hold anything a past build wrote. An unencoded id with a `/` or a `?` in it
   * would address a different route entirely. */
  return `/api/v1/watchlist/${encodeURIComponent(contentId)}`;
}

/**
 * Join clauses into a sentence a person reads, not a bullet list.
 *
 * The Oxford comma is deliberate: "your languages, your list and your history"
 * is ambiguous about whether the last two are one thing, and this is the one
 * sentence in the product where an ambiguity is a consent problem.
 */
function sentenceList(clauses: readonly string[]): string {
  /* Indexed reads are guarded rather than asserted: `noUncheckedIndexedAccess`
   * is on in this workspace, and a `!` here would be exactly the unchecked
   * access the flag exists to find. */
  const last = clauses[clauses.length - 1];
  if (last === undefined) return "";
  if (clauses.length === 1) return last;
  return `${clauses.slice(0, -1).join(", ")}, and ${last}`;
}

/**
 * What a reset would actually do, given what this profile currently holds.
 *
 * THE SNAPSHOT IS REQUIRED AND IS NOT OPTIONAL. A confirmation that says "this
 * will remove every title on your list" without knowing how many there are is
 * the over-promise in miniature: it cannot distinguish an empty list (nothing
 * to confirm) from forty entries (a decision worth pausing over) from an
 * unreadable one (where the only honest answer is that we do not know what we
 * would be deleting).
 *
 * AN UNREADABLE FACET PRODUCES NO PLAN. That is the sharp case: a watchlist
 * that could not be read yields `unavailable`, never a plan with zero requests
 * that would report "done" and leave everything in place.
 */
export function resetPlan(id: ResetTargetId, snapshot: ProfileLibrarySnapshot): ResetPlan {
  const target = resetTarget(id);

  if (target.availability === "no-endpoint") {
    return {
      kind: "unavailable",
      target,
      detail: target.unavailableBecause ?? "this build cannot remove that"
    };
  }

  if (snapshot.profileId === null) {
    return {
      kind: "unavailable",
      target,
      detail: "no profile is in use, so there is nothing scoped to delete; choose who is watching first"
    };
  }

  if (target.id === "preferences") {
    /*
     * NO "NOTHING TO DO" SHORTCUT FOR PREFERENCES, and the asymmetry with the
     * watchlist below is deliberate. This screen does not know whether a row
     * exists -- `stored` lives on the preferences read, which is the language
     * form's own state and not in this snapshot -- and the endpoint is
     * idempotent, so sending the delete is both correct and cheap. Guessing
     * "you have nothing stored" from a snapshot that does not carry the fact
     * would be the screen inventing an answer.
     */
    return {
      kind: "plan",
      target,
      requests: [
        { method: "DELETE", url: PREFERENCES_ENDPOINT, describes: "your playback settings" }
      ],
      confirmation: confirmationSentence(target, 1)
    };
  }

  /* target.id === "watchlist" */
  const facet = snapshot.watchlist;
  if (facet.status !== "ok") {
    return {
      kind: "unavailable",
      target,
      detail:
        "your list could not be read, so this screen does not know what it would be deleting and will not guess"
    };
  }
  if (facet.entries.length === 0) {
    return { kind: "nothing-to-do", target, detail: "your list is already empty" };
  }

  return {
    kind: "plan",
    target,
    requests: facet.entries.map((entry) => ({
      method: "DELETE" as const,
      url: watchlistEntryEndpoint(entry.contentId),
      describes: entry.contentId
    })),
    confirmation: confirmationSentence(target, facet.entries.length)
  };
}

/**
 * The sentence a viewer confirms.
 *
 * GENERATED FROM THE TARGET AND THE COUNT, so it cannot describe a removal the
 * plan does not perform. It names the count because "every title on your list"
 * and "all 37 titles on your list" are different decisions, and it names what
 * STAYS because a list of removals alone reads as "and nothing else survives".
 */
export function confirmationSentence(target: ResetTarget, requestCount: number): string {
  const removals = sentenceList(target.removes);
  const kept = sentenceList(target.keeps);
  const scale =
    requestCount > 1 ? ` This is ${String(requestCount)} separate removals.` : "";
  return (
    `This removes ${removals}, for the profile in use and no other.${scale}` +
    ` It does not remove ${kept}.` +
    " It cannot be undone."
  );
}

/** What one request did. Supplied by the component, which is what sends them. */
export interface ResetRequestOutcome {
  readonly request: ResetRequest;
  readonly removed: boolean;
}

/**
 * Whether a reset actually happened, checked against a FRESH READ.
 *
 * ==========================================================================
 * THIS IS THE "IT IS ACTUALLY GONE" CHECK, AND IT DOES NOT TRUST THE RESPONSES
 * ==========================================================================
 *
 * The obvious verification is "every request answered 200, so it worked", and
 * it is exactly the verification that cannot catch the failure that matters: an
 * endpoint that answers 200 and deletes nothing. `settleState` in
 * `watchlist-state.ts` documents the same class -- "a refused write must not
 * render as a success, which is the shape of defect the harnesses in this
 * repository have caught four times" -- and a deletion is the version of it
 * with the highest cost, because the viewer's belief is unfalsifiable from the
 * screen.
 *
 * So this takes the snapshot read AFTER the reset and asks the store. The
 * outcomes are used only to explain a partial result, never to decide one.
 *
 * `unverified` IS NOT `gone`. A post-reset read that failed proves nothing, and
 * a screen that said "your data is gone" on the strength of a failed read would
 * be making the one claim this module exists to stop.
 */
export type ResetVerdict =
  | { readonly status: "gone" }
  | { readonly status: "partial"; readonly remaining: number; readonly detail: string }
  | { readonly status: "unverified"; readonly detail: string };

/**
 * Verify a watchlist reset.
 *
 * Only the watchlist is verifiable this way today, and the reason is honest
 * rather than incidental: a snapshot carries the list, and preference
 * verification would need the `stored` flag from a fresh preferences read,
 * which belongs to the language form that owns that row. `verifyPreferencesGone`
 * below takes that flag directly so the caller holding it can do the check, and
 * neither function infers one from the other.
 */
export function verifyWatchlistGone(after: ProfileLibrarySnapshot): ResetVerdict {
  if (after.watchlist.status !== "ok") {
    return {
      status: "unverified",
      detail:
        "your list could not be read after the removals, so this screen cannot confirm anything was deleted"
    };
  }
  const remaining = after.watchlist.entries.length;
  if (remaining === 0) return { status: "gone" };
  return {
    status: "partial",
    remaining,
    detail: `${String(remaining)} ${remaining === 1 ? "title is" : "titles are"} still on your list; nothing else was changed`
  };
}

/**
 * Verify a preferences reset from the flag the endpoint answers.
 *
 * `stored === false` AFTER A DELETE IS THE PROOF, and it is the whole reason
 * `storedMediaPreferencesSchema` carries the flag: "never chosen" and "chose
 * nothing" have identical values, so a verification that compared VALUES could
 * not tell a successful delete from a write of empty lists. The flag is the
 * only thing that can.
 */
export function verifyPreferencesGone(stored: boolean | null): ResetVerdict {
  if (stored === null) {
    return {
      status: "unverified",
      detail:
        "your settings could not be read after the removal, so this screen cannot confirm anything was deleted"
    };
  }
  return stored
    ? {
        status: "partial",
        remaining: 1,
        detail: "your settings are still stored; nothing was deleted"
      }
    : { status: "gone" };
}

/**
 * Whether there is anything at all to offer a reset for.
 *
 * Used to decide whether the section renders its controls or its first-run
 * explanation. It reads `facetIsTrulyEmpty` rather than a length, so an
 * unreadable list does NOT look like an empty one -- offering "there is nothing
 * to delete" to somebody whose database is down would be a claim about their
 * data made from a failed read.
 */
export function hasAnythingToReset(snapshot: ProfileLibrarySnapshot): boolean {
  if (snapshot.profileId === null) return false;
  return !facetIsTrulyEmpty(snapshot.watchlist) || snapshot.watchlist.status !== "ok";
}
