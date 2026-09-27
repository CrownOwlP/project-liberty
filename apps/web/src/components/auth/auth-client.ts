import { z } from "zod";

/* -------------------------------------------------------------------------
 * The browser's side of /api/auth/* (PW-0312)
 *
 * THE SECOND CLIENT-SIDE CALLER OF THIS APPLICATION'S OWN API, and it follows
 * `components/profiles/profiles-client.ts` rather than re-deriving its rules,
 * which is what the acceptance asks for. Every one of those rules is here for
 * the reason that file gives, and the reasons are not repeated at length:
 * `fetch` is injected so a test drives it without a network; `cache: "no-store"`
 * because an identity answer must never be served from a cache; no retries,
 * because a retried sign-in is a second password attempt nobody asked for;
 * `credentials: "same-origin"` so the session cookie is sent and so a
 * cross-origin copy of this bundle gets nothing.
 *
 * IT INVENTS NO SECOND AUTH PROTOCOL, which the acceptance requires by name.
 * There is no client-side session parsing here, no second cookie, no token in
 * `localStorage`, and no parallel identity state: the server sets the session
 * cookie and the server is asked who the viewer is. What this module sends is a
 * form's contents; what it reads back is whether the server accepted them.
 *
 * NO PASSWORD IS EVER PUT ANYWHERE BUT A REQUEST BODY. It is not logged, not
 * placed in a URL, not stored, and not echoed into any result this module
 * returns -- `AuthCallResult` has no field a password could travel in.
 * ---------------------------------------------------------------------- */

export const SIGN_IN_ENDPOINT = "/api/auth/sign-in/email";
export const SIGN_UP_ENDPOINT = "/api/auth/sign-up/email";
export const SIGN_OUT_ENDPOINT = "/api/auth/sign-out";
export const PASSWORD_RESET_ENDPOINT = "/api/auth/request-password-reset";
export const SESSION_ENDPOINT = "/api/auth/get-session";

/**
 * What Better Auth answers with when it refuses.
 *
 * PARSED, NOT TRUSTED, for the reason `profiles-client.ts` gives about its own
 * responses: a client that reads fields off an unvalidated object turns a
 * library upgrade into a render crash. Both fields are optional because the
 * library does not promise either on every path, and the UI has a sentence of
 * its own for the case where neither arrives.
 */
const authRefusalSchema = z
  .object({ message: z.string().optional(), code: z.string().optional() })
  .passthrough();

/**
 * What a call to the identity API produced.
 *
 * FOUR OUTCOMES, AND `unreachable` IS SEPARATE FROM `refused` ON PURPOSE. A
 * network that did not answer and a server that said no have different remedies
 * -- try again, versus change what you typed -- and a screen that collapsed them
 * would tell somebody their password was wrong because their train went into a
 * tunnel.
 */
export type AuthCallResult =
  | { readonly outcome: "accepted" }
  | { readonly outcome: "refused"; readonly status: number; readonly detail: string }
  | { readonly outcome: "unreachable" }
  | { readonly outcome: "unreadable"; readonly status: number };

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function defaultFetch(): FetchLike {
  return (input, init) => fetch(input, init);
}

/**
 * The sentence shown when the server refuses and says nothing useful.
 *
 * DELIBERATELY THE SAME FOR A WRONG PASSWORD AND AN UNKNOWN ADDRESS. Better
 * Auth already collapses those, and this keeps it collapsed on the way out: a
 * screen that said "no account with that address" is an account-existence
 * oracle anybody can query, which is the same non-oracle discipline
 * `deploymentSessionAccount` applies to its four session failures and
 * `profile_unavailable` applies to its two.
 */
export const GENERIC_REFUSAL = "that email address and password did not match an account";

async function readAuthResponse(response: Response): Promise<AuthCallResult> {
  if (response.ok) return { outcome: "accepted" };

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { outcome: "unreadable", status: response.status };
  }

  const parsed = authRefusalSchema.safeParse(payload);
  if (!parsed.success) return { outcome: "unreadable", status: response.status };

  return {
    outcome: "refused",
    status: response.status,
    detail: parsed.data.message ?? GENERIC_REFUSAL
  };
}

const JSON_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "application/json",
  accept: "application/json"
};

