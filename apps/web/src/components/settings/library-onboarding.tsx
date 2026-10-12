/* -------------------------------------------------------------------------
 * The first-run panel (W132-F)
 *
 * A SERVER COMPONENT, WITH NO STATE AND NO EFFECT, and that is what makes it
 * testable. `apps/web/vitest.config.ts` sets `environment: "node"`: a
 * `"use client"` component rendering `next/link` cannot be rendered in a test
 * at all -- React throws "invariant expected app router to be mounted" -- while
 * a pure server component renders with `renderToStaticMarkup`, which is how
 * `profile-ui.test.tsx` and `settings.test.tsx` already work.
 *
 * ALL THE COPY AND EVERY DECISION ARE IN `profiles/onboarding.ts`. This file
 * chooses no words and makes no judgement about whether to appear: it renders
 * `null` when `onboardingFor` answers `null`, and the rules about WHEN that
 * happens -- never over a failed read, never for a profile with anything in it,
 * never for a step this build cannot perform -- are unit-tested there. A
 * component is the one place in this repository where logic cannot be tested,
 * so none is put here.
 * ---------------------------------------------------------------------- */
import Link from "next/link";

import {
  actionableSteps,
  blockedSteps,
  onboardingFor
} from "../profiles/onboarding";
import type { ProfileLibrarySnapshot } from "../profiles/profile-library";
import styles from "./settings.module.css";

export function LibraryOnboarding({ snapshot }: { snapshot: ProfileLibrarySnapshot }) {
  const onboarding = onboardingFor(snapshot);
  /*
   * `null` IS THE COMMON CASE AND IS NOT A FAILURE. A profile with a list and
   * some history needs no explanation, and a panel that kept appearing would
   * be the product repeating its own instructions to somebody who has already
   * followed them.
   */
  if (onboarding === null) return null;

  return (
    <section className="section" aria-labelledby="settings-onboarding">
      <div className="state-panel">
        <h2 id="settings-onboarding">{onboarding.heading}</h2>
        <p>{onboarding.lead}</p>

        <ul className={styles.steps}>
          {actionableSteps(onboarding).map((step) => (
            <li key={step.id} className={styles.step}>
              <h3>{step.label}</h3>
              <p>{step.detail}</p>
              {/*
                A LINK ONLY WHERE THERE IS SOMEWHERE TO GO. The "pick up where
                you stopped" step has no destination -- there is nothing to
                resume yet, which is the point of saying it -- and an anchor to
                `/` there would send a household somewhere that does not answer
                the sentence above it.
              */}
              {step.href === null ? null : (
                <p>
                  <Link href={step.href}>{step.label}</Link>
                </p>
              )}
            </li>
          ))}
        </ul>

        {/*
          THE GAPS ARE NAMED RATHER THAN HIDDEN. A household that has used other
          players looks for favourites and, not finding them, concludes it is
          using this one wrongly. Saying "this build has no favourites storage"
          is shorter than that search and is true.

          They are rendered in their own list, dimmed, with the reason attached
          -- never beside the invitations, where a step with no link reads as a
          link that failed to load.
        */}
        {blockedSteps(onboarding).length === 0 ? null : (
          <>
            <h3>Not in this build</h3>
            <ul className={styles.steps}>
              {blockedSteps(onboarding).map((step) => (
                <li key={step.id} className={`${styles.step} ${styles.stepBlocked}`}>
                  <h4>{step.label}</h4>
                  <p>{step.blocked}</p>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}
