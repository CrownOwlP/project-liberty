"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState, type FormEvent } from "react";

import { GENERIC_REFUSAL, signIn, signUp, type AuthCallResult } from "./auth-client";
import styles from "./auth.module.css";

/* -------------------------------------------------------------------------
 * The sign-in and sign-up form (PW-0312)
 *
 * ONE COMPONENT FOR BOTH, and that is a decision rather than a saving. The two
 * screens differ in three things -- one extra field, which endpoint is called,
 * and what happens on success -- and everything else about them is identical:
 * the same labels, the same disabled-while-pending rule, the same refusal
 * presentation, the same non-oracle sentence, the same autocomplete hints.
 * Written as two components they would drift, and the thing that would drift
 * first is the part that matters: the refusal wording, which is deliberately
 * the same for a wrong password and an unknown address.
 *
 * A CLIENT COMPONENT, AND THE ONLY ONE THIS SURFACE HAS. It needs to hold a
 * password in memory long enough to send it, disable itself while a request is
 * in flight, and show what came back -- none of which a server component can
 * do. Everything else on these screens is server-rendered.
 *
 * NOTHING ABOUT THE SESSION IS READ HERE. On success the server has set the
 * cookie and `router.refresh()` makes the server re-render the shell, which is
 * what updates the account state. There is no client-side session object, no
 * second cookie and no token in storage -- the acceptance forbids all three,
 * and the reason is that a client that believes it knows who you are will
 * eventually disagree with the server that decides.
 * ---------------------------------------------------------------------- */

export type CredentialsMode = "sign-in" | "sign-up";

export interface CredentialsFormProps {
  readonly mode: CredentialsMode;
  /**
   * What success means on this deployment.
   *
   * `navigate` is a viewer who is now signed in. `await-verification` is a
   * sign-up on a deployment that requires an address to be verified first --
   * there, the account exists and the viewer CANNOT yet sign in, so navigating
   * them to a protected page would refuse them and look like the sign-up
   * failed. Which one applies is a POLICY fact the server resolved; see
   * `auth-policy.ts`.
   */
  readonly successMode?: "navigate" | "await-verification";
  /**
   * Where to go after the server accepts.
   *
   * ALREADY VALIDATED BY THE SERVER COMPONENT THAT RENDERS THIS. See
   * `safeNextPath` in `./next-path.ts`: a destination that arrived in a query
   * string is an open-redirect waiting to happen, so it is narrowed to a
   * same-origin path before it ever reaches this file, and this component has
   * no way to widen it again.
   */
  readonly next: string;
}

type Phase =
  | { readonly kind: "idle" }
  | { readonly kind: "pending" }
  | { readonly kind: "verify" }
  | { readonly kind: "refused"; readonly detail: string }
  | { readonly kind: "unreachable" };

const COPY = {
  "sign-in": {
    submit: "Sign in",
    pending: "Signing in…",
    endpointLabel: "Sign in to Project Liberty"
  },
  "sign-up": {
    submit: "Create account",
    pending: "Creating your account…",
    endpointLabel: "Create a Project Liberty account"
  }
} as const;

function describe(result: Exclude<AuthCallResult, { outcome: "accepted" }>): Phase {
  if (result.outcome === "unreachable") return { kind: "unreachable" };
  if (result.outcome === "unreadable") {
    /*
     * The server answered with something this build could not read. That is
     * ours, not the viewer's, and it is reported as such rather than as a
     * credential problem -- telling somebody their password is wrong when the
     * API changed shape is how a support queue fills up with correct passwords.
     */
    return {
      kind: "refused",
      detail: "the sign-in service answered in a way this build did not understand"
    };
  }
  return { kind: "refused", detail: result.detail || GENERIC_REFUSAL };
}

