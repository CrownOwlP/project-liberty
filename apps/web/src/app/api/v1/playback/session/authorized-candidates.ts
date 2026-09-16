import type { StreamCandidate } from "@liberty/contracts/domains/playback";
import { PROTECTION_NOT_STATED, type ContentProtection } from "@liberty/contracts/shared/drm";
import { LATENCY_CEILING_MS } from "@liberty/media-engine";
import {
  classifyHost,
  createFixtureProvider,
  type FixtureProvider as SdkFixtureProvider,
  type FixtureProviderRejectionReason,
  type FixtureRightsBasis
} from "@liberty/provider-sdk";
import { localDeploymentFor, NonDeploymentEnvironment } from "../../../deployment-environment";

/* -------------------------------------------------------------------------
 * Where a session's candidates come from (PL-0501)
 *
 * THE SERVER RESOLVES; THE CLIENT NAMES. A request carries a content id and a
 * device capability profile, and nothing else (see `contract.ts`). Everything
 * that ends up as a URL in a response was produced on this side of the
 * boundary, by an adapter that established authorization first. That is product
 * invariant 1, and it is a property of the SHAPE of this module: a resolver is
 * a function of a normalized content id, so there is no parameter through which
 * a caller could suggest a stream.
 *
 * WHY THE SEAM EXISTS AT ALL rather than the route calling a provider directly:
 * `@liberty/provider-sdk`'s `AuthorizedMediaProvider` resolves candidates for a
 * `CatalogItemRef` -- a provider id, an external id and a rights basis -- and
 * nothing in this app yet maps a normalized content id onto one for a REAL
 * provider. That mapping is a catalog/provider-registry question, not a
 * session-API question, and inventing an answer here would put provider
 * configuration inside an HTTP route. So the session API depends on the
 * CAPABILITY, injectably, and a registry lands behind it without this file
 * changing.
 * ---------------------------------------------------------------------- */

/**
 * A URL an authorized session would hand to the player, with the one fact the
 * outbound URL policy needs about where it came from.
 *
 * Separate from the `StreamCandidate` rather than flattened into it, because
 * the two have different lifetimes and different readers: the candidate is
 * metadata a provider stated and the ranking scores, and this is a
 * credential-bearing address that no ranking should ever see. `ranking.ts`
 * takes `StreamCandidate` and could not read this even by accident.
 *
 * `allowLoopback` mirrors `UrlPolicyOptions` in `@liberty/provider-sdk`, and it
 * is deliberately only HALF of the permission: loopback also requires the
 * deployment to say it is local. A source claiming to be local is a statement
 * about somebody's laptop, and honouring it alone in a hosted process would aim
 * this endpoint at our own admin ports.
 *
 * THIS IS THE SEAM FOR A SHORT-LIVED PLAYBACK CREDENTIAL, and it is the right
 * place for one: only the adapter that owns an origin can sign for it, so a
 * signed URL or a licence token belongs to whatever produces this record, with
 * the session's `expiresAt` bounding how long a client may hold it. Nothing
 * mints one today -- `uri` is whatever the resolver stated -- and no route,
 * bundle or fixture in this task contains a licence URL or key.
 */
export interface AuthorizedSource {
  readonly uri: string;
  /** `null` = the resolver could not state one. Never a guess. */
  readonly mimeType: string | null;
  /** Whether the SOURCE is declared local. Necessary for loopback, never sufficient. */
  readonly allowLoopback: boolean;
}

/**
 * A candidate, its address, and what it states about content protection.
 *
 * This is `ResolvedStreamCandidate` in this route's vocabulary --
 * `StreamCandidate` plus `protection` -- with the address kept on `source` for
 * the reason above. `protection` sits beside `source` rather than inside
 * `candidate` because `candidate` is the RANKER's input and
 * `docs/API_CONTRACTS.md` is explicit that the descriptor is player-input:
 * `@liberty/media-engine` has no use for a key system, and a score component
 * that discounted protected candidates would be a second opinion about routing.
 *
 * REQUIRED, never optional. A resolver that has nothing to say states
 * `PROTECTION_NOT_STATED`; it may not stay silent, because an absent field and
 * a producer that predates the field are indistinguishable, and the reading an
 * absent field invites is "there is no DRM" -- which
 * `docs/DESKTOP_PLAYBACK.md` §4 names as the one way this design produces an
 * invariant-2 incident.
 */
