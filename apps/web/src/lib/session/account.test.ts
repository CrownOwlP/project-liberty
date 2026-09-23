import { describe, expect, it } from "vitest";
import {
  isNonDeploymentEnvironmentName,
  NON_DEPLOYMENT_ENVIRONMENTS,
  NonDeploymentEnvironment
} from "../../app/api/deployment-environment";
import {
  DEFAULT_DEVELOPMENT_ACCOUNT_ID,
  DEVELOPMENT_ACCOUNT_HEADER,
  DEVELOPMENT_SESSION_HEADER,
  resolveRequestAccount
} from "./account";

/*
 * The identity gate.
 *
 * The property that matters is the first one: a deployment gets an explanation,
 * never an account. Everything else here is about the development branch being
 * usable without being sloppy -- a malformed header is refused rather than
 * quietly falling back, because a silent fallback would make two "different"
 * households share one identity and make a cross-household isolation test pass
 * for the wrong reason.
 *
 * THE ENVIRONMENT ARGUMENT IS THE CAPABILITY OR `null`, NEVER A RUNTIME NAME.
 * It used to be a `nodeEnv` string, so a single loop over a list of names
 * covered both branches -- and a caller that could name its own environment was
 * precisely how a hosted process could have been issued a development identity.
 * Two questions are asked separately now: which NAMES the allowlist admits, of
 * `isNonDeploymentEnvironmentName`, which issues nothing and may therefore be
 * handed any string; and what `resolveRequestAccount` does with each answer,
 * with `null` for the deployment branch and this process's own witness for the
 * granting one.
 */

function request(headers: Record<string, string> = {}): Request {
  return new Request("https://liberty.test/api/v1/profiles", { method: "GET", headers });
}

/**
 * This process's own witness.
 *
 * `classify` takes no argument -- it reads the process. The witness is genuine
 * because the process running this suite really is a test process: vitest sets
 * `NODE_ENV=test`, which `NON_DEPLOYMENT_ENVIRONMENTS` admits. That is the
 * design rather than a way around it.
 *
 * Not a `!`. A test that reached for a non-null assertion on this value would be
 * demonstrating the opposite of what the type is for. Nothing in this file
 * rewrites `NODE_ENV`, so there is no window in which this answer changes.
 */
function classifiedProcess(): NonDeploymentEnvironment {
  const environment = NonDeploymentEnvironment.classify();
  if (environment === null) {
    throw new Error(
      "this process is not classified as a non-deployment; vitest sets NODE_ENV=test, which NON_DEPLOYMENT_ENVIRONMENTS admits"
    );
  }
  return environment;
}

describe("a deployment gets an explanation, not an account", () => {
  /*
   * The names a deployment runs under, asked of the predicate rather than of the
   * mint. `""` stands for an UNSET `NODE_ENV`, and it is the faithful stand-in
   * rather than a compromise: the allowlist test collapses both with `?? ""`, so
   * this exercises the same comparison. A process running under any of these
   * gets `null` from `classify`, which is what the case below passes.
   */
  it.each(["production", "staging", "preview", "Production", "PRODUCTION", "", "dev", "prod"])(
    "is a name the allowlist refuses: %j",
    (nodeEnv) => {
      expect(isNonDeploymentEnvironmentName(nodeEnv)).toBe(false);
    }
  );

  it("asks the deployment authenticator, and answers whatever it answers", async () => {
    /*
     * `null` is the classification a deployment receives, passed the way a
     * deployment receives it. `undefined` cannot be used, because passing it
     * explicitly triggers the parameter's default -- a read of `process.env` --
     * which in this worker is `test` and would assert the opposite of what the
     * case means.
     *
     * WHAT THIS CASE ASSERTED BEFORE PW-0403, and why it changed: it required
     * the reason `authentication_not_configured` and the words
     * `@liberty/auth/server`, because no auth instance existed anywhere in the
     * application and "nobody is wired up" was the only true answer a deployment
     * could give. There is one now. A deployment no longer refuses by
     * definition; it ASKS, and the interesting property is that it delegates
     * rather than deciding here.
     */
    const asked: Request[] = [];
    const resolved = await resolveRequestAccount(request(), null, async (received) => {
      asked.push(received);
      return { ok: true, account: { userId: "u1", sessionId: "s1" }, detail: "stub" };
    });

    expect(asked).toHaveLength(1);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.account).toEqual({ userId: "u1", sessionId: "s1" });
  });

  it("does not consult the session store outside a deployment", async () => {
    /*
     * The other direction, and it is the one that matters for safety: a
     * classified process must never reach the deployment authenticator, so a
     * stale or forged session cookie cannot identify anybody in `next dev`.
     */
    let asked = 0;
    const resolved = await resolveRequestAccount(request(), classifiedProcess(), async () => {
      asked += 1;
      return { ok: false, reason: "not_authenticated", detail: "should not be reached" };
    });

    expect(asked).toBe(0);
    expect(resolved.ok).toBe(true);
  });

  it("cannot be talked into an account by a header", async () => {
    /*
     * The development headers are read only after the witness is obtained, so in
     * a deployment they are not read at all. Asserted through the authenticator
     * rather than through the old blanket refusal: the stub refuses, and the
     * point is that the header did not produce an account on the way past.
     */
    const resolved = await resolveRequestAccount(
      request({ [DEVELOPMENT_ACCOUNT_HEADER]: "household-b" }),
      null,
      async () => ({ ok: false, reason: "not_authenticated", detail: "no session" })
    );
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toBe("not_authenticated");
  });
});

