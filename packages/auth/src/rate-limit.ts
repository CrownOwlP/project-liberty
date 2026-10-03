/* -------------------------------------------------------------------------
 * The authentication rate-limit policy, chosen here rather than inherited
 * (PL-0719)
 *
 * ==========================================================================
 * WHY THIS FILE EXISTS
 * ==========================================================================
 *
 * PL-0715 was opened because the watchlist e2e harness read a THROTTLED
 * sign-up as a wrong password and reported a product failure. Repairing the
 * harness was the right repair and is done. It did not answer the question the
 * defect exposed, which is that this product had never DECIDED what its
 * authentication rate-limit policy is.
 *
 * It had one. `better-auth` 1.7.5 supplies it, and `better-auth.ts` passed no
 * `rateLimit` key at all, so every number below arrived from a dependency:
 *
 *   dist/context/create-context.mjs:172  enabled: options.rateLimit?.enabled ?? isProduction
 *   dist/context/create-context.mjs:173  window:  options.rateLimit?.window || 10
 *   dist/context/create-context.mjs:174  max:     options.rateLimit?.max    || 100
 *   dist/context/create-context.mjs:175  storage: ... || "memory"
 *   dist/api/rate-limiter/index.mjs:302  getDefaultSpecialRules()
 *
 * Nothing in this repository named any of them, which has two consequences and
 * the second is the serious one. A reader could not find out what the product
 * does without reading `node_modules`. And a dependency bump that changed a
 * default would change this product's brute-force posture WITH NO DIFF -- no
 * line to review, no test to fail, nothing in a release note anybody here
 * wrote. That is the defect. The numbers themselves were defensible.
 *
 * ==========================================================================
 * WHAT IS DECIDED, AND WHAT IS DELIBERATELY NOT CHANGED
 * ==========================================================================
 *
 * THE VALUES ARE KEPT. Ten seconds and three attempts on the credential paths
 * is the right order of magnitude and is argued for below; adopting it on
 * purpose is a decision, and changing it without evidence would not be. This
 * file does not loosen anything -- a reader can check that against the figures
 * quoted above, which is part of why they are quoted.
 *
 * WHAT CHANGES IS WHO OWNS THEM. They are stated here, passed explicitly to
 * the library, and reported through `enabled-surface.ts`, which already exists
 * to make "what is switched on" a hand-written second reading that a test
 * compares against an allowlist. A rate-limit policy is exactly that kind of
 * fact, so it joins that machinery rather than inventing a parallel one.
 *
 * ==========================================================================
 * THE DEVELOPMENT/PRODUCTION DIVERGENCE IS REMOVED, ON PURPOSE
 * ==========================================================================
 *
 * The inherited `enabled` was `isProduction` -- throttling ON in production
 * and OFF in development -- and NODE_ENV is not a security boundary. It is a
 * build flag that says which bundle was produced, and letting it decide
 * whether a brute-force control runs means any deployment anyone starts with
 * `next dev` has no such control, whatever it is serving and to whom.
 *
 * STATED EXACTLY, BECAUSE THE WEAKER VERSION OF THIS ARGUMENT IS WRONG. It is
 * tempting to say the e2e suite proved the divergence by running in both
 * configurations. It did not: a development build in this harness is given no
 * auth secret and therefore has no identity system at all, so nothing is
 * throttled there because nothing authenticates there. The divergence is real
 * for a development-mode deployment that DOES have an identity system -- which
 * this harness can produce, and which a developer running against a local
 * database produces every day -- and that is the configuration the argument
 * rests on.
 *
 * So it is ON everywhere, and there is NO SWITCH. No configuration field, no
 * environment variable, no test-only path. A knob that turns a security
 * control off is a bypass whoever adds it, and the honest cost is stated
 * rather than hidden: a developer who mistypes a password four times in ten
 * seconds waits ten seconds, and the e2e harness must create accounts at a
 * rate a real client could.
 *
 * ==========================================================================
 * THE KEY, AND A HAZARD THIS FILE REPORTS RATHER THAN SILENTLY FIXES
 * ==========================================================================
 *
 * The library keys each bucket by CLIENT IP AND PATH
 * (`createRateLimitKey(ip, path)`, rate-limiter/index.mjs:245). When it cannot
 * resolve a client IP it falls back to a single literal key,
 * `"no-trusted-ip"`, and logs a warning -- which means ONE SHARED BUCKET FOR
 * EVERY CLIENT: three sign-ins per ten seconds for the entire deployment.
 * Behind a reverse proxy with no `advanced.ipAddress.ipAddressHeaders` or
 * `trustedProxies` configured, that is the live behaviour.
 *
 * IT IS NOT FIXED HERE, and that is a judgement rather than an omission.
 * Trusting a forwarded-IP header is a decision about which hop may assert a
 * client address, and trusting a spoofable header is WORSE than a shared
 * bucket: it hands an attacker a per-request bypass of the very control this
 * file is here to own. Which header is trustworthy depends on a deployment
 * topology nobody has yet fixed for this product. So the hazard is written
 * down, named in the surface report, and left for the deployment decision it
 * belongs to.
 *
 * ==========================================================================
 * WHAT THIS IS NOT
 * ==========================================================================
 *
 * NOT A NEW DEFENCE. CAPTCHA, account lockout, device fingerprinting and IP
 * reputation are all out of scope and none of them is here. This file names
 * and owns the control that was already running.
 * ---------------------------------------------------------------------- */