export interface AuthorizedCandidate {
  readonly candidate: StreamCandidate;
  readonly source: AuthorizedSource;
  /** What the producing boundary states about encryption. Never derived here. */
  readonly protection: ContentProtection;
}

/**
 * What a resolver can answer.
 *
 * Four outcomes rather than a list-or-null, because they send a reader to four
 * different systems and the session response distinguishes them: an unknown id
 * is the catalog's problem, an unavailable provider is the provider's, an
 * unconfigured one is the operator's, and a resolved-but-empty list is a real
 * answer meaning "this title has no streams right now".
 *
 * A resolver may still throw -- it talks to a network -- and `issue-session.ts`
 * treats a throw as `provider-unavailable` without reading the error's text.
 */
export type AuthorizedCandidateResolution =
  | { readonly status: "resolved"; readonly candidates: readonly AuthorizedCandidate[] }
  | { readonly status: "not-found" }
  | { readonly status: "not-configured" }
  | { readonly status: "provider-unavailable"; readonly detail: string };

/**
 * `requestId` is generated by this server per request and is NOT read from an
 * inbound header. A client-chosen correlation id forwarded to a third party is
 * a client-chosen value in somebody else's logs, and `ProviderContext`'s own
 * documentation makes the same point about `profileId`.
 */
export interface ResolverContext {
  readonly requestId: string;
}

export type AuthorizedCandidateResolver = (
  contentId: string,
  context: ResolverContext
) => AuthorizedCandidateResolution | Promise<AuthorizedCandidateResolution>;

/* -------------------------------------------------------------------------
 * THE DEVELOPMENT FIXTURES, WHICH THIS MODULE NO LONGER IMPLEMENTS.
 *
 * Everything below CONFIGURES and CONSUMES `@liberty/provider-sdk`'s fixture
 * provider. Nothing below declares rights, composes a media URL, states a media
 * fact, invents a candidate id or carries a copy of the opaque-reference rule --
 * and that is the whole point of this section rather than an incidental
 * property of it.
 *
 * WHAT WAS HERE BEFORE, because the defect is worth naming precisely. This file
 * built its own `owned` rights basis, its own three candidates, its own
 * `fixtureUri`, its own reserved reference token and its own copy of
 * `OPAQUE_RIGHTS_REFERENCE_PATTERN`, while `packages/provider-sdk/src/fixture/`
 * independently implemented the same adapter. Two fixture providers asserting
 * rights over the same imaginary media is the exact arrangement that produced
 * the original incident -- a second, unguarded copy of these fixtures shipping
 * in the watch route -- and having the second copy inside a package rather than
 * inside a route did not change what it was. Product invariant 3 says provider
 * adapters live behind `@liberty/provider-sdk`; there is now one of them.
 *
 * WHAT THIS MODULE STILL OWNS, and must, because the SDK cannot:
 *
 *   - the ORIGIN the operator configured, which is a fact about this
 *     deployment;
 *   - whether that origin is loopback, which is the SOURCE half of the loopback
 *     permission. `url-policy.ts` requires two independently-owned facts, and
 *     collapsing them into one owner is a defect this route has already had;
 *   - whether this instance is a local deployment, which is the DEPLOYMENT half
 *     of the same permission, read from the one classification this app
 *     consults;
 *   - obtaining the classification that decides whether a fixture provider may
 *     be constructed at all. Performing it is not this module's job either --
 *     that happens in `@liberty/contracts/shared/runtime` -- but asking for it
 *     is, because this is where the answer is needed.
 * ---------------------------------------------------------------------- */

/**
 * Where fixture streams are served from.
 *
 * READ HERE AND NOWHERE ELSE. `apps/web/src/app/watch/watch-session.ts` used to
 * read the same variable to build its own copy of these fixtures, and the note
 * that once stood here asked the next reader to keep the two in step -- two
 * fixture origins would have meant the watch page and the session API disagreed
 * about what "the dev rig" is. The watch route now imports
 * `resolveAuthorizedCandidates` instead of restating it, so there is one reader
 * and the agreement is structural rather than remembered.
 *
 * `.invalid` is reserved by RFC 2606 and resolves nowhere, so the default can
 * never accidentally reach a real host -- the fixtures fail, failover walks all
 * three, and the reason trail shows the whole sequence, which is more useful
 * than a player that silently does nothing.
 *
 * OPERATOR-SUPPLIED AND THEREFORE UNTRUSTED AS A URL, even though the operator
 * is not an attacker: a typo is as capable of aiming this at 169.254.169.254 as
 * malice is. Nothing here sanitises it. It is handed to `createFixtureProvider`
 * verbatim, which REFUSES it with a named `checkUrl` reason rather than
 * rewriting it -- so a private host, a plaintext origin or embedded credentials
 * produce a refusal a caller can report, and the composed candidate URLs are
 * checked again by `issue-session.ts` immediately before any of them is
 * published. Stripping credentials or rewriting a private host here would be
 * worse than leaving them: it would make a misconfigured origin silently WORK,
 * and the gates that exist to report it would never fire.
 */
