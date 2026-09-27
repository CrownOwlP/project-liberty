import Link from "next/link";

import { AppShell } from "../../components/shell/app-shell";
import { CredentialsForm } from "../../components/auth/credentials-form";
import { resolveAuthPolicy, signUpCanComplete } from "../../components/auth/auth-policy";
import { safeNextPath } from "../../components/auth/next-path";
import styles from "../../components/auth/auth.module.css";

export const revalidate = 0;

export const metadata = {
  title: "Create an account — Project Liberty",
  robots: { index: false, follow: false }
};

/* -------------------------------------------------------------------------
 * Creating an account (PW-0312)
 *
 * THIS SCREEN REFUSES TO OFFER A FORM IT KNOWS CANNOT COMPLETE, which is the
 * whole reason it consults the policy rather than just rendering. With
 * `requireEmailVerification: true` and no mail transport -- the state every
 * Liberty deployment is in today -- a successful sign-up creates an account
 * that can never sign in and takes the address while doing it. That is worse
 * than refusing, and it is invisible: the form would report success.
 *
 * WHERE THE SUCCESS GOES depends on the same policy. With verification
 * required, the viewer is NOT signed in afterwards and is told to check their
 * email; without it, they are signed in and are sent where they were going.
 * ---------------------------------------------------------------------- */

export default async function SignUpPage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const next = safeNextPath((await searchParams).next);
  const policy = resolveAuthPolicy();

  if (!signUpCanComplete(policy)) {
    return (
      <AppShell pathname="/signup" badge={null}>
        <section className={`section ${styles.panel}`}>
          <h1>Create an account</h1>
          <div className="state-panel" role="status">
            <h2>Not yet on this deployment</h2>
            <p>
              {policy.available
                ? "New accounts here must confirm an email address, and this deployment has no way to send one. Until that is configured, an account created now could never be used."
                : "This deployment has no identity system configured, so there is nothing to create an account in."}
            </p>
            {policy.available && (
              <p className={styles.alternate}>
                Already have an account? <Link href="/signin">Sign in</Link>.
              </p>
            )}
          </div>
        </section>
      </AppShell>
    );
  }

  return (
    <AppShell pathname="/signup" badge={null}>
      <section className={`section ${styles.panel}`}>
        <h1>Create an account</h1>
        <CredentialsForm
          mode="sign-up"
          next={next}
          successMode={policy.requiresEmailVerification ? "await-verification" : "navigate"}
        />
        <p className={styles.alternate}>
          Already have an account? <Link href="/signin">Sign in</Link>.
        </p>
      </section>
    </AppShell>
  );
}
