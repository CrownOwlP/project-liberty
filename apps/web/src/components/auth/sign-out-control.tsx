"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";

import { signOut } from "./auth-client";
import styles from "./auth.module.css";

/* -------------------------------------------------------------------------
 * Signing out (PW-0312)
 *
 * A BUTTON IN A FORM, NEVER A LINK. Signing out changes state on the server,
 * and a GET that changes state is followed by link prefetchers, crawlers,
 * antivirus scanners and mail clients -- the classic way an application logs
 * its own users out when somebody hovers a message. `onSubmit` with
 * `preventDefault` keeps it a real submission for a browser with no JavaScript
 * while letting this component handle the response.
 *
 * THE SERVER ENDS THE SESSION, AND THIS FILE DOES NOT PRETEND TO. There is no
 * cookie cleared here, no local state discarded, no optimistic "signed out"
 * render: the request deletes the session ROW, which is the whole point of
 * PL-0401's ruling that Liberty uses database sessions, and `router.refresh()`
 * then asks the server what the shell should now say. A client that decided for
 * itself would show "signed out" over a session that is still live.
 * ---------------------------------------------------------------------- */

export function SignOutControl() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  const submit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (pending) return;
      setPending(true);

      const result = await signOut();

      /*
       * REFRESHED ON EVERY OUTCOME, INCLUDING FAILURE, and that is deliberate.
       * If the request did not reach the server the session is still live, and
       * the honest thing is to re-ask the server rather than to leave the
       * topbar asserting either state. The refresh answers it: still signed in,
       * or not.
       */
      void result;
      setPending(false);
      router.refresh();
      router.replace("/");
    },
    [pending, router]
  );

  return (
    <form onSubmit={submit}>
      <button className={styles.signOut} type="submit" disabled={pending}>
        {pending ? "Signing out…" : "Sign out"}
      </button>
    </form>
  );
}
