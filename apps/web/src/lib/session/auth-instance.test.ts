import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { CREDENTIAL_RATE_LIMIT, DEFAULT_RATE_LIMIT } from "@liberty/auth";

import { selectAuthInstance } from "./auth-instance";

/* -------------------------------------------------------------------------
 * The auth composition root (PW-0403)
 *
 * `selectAuthInstance` takes every input explicitly -- the same shape
 * `selectRepository` and `deploymentSessionAccount` use -- so these run with no
 * PostgreSQL, no `process.env` mutation, and therefore no race against every
 * other suite in the same worker.
 *
 * THE SUCCESS PATH IS NOT TESTED HERE AND THAT IS DELIBERATE. Constructing the
 * instance requires a real Drizzle handle over a real pool, and a stub of one
 * would be a stub of Better Auth's constructor -- the same argument
 * `better-auth.ts` makes for why that file has no unit tests. What IS testable
 * is every way the root REFUSES, which is the part that decides whether a
 * misconfigured deployment fails safe or fails open.
 * ---------------------------------------------------------------------- */

const SECRET = "0123456789abcdef0123456789abcdef";
const BASE_URL = "https://liberty.example";

function inputs(over: Partial<Parameters<typeof selectAuthInstance>[0]> = {}) {
  return {
    databaseUrl: "postgres://user:pw@db.example/liberty",
    secret: SECRET,
    baseUrl: BASE_URL,
    trustedOrigins: [] as readonly string[],
    sessionExpiresInSeconds: undefined,
    requireEmailVerification: undefined,
    repository: {
      ok: true as const,
      repository: {} as never,
      detail: "PostgreSQL, selected by DATABASE_URL",
      handle: { db: {} as never, pool: {} as never }
    },
    ...over
  };
}

describe("the store is decided before the configuration", () => {
  it("reports the repository's own detail when no store could be selected", async () => {
    /*
     * FIRST, before the secret is looked at, because that failure is the one an
     * operator cannot fix by setting a variable this module names. Complaining
     * about LIBERTY_AUTH_SECRET to somebody who has not set DATABASE_URL sends
     * them to the second problem first.
     */
    const resolved = selectAuthInstance(
      inputs({
        secret: undefined,
        repository: {
          ok: false,
          reason: "storage_not_configured",
          detail: "DATABASE_URL is not set and this process is a deployment"
        }
      })
    );

    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.detail).toContain("DATABASE_URL is not set");
    expect(resolved.detail).not.toContain("LIBERTY_AUTH_SECRET");
  });

  it("refuses the in-memory adapter, because a session that vanishes is not a session", async () => {
    /*
     * The in-memory store executes no SQL and does not survive the process.
     * Better Auth would need tables it does not have, and even if it had them,
     * every session would end at restart. Refusing here is what stops a
     * development convenience from becoming a deployment's identity layer.
     */
    const resolved = selectAuthInstance(
      inputs({
        repository: {
          ok: true,
          repository: {} as never,
          detail: "in-memory development store",
          handle: null
        }
      })
    );

    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.detail).toContain("in-memory");
  });

  it("refuses when the store is PostgreSQL and no connection string was supplied", async () => {
    /*
     * The two were resolved from different reads of the environment. Continuing
     * would either fail schema validation with a confusing message or, worse,
     * point the auth instance at a different database than the one holding the
     * profiles.
     */
    const resolved = selectAuthInstance(inputs({ databaseUrl: undefined }));

    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.detail).toContain("different reads of the environment");
  });
});