export function CredentialsForm({ mode, next, successMode = "navigate" }: CredentialsFormProps) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const copy = COPY[mode];

  const submit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (phase.kind === "pending") return;

      /*
       * READ OFF THE FORM, NOT HELD IN STATE. The password is in the DOM for as
       * long as the field exists either way, but keeping it out of React state
       * keeps it out of every render, every devtools inspection of this
       * component, and every future `console.log` of `phase`.
       */
      const data = new FormData(event.currentTarget);
      const email = String(data.get("email") ?? "");
      const password = String(data.get("password") ?? "");
      const name = String(data.get("name") ?? "");

      setPhase({ kind: "pending" });
      const result =
        mode === "sign-in"
          ? await signIn({ email, password })
          : await signUp({ email, password, name });

      if (result.outcome === "accepted") {
        if (successMode === "await-verification") {
          /*
           * The account exists and the viewer is NOT signed in. Navigating
           * anywhere protected would refuse them and read as a failed sign-up,
           * so the form is replaced by the one sentence that is true.
           */
          setPhase({ kind: "verify" });
          return;
        }
        /*
         * `replace`, NOT `push`. The back button must not return a
         * newly-signed-in viewer to a sign-in form that would then submit
         * again; and `refresh` first, so the server re-renders the shell with
         * the account state before the navigation lands.
         */
        router.refresh();
        router.replace(next);
        return;
      }

      setPhase(describe(result));
    },
    [mode, next, phase.kind, router, successMode]
  );

  const pending = phase.kind === "pending";

  /*
   * THE VERIFICATION STATE REPLACES THE FORM RATHER THAN SITTING BESIDE IT. A
   * form still on screen after a successful sign-up invites a second submission
   * that can only fail with "that address is taken", which reads as though the
   * first one did not work.
   */
  if (phase.kind === "verify") {
    return (
      <div className={styles.form} role="status">
        <p>
          Your account is created. Check <strong>your email</strong> for a message confirming the
          address, then come back and sign in.
        </p>
        <p className={styles.alternate}>
          The link in that message is the only way to confirm the address. Nobody from Project
          Liberty will ever ask you for it.
        </p>
      </div>
    );
  }

  return (
    <form className={styles.form} onSubmit={submit} aria-label={copy.endpointLabel}>
      {mode === "sign-up" && (
        <label className={styles.field}>
          <span>Name</span>
          <input
            name="name"
            type="text"
            required
            autoComplete="name"
            disabled={pending}
            className={styles.input}
          />
        </label>
      )}

      <label className={styles.field}>
        <span>Email</span>
        <input
          name="email"
          type="email"
          required
          /* `username` rather than `email`: it is what password managers look
           * for on a credential form, and getting it wrong means they do not
           * offer to fill or to save. */
          autoComplete="username"
          disabled={pending}
          className={styles.input}
        />
      </label>

      <label className={styles.field}>
        <span>Password</span>
        <input
          name="password"
          type="password"
          required
          /*
           * The one place these two forms genuinely differ in an attribute, and
           * it matters: `new-password` asks a manager to GENERATE one and to
           * offer to save it, `current-password` asks it to fill the saved one.
           * Using `current-password` on a sign-up form is how people end up
           * reusing a password their manager would have replaced.
           */
          autoComplete={mode === "sign-up" ? "new-password" : "current-password"}
          disabled={pending}
          className={styles.input}
        />
      </label>

      <button className="button button-primary" type="submit" disabled={pending}>
        {pending ? copy.pending : copy.submit}
      </button>

      {/*
        `role="alert"` so the refusal is announced rather than silently
        appearing below a form somebody is still looking at the top of. It is
        rendered only when there is something to say -- an always-present empty
        live region is announced on every render by some screen readers.
      */}
      {phase.kind === "refused" && (
        <p className={styles.failure} role="alert">
          {phase.detail}
        </p>
      )}
      {phase.kind === "unreachable" && (
        <p className={styles.failure} role="alert">
          That didn&apos;t reach the server. Your details were not sent anywhere else — check your
          connection and try again.
        </p>
      )}
    </form>
  );
}
