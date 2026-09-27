import { readFileSync } from "node:fs";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  GENERIC_REFUSAL,
  PASSWORD_RESET_ENDPOINT,
  SESSION_ENDPOINT,
  SIGN_IN_ENDPOINT,
  SIGN_OUT_ENDPOINT,
  SIGN_UP_ENDPOINT,
  probeSession,
  requestPasswordReset,
  signIn,
  signOut,
  signUp,
  type FetchLike
} from "./auth-client";
import {
  MAIL_TRANSPORT_CONFIGURED,
  passwordResetCanStart,
  signUpCanComplete,
  type AuthPolicy
} from "./auth-policy";
import { DEFAULT_NEXT_PATH, safeNextPath, signInHref } from "./next-path";
import { UNNAMED_ACCOUNT_LABEL } from "./account-label";
import { CredentialsForm } from "./credentials-form";
import { PasswordResetEntry } from "./password-reset-entry";
import { SignedOutPanel } from "./signed-out-panel";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, replace: () => {} }) }));

/**
 * The authentication surface (PW-0312).
 *
 * Rendered with `react-dom/server` and checked against source, the pattern
 * `profile-ui.test.tsx` established: this workspace's vitest environment is
 * `node`, so no effect runs and no click can be dispatched. What that CAN see
 * is the markup a browser is handed, which is what every assertion below is
 * about — plus the pure functions, which is where this surface's security is.
 */

