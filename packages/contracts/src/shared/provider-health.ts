/* -------------------------------------------------------------------------
 * Shared vocabulary: the provider health floor
 *
 * A LEAF module, and a stricter leaf than its siblings: it imports NOTHING AT
 * ALL, not even zod. That is load-bearing rather than incidental, and the
 * reason is at the bottom of this comment.
 *
 * WHY THIS FILE EXISTS. One threshold was written down twice.
 * `@liberty/media-engine` declared `PROVIDER_HEALTH_FLOOR = 0.5` and excluded a
 * candidate scoring below it; `@liberty/provider-sdk` separately set
 * `failBelow: 0.5` in its shipped policy and returned `fail` below it. Three
 * comments and one runtime message in `health.ts` ASSERTED that the two agree,
 * because provider-sdk cannot import media-engine and the agreement had nowhere
 * else to live. Prose is exactly what does not survive somebody tuning one of
 * the two numbers: the day they diverge, `fail` stops meaning "media-engine will
 * drop this" and starts meaning nothing in particular, and nothing goes red.
 *
 * Both packages already depend on `@liberty/contracts` and neither is reachable
 * from it, so the value moves here and costs no new edge. Putting it in either
 * consumer would have required an edge from media-engine to provider-sdk, which
 * is the provider-adapter isolation boundary (invariant 3) pointing backwards.
 *
 * THE COMPARISON IS PART OF THE VOCABULARY, which is why `isBelowHealthFloor`
 * is here and is the only place the operator is written. Sharing the NUMBER
 * while leaving two hand-written comparisons behind would have fixed half of a
 * two-part coupling: provider-sdk's shipped prior for an unobserved provider is
 * exactly this value, so an unobserved provider sits ON the floor, and it
 * survives only because the comparison is a strict `<`. A refactor that moved
 * either site to `<=` would silently bury every provider nobody has observed
 * yet -- which is self-fulfilling, since a buried provider is never asked
 * anything and so never accumulates the observations that would let it out.
 * `health.ts` documents that coupling at length and `health.test.ts` pins it;
 * this function is what makes the strictness impossible to change in one place
 * only.
 *
 * WHAT THIS MODULE MUST NEVER GROW. Health is an OPERATIONAL signal and rights
 * are an ENTITLEMENT one. PL-0303's entitlement separation rests on the fact
 * that the health mechanism cannot see a rights value, a candidate or a source,
 * and media-engine checks the rights allowlist first and unconditionally, so a
 * health verdict can only subtract eligibility and never grant it. A shared
 * module sitting between the two packages is the obvious place for that
 * separation to be eroded by accident -- a rights type imported "just for a
 * signature", and suddenly there is a path. So this file carries threshold
 * vocabulary and nothing else, its import list is empty, and
 * `provider-health.test.ts` asserts both mechanically rather than trusting this
 * paragraph.
 * ---------------------------------------------------------------------- */

/**
 * The provider health score below which a candidate is excluded from playback
 * outright, and below which a provider's health verdict is `fail`.
 *
 * ONE value with two names in the consumers and one meaning. `media-engine`
 * re-exports it under its historical name `PROVIDER_HEALTH_FLOOR`;
 * `provider-sdk` uses it as the shipped policy's `failBelow`. `failBelow`
 * remains a POLICY FIELD rather than being replaced by this constant, because a
 * policy is versioned and a future version may legitimately move it -- but the
 * SHIPPED policy reads this symbol, so the two cannot drift by an edit to one
 * of them.
 *
 * The value is coupled to the shipped Laplace 1/1 prior, under which an
 * unobserved provider scores exactly 0.5. Changing this number without changing
 * that prior changes which providers are reachable at all. See
 * `packages/provider-sdk/src/health.ts`.
 */
export const PROVIDER_HEALTH_FLOOR = 0.5;

/**
 * Strictly below the floor, and the only place that comparison is written.
 *
 * `floor` is a parameter rather than a closed-over constant so that a versioned
 * policy carrying its own `failBelow` uses the same OPERATOR as the engine even
 * when it does not use the same NUMBER. Callers with no policy omit it.
 *
 * A score exactly equal to the floor is NOT below it and is not excluded. That
 * is the shipped prior's position, and it is deliberate: "we have no idea" is
 * the weakest standing that is still not an exclusion.
 */
export function isBelowHealthFloor(score: number, floor: number = PROVIDER_HEALTH_FLOOR): boolean {
  return score < floor;
}