const FIXTURE_MEDIA_ORIGIN = process.env.LIBERTY_FIXTURE_MEDIA_ORIGIN ?? "https://fixtures.invalid";

/* -------------------------------------------------------------------------
 * WHERE THE ENVIRONMENT GATE WENT, AND WHY THERE IS NO `FIXTURE_ENVIRONMENTS`
 * HERE ANY MORE.
 *
 * This module used to export `FIXTURE_ENVIRONMENTS`, an alias of
 * `NON_DEPLOYMENT_ENVIRONMENTS`, and then test it with
 * `FIXTURE_ENVIRONMENTS.includes(process.env.NODE_ENV ?? "")`. So did
 * `../resolve/handler.ts`. One array, two spellings of the same `.includes`,
 * and `issue-session.ts` reaching the same answer a third way through
 * `isLocalDeployment` -- which is a restatement of the classification even
 * though the values could not drift, and a restatement is what has to be kept
 * in step by hand.
 *
 * The allowlist is now expressed exactly once, in
 * `@liberty/contracts/shared/runtime`, and consumed rather than re-tested --
 * including by `@liberty/provider-sdk`, which held a same-shaped array of its
 * own until PL-0301 and now requires an issued classification to be handed to
 * it. `app/api/deployment-environment.ts` is this app's door to that module and
 * decides the shape of the consumption; the two shapes are different on
 * purpose:
 *
 *   - `isLocalDeployment()` for the callers that need a boolean to hand to
 *     `checkUrl`, or to decide whether a development-only route exists;
 *   - `NonDeploymentEnvironment.classify()` for THIS one, because what is gated
 *     here is not an input to a later check -- it is the construction of a
 *     rights claim. See `fixtureProvider`;
 *   - `localDeploymentFor(environment)` for the flag that travels WITH such a
 *     classification, so the two are one answer rather than two reads.
 *
 * NONE OF THE THREE TAKES A RUNTIME NAME. The mint reads the process and
 * declares no parameter, so this module cannot ask to be classified as anything
 * -- which is the difference between consuming the gate and restating it.
 * ---------------------------------------------------------------------- */

/**
 * Whether the configured origin names the machine this process runs on.
 *
 * DERIVED, never asserted, and that is a correction. Every fixture candidate
 * used to carry `allowLoopback: true` unconditionally, with a comment observing
 * that loopback also needs the deployment to say it is local. True, and it
 * defeated the design it cited: `url-policy.ts` requires TWO permissions
 * expressly because they have DIFFERENT OWNERS -- a source config and the
 * process environment -- so that "neither owner can grant loopback by
 * themselves". Hardcoding the source half left one owner, and that owner is
 * `NODE_ENV`, which is also what decides whether fixtures resolve at all. The
 * two independent conditions had collapsed into one variable.
 *
 * Reading it off the origin restores the separation and is the more honest
 * claim anyway: the source is local exactly when the operator pointed it at a
 * loopback host, and it is not local when they did not. `classifyHost` is the
 * provider SDK's classifier rather than a string test, so `127.0.0.1`,
 * `localhost`, `[::1]` and `[::ffff:7f00:1]` are one answer and a name that
 * merely looks local is not.
 */
function originIsLoopback(origin: string): boolean {
  try {
    return classifyHost(new URL(origin).hostname) === "loopback";
  } catch {
    /* Not a URL at all. Not loopback, and refused as `url_unparseable` by
     * `createFixtureProvider` before any candidate exists. */
    return false;
  }
}

/**
 * The one fixture provider, in this route's vocabulary.
 *
 * A SHAPE ADAPTER AND NOT A SECOND PROVIDER, which is a distinction worth being
 * explicit about in this file of all files. It renames three fields --
 * `FixtureCandidate`'s `uri`, `mimeType` and `allowLoopback` become an
 * `AuthorizedSource` -- and forwards the candidate unchanged. It declares no
 * rights, composes no URL, invents no id and states no media fact; every one of
 * those comes from `@liberty/provider-sdk`'s `FixtureProvider`, which this
 * module imports as `SdkFixtureProvider` and wraps. If a future edit adds a
 * field here that the SDK did not state, that is the duplication coming back.
 */