function source(file: string): string {
  return readFileSync(new URL(file, import.meta.url), "utf8")
    /* These modules name in prose the things they forbid; a rule its own
     * explanation can fail is not a rule. */
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

describe("the destination cannot leave this origin", () => {
  /*
   * THE MOST IMPORTANT TEST IN THIS TASK. A sign-in screen takes its
   * destination from a query string -- it must, because the point is to return
   * somebody where they were refused -- and that is one careless line away from
   * a page that looks like this product, collects a password and forwards the
   * viewer to an attacker.
   */
  const hostile = [
    "https://evil.example/liberty",
    "http://evil.example",
    "//evil.example",
    "/\\evil.example",
    "\\\\evil.example",
    "/\\/\\evil.example",
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "https:/\\evil.example",
    "/redirect?to=https://evil.example",
    "profiles",
    "",
    "/path\u0000/null",
    "/path\nnewline"
  ];

  for (const value of hostile) {
    it(`refuses ${JSON.stringify(value)}`, () => {
      expect(safeNextPath(value)).toBe(DEFAULT_NEXT_PATH);
    });
  }

  it("refuses a repeated parameter outright", () => {
    /* `?next=/a&next=https://evil.example` arrives as an array. Only a lone
     * string is a destination; an array is somebody testing this function. */
    expect(safeNextPath(["/profiles", "https://evil.example"])).toBe(DEFAULT_NEXT_PATH);
    expect(safeNextPath(undefined)).toBe(DEFAULT_NEXT_PATH);
  });

  it("accepts the same-origin paths this product actually routes", () => {
    for (const value of ["/profiles", "/search?q=aurora", "/watch/aurora-fall", "/title/x#top"]) {
      expect(safeNextPath(value), value).toBe(value);
    }
  });

  it("refuses an absurdly long path rather than putting it in a URL", () => {
    expect(safeNextPath(`/${"a".repeat(600)}`)).toBe(DEFAULT_NEXT_PATH);
  });

  it("encodes the destination it does carry, and omits it when it is the default", () => {
    expect(signInHref("/profiles")).toBe("/signin?next=%2Fprofiles");
    expect(signInHref("https://evil.example")).toBe("/signin");
    expect(signInHref()).toBe("/signin");
  });

  it("is the only thing that builds a sign-in URL", () => {
    /* A second place that interpolated `next` into a href would be a second
     * place the guard could be forgotten. */
    const panel = source("./signed-out-panel.tsx");
    expect(panel).toContain("signInHref");
    expect(panel).not.toMatch(/\/signin\?/);
  });
});

describe("the screen states what THIS deployment can do", () => {
  const policy = (over: Partial<AuthPolicy>): AuthPolicy => ({
    available: true,
    requiresEmailVerification: true,
    canDeliverMail: false,
    ...over
  });

  it("refuses to offer sign-up that cannot complete", () => {
    /*
     * The state every Liberty deployment is in today. A successful sign-up here
     * creates an account nobody can ever sign in to AND takes the address while
     * doing it -- worse than refusing, and invisible, because the form would
     * report success.
     */
    expect(signUpCanComplete(policy({}))).toBe(false);
    expect(signUpCanComplete(policy({ canDeliverMail: true }))).toBe(true);
    expect(signUpCanComplete(policy({ requiresEmailVerification: false }))).toBe(true);
    expect(signUpCanComplete(policy({ available: false, canDeliverMail: true }))).toBe(false);
  });

  it("makes reset depend on delivery alone", () => {
    /* Reset is not conditional on verification: the whole flow is "we send you
     * a link", so with no transport there is nothing to begin. */
    expect(passwordResetCanStart(policy({}))).toBe(false);
    expect(passwordResetCanStart(policy({ requiresEmailVerification: false }))).toBe(false);
    expect(passwordResetCanStart(policy({ canDeliverMail: true }))).toBe(true);
  });

  it("mirrors the composition root's transport rather than guessing at it", () => {
    /*
     * `MAIL_TRANSPORT_CONFIGURED` cannot be derived -- there is no way to ask a
     * constructed instance whether its transport works without sending a
     * message to somebody -- so it is stated, and this is what stops the two
     * drifting apart silently. The day a real transport is wired, this test
     * fails and that constant is the line to change.
     */
    const root = readFileSync(
      new URL("../../lib/session/auth-instance.ts", import.meta.url),
      "utf8"
    );
    expect(root).toContain("sendMail: noMailTransport");
    expect(MAIL_TRANSPORT_CONFIGURED).toBe(false);
  });
});

describe("a password-reset entry that cannot start says so and shows nothing else", () => {
  const html = renderToStaticMarkup(<PasswordResetEntry canStart={false} />);

  it("renders no form and no field", () => {
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<input");
  });

  it("says why, in terms the viewer can act on", () => {
    expect(html).toContain("no way to send email");
  });

  it("exposes no link, token or URL anywhere in this component's source", () => {
    /*
     * THE CLAUSE MOST LIKELY TO BE GOT WRONG. The composition root's transport
     * THROWS rather than logging the reset link, because that URL is a
     * one-click account takeover. The tempting "helpful" fix on a deployment
     * with no transport is to print it, copy it, or show it in a developer
     * panel, and every one of those undoes the reason it throws. There is no
     * code path here that could: no token reaches this process at all.
     */
    const moduleSource = source("./password-reset-entry.tsx");
    expect(moduleSource).not.toMatch(/clipboard/i);
    expect(moduleSource).not.toMatch(/console\./);
    expect(moduleSource).not.toMatch(/resetUrl|resetLink|token/i);
    /* Non-vacuity: it is still the component. */
    expect(moduleSource).toContain("requestPasswordReset");
  });

  it("reports the same thing for every address once it can start", () => {
    /* An oracle check: the success sentence must not be conditional on whether
     * the address exists. Asserted over source because the state is reached by
     * an effect this environment cannot run. */
    const moduleSource = source("./password-reset-entry.tsx");
    expect(moduleSource).toContain('setPhase(result.outcome === "unreachable" ? "unreachable" : "sent")');
  });
});

describe("the credentials form", () => {
  const signInHtml = renderToStaticMarkup(<CredentialsForm mode="sign-in" next="/profiles" />);
  const signUpHtml = renderToStaticMarkup(<CredentialsForm mode="sign-up" next="/" />);

  it("asks a password manager for the right thing on each screen", () => {
    /*
     * `current-password` on a sign-up form is how people reuse a password their
     * manager would otherwise have generated. `username` rather than `email` is
     * what managers actually look for on a credential form.
     *
     * MATCHED CASE-INSENSITIVELY, AND THAT IS A FINDING RATHER THAN A
     * LOOSENING. This React build emits the attribute as `autoComplete`,
     * camelCase, instead of lowering it the way it lowers `className`. HTML
     * attribute names are case-insensitive, so a browser and a password manager
     * read it identically -- but a test that pinned the lowercase spelling
     * would be pinning a rendering detail of one React version rather than the
     * behaviour, and would fail on the day it changes back.
     */
    expect(signInHtml.toLowerCase()).toContain('autocomplete="current-password"');
    expect(signUpHtml.toLowerCase()).toContain('autocomplete="new-password"');
    expect(signInHtml.toLowerCase()).toContain('autocomplete="username"');
  });

  it("asks for a name only where an account is being created", () => {
    expect(signUpHtml).toContain('name="name"');
    expect(signInHtml).not.toContain('name="name"');
  });

  it("never renders a password value into markup", () => {
    expect(signInHtml).not.toMatch(/type="password"[^>]*value=/);
  });

  it("keeps the password out of React state", () => {
    /*
     * It is in the DOM either way, but keeping it out of state keeps it out of
     * every render, every devtools inspection of this component, and every
     * future log of `phase`.
     */
    const moduleSource = source("./credentials-form.tsx");
    expect(moduleSource).toContain("new FormData(event.currentTarget)");
    expect(moduleSource).not.toMatch(/useState[^;]*password/i);
  });

  it("replaces rather than pushes on success, so back does not resubmit", () => {
    const moduleSource = source("./credentials-form.tsx");
    expect(moduleSource).toContain("router.replace(next)");
    expect(moduleSource).not.toContain("router.push(");
  });
});

describe("the identity API is the only protocol", () => {
  function record(status: number, body: unknown): { calls: Array<[string, RequestInit | undefined]>; fetchImpl: FetchLike } {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fetchImpl: FetchLike = async (input, init) => {
      calls.push([input, init]);
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" }
      });
    };
    return { calls, fetchImpl };
  }

  it("posts to the endpoints Better Auth actually serves", async () => {
    const { calls, fetchImpl } = record(200, {});
    await signIn({ email: "a@b.invalid", password: "x" }, fetchImpl);
    await signUp({ email: "a@b.invalid", password: "x", name: "A" }, fetchImpl);
    await signOut(fetchImpl);
    await requestPasswordReset("a@b.invalid", fetchImpl);
    await probeSession(fetchImpl);
    expect(calls.map(([url]) => url)).toEqual([
      SIGN_IN_ENDPOINT,
      SIGN_UP_ENDPOINT,
      SIGN_OUT_ENDPOINT,
      PASSWORD_RESET_ENDPOINT,
      SESSION_ENDPOINT
    ]);
    for (const [, init] of calls) {
      expect(init?.cache).toBe("no-store");
      expect(init?.credentials).toBe("same-origin");
    }
  });

  it("collapses a wrong password and an unknown address into one sentence", async () => {
    /*
     * A screen that said "no account with that address" is an
     * account-existence oracle anybody can query -- the same non-oracle rule
     * `deploymentSessionAccount` applies to its four session failures.
     */
    const { fetchImpl } = record(401, {});
    const result = await signIn({ email: "a@b.invalid", password: "x" }, fetchImpl);
    expect(result).toEqual({ outcome: "refused", status: 401, detail: GENERIC_REFUSAL });
  });

  it("separates a server that said no from a network that did not answer", async () => {
    const exploding: FetchLike = async () => {
      throw new TypeError("Failed to fetch");
    };
    expect(await signIn({ email: "a@b.invalid", password: "x" }, exploding)).toEqual({
      outcome: "unreachable"
    });
  });

  it("does not echo the credentials back in any result", async () => {
    const { fetchImpl } = record(401, { message: "nope" });
    const result = await signIn({ email: "viewer@b.invalid", password: "hunter2" }, fetchImpl);
    expect(JSON.stringify(result)).not.toContain("hunter2");
    expect(JSON.stringify(result)).not.toContain("viewer@b.invalid");
  });

  it("reads the session from the server rather than deciding one", async () => {
    const signedIn = record(200, { user: { name: "Priya" }, session: { id: "s1" } });
    expect(await probeSession(signedIn.fetchImpl)).toEqual({ outcome: "signed-in", name: "Priya" });

    const signedOut = record(200, null);
    expect(await probeSession(signedOut.fetchImpl)).toEqual({ outcome: "signed-out" });

    /* 503 is the composition root saying there is no instance. Not signed-out:
     * there is nobody to sign in, so no sign-in link is offered. */
    const noInstance = record(503, { error: "no authentication instance" });
    expect(await probeSession(noInstance.fetchImpl)).toEqual({ outcome: "unavailable" });
  });

  it("decodes no cookie and reads no storage anywhere in this surface", async () => {
    /*
     * "No client-side session parsing, no second cookie, no parallel identity
     * state" -- the acceptance's words. The server is the authority; these
     * modules ask it.
     */
    for (const file of [
      "./auth-client.ts",
      "./account-region.tsx",
      "./credentials-form.tsx",
      "./sign-out-control.tsx",
      "./password-reset-entry.tsx"
    ]) {
      const moduleSource = source(file);
      expect(moduleSource, file).not.toMatch(/document\.cookie/);
      expect(moduleSource, file).not.toMatch(/localStorage|sessionStorage/);
      expect(moduleSource, file).not.toMatch(/atob\(|jwtDecode|decodeJwt/);
    }
  });
});

