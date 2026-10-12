/* -------------------------------------------------------------------------
 * WHAT A PROFILE WITH NOTHING IN IT IS TOLD (W132-F)
 *
 * ==========================================================================
 * THE DEFECT CLASS: AN EMPTY STATE THAT REPORTS A FACT AND OFFERS NO ACT
 * ==========================================================================
 *
 * A new profile's first visit is the one moment where every surface in this
 * product is simultaneously correct and useless. The watchlist is empty, the
 * continue-watching rail has nothing to resume, the settings screen offers a
 * form over defaults nobody has changed, and every one of those is the TRUE
 * answer. A household that has just created a profile reads them as a product
 * that does not work.
 *
 * `watchlist-list.tsx` already gets this right for one screen -- "Nothing on
 * your list yet / Add a title from its page or from a card on the home screen"
 * with a link to the catalog -- and that copy is the model this module
 * generalises. What it cannot do is be reused: it is JSX inside a component in
 * a repository whose Vitest environment is `node`, so the copy cannot be tested
 * and the next surface to need it will write its own.
 *
 * ==========================================================================
 * IT NEVER INVENTS A STEP THE BUILD CANNOT PERFORM
 * ==========================================================================
 *
 * This is where onboarding copy goes wrong in a product with gaps. "Mark your
 * favourites" is a perfectly good suggestion and THIS BUILD HAS NO FAVOURITES
 * STORAGE -- see `profile-library.ts`. A step pointing at a feature that does
 * not exist is worse than no step: it sends a household looking for a control,
 * and when they do not find it the conclusion is that they are using it wrong.
 *
 * So every step carries `blocked`, a step whose facet reports
 * `not-implemented` is blocked with the detail the facet gave, and
 * `actionableSteps` is what a panel renders. The blocked ones are available to
 * a screen that wants to be explicit, and are never drawn as invitations.
 *
 * ==========================================================================
 * IT DOES NOT FIRE ON A FAILED READ
 * ==========================================================================
 *
 * `libraryIsFirstRun` is the gate, and it answers `false` for an unreadable
 * facet rather than `true`. Showing "add your first title" to a household with
 * forty titles and a database that is down is the defect that version of this
 * module would have shipped: cheerful onboarding over a real failure, with the
 * failure hidden.
 *
 * NO CLOCK AND NO COUNTER. There is no "seen it already" state, because
 * recording one would need either browser storage -- forbidden in this
 * repository by rule, enforced by `auth-ui.test.tsx` and `profile-ui.test.tsx`
 * -- or a new column. The panel appears exactly while the profile is empty and
 * stops the moment it is not, which needs nothing stored and cannot get out of
 * step with the thing it describes.
 * ---------------------------------------------------------------------- */
import {
  libraryIsFirstRun,
  type ProfileLibrarySnapshot
} from "./profile-library";

/** One thing a household can do next. */
export interface OnboardingStep {
  readonly id: "browse" | "list" | "resume" | "settings" | "favourites";
  /** The invitation, as a verb. */
  readonly label: string;
  /** Why it is worth doing, in one sentence a person reads. */
  readonly detail: string;
  /**
   * Where it goes, or `null` for a step with no destination.
   *
   * AN APP-RELATIVE PATH AND NEVER A FULL URL. A caller-supplied absolute URL
   * rendered into an `href` is an open redirect, and `avatar.ts` records the
   * same refusal about `avatarKey` for the same reason. These are literals in
   * this file, so the property holds by construction -- and
   * `onboarding.test.ts` asserts it so a later edit cannot quietly add one.
   */
  readonly href: string | null;
  /**
   * Why this step cannot be taken in this build, or `null`.
   *
   * A blocked step is NOT rendered as an invitation. See the header.
   */
  readonly blocked: string | null;
}

/** What a first-run panel shows. */
export interface Onboarding {
  readonly heading: string;
  readonly lead: string;
  readonly steps: readonly OnboardingStep[];
}

/**
 * The steps, in the order a household would actually take them.
 *
 * BROWSE IS FIRST AND SETTINGS IS LAST, deliberately. Every other order makes
 * the product's first instruction a configuration task: a new viewer has
 * nothing to configure a preference FOR, and a screen that opens with
 * "choose your preferred audio languages" is asking a question whose answer
 * cannot be checked against anything. Watch something, then tune it.
 */
