"use client";

import { useCallback, useState, type FormEvent } from "react";

import { requestPasswordReset } from "./auth-client";
import styles from "./auth.module.css";

/* -------------------------------------------------------------------------
 * Getting back into an account (PW-0312)
 *
 * THE CLAUSE MOST LIKELY TO BE GOT WRONG, AND THE ONE THIS FILE IS MOSTLY
 * ABOUT. `lib/session/auth-instance.ts` wires `noMailTransport`, which THROWS
 * rather than logging the link, because a password-reset URL is a one-click
 * account-takeover token. The temptation on a deployment with no transport is
 * to be helpful -- print the link, copy it to the clipboard, show it in a
 * developer panel -- and every one of those undoes the reason that function
 * throws. This component shows the viewer NOTHING but a sentence saying the
 * message cannot be sent, and there is no code path here that could display,
 * log or copy a token, because no token ever reaches this process.
 *
 * THE RESULT IS NOT REPORTED AS A YES OR A NO. Whatever the server says, the
 * viewer is told the same thing: if that address has an account, a message is
 * on its way. A form that confirmed only for known addresses is an
 * account-existence oracle anybody can query at leisure, which is the same
 * non-oracle rule `deploymentSessionAccount` applies to its four session
 * failures. `unreachable` is the one exception and is not an exception to the
 * rule: it reports that nothing was sent at all, which says nothing about the
 * address.
 * ---------------------------------------------------------------------- */

export interface PasswordResetEntryProps {
  /**
   * Whether this deployment can actually deliver a message.
   *
   * Resolved on the server by `passwordResetCanStart`, and passed in rather
   * than read here: a client component cannot see the composition root, and a
   * client that guessed would eventually offer a form that silently does
   * nothing.
   */
  readonly canStart: boolean;
}

type Phase = "idle" | "pending" | "sent" | "unreachable";

export function PasswordResetEntry({ canStart }: PasswordResetEntryProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [open, setOpen] = useState(false);

  const submit = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const email = String(data.get("resetEmail") ?? "");
    setPhase("pending");
    const result = await requestPasswordReset(email);
    setPhase(result.outcome === "unreachable" ? "unreachable" : "sent");
  }, []);

  if (!canStart) {
    return (
      <p className={styles.alternate}>
        Forgotten your password? This deployment has no way to send email yet, so a reset message
        cannot be sent. Ask whoever runs it to configure one.
      </p>
    );
  }

  if (phase === "sent") {
    /*
     * The same sentence for every address. See the header: reporting "sent" for
     * known addresses and something else for unknown ones is the oracle.
     */
    return (
      <p className={styles.alternate} role="status">
        If that address has an account, a reset message is on its way. Check your email.
      </p>
    );
  }

  if (!open) {
    return (
      <p className={styles.alternate}>
        <button className={styles.signOut} type="button" onClick={() => setOpen(true)}>
          Forgotten your password?
        </button>
      </p>
    );
  }

  return (
    <form className={styles.form} onSubmit={submit} aria-label="Reset your password">
      <label className={styles.field}>
        <span>Email</span>
        <input
          name="resetEmail"
          type="email"
          required
          autoComplete="username"
          disabled={phase === "pending"}
          className={styles.input}
        />
      </label>
      <button className="button button-secondary" type="submit" disabled={phase === "pending"}>
        {phase === "pending" ? "Sending…" : "Send a reset link"}
      </button>
      {phase === "unreachable" && (
        <p className={styles.failure} role="alert">
          That didn&apos;t reach the server, so nothing was sent. Check your connection and try
          again.
        </p>
      )}
    </form>
  );
}
