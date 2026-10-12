"use client";

/* -------------------------------------------------------------------------
 * The reset and deletion controls (W132-F)
 *
 * ==========================================================================
 * WHAT IS IN THIS FILE AND WHAT DELIBERATELY IS NOT
 * ==========================================================================
 *
 * `apps/web` runs Vitest in a `node` environment with no DOM, so logic left in
 * a component is logic no unit test can reach. Every rule about WHAT a reset
 * removes, what sentence a viewer confirms, and whether it actually happened
 * lives in `data-reset.ts` and is tested there against a table. This file
 * sends the requests the plan names, in order, and reports what came back.
 *
 * ==========================================================================
 * IT VERIFIES AGAINST A FRESH READ AND NEVER AGAINST THE RESPONSES
 * ==========================================================================
 *
 * The obvious implementation reports success when every `DELETE` answered 2xx,
 * and that is the one implementation that cannot catch the failure that
 * matters: an endpoint that answers 200 and deletes nothing. `settleState` in
 * `watchlist-state.ts` documents the same class -- "a refused write must not
 * render as a success, which is the shape of defect the harnesses in this
 * repository have caught four times" -- and a deletion is the version with the
 * highest cost, because the viewer's belief is unfalsifiable from the screen.
 *
 * So after the removals this re-reads `GET /api/v1/watchlist` (or the
 * preferences endpoint) and asks `verifyWatchlistGone` / `verifyPreferencesGone`
 * what the store now says. A read that fails reports `unverified`, which is NOT
 * "gone": a screen saying "your data is gone" on the strength of a failed read
 * is the one false statement a deletion control must never make.
 *
 * ==========================================================================
 * A TWO-STEP CONFIRMATION, AND NO `window.confirm`
 * ==========================================================================
 *
 * `confirm()` is a browser dialog whose text is unstyled, untranslatable,
 * unreadable by the page's own assistive-technology affordances, and -- in a
 * packaged WebView2 build -- not guaranteed to appear at all. The confirmation
 * is in the document: pressing the button reveals the generated sentence and a
 * second, explicit control. Pressing once removes nothing.
 *
 * NO PROFILE ID IS SENT, IN ANY FIELD. Every endpoint derives the scope from
 * the session, and `resetPlan` produces URLs with no room for one. This
 * component could not address another household's data if it tried.
 *
 * NO BROWSER STORAGE. This repository forbids `localStorage` and
 * `sessionStorage` by rule; the pending state below is React state that dies
 * with the page, which is correct for a confirmation nobody should be able to
 * resume from a previous visit.
 * ---------------------------------------------------------------------- */

import { useState } from "react";

import type { ProfileLibrarySnapshot } from "../profiles/profile-library";
import { snapshotFromBody } from "../watchlist/watchlist-source";
import {
  RESET_TARGETS,
  resetPlan,
  verifyPreferencesGone,
  verifyWatchlistGone,
  type ResetPlan,
  type ResetTargetId,
  type ResetVerdict
} from "./data-reset";
import styles from "./settings.module.css";

type Phase =
  | { readonly kind: "idle" }
  | { readonly kind: "confirming"; readonly plan: ResetPlan }
  | { readonly kind: "working"; readonly target: ResetTargetId }
  | { readonly kind: "settled"; readonly target: ResetTargetId; readonly verdict: ResetVerdict };

/**
 * Re-read the watchlist and say what the store now holds.
 *
 * `snapshotFromBody` IS REUSED RATHER THAN REIMPLEMENTED. It already parses
 * this endpoint's body defensively and answers `null` for anything it does not
 * recognise, and a second parser here would be a second opinion about what the
 * wire format is -- the one that drifted would be the one nobody noticed.
 */
async function reReadWatchlist(): Promise<ProfileLibrarySnapshot["watchlist"]> {
  try {
    const response = await fetch("/api/v1/watchlist", {
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json" }
    });
    const ids = snapshotFromBody(await response.json());
    if (ids === null) return { status: "unavailable", reason: "watchlist_unreadable" };
    return {
      status: "ok",
      /* `addedAt` is not on this endpoint's list shape and is not invented: the
       * verification counts entries and reads no instant. A fabricated date
       * would be a value another consumer could later believe. */
      entries: ids.map((contentId) => ({ contentId, addedAt: "" }))
    };
  } catch {
    return { status: "unavailable", reason: "watchlist_unreachable" };
  }
}

/** Re-read the preferences row and answer whether anything is still stored. */
async function reReadPreferencesStored(): Promise<boolean | null> {
  try {
    const response = await fetch("/api/v1/profiles/preferences", {
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json" }
    });
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null) return null;
    const record = body as { outcome?: unknown; stored?: unknown };
    if (record.outcome !== "read") return null;
    /*
     * `stored === false` AFTER A DELETE IS THE PROOF, and it is the whole
     * reason `storedMediaPreferencesSchema` carries the flag: "never chosen"
     * and "chose nothing" have identical VALUES, so a verification comparing
     * values could not tell a successful delete from a write of empty lists.
     */
    return typeof record.stored === "boolean" ? record.stored : null;
  } catch {
    return null;
  }
}