function stepsFor(snapshot: ProfileLibrarySnapshot): readonly OnboardingStep[] {
  const favourites = snapshot.favourites;
  return [
    {
      id: "browse",
      label: "Find something to watch",
      detail:
        "Everything this installation can play is in the catalog. If the catalog is empty too, nothing has been added to this library yet — that is a fact about the files on this machine, not about your profile.",
      href: "/",
      blocked: null
    },
    {
      id: "list",
      label: "Keep a list",
      detail:
        "Add to My List on a title's page, or on any card, puts it on your list. The list belongs to this profile and nobody else in the household sees it.",
      href: "/watchlist",
      blocked: null
    },
    {
      id: "resume",
      label: "Pick up where you stopped",
      detail:
        "Once you have watched part of something, it appears on the home screen with the position you left it at. Nothing appears here until then, which is why this profile has no Continue watching row yet.",
      href: null,
      blocked: null
    },
    {
      id: "settings",
      label: "Choose your languages, once you have something to watch",
      detail:
        "Preferred audio and subtitle languages are stored on this profile. They are worth setting after you have found a title, so you can tell whether they did what you wanted.",
      href: "/settings",
      blocked: null
    },
    {
      /*
       * PRESENT AND BLOCKED RATHER THAN OMITTED. A household that has used
       * other players looks for favourites and concludes they are using this
       * one wrongly; naming the gap is shorter than the search. It is never
       * drawn as an invitation -- `actionableSteps` filters it out -- so a
       * screen has to opt into saying it.
       */
      id: "favourites",
      label: "Mark favourites",
      detail: "A separate shelf of the titles you keep coming back to.",
      href: null,
      blocked:
        favourites.status === "not-implemented"
          ? favourites.detail
          : favourites.status === "unavailable"
            ? "favourites could not be read, so this screen cannot say whether you have any"
            : null
    }
  ];
}

/**
 * The onboarding for this profile, or `null` when there is nothing to onboard.
 *
 * `null` IS THE COMMON CASE AND IS NOT A FAILURE. A profile with a list and
 * some history needs no explanation, and a panel that kept appearing would be
 * the product repeating its own instructions to somebody who has followed
 * them.
 */
export function onboardingFor(snapshot: ProfileLibrarySnapshot): Onboarding | null {
  if (!libraryIsFirstRun(snapshot)) return null;
  return {
    heading: "This profile is new, so there is nothing here yet",
    lead:
      "Nothing below is missing or broken. A profile starts with no list and nothing watched, and these are the things that fill it.",
    steps: stepsFor(snapshot)
  };
}

/**
 * The steps a panel may render as invitations.
 *
 * A FUNCTION RATHER THAN A FILTER AT EVERY CALL SITE, so the rule that a
 * blocked step is never an invitation is stated once and cannot be forgotten by
 * the next surface that renders these.
 */
export function actionableSteps(onboarding: Onboarding): readonly OnboardingStep[] {
  return onboarding.steps.filter((step) => step.blocked === null);
}

/** The steps a panel may render as honest gaps. */
export function blockedSteps(onboarding: Onboarding): readonly OnboardingStep[] {
  return onboarding.steps.filter((step) => step.blocked !== null);
}

/**
 * The empty-state copy for one surface, whether or not it is a first run.
 *
 * ==========================================================================
 * WHY THIS IS SEPARATE FROM `onboardingFor`
 * ==========================================================================
 *
 * A watchlist can be empty on a profile that is NOT new -- somebody removed
 * their last title -- and the first-run panel would be wrong there: it would
 * explain the product to a household that has been using it for months. This
 * answers the narrower question: what does THIS empty shelf say about itself.
 *
 * It returns `null` for an unreadable facet, because an empty state is a claim
 * about the viewer's data and a failed read is not evidence for one. The
 * caller's failure panel owns that case, and every list screen in this
 * application already has one.
 */
export interface EmptyShelfCopy {
  readonly heading: string;
  readonly detail: string;
  readonly actionHref: string | null;
  readonly actionLabel: string | null;
}

export function emptyWatchlistCopy(snapshot: ProfileLibrarySnapshot): EmptyShelfCopy | null {
  if (snapshot.watchlist.status !== "ok" || snapshot.watchlist.entries.length > 0) return null;
  const firstRun = libraryIsFirstRun(snapshot);
  return {
    heading: "Nothing on your list yet",
    detail: firstRun
      ? "This profile is new. Add a title from its page or from a card on the home screen, and it will be here — on this profile only."
      : "Add a title from its page or from a card on the home screen, and it will be here.",
    actionHref: "/",
    actionLabel: "Browse the catalog"
  };
}