export interface FixtureProvider {
  /**
   * The `NODE_ENV` that admitted this provider.
   *
   * Reported, never re-tested. Carried so a caller that logs or asserts WHICH
   * environment authorised the fixtures reads the value the classification
   * actually used, instead of re-reading `process.env` and possibly reporting a
   * different one.
   */
  readonly environment: string;
  /**
   * The declaration every candidate below carries: a category from the provider
   * SDK's own closed vocabularies plus an OPAQUE internal reference. The rule
   * that reference has to satisfy lives in `@liberty/provider-sdk`'s
   * `fixture/rights.ts` and is stated in exactly that one place.
   */
  readonly rightsBasis: FixtureRightsBasis;
  candidates(contentId: string, context: ResolverContext): readonly AuthorizedCandidate[];
}

/**
 * What asking for the fixture provider can answer.
 *
 * A REFUSAL IS DATA, not an exception and not an empty list. The operator's
 * origin is checked by the SDK's outbound URL policy at construction, so
 * `https://user:pass@rig.test`, `https://10.0.0.5` and `not-a-url` each produce
 * a NAMED reason here. Folding those into "no candidates" would lose the one
 * thing that tells an operator what to fix, and folding them into
 * `not-configured` would tell them to configure a provider they already
 * configured.
 */
export type FixtureProviderResult =
  | { readonly status: "ready"; readonly provider: FixtureProvider }
  | {
      readonly status: "refused";
      readonly reason: FixtureProviderRejectionReason;
      readonly detail: string;
    };

/**
 * The fixture provider, which cannot be obtained without proof that this process
 * is not a deployment.
 *
 * THIS ARGUMENT IS THE WHOLE RIGHTS CONTROL, so it is worth being precise about
 * what it does. The fixture candidates declare `owned` over media nothing has
 * ever opened. Nothing verifies that: there is no probe here, no manifest is
 * read, and `issue-session.ts` treats the value exactly as it treats any
 * adapter's -- membership of `PLAYABLE_RIGHTS` and no further question, because
 * the platform's model is that adapters establish authorization and the engine
 * ranks among what they established. An unverifiable declaration therefore has
 * exactly one real control, and it is that this path cannot run on a build that
 * ships.
 *
 * IT USED TO BE A CONDITION AND IS NOW A TYPE. The gate was
 * `FIXTURE_ENVIRONMENTS.includes(process.env.NODE_ENV ?? "")` inside the
 * resolver: correct, and deletable. Delete it and every fixture resolves in
 * production, and everything still compiles. That is not a hypothetical failure
 * mode here -- `watch/watch-session.ts` shipped a second copy of these fixtures
 * under NO environment condition at all, and `docs/E2E.md` recorded the
 * difference as intended behaviour.
 *
 * THE CHAIN, END TO END, because it now crosses a package boundary:
 *
 *   1. `NonDeploymentEnvironment` is `ClassifiedRuntime` from
 *      `@liberty/contracts/shared/runtime`, and cannot be built anywhere but
 *      that module: its brand key is a `unique symbol` that module keeps to
 *      itself, so no consumer can name the property and none can write it. The
 *      only producer is `classifyRuntime`, which TAKES NO ARGUMENT -- it
 *      classifies the process it is running in, and answers `null` for every
 *      environment outside the one allowlist in this repository, so no caller
 *      can obtain one by naming an environment it is not in. A caller cannot
 *      reach this function without handling that `null`, and deleting the check
 *      is a COMPILE ERROR rather than a silent widening;
 *   2. this function hands that capability to `createFixtureProvider`
 *      unchanged. It is not re-boxed on the way through, so the object the SDK
 *      receives is the object the classification issued;
 *   3. `createFixtureProvider` asks the contracts module's registry whether
 *      that exact object was issued -- the check a brand alone cannot make,
 *      because a cast and a spread copy both type-check -- refuses by name if
 *      it was not, and only then mints its own nominal witness INSIDE the
 *      factory and builds the rights basis there. It is the only path to either
 *      that this app has: `NonProductionRuntime` and `fixtureRightsBasis` are
 *      not exported from `@liberty/provider-sdk`, and the package publishes one
 *      entry point, so neither can be named here at all. The fabricated `owned`
 *      declaration is therefore a value that CANNOT BE BUILT from this app
 *      except by going through step 1, rather than a value that is built and
 *      then withheld.
 *
 * What it does not do is defend against an edit to those modules. Nothing in
 * TypeScript can. What it defends against is the way this defect actually
 * recurs: a change somewhere else that quietly stops consulting the gate, or a
 * call site that writes the permission-granting argument itself -- which is
 * what the old structural `{ nodeEnv }` interface allowed and PL-0706 removed.
 *
 * A REMAINING GAP, recorded rather than papered over: a hosted deployment that
 * exports `NODE_ENV=development` and runs `next dev` still gets a witness.
 * Nothing here can distinguish that from a laptop, because it IS a development
 * build; the control for it is not shipping one.
 *
 * `origin` is a parameter rather than only an environment read so tests can pin
 * it. A test whose expectations depend on an operator's `.env.local` is a test
 * that fails on one machine and passes on another.
 */