/** One bucket: how many requests, over how long, for which paths. */
export interface AuthRateLimitRule {
  /** What this rule protects, in one line, for a reader of a 429. */
  readonly describe: string;
  /**
   * Request paths this rule governs, as the auth handler sees them -- relative
   * to the auth base path, so `/sign-in/email` rather than
   * `/api/auth/sign-in/email`.
   *
   * BOTH THE EXACT PATHS AND THE GLOB ARE LISTED, which looks redundant and is
   * not. The library matches a custom rule by exact string unless the key
   * contains `*`, and its glob treats `/` as a segment separator, so
   * `/sign-in/*` matches `/sign-in/email` and does not match `/sign-in`.
   * Listing both spellings means the rule applies however the endpoint is
   * reached, and because every spelling carries the SAME numbers, no ambiguity
   * in matching can change the answer.
   */
  readonly paths: readonly string[];
  readonly windowSeconds: number;
  readonly maxRequests: number;
}

/**
 * Credential presentation: the attempt that can be guessed.
 *
 * THREE IN TEN SECONDS, and the reasoning is a trade between two people who
 * both exist. A credential-stuffing attacker wants thousands of attempts a
 * minute against one address or one password against thousands of addresses;
 * three per ten seconds per IP makes that uninteresting without a botnet, and
 * against a botnet no per-IP limit is the control that saves you. A household
 * of four behind one address, two of whom are typing a password on a television
 * remote, wants not to be told to go away. Ten seconds is short enough that a
 * person who fat-fingers a password twice is never aware of it, and three is
 * enough for a correction and a retry.
 *
 * IT ERRS TOWARD THE HOUSEHOLD, deliberately. The limit is a cost imposed on
 * bulk guessing, not a lockout, and it resets by the clock rather than
 * requiring anyone to ask for help. The control that genuinely stops a
 * determined attacker is a second factor, which `enabled-surface.ts` records
 * as withheld-not-rejected and which is a product decision with recovery and
 * support consequences -- not something to approximate by making this number
 * hostile.
 *
 * CHANGE-PASSWORD AND CHANGE-EMAIL ARE IN THE SAME RULE because they are the
 * same kind of event: an endpoint where presenting a credential, or changing
 * the address a reset would be sent to, can be attempted repeatedly by someone
 * who already has a foothold.
 */
export const CREDENTIAL_RATE_LIMIT: AuthRateLimitRule = {
  describe: "sign-in, sign-up, password change and email change",
  paths: [
    "/sign-in",
    "/sign-in/*",
    "/sign-up",
    "/sign-up/*",
    "/change-password",
    "/change-password/*",
    "/change-email",
    "/change-email/*"
  ],
  windowSeconds: 10,
  maxRequests: 3
};

/**
 * Message-sending: the attempt that costs somebody else something.
 *
 * SIXTY SECONDS RATHER THAN TEN, and it is a different control answering a
 * different abuse. Nothing is being guessed here. What is being spent is a
 * stranger's inbox: these endpoints send mail to an address the requester
 * types, so an unthrottled one is a mail-bombing service with this product's
 * reputation attached to it. The limit therefore has to be slow enough to make
 * that pointless, and it can be, because the legitimate request is "send it
 * again, I did not get it" and nobody makes that request four times a minute.
 */