async function post(
  endpoint: string,
  body: unknown,
  fetchImpl: FetchLike
): Promise<AuthCallResult> {
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: JSON_HEADERS,
      body: JSON.stringify(body)
    });
  } catch {
    /* The thrown value is not carried. A `TypeError` from `fetch` says
     * "Failed to fetch" and nothing a viewer can act on, and a future runtime
     * could put a URL in it. */
    return { outcome: "unreachable" };
  }
  return readAuthResponse(response);
}

export async function signIn(
  credentials: { readonly email: string; readonly password: string },
  fetchImpl: FetchLike = defaultFetch()
): Promise<AuthCallResult> {
  return post(SIGN_IN_ENDPOINT, credentials, fetchImpl);
}

export async function signUp(
  account: { readonly email: string; readonly password: string; readonly name: string },
  fetchImpl: FetchLike = defaultFetch()
): Promise<AuthCallResult> {
  return post(SIGN_UP_ENDPOINT, account, fetchImpl);
}

export async function signOut(fetchImpl: FetchLike = defaultFetch()): Promise<AuthCallResult> {
  return post(SIGN_OUT_ENDPOINT, {}, fetchImpl);
}

/**
 * Ask for a password-reset message.
 *
 * ITS RESULT IS NOT SHOWN TO THE VIEWER AS A YES OR A NO. The screen says the
 * same thing either way -- "if that address has an account, a message is on its
 * way" -- because a reset form that reported success only for known addresses
 * is the account-existence oracle the sign-in form above already refuses to be.
 * The result is returned so the screen can tell `unreachable` from `refused`
 * and offer a retry, not so it can report which.
 */
export async function requestPasswordReset(
  email: string,
  fetchImpl: FetchLike = defaultFetch()
): Promise<AuthCallResult> {
  return post(PASSWORD_RESET_ENDPOINT, { email }, fetchImpl);
}

/* -------------------------------------------------------------------------
 * Asking the server who this browser is
 * ---------------------------------------------------------------------- */

/**
 * As much of the session as the shell renders, and no more.
 *
 * ONE FIELD READ FROM THE USER AND ONE FROM THE SESSION. `.passthrough()` keeps
 * whatever else the library sends without this build depending on it, and
 * nothing here reads an email address, a token, an expiry or an id beyond
 * establishing that a session exists -- see `account-state.ts` for why the
 * label is the name and never the address.
 */
const sessionSchema = z
  .object({
    user: z.object({ name: z.string().optional() }).passthrough().nullish(),
    session: z.object({ id: z.string() }).passthrough().nullish()
  })
  .passthrough();

/**
 * Whether this browser has a session, and what the account calls itself.
 *
 * THIS IS NOT CLIENT-SIDE SESSION PARSING, which the acceptance forbids. No
 * cookie is read here, no token is decoded, and nothing is inferred: the
 * question is asked of the server and its answer is reported. The distinction
 * that matters is that this build cannot decide it is signed in -- only the
 * server can, and a stale answer here is corrected by the next render rather
 * than by a second identity state that could disagree.
 */
export type SessionProbe =
  | { readonly outcome: "signed-in"; readonly name: string | null }
  | { readonly outcome: "signed-out" }
  | { readonly outcome: "unavailable" };

export async function probeSession(
  fetchImpl: FetchLike = defaultFetch()
): Promise<SessionProbe> {
  let response: Response;
  try {
    response = await fetchImpl(SESSION_ENDPOINT, {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json" }
    });
  } catch {
    return { outcome: "unavailable" };
  }

  /*
   * 503 is the composition root saying there is no identity instance --
   * `api/auth/[...all]/route.ts` answers it with a reason. That is
   * `unavailable`, not `signed-out`: there is nobody to sign in, so a shell
   * that offered a sign-in link would be linking to an apology.
   */
  if (response.status === 503) return { outcome: "unavailable" };
  if (!response.ok) return { outcome: "signed-out" };

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { outcome: "unavailable" };
  }

  /* Better Auth answers 200 with a null body for a request with no session. */
  if (payload === null) return { outcome: "signed-out" };

  const parsed = sessionSchema.safeParse(payload);
  if (!parsed.success) return { outcome: "unavailable" };
  if (!parsed.data.session) return { outcome: "signed-out" };

  const name = parsed.data.user?.name?.trim();
  return { outcome: "signed-in", name: name !== undefined && name !== "" ? name : null };
}