/*
 * The runtime half of the control, which the type cannot supply.
 *
 * The parameter is checked by the COMPILER, and two values get past a compiler:
 * an `as unknown as NonDeploymentEnvironment`, and a spread copy of a genuine
 * classification. The cast is the blunt forgery; the SPREAD is the subtle one
 * and the reason a brand alone was never enough -- it copies the brand, needs no
 * cast, and only object identity tells it from the real thing. Both are
 * exercised, matching `packages/provider-sdk/src/fixture/provider.test.ts`.
 *
 * NEITHER CASE PASSES WITHOUT THE REGISTRY CHECK IN `developmentAccount`. A
 * forgery is not `null`, so the deployment branch does not catch it and the
 * headers are read: the first case would have been granted a development
 * identity outright, and the second would have been refused for its HEADER --
 * `development_identifier_malformed`, the caller's-fault code -- rather than for
 * the capability that is the real reason it may not have one.
 */
describe("a classification the contracts module never issued", () => {
  function forgeries(): readonly NonDeploymentEnvironment[] {
    const cast = { nodeEnv: "test" } as unknown as NonDeploymentEnvironment;
    /* Genuine, then copied: the copy carries the brand and is refused anyway. */
    const copied: NonDeploymentEnvironment = { ...classifiedProcess() };
    return [cast, copied];
  }

  it("gets an explanation, not an account", async () => {
    for (const forged of forgeries()) {
      const resolved = await resolveRequestAccount(request(), forged);
      expect(resolved.ok).toBe(false);
      if (resolved.ok) continue;
      expect(resolved.reason).toBe("authentication_not_configured");
      /* The detail names the forgery. It deliberately does not repeat the
       * deployment branch's remedy: wiring an auth instance is not the answer to
       * a manufactured capability. */
      expect(resolved.detail).toContain("was not issued by");
      expect(resolved.detail).not.toContain("@liberty/auth/server");
    }
  });

  it("is refused before a header is read", async () => {
    /*
     * The ordering, pinned with a header that would otherwise produce
     * `development_identifier_malformed`: a caller holding a forgery is told
     * about the forgery rather than about its typo, because the capability is
     * what actually blocks the request.
     */
    for (const forged of forgeries()) {
      const resolved = await resolveRequestAccount(
        request({ [DEVELOPMENT_ACCOUNT_HEADER]: "Household A" }),
        forged
      );
      expect(resolved.ok).toBe(false);
      if (resolved.ok) continue;
      expect(resolved.reason).toBe("authentication_not_configured");
    }
  });
});

describe("outside a deployment", () => {
  /* Enumerated from the exported allowlist rather than restated, so widening
   * `NON_DEPLOYMENT_ENVIRONMENTS` is visible here rather than silently
   * untested. */
  it.each([...NON_DEPLOYMENT_ENVIRONMENTS])("is a name the allowlist admits: %s", (nodeEnv) => {
    expect(isNonDeploymentEnvironmentName(nodeEnv)).toBe(true);
  });

  it("produces a stable default account for a classified process", async () => {
    const environment = classifiedProcess();
    const resolved = await resolveRequestAccount(request(), environment);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.account.userId).toBe(DEFAULT_DEVELOPMENT_ACCOUNT_ID);
    /*
     * The session id is DERIVED from the account rather than a constant, so two
     * development accounts do not share one row in `active_profile_selection`
     * -- which is keyed by session, and would otherwise make one household's
     * profile choice reselect the other's.
     */
    expect(resolved.account.sessionId).toBe(`${DEFAULT_DEVELOPMENT_ACCOUNT_ID}-session`);
    /* The trail names which environment admitted the identity, read off the
     * witness rather than restated -- the witness carries the environment the
     * classification actually used, and it is the only one this process may
     * name. Matched with its `NODE_ENV=` prefix so a bare occurrence of the word
     * elsewhere in the detail would not satisfy it. */
    expect(resolved.detail).toContain(`NODE_ENV=${environment.nodeEnv}`);
  });

  it("lets a developer name two households, with distinct sessions", async () => {
    const environment = classifiedProcess();
    const first = await resolveRequestAccount(
      request({ [DEVELOPMENT_ACCOUNT_HEADER]: "household-a" }),
      environment
    );
    const second = await resolveRequestAccount(
      request({ [DEVELOPMENT_ACCOUNT_HEADER]: "household-b" }),
      environment
    );

    expect(first.ok && first.account.userId).toBe("household-a");
    expect(second.ok && second.account.userId).toBe("household-b");
    expect(first.ok && second.ok && first.account.sessionId === second.account.sessionId).toBe(
      false
    );
  });

  it("lets one account hold two sessions, which is what two devices are", async () => {
    const television = await resolveRequestAccount(
      request({
        [DEVELOPMENT_ACCOUNT_HEADER]: "household-a",
        [DEVELOPMENT_SESSION_HEADER]: "television"
      }),
      classifiedProcess()
    );
    expect(television.ok && television.account.userId).toBe("household-a");
    expect(television.ok && television.account.sessionId).toBe("television");
  });

  it("refuses a malformed header rather than falling back to the default", async () => {
    for (const value of ["Household A", "household_a", "../etc/passwd", "a".repeat(65)]) {
      const resolved = await resolveRequestAccount(
        request({ [DEVELOPMENT_ACCOUNT_HEADER]: value }),
        classifiedProcess()
      );
      expect(resolved.ok).toBe(false);
      if (resolved.ok) continue;
      expect(resolved.reason).toBe("development_identifier_malformed");
      /* The LENGTH and the header name, never the value: echoing an unbounded
       * header into a refusal moves the unbounded string into the logs. */
      expect(resolved.detail).toContain(DEVELOPMENT_ACCOUNT_HEADER);
      expect(resolved.detail).not.toContain(value);
    }
  });
});