describe("no client module on this surface reaches the composition root", () => {
  /*
   * A BOUNDARY A UNIT SUITE CANNOT SEE, ASSERTED SO IT CAN. `account-state.ts`
   * is a server module: it reaches `lib/session/auth-instance.ts`, and through
   * it `@liberty/persistence` and `pg`. An earlier draft had the client
   * `account-region.tsx` import one CONSTANT from it, which pulled that entire
   * graph into the browser bundle -- vitest resolved it happily and `next
   * build` refused with a module-not-found on pg's node-only imports.
   *
   * The constant moved to `account-label.ts`, which imports nothing. This test
   * is what makes the next such import fail a unit gate instead of a production
   * build, which is the difference between a minute and an afternoon.
   */
  const CLIENT_MODULES = [
    "./account-region.tsx",
    "./credentials-form.tsx",
    "./sign-out-control.tsx",
    "./password-reset-entry.tsx",
    "./auth-client.ts",
    "./next-path.ts",
    "./account-label.ts"
  ];

  for (const file of CLIENT_MODULES) {
    it(`${file} imports nothing that reaches the server`, () => {
      const moduleSource = source(file);
      for (const forbidden of [
        "lib/session/auth-instance",
        "lib/db/",
        "@liberty/persistence",
        "@liberty/auth",
        "./account-state",
        "./auth-policy",
        "next/headers"
      ]) {
        expect(moduleSource, `${file} imports ${forbidden}`).not.toContain(forbidden);
      }
    });
  }

  it("still shares the one label rather than spelling it twice", () => {
    /* Non-vacuity: the extraction solved the bundle problem without making two
     * copies of the string, which would have been the other easy fix. */
    expect(UNNAMED_ACCOUNT_LABEL).toBe("Account");
    expect(source("./account-state.ts")).toContain('from "./account-label"');
    expect(source("./account-region.tsx")).toContain('from "./account-label"');
  });
});