export function fixtureProvider(
  environment: NonDeploymentEnvironment,
  origin: string = FIXTURE_MEDIA_ORIGIN
): FixtureProviderResult {
  const created = createFixtureProvider(environment, {
    mediaOrigin: origin,
    /*
     * The engine's latency ceiling, so an untimed candidate is charged the
     * penalty dimension IN FULL rather than rewarded for stating nothing.
     * `scoring.ts` states the rule; the SDK requires the number from a composition
     * root because a provider adapter must not depend on the ranker that scores
     * its output.
     */
    unmeasuredLatencyMs: LATENCY_CEILING_MS,
    /* The SOURCE half of the loopback permission, derived from the operator's
     * own origin. */
    allowLoopback: originIsLoopback(origin),
    /*
     * The DEPLOYMENT half, and it is answered from the classification this
     * function was handed rather than from a fresh read of `process.env`.
     * `localDeploymentFor` asks the contracts registry whether that exact
     * object was issued: an issued classification means this process was
     * admitted by the one allowlist, which is what the flag states, and a cast
     * or a spread copy answers `false` here and is refused outright by
     * `createFixtureProvider` before this option is read at all.
     *
     * NOT `true`, and not a second call to `isLocalDeployment()`. A literal
     * would hardcode one of the two independently-owned permissions
     * `url-policy.ts` requires -- the mistake `allowLoopback` above was
     * corrected for -- and a second call would ask the process a question the
     * classification in hand has already answered.
     */
    localDeployment: localDeploymentFor(environment)
  });

  if (!created.ok) {
    return { status: "refused", reason: created.reason, detail: created.detail };
  }
  return { status: "ready", provider: toCandidateSource(created.provider) };
}

/**
 * The SDK provider's resolution, in this route's shape.
 *
 * The content id reaches the provider through its own `registry.lookup`, which
 * is what turns a normalized content id into the `CatalogItemRef` the provider
 * boundary takes. `null` -- an id this registry does not carry, including every
 * id that is not a well-formed normalized content id -- becomes an EMPTY LIST
 * rather than a throw: it lands as `no_candidates_resolved`, which is the
 * reversible direction and an answer the endpoint can report. `..` matters here
 * specifically, because dots are unreserved and survive percent-encoding, and
 * the external id is interpolated into a URL path on the other side of the
 * lookup.
 *
 * -------------------------------------------------------------------------
 * WHY EVERY FIXTURE CANDIDATE LEAVES HERE AS `PROTECTION_NOT_STATED`, AND WHY
 * THAT IS NOT THIS SHAPE ADAPTER STATING A MEDIA FACT.
 *
 * The open question, recorded rather than absorbed. `FixtureCandidate` in
 * `@liberty/provider-sdk` carries `candidate`, `uri`, `mimeType`,
 * `allowLoopback` and `unknownFacts` -- and nothing about encryption. The
 * honest descriptor for a clear development fixture is `{ state: "clear" }`,
 * because somebody would have had to look and nothing is encrypted; but
 * `{ state: "clear" }` is an ASSERTION ABOUT THE BYTES, and product invariant 3
 * says only a provider adapter may make one. `provider-sdk` is not this task's
 * surface, so this file cannot make the fixture provider say it.
 *
 * `PROTECTION_NOT_STATED` is `{ state: "unknown", why: "provider_did_not_state" }`,
 * and that is the distinction this file turns on: it is not a claim about the
 * media at all, it is a TRUE OBSERVATION ABOUT THE PRODUCER -- this provider
 * did not state one -- which is exactly the fact a shape adapter is in a
 * position to report. The rule this module states about itself ("declares no
 * rights, composes no URL, invents no id and states no media fact") is
 * therefore kept rather than bent: the alternative reading, in which supplying
 * any value at all is a media fact, would make the field unfillable from here
 * and would leave the session publishing candidates with no protection
 * descriptor, which the wire contract no longer permits.
 *
 * IT IS SAFE BY CONSTRUCTION AND THE FAILURE MODE IS NAMED.
 * `requiresContentDecryptionModule` returns `true` for `unknown` as well as for
 * `protected`, so the worst this costs is a clear development fixture routed to
 * the EME adapter that has a CDM it does not need, and refused by the mpv
 * adapter under `drm_required_no_cdm` with a reason that says the state was
 * UNSTATED rather than positive. It is not a rights breach and it cannot become
 * one: there is no direction in which "unknown" is read as "clear".
 *
 * THE GAP IS IN `provider-sdk` AND IS UNOWNED. The fixture provider is the
 * boundary that knows these three files are unencrypted, so
 * `FixtureCandidate.protection` -- stated once, in the adapter, as
 * `{ state: "clear" }` -- is where the right answer belongs, and this mapping
 * would then forward it unchanged like every other field. That is a
 * `packages/provider-sdk` write, it is nobody's task at the time of writing,
 * and it is flagged for the reviewer here and in this task's report rather than
 * performed quietly from outside the package that owns it. Until it exists,
 * ANY fixture routed by protection is routed conservatively, which is the
 * reversible direction.
 * ---------------------------------------------------------------------- */