describe("configuration is validated by the reviewed schema, not here", () => {
  it("refuses a missing secret", async () => {
    const resolved = selectAuthInstance(inputs({ secret: undefined }));
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.detail).toContain("secret");
  });

  it("refuses a short secret, which is the misconfiguration that would otherwise WORK", async () => {
    /*
     * The dangerous class: a 12-character secret produces a functioning system
     * in which cookies are forgeable. `libertyAuthConfigSchema` asserts the
     * length for exactly this reason, and this asserts that the root consults it.
     */
    const resolved = selectAuthInstance(inputs({ secret: "too-short" }));
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.detail).toContain("32 characters");
  });

  it("refuses a base URL that is not absolute", async () => {
    const resolved = selectAuthInstance(inputs({ baseUrl: "/api/auth" }));
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.detail).toContain("baseUrl");
  });

  it("refuses a wildcard trusted origin, because it is not a URL", async () => {
    /*
     * `["*"]` cannot be expressed: the schema requires each entry to be a URL,
     * so the permissive configuration is a validation error rather than a
     * setting. Asserted here because it is the one an operator under time
     * pressure reaches for.
     */
    const resolved = selectAuthInstance(inputs({ trustedOrigins: ["*"] }));
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.detail).toContain("trustedOrigins");
  });

  it("refuses a session lifetime outside the reviewed bounds", async () => {
    const resolved = selectAuthInstance(inputs({ sessionExpiresInSeconds: 30 }));
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.detail).toContain("sessionExpiresInSeconds");
  });

  it("reports EVERY problem at once", async () => {
    /*
     * `resolveAuthConfig` collects them so that fixing one variable per restart
     * is not how a deployment is spent. The root must not stop at the first.
     */
    const resolved = selectAuthInstance(inputs({ secret: "short", baseUrl: "nope" }));
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.detail).toContain("secret");
    expect(resolved.detail).toContain("baseUrl");
  });

  it("never puts the secret or the connection string in a refusal", async () => {
    /*
     * Both are credentials, and a refusal is logged. The schema's own comments
     * require its messages to name fields rather than values; this asserts that
     * the root does not undo that by interpolating its inputs.
     */
    const resolved = selectAuthInstance(
      inputs({
        secret: "secret-value-that-is-far-too-short",
        baseUrl: "not-a-url",
        databaseUrl: "postgres://user:hunter2@db.example/liberty"
      })
    );

    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.detail).not.toContain("hunter2");
    expect(resolved.detail).not.toContain("secret-value-that-is-far-too-short");
  });
});

describe("the module's own shape", () => {
  it("never throws on import and has no module-scope environment read", async () => {
    /*
     * A composition root that throws on import takes down every route in the
     * application, including the ones that need no authentication, and does it
     * with a stack trace rather than a reason. A module-scope `process.env` read
     * freezes the answer to whatever the process looked like when the first
     * route loaded -- which in a desktop sidecar is before the launcher has
     * finished configuring it.
     *
     * Asserted against source, because both properties are about what the module
     * does at load time and neither is observable from a value.
     */
    const raw = await readFile(new URL("./auth-instance.ts", import.meta.url), "utf8");
    const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

    /* Every process.env read is inside a function body. */
    for (const line of stripped.split("\n")) {
      if (!line.includes("process.env")) continue;
      expect(line.startsWith("  ")).toBe(true);
    }
    /*
     * EXACTLY ONE `throw` IN THE MODULE, and it is the mail transport's -- which
     * is a rejected promise at send time, not a load-time failure. Counting is
     * the assertion rather than forbidding the keyword, because forbidding it
     * would have to be relaxed the first time somebody adds a legitimate one and
     * the rule would quietly disappear. Everything else returns a refusal value.
     */
    const throws = stripped.match(/\bthrow /g) ?? [];
    expect(throws).toHaveLength(1);
    const mailStart = stripped.indexOf("async function noMailTransport");
    expect(stripped.indexOf("throw ")).toBeGreaterThan(mailStart);
    /* Non-vacuity: the stripped source is still the module. */
    expect(stripped).toContain("export function selectAuthInstance");
    expect(stripped).toContain("process.env");
  });

  it("does not log a link or swallow mail, it refuses to send", async () => {
    /*
     * `createLibertyAuth` requires a transport with no default, and its comment
     * gives both wrong answers: a default that dropped mail makes
     * requireEmailVerification unsatisfiable in a way that looks like a user
     * problem, and a default that logged the URL puts a one-click
     * account-takeover token in the log aggregator. The placeholder must do
     * neither.
     */
    const raw = await readFile(new URL("./auth-instance.ts", import.meta.url), "utf8");
    const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const start = stripped.indexOf("async function noMailTransport");
    expect(start).toBeGreaterThan(-1);
    const body = stripped.slice(start, stripped.indexOf("\n}", start));

    expect(body).not.toContain("console.");
    expect(body).not.toContain("message.url");
    expect(body).toContain("throw new Error");
  });
});