describe("signing out is a submission, not a link", () => {
  it("renders a form with a submit button and no anchor", () => {
    /*
     * A GET that changes state is followed by link prefetchers, crawlers,
     * antivirus scanners and mail clients -- the classic way an application
     * signs its own users out when somebody hovers a message.
     */
    const moduleSource = source("./sign-out-control.tsx");
    expect(moduleSource).toContain("<form");
    expect(moduleSource).toContain('type="submit"');
    expect(moduleSource).not.toContain("<a ");
    expect(moduleSource).not.toContain("<Link");
  });

  it("re-asks the server rather than asserting a signed-out state", () => {
    const moduleSource = source("./sign-out-control.tsx");
    expect(moduleSource).toContain("router.refresh()");
    expect(moduleSource).not.toMatch(/setSignedOut|document\.cookie/);
  });
});

describe("a signed-out viewer is given somewhere to go", () => {
  it("names what they were doing and carries them back to it", () => {
    const html = renderToStaticMarkup(
      <SignedOutPanel next="/profiles" what="choose who is watching" />
    );
    expect(html).toContain("choose who is watching");
    expect(html).toContain('href="/signin?next=%2Fprofiles"');
  });

  it("drops a hostile destination rather than carrying it", () => {
    const html = renderToStaticMarkup(
      <SignedOutPanel next="https://evil.example" what="do that" />
    );
    expect(html).toContain('href="/signin"');
    expect(html).not.toContain("evil.example");
  });
});

describe("the shell shows the account and the profile as two facts", () => {
  it("renders both, account first", () => {
    const shell = source("../shell/app-shell.tsx");
    expect(shell).toContain("<AccountRegion />");
    expect(shell).toContain("<ActiveProfileBadge />");
    expect(shell.indexOf("<AccountRegion />")).toBeLessThan(shell.indexOf("<ActiveProfileBadge />"));
  });

  it("does not move profile selection into the auth library", () => {
    /*
     * The acceptance forbids it, and an "account state" module is exactly where
     * somebody would do it. Profiles live ABOVE auth (PL-0402) and
     * `active_profile_selection` stays keyed by session in Liberty's own store.
     */
    for (const file of ["./account-state.ts", "./account-region.tsx", "./auth-client.ts"]) {
      const moduleSource = source(file);
      expect(moduleSource, file).not.toMatch(/activeProfileId|profileId|selectActiveProfile/);
    }
  });
});