function toCandidateSource(provider: SdkFixtureProvider): FixtureProvider {
  return {
    environment: provider.runtime,
    rightsBasis: provider.rightsBasis,
    candidates: (contentId, context) => {
      const item = provider.registry.lookup(contentId);
      if (item === null) return [];

      return provider.resolve(item, { requestId: context.requestId }).mapped.map((entry) => ({
        candidate: entry.candidate,
        source: {
          uri: entry.uri,
          mimeType: entry.mimeType,
          allowLoopback: entry.allowLoopback
        },
        /* See the block comment above. The SDK states nothing, so what is
         * reported is that the SDK stated nothing -- not a guess at what it
         * would have said. */
        protection: PROTECTION_NOT_STATED
      }));
    }
  };
}

/**
 * The resolver the route uses when nothing is injected.
 *
 * IN A DEPLOYMENT IT RESOLVES NOTHING, and that is the honest answer rather than
 * a gap: no provider registry is wired into this app yet, and serving fixtures
 * from a hosted deployment would publish an unverifiable `owned` declaration for
 * files that do not exist. `not-configured` is a distinct outcome precisely so
 * the operator's remedy ("configure a provider") is legible instead of arriving
 * as a generic empty result.
 *
 * The classification is read from the process boundary at CALL time, not at
 * module scope: a module-scope read freezes the answer to whatever the process
 * looked like when the route was first loaded, which in a serverless cold start
 * is not necessarily the request's environment.
 *
 * THE `null` CHECK BELOW IS NOT OPTIONAL AND CANNOT BE DROPPED. `classify`
 * returns `NonDeploymentEnvironment | null` and `fixtureProvider` takes the
 * non-null type, so removing this branch does not widen the gate -- it fails to
 * compile. It is also not a source config value and must not become one: a
 * fixture source that could declare itself production-worthy is the same mistake
 * `url-policy.ts` refuses to make with `localDeployment`.
 *
 * A REFUSED ORIGIN IS `provider-unavailable` AND NOT `not-configured`. The two
 * have different remedies and the response codes say so: `not-configured` means
 * nothing is configured, which is what a hosted deployment gets, while a
 * configured origin the URL policy refused is a misconfiguration whose named
 * reason is the only useful thing to publish. The detail is the SDK's own --
 * chosen text rather than a thrown string, which is the distinction
 * `issue-session.ts` draws when it declines to echo an exception.
 */
export const resolveAuthorizedCandidates: AuthorizedCandidateResolver = (contentId, context) => {
  const environment = NonDeploymentEnvironment.classify();
  if (environment === null) return { status: "not-configured" };

  const fixtures = fixtureProvider(environment);
  if (fixtures.status === "refused") {
    return {
      status: "provider-unavailable",
      detail: `the fixture provider could not be constructed (${fixtures.reason}): ${fixtures.detail}`
    };
  }

  return { status: "resolved", candidates: fixtures.provider.candidates(contentId, context) };
};