export function DataResetSection({ snapshot }: { snapshot: ProfileLibrarySnapshot }) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  const run = async (plan: ResetPlan): Promise<void> => {
    if (plan.kind !== "plan") return;
    setPhase({ kind: "working", target: plan.target.id });

    /*
     * SEQUENTIAL, NOT `Promise.all`. A watchlist reset is one request per
     * entry, and firing fifty at once at a single-connection development
     * database is how a reset becomes a timeout that deleted some unknown
     * prefix of the list. The verification below does not care about the order
     * either way, so there is nothing to buy by racing them.
     *
     * A FAILED REQUEST DOES NOT STOP THE LOOP. Stopping would leave a partial
     * deletion the viewer cannot complete without pressing the button again on
     * a list that now looks different; continuing and then verifying reports
     * exactly what survived.
     */
    for (const request of plan.requests) {
      try {
        await fetch(request.url, {
          method: request.method,
          cache: "no-store",
          credentials: "same-origin",
          headers: { accept: "application/json" }
        });
      } catch {
        /* Swallowed on purpose: the verification below is the authority on
         * what happened, and a thrown fetch tells us nothing a re-read will not
         * tell us more reliably. */
      }
    }

    const verdict =
      plan.target.id === "watchlist"
        ? verifyWatchlistGone({ ...snapshot, watchlist: await reReadWatchlist() })
        : verifyPreferencesGone(await reReadPreferencesStored());

    setPhase({ kind: "settled", target: plan.target.id, verdict });
  };

  return (
    <section className="section" aria-labelledby="settings-reset">
      <h2 id="settings-reset">Remove your data</h2>
      <p>
        Everything below is stored on this installation and on the profile in use. Nothing is sent
        anywhere and there is no copy of it in a cloud service to delete separately.
      </p>

      <ul className={styles.resetTargets}>
        {RESET_TARGETS.map((target) => {
          const plan = resetPlan(target.id, snapshot);
          const confirming = phase.kind === "confirming" && phase.plan.target.id === target.id;
          const working = phase.kind === "working" && phase.target === target.id;
          const settled = phase.kind === "settled" && phase.target === target.id;

          return (
            <li
              key={target.id}
              className={`${styles.resetTarget} ${
                plan.kind === "plan" ? "" : styles.resetUnavailable
              }`}
            >
              <h3>{target.label}</h3>

              {/*
                WHAT THIS BUILD CANNOT DO IS STATED, NOT OMITTED. A missing
                control is read as a control somebody has not found yet; a
                sentence naming the absent endpoint is read as the truth. See
                `data-reset.ts` for which endpoints exist and which do not.
              */}
              {plan.kind === "unavailable" ? <p>{plan.detail}</p> : null}
              {plan.kind === "nothing-to-do" ? <p>{plan.detail}</p> : null}

              {plan.kind === "plan" && !confirming && !settled ? (
                <p>
                  <button type="button" onClick={() => setPhase({ kind: "confirming", plan })}>
                    Remove…
                  </button>
                </p>
              ) : null}

              {/*
                THE CONFIRMATION, IN THE DOCUMENT. It is the generated sentence
                from `confirmationSentence`, so it cannot describe a removal the
                plan will not perform, and it names what STAYS as well as what
                goes -- a list of removals alone reads as "and nothing else
                survives".
              */}
              {confirming && phase.plan.kind === "plan" ? (
                <>
                  <p className={styles.confirmation}>{phase.plan.confirmation}</p>
                  <p>
                    <button type="button" onClick={() => void run(phase.plan)}>
                      Yes, remove it
                    </button>{" "}
                    <button type="button" onClick={() => setPhase({ kind: "idle" })}>
                      Keep it
                    </button>
                  </p>
                </>
              ) : null}

              {working ? <p aria-live="polite">Removing…</p> : null}

              {settled ? (
                <p role="status" className={styles.confirmation}>
                  {/*
                    THREE OUTCOMES AND NONE OF THEM COLLAPSES. `unverified` is
                    not success: it says the removals were sent and the check
                    could not be made, which is the honest report of a failed
                    re-read and the one thing a deletion control must not round
                    up to "done".
                  */}
                  {phase.verdict.status === "gone"
                    ? "Checked: it is gone. This screen re-read the store after the removal rather than trusting the response."
                    : phase.verdict.status === "partial"
                      ? phase.verdict.detail
                      : phase.verdict.detail}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