export const RECOVERY_RATE_LIMIT: AuthRateLimitRule = {
  describe: "password reset and verification mail",
  paths: [
    "/request-password-reset",
    "/forget-password",
    "/forget-password/*",
    "/send-verification-email"
  ],
  windowSeconds: 60,
  maxRequests: 3
};

/**
 * Everything else the auth handler serves.
 *
 * A HUNDRED IN TEN SECONDS IS A BACKSTOP, NOT A SECURITY CONTROL, and calling
 * it one would be the overstatement this file exists to avoid. The traffic it
 * governs is dominated by `/get-session`, which every page of this application
 * asks for and which a viewer opening several tabs legitimately asks for in
 * bursts. Its job is to stop one client exhausting the process, and the two
 * rules above are what answer the attacks.
 */
export const DEFAULT_RATE_LIMIT = {
  windowSeconds: 10,
  maxRequests: 100
} as const;

/** The rules, in the order a reader should meet them. */
export const AUTH_RATE_LIMIT_RULES: readonly AuthRateLimitRule[] = [
  CREDENTIAL_RATE_LIMIT,
  RECOVERY_RATE_LIMIT
];

/**
 * Where the counters live, named so a change of mind is a diff.
 *
 * In the process's own memory, which has two consequences worth stating. The
 * counters are PER PROCESS, so a deployment running several instances behind a
 * load balancer multiplies every limit by the instance count; and they are
 * lost on restart, so a deploy clears every bucket. Both are acceptable for a
 * limit measured in seconds and neither is acceptable silently. A shared store
 * is the fix when this product runs more than one instance, and that is a
 * deployment decision with an operational cost, not a line to change here
 * today.
 */
export const AUTH_RATE_LIMIT_STORAGE = "memory" as const;

/**
 * What a bucket is keyed by.
 *
 * Stated as data so the surface report can carry it and so the hazard in this
 * file's header has a name a reader can search for.
 */
export const AUTH_RATE_LIMIT_KEY = "client-ip+path" as const;

/**
 * Which rule governs a path, as a pure decision.
 *
 * A SECOND READING, NOT THE IMPLEMENTATION. The library does the enforcing;
 * this answers the same question over the same data so a test can assert what
 * the policy SAYS without a server, and so the e2e test that proves the
 * behaviour has something to check its expectation against. The two agreeing
 * is the thing worth knowing; this function being the only reading would prove
 * nothing.
 *
 * Matching mirrors the library's: an exact path, or a glob where `*` covers
 * exactly one segment.
 */
export function rateLimitFor(path: string): AuthRateLimitRule | null {
  for (const rule of AUTH_RATE_LIMIT_RULES) {
    for (const pattern of rule.paths) {
      if (!pattern.includes("*")) {
        if (pattern === path) return rule;
        continue;
      }
      const prefix = pattern.slice(0, pattern.indexOf("*"));
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      /* One segment, and a non-empty one: `/sign-in/*` is `/sign-in/email`,
       * not `/sign-in` and not `/sign-in/email/extra`. */
      if (rest.length > 0 && !rest.includes("/")) return rule;
    }
  }
  return null;
}

/**
 * The HTTP status a throttled request receives.
 *
 * Named rather than written as a literal at each use, because the whole origin
 * of this task is two refusals being confused for each other.
 */
export const RATE_LIMITED_STATUS = 429;

/** The header the library attaches, carrying seconds until the bucket refills. */
export const RETRY_AFTER_HEADER = "X-Retry-After";

/**
 * Tell the two refusals apart.
 *
 * THIS IS THE FUNCTION PL-0715 EXISTED FOR. A harness -- or a sign-in form, or
 * an operator reading a log -- that treats a 429 as a wrong password reports
 * a product failure that is not one, which is precisely what happened and cost
 * a round. They are different facts about different things: one says the
 * credential is wrong, the other says this client has asked too often and the
 * credential was never examined.
 *
 * Deliberately total over the statuses these endpoints answer with, so a
 * caller gets a named case rather than a boolean that quietly collapses the
 * distinction again.
 */
export type AuthRefusal = "rate_limited" | "credential_rejected" | "other";

export function classifyAuthRefusal(status: number): AuthRefusal {
  if (status === RATE_LIMITED_STATUS) return "rate_limited";
  if (status === 401 || status === 403) return "credential_rejected";
  return "other";
}
