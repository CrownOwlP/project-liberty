"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { probeSession, type SessionProbe } from "./auth-client";
import { SignOutControl } from "./sign-out-control";
import { UNNAMED_ACCOUNT_LABEL } from "./account-label";
import styles from "./auth.module.css";

/* -------------------------------------------------------------------------
 * The account region in the topbar (PW-0312)
 *
 * A CLIENT COMPONENT, AND THAT IS THE SHELL'S OWN RULE RATHER THAN A
 * PREFERENCE. `app-shell.tsx` is a server component on purpose, and it already
 * opens exactly one client boundary -- the active profile badge -- with the
 * reason written beside it: "it reads the session, and a server shell that did
 * the same would make every route dynamic". Reading the account on the server
 * here would do precisely that to every page in the application, including the
 * ones PL-0704 depends on rendering a status from. So this is the second
 * boundary of the same kind, opened for the same reason, and it asks the server
 * the same way the badge does.
 *
 * IT SITS BESIDE THE PROFILE BADGE, NOT INSTEAD OF IT. Two facts, two elements.
 * The badge says which profile is watching; this says which account is signed
 * in. The acceptance requires that neither be mistaken for the other, and
 * `packages/auth/src/session.ts` spends a header on why profiles live ABOVE
 * auth rather than inside it.
 *
 * NOTHING IS DECIDED HERE. There is no cookie read, no token decoded and no
 * cached identity: `probeSession` asks the server and this renders the answer.
 * A first paint shows nothing at all rather than guessing -- a topbar that
 * flashed "Sign in" at a signed-in viewer is a worse lie than a moment of
 * nothing, and the moment is one same-origin request long.
 * ---------------------------------------------------------------------- */

export function AccountRegion() {
  const [probe, setProbe] = useState<SessionProbe | null>(null);

  useEffect(() => {
    /*
     * `live` is the unmount guard, and it is here for the reason
     * `profile-picker.tsx` records: a `setState` after unmount is both a React
     * warning and a real bug on a shell that re-renders on every navigation.
     */
    let live = true;
    void probeSession().then((result) => {
      if (live) setProbe(result);
    });
    return () => {
      live = false;
    };
  }, []);

  /* Not yet asked, or nobody to sign in. Both render nothing; see the header. */
  if (probe === null || probe.outcome === "unavailable") return null;

  if (probe.outcome === "signed-out") {
    return (
      <Link className={styles.account} href="/signin">
        Sign in
      </Link>
    );
  }

  return (
    <div className={styles.account}>
      {/*
        The label is announced with what it MEANS. On its own "Priya" in a
        topbar is a word; "Signed in as Priya" is the fact. The visible text
        stays short because the screen it sits on is across a room.
      */}
      <span className="visually-hidden">Signed in as</span>
      <span className={styles.accountName}>{probe.name ?? UNNAMED_ACCOUNT_LABEL}</span>
      <SignOutControl />
    </div>
  );
}
