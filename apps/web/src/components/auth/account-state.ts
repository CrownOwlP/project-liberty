import { resolveAuthInstance } from "../../lib/session/auth-instance";

import { UNNAMED_ACCOUNT_LABEL } from "./account-label";

/* -------------------------------------------------------------------------
 * Who this browser is signed in AS (PW-0312)
 *
 * A DIFFERENT FACT FROM WHICH PROFILE IS SELECTED, and the acceptance says so
 * in terms: "who you are SIGNED IN AS is a different fact from which profile is
 * selected. Both belong there and neither may be mistaken for the other." The
 * account is the household's login; the profile is who in the household is
 * watching. `components/profiles/active-profile-badge.tsx` renders the second
 * and this module feeds the first, and they sit beside each other in the shell
 * rather than one standing in for the other.
 *
 * IT DOES NOT MOVE PROFILES INTO BETTER AUTH, which the acceptance forbids and
 * which a file called "account state" is exactly where somebody would do. This
 * module asks the auth instance one question -- is there a verified session,
 * and what does the account call itself -- and knows nothing about profiles.
 * `active_profile_selection` stays keyed by session in Liberty's own store, and
 * `packages/auth/src/session.ts` explains at length why.
 * ---------------------------------------------------------------------- */

/**
 * What the shell renders.
 *
 * THREE STATES, AND `unavailable` IS NOT `signed-out`. A deployment with no
 * identity instance has nobody to sign in and nowhere to send them; offering a
 * "Sign in" link there is a link to a screen that can only apologise. A
 * development process is in this state too, and correctly: it has an identity,
 * but not one anybody signed into or can sign out of.
 */
export type AccountState =
  | { readonly kind: "unavailable" }
  | { readonly kind: "signed-out" }
  | { readonly kind: "signed-in"; readonly label: string };

/*
 * `UNNAMED_ACCOUNT_LABEL` LIVES IN `./account-label.ts` AND NOT HERE, because
 * the client component that renders it must not import this file: this one
 * reaches the auth composition root, and through it `@liberty/persistence` and
 * `pg`. That is a bundle boundary a unit suite cannot see and only `next build`
 * enforces -- see that module's header for the build failure it was extracted
 * from.
 */

/** What `auth.api.getSession` gives back, as much of it as this module reads. */
interface SessionShape {
  readonly user?: { readonly name?: unknown } | null;
  readonly session?: { readonly id?: unknown } | null;
}

/**
 * Resolve the account state from a request's headers.
 *
 * HEADERS IN, NOT A `Request`, for the reason `loadContinueWatching` takes the
 * same: the session cookie is the only input that decides anything, a server
 * component holds `headers()` rather than a request, and taking the narrower
 * thing keeps the synthesis in one visible place.
 *
 * NEVER THROWS. The shell renders on every route in the application, so an
 * exception here is every page in the product replaced by an error -- including
 * the sign-in screen that would fix it.
 */
export async function resolveAccountState(requestHeaders: Headers): Promise<AccountState> {
  let resolution: ReturnType<typeof resolveAuthInstance>;
  try {
    resolution = resolveAuthInstance();
  } catch {
    return { kind: "unavailable" };
  }
  if (!resolution.ok) return { kind: "unavailable" };

  let session: SessionShape | null | undefined;
  try {
    session = (await resolution.auth.api.getSession({ headers: requestHeaders })) as
      | SessionShape
      | null
      | undefined;
  } catch {
    /*
     * The store could not answer. Reported as signed-out rather than as
     * unavailable, because the remedy a viewer is offered -- a sign-in link --
     * is the correct one either way, and claiming "no identity system here" on
     * a deployment that has one would be a worse lie than the momentary one.
     */
    return { kind: "signed-out" };
  }

  if (session === null || session === undefined) return { kind: "signed-out" };
  if (typeof session.session?.id !== "string") return { kind: "signed-out" };

  const name = session.user?.name;
  const label = typeof name === "string" && name.trim() !== "" ? name.trim() : UNNAMED_ACCOUNT_LABEL;
  return { kind: "signed-in", label };
}
