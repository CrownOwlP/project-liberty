import Link from "next/link";

import { AppShell } from "../../components/shell/app-shell";
import { CredentialsForm } from "../../components/auth/credentials-form";
import { PasswordResetEntry } from "../../components/auth/password-reset-entry";
import { safeNextPath } from "../../components/auth/next-path";
import {
  passwordResetCanStart,
  resolveAuthPolicy,
  signUpCanComplete
} from "../../components/auth/auth-policy";
import styles from "../../components/auth/auth.module.css";

/**
 * Rendered per request. The policy below is a fact about the running process,
 * and a statically baked page would freeze whichever answer the build machine
 * happened to have.
 */
export const revalidate = 0;

export const metadata = {
  title: "Sign in — Project Liberty",
  /* `noindex` because a sign-in form is not a page anybody should arrive at
   * from a search engine, and because the `?next=` parameter makes every
   * destination a separate crawlable URL. */
  robots: { index: false, follow: false }
};

/* -------------------------------------------------------------------------
 * Signing in (PW-0312)
 *
 * THE SCREEN THAT DID NOT EXIST. `/api/auth/*` has been served since PW-0403
 * and nothing linked to it, so a deployment refused everybody correctly and
 * offered them nowhere to go. This is the somewhere.
 *
 * IT STATES WHAT THIS DEPLOYMENT CAN DO, NOT WHAT THE LIBRARY CAN. Three
 * different pages are rendered from one file depending on facts the process
 * holds: no identity instance at all, an instance with no way to send email,
 * and a working one. The acceptance asks for exactly that -- "the screen must
 * reflect what this deployment can do" -- and the alternative, a form that
 * submits into a 503, is the dead end this task exists to remove.
 * ---------------------------------------------------------------------- */

export default async function SignInPage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  /*
   * NARROWED BEFORE IT IS USED, AND IT IS THE FIRST THING THIS PAGE DOES.
   * `next` arrives in a query string, which is how a sign-in screen becomes an
   * open redirect. `safeNextPath` accepts only a same-origin path; see
   * `next-path.ts` for the near-misses a host check would let through.
   */
  const next = safeNextPath((await searchParams).next);
  const policy = resolveAuthPolicy();

  return (
    <AppShell pathname="/signin" badge={null}>
      <section className={`section ${styles.panel}`}>
        <h1>Sign in</h1>

        {!policy.available ? (
          /*
           * NO INSTANCE. A form here could only submit into a 503, so there is
           * no form. What the viewer is told is true and is not their problem;
           * what they are NOT told is which environment variable is missing,
           * because that sentence is for an operator reading a log and this
           * page is public.
           */
          <div className="state-panel" role="status">
            <h2>Accounts aren&apos;t set up here yet</h2>
            <p>
              This deployment has no identity system configured, so there is nothing to sign in to.
              Nothing is wrong with your account — there are no accounts yet.
            </p>
          </div>
        ) : (
          <>
            <CredentialsForm mode="sign-in" next={next} />

            <PasswordResetEntry canStart={passwordResetCanStart(policy)} />

            {signUpCanComplete(policy) ? (
              <p className={styles.alternate}>
                No account yet? <Link href="/signup">Create one</Link>.
              </p>
            ) : (
              /*
               * SIGN-UP IS OFFERED ONLY WHEN IT CAN COMPLETE. On a deployment
               * that requires a verified address and cannot send a message, an
               * account can be created that nobody can ever sign in to -- and
               * the address is then taken. Linking to that form would be
               * offering something this deployment cannot honour.
               */
              <p className={styles.alternate}>
                New accounts can&apos;t be created here yet: this deployment requires a verified
                email address and has no way to send one.
              </p>
            )}
          </>
        )}
      </section>
    </AppShell>
  );
}