describe("the rate-limit policy reaches the instance (PL-0719)", () => {
  /*
   * THE ONLY TEST HERE THAT TAKES THE SUCCESS PATH, and it takes it for a
   * reason the other cases do not need. Every assertion above is about a
   * REFUSAL, because `better-auth.ts` argues that assertions about a
   * constructed instance are assertions about a stub of the vendor's
   * behaviour. This one is different: it reads back OUR OWN OPTION OBJECT off
   * the instance, which is our data and not the library's.
   *
   * WHY IT IS WORTH THE EXCEPTION. The behavioural proof --
   * `e2e/tests/auth-rate-limit.spec.ts` -- cannot distinguish this product's
   * policy from the library's, and says so: the values were deliberately kept
   * the same as better-auth's defaults, because changing a security limit
   * without evidence is not an improvement. So a server that throttles proves
   * only that SOMETHING throttles. This is what proves the configuration is
   * ours: delete the `rateLimit` key from `createLibertyAuth` and these
   * assertions fail, while the end-to-end test keeps passing on the library's
   * default.
   */
  it("passes an EXPLICIT rateLimit rather than leaving the library's default", async () => {
    const resolved = selectAuthInstance(inputs());
    expect(resolved.ok, resolved.ok ? "" : resolved.detail).toBe(true);
    if (!resolved.ok) return;

    const rateLimit = resolved.auth.options.rateLimit;
    expect(
      rateLimit,
      "createLibertyAuth passed no rateLimit key, so every number governing this product's " +
        "brute-force posture is again a dependency default that can change with no diff here"
    ).toBeDefined();
    /*
     * A LITERAL `true`, NOT `isProduction`. The inherited default tied a
     * security control to NODE_ENV, which is a build flag and not a security
     * boundary.
     */
    expect(rateLimit?.enabled).toBe(true);
    expect(rateLimit?.window).toBe(DEFAULT_RATE_LIMIT.windowSeconds);
    expect(rateLimit?.max).toBe(DEFAULT_RATE_LIMIT.maxRequests);
  });

  it("states the credential rule on the path the product actually serves", async () => {
    /* `/sign-in/email` is what `e2e/src/identity.ts` posts to and what the
     * end-to-end test above exercises. A rule written for a path nothing
     * reaches would be a policy that describes nothing. */
    const resolved = selectAuthInstance(inputs());
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const rules = resolved.auth.options.rateLimit?.customRules ?? {};
    for (const path of ["/sign-in", "/sign-in/*", "/sign-up", "/sign-up/*"]) {
      expect(rules[path], `no custom rule for ${path}`).toEqual({
        window: CREDENTIAL_RATE_LIMIT.windowSeconds,
        max: CREDENTIAL_RATE_LIMIT.maxRequests
      });
    }
  });

  it("NEVER LOOSENS THE CREDENTIAL PATHS, whatever else the rules say", async () => {
    /*
     * The guard that matters more than the exact values. A later edit may
     * have good reason to add a rule or change the backstop; none of them has
     * a reason to let the endpoint where a password is guessed become more
     * permissive than the general limit.
     */
    const resolved = selectAuthInstance(inputs());
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const rateLimit = resolved.auth.options.rateLimit;
    const backstop = rateLimit?.max ?? Number.POSITIVE_INFINITY;
    for (const [path, rule] of Object.entries(rateLimit?.customRules ?? {})) {
      if (typeof rule === "function" || rule === undefined) continue;
      expect(rule.max, `${path} is more permissive than the general backstop`).toBeLessThanOrEqual(
        backstop
      );
    }
  });
});
