import { unknownMediaFacts, type StreamCandidate } from "@liberty/contracts/domains/playback";
import { normalizedContentIdSchema } from "@liberty/contracts/shared/ids";
import type { MediaFact } from "@liberty/contracts/shared/media-facts";
import type { ContentRights } from "@liberty/contracts/shared/rights";
import {
  DEFAULT_PROVIDER_HEALTH_POLICY,
  evaluateProviderHealth,
  healthRankingScore,
  type ProviderHealthPolicy,
  type ProviderHealthReport
} from "../health";
import type { AuthorizedMediaProvider, CatalogItemRef, ProviderContext } from "../provider";
import type { CatalogItemRegistry } from "../registry";
import { describeRightsBasis } from "../stremio/source";
import { checkUrl, truncate, type UrlRejectionReason } from "../stremio/url-policy";
import type { NonProductionRuntime } from "./environment";
import { fixtureRightsBasis, isOpaqueRightsReference, type FixtureRightsBasis } from "./rights";

/**
 * The authorized fixture provider (PL-0301), behind the provider boundary.
 *
 * WHY IT IS HERE AND NOT IN THE APPLICATION. Product invariant 3: provider
 * adapters remain isolated behind `@liberty/provider-sdk`. The fixture rig is an
 * adapter -- it turns a `CatalogItemRef` into normalized, authorized candidates
 * and states nothing about which of them is better -- and it was living in
 * `apps/web/src/app/api/v1/playback/session/authorized-candidates.ts`, which is
 * an HTTP route's helper. An adapter inside a route is an adapter whose rights
 * gate, URL policy and health story are that route's business rather than the
 * SDK's -- and what that arrangement cost, once, was a second and entirely
 * unguarded copy of those fixtures in the watch route, which shipped before
 * PL-0703 removed it.
 *
 * THE ONE FACT WORTH READING FIRST: this provider declares `owned` over media
 * nothing has ever opened, and the only real control on that declaration is that
 * it cannot be constructed in a production runtime. `./environment.ts` carries
 * the whole argument and `./rights.ts` carries its second half. `createFixture`
 * takes a `NonProductionRuntime` for that reason and for no other.
 *
 * WHAT IT DELIBERATELY DOES NOT DO:
 *
 *   - It states NO media facts. `videoCodec`, `audioCodec`, `height` and
 *     `bitrateKbps` are all `null`, which is the contract's word for unknown.
 *     Nothing has inspected these files -- they may not exist, and when they do
 *     they are whatever an operator packaged -- so any value would be invented.
 *     The codecs are the pair that used to do real damage: h264/aac is the most
 *     widely supported combination in existence, so stating it made every
 *     fixture pass capability eligibility PRECISELY BECAUSE every device accepts
 *     it, and the session was then labelled `verified` about a file nobody had
 *     opened. `null` produces `unverified`, which is the true statement.
 *   - It RANKS NOTHING. The three candidates are returned worst-first, on
 *     purpose: if the list were already in preference order, a defect in ranking
 *     or in a caller's mapping would be invisible because the wrong answer and
 *     the right one would look identical.
 *   - It makes NO REQUEST, ever. There is no fetch in this file. That is what
 *     makes `resolve` synchronous and total.
 *
 * NO TORRENT, MAGNET, INFOHASH OR DEBRID PATH EXISTS HERE, and none may be
 * added. Every URI this module produces is composed from an operator-configured
 * origin that `checkUrl` accepted as an `https:` (or loopback `http:`) address,
 * so a non-HTTP scheme cannot be reached even by configuration.
 */

/** The provider id used when a caller states none. */
export const DEFAULT_FIXTURE_PROVIDER_ID = "fixture";

/**
 * Ids appear in candidate ids, log lines and metric labels. Constrained to a
 * boring charset so a provider id can never smuggle a delimiter into the
 * `${providerId}:${contentId}:${key}` candidate id and make two providers
 * produce colliding, or deliberately overlapping, candidate identities.
 *
 * `stremio/source.ts` enforces the identical rule on a source id for the
 * identical reason, and keeps its pattern module-private. Unifying the two means
 * editing the Stremio adapter to publish it, which is a change to a reviewed
 * module for no behavioural gain, so the rule is restated here and the
 * unification is left as a follow-up. Both are closed charsets that refuse what
 * they do not recognise, so a divergence can only make one stricter.
 */
const FIXTURE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/**
 * One playable shape per variant, and the file name the rig serves it under.
 *
 * WHAT DIFFERS BETWEEN THEM IS `protocol`, AND ONLY `protocol`. That is a
 * genuine fact -- this module composed the URL, so it knows what shape sits at
 * the end of it -- while every media fact stays `null`. So a ranker still
 * reorders the list (dash and hls are adaptive, https is not) and the
 * worst-first property still has something to prove, while the hls/dash tie
 * exercises an id tiebreak.
 *
 * `720p.mp4` IS A FILE NAME, NOT A HEIGHT. It is the name the development rig
 * serves, kept so that adopting this provider does not require re-packaging the
 * rig, and nothing in this file reads a resolution out of it. Reading `720` off
 * a filename this module chose would be circular -- the module would be
 * measuring its own configuration -- which is exactly the reasoning `mapping.ts`
 * gives for refusing to read quality out of an addon's title.
 *
 * The MIME types are facts about the URL that was composed rather than claims
 * about the bytes at the other end: a `.m3u8` path is an HLS playlist address
 * whether or not anything is serving one.
 */
export interface FixtureVariant {
  /** Trailing segment of the candidate id. Distinguishes the three. */
  readonly key: string;
  readonly protocol: StreamCandidate["protocol"];
  readonly file: string;
  readonly mimeType: string;
}

export const FIXTURE_VARIANTS: readonly FixtureVariant[] = [
  { key: "progressive", protocol: "https", file: "720p.mp4", mimeType: "video/mp4" },
  { key: "hls", protocol: "hls", file: "master.m3u8", mimeType: "application/vnd.apple.mpegurl" },
  { key: "dash", protocol: "dash", file: "manifest.mpd", mimeType: "application/dash+xml" }
];

/**
 * A candidate plus the address it refers to.
 *
 * SEPARATE FROM THE `StreamCandidate` RATHER THAN FLATTENED INTO IT, because the
 * two have different readers: the candidate is metadata a ranker scores, and
 * this is the address a player is eventually handed. `@liberty/media-engine`
 * takes `StreamCandidate` and could not read `uri` even by accident. The Stremio
 * adapter makes the same split with `MappedStream`.
 *
 * THIS IS ALSO THE SEAM FOR A SHORT-LIVED PLAYBACK CREDENTIAL, and it is the
 * right place for one: only the adapter that owns an origin can sign for it.
 * Nothing mints one today -- `uri` is the composed address and nothing more --
 * and no licence URL, key or token appears anywhere in this module.
 */
export interface FixtureCandidate {
  readonly candidate: StreamCandidate;
  readonly uri: string;
  readonly mimeType: string;
  /**
   * Whether the fixture ORIGIN is a loopback address that this provider was
   * configured to address. Necessary for a caller's own outbound gate, never
   * sufficient: loopback also requires the deployment to say it is local, which
   * is a separate, separately-owned fact. See `stremio/url-policy.ts`.
   */
  readonly allowLoopback: boolean;
  /**
   * The contract facts this candidate never stated, in `MEDIA_FACTS` order.
   *
   * Read off the finished candidate with the contract's own `unknownMediaFacts`
   * rather than assembled here, for the reason `mapping.ts` gives: media-engine
   * publishes the same list on every `RankedCandidate`, and two implementations
   * of "which facts are missing" would eventually disagree about the set or its
   * order, which would surface as an adapter trail contradicting the playback
   * trail beside it.
   *
   * It is all four today and will stay all four until something inspects a file.
   */
  readonly unknownFacts: readonly MediaFact[];
}

export type FixtureResolutionReason =
  | "resolved"
  | "item_provider_mismatch"
  | "item_rights_conflict"
  | "item_id_not_normalized"
  | "rights_reference_unreviewed";

export interface FixtureResolution {
  readonly providerId: string;
  /** The declared rights every candidate carries. */
  readonly rights: ContentRights;
  readonly rightsBasis: FixtureRightsBasis;
  readonly candidates: StreamCandidate[];
  /** The same candidates plus what the adapter knows and the contract cannot hold. */
  readonly mapped: FixtureCandidate[];
  readonly reason: FixtureResolutionReason;
  readonly detail: string;
  readonly requestId: string;
}

export interface FixtureProviderOptions {
  /** Defaults to `DEFAULT_FIXTURE_PROVIDER_ID`. Becomes every candidate's `providerId`. */
  readonly id?: string | undefined;
  readonly displayName?: string | undefined;
  /**
   * Where fixture media is served from. Required, and validated by the same
   * outbound URL policy the Stremio adapter runs.
   *
   * REQUIRED RATHER THAN DEFAULTED, and rather than read from the environment.
   * `stremio/source.ts` states the rule this follows: a gate in this package is
   * pure and testable, and facts about the deployment come from the deployment.
   * A default here would also be a second origin -- the application already owns
   * one, and two of them is how a watch page and a session API come to disagree
   * about what "the dev rig" is.
   *
   * OPERATOR-SUPPLIED AND THEREFORE UNTRUSTED AS A URL, even though the operator
   * is not an attacker: a typo is as capable of aiming this at 169.254.169.254
   * as malice is. It is REFUSED at construction with a named reason rather than
   * sanitised. Rewriting a private host or stripping embedded credentials here
   * would turn a misconfiguration into a working stream and silence the one
   * check that names it.
   */
  readonly mediaOrigin: string;
  /**
   * What to state for `estimatedLatencyMs` on a candidate nothing has timed.
   *
   * REQUIRED, AND SUPPLIED BY THE COMPOSITION ROOT, because the honest value is
   * an ENGINE constant and this package must not depend on the engine. Pass
   * `LATENCY_CEILING_MS` from `@liberty/media-engine`: `scoring.ts` states the
   * rule and the reason -- an unknown positive dimension earns nothing, but an
   * unknown PENALTY that contributed zero would reward a candidate for
   * withholding information, so the penalty is charged in full. Nothing timed
   * these fixtures, so nothing gets the benefit.
   *
   * The three alternatives were each worse. Importing `@liberty/media-engine`
   * here inverts the layering (an adapter would depend on the ranker that scores
   * its output). Restating the constant is the duplicated-constant drift this
   * package has already had to remove twice. Defaulting to `0` is the one value
   * that flatters every fixture, on the dimension where flattery is silent.
   *
   * This module cannot verify the number it is handed, and does not pretend to:
   * it refuses anything that is not a finite, non-negative number, which is what
   * `streamCandidateSchema` requires, and a caller that passes a flattering
   * value has stated it in one visible place.
   */
  readonly unmeasuredLatencyMs: number;
  /**
   * Declares this provider as pointed at a rig on THIS machine. Necessary for
   * loopback URLs (and plaintext http to them), and never sufficient: the
   * deployment must independently be a local one. Defaults to false -- a
   * provider that did not say it was local is not local.
   */
  readonly allowLoopback?: boolean | undefined;
  /**
   * Whether this INSTANCE is a local deployment. A property of the running
   * deployment, not of this provider, which is why it is not derivable from the
   * runtime witness: a runtime can honestly be `development` and still be hosted,
   * and `stremio/url-policy.ts` requires the two loopback permissions to have
   * different owners so that neither owner can grant loopback alone.
   */
  readonly localDeployment?: boolean | undefined;
  /**
   * How an unobserved provider's ranking number is derived (PL-0303).
   *
   * A WINDOWED POLICY IS ACCEPTED HERE, unlike in `createStremioProvider` which
   * refuses one. The refusal there exists because that adapter keeps lifetime
   * counts and would report them under a policy that promises a window. This
   * provider keeps NO counts at all -- it makes no request, so it observes
   * nothing -- and `evaluateProviderHealth` answers the same unobserved report
   * for a zero summary under every policy. There is no windowed measurement to
   * misrepresent, so there is nothing to refuse.
   */
  readonly healthPolicy?: ProviderHealthPolicy | undefined;
}

export type FixtureProviderRejectionReason =
  | "fixture_id_invalid"
  | "fixture_latency_not_stated"
  | UrlRejectionReason;

export type CreateFixtureProviderResult =
  | { readonly ok: true; readonly provider: FixtureProvider }
  | {
      readonly ok: false;
      readonly reason: FixtureProviderRejectionReason;
      readonly detail: string;
    };

export interface FixtureProvider extends AuthorizedMediaProvider {
  /** The runtime name that admitted this provider. Reported, never re-tested. */
  readonly runtime: string;
  readonly rightsBasis: FixtureRightsBasis;
  /** The validated origin, with any query and fragment already dropped. */
  readonly mediaOrigin: string;
  readonly allowLoopback: boolean;
  readonly localDeployment: boolean;
  /**
   * The identity mapping from a normalized content id onto this provider's
   * items. See `fixtureCatalogItemRegistry` for why a fixture provider is the
   * one provider that can honestly supply a total registry.
   */
  readonly registry: CatalogItemRegistry;
  /**
   * The full reason trail. `resolveAuthorizedCandidates` returns only the
   * candidates because that is what the `AuthorizedMediaProvider` contract says;
   * everything needed to explain an empty result is here.
   *
   * SYNCHRONOUS, unlike the Stremio adapter's, and the difference is a fact
   * rather than a style: nothing in this module performs I/O, so a `Promise`
   * would be a claim that it might.
   */
  resolve(item: CatalogItemRef, context: ProviderContext): FixtureResolution;
  /**
   * What this provider has observed, as a labelled verdict (PL-0303): nothing.
   *
   * It always reports `status: "unknown"` with a null observed rate and a zero
   * sample count, because it makes no requests and therefore accumulates no
   * outcomes. The number its candidates rank on arrives as `priorScore`, named
   * so nobody can read it as a measurement.
   */
  providerHealthReport(): ProviderHealthReport;
}

/**
 * The identity registry, which is the only honest registry a fixture provider
 * can have.
 *
 * A REAL PROVIDER'S REGISTRY IS DATA AND IS STILL DEFERRED. See `../registry.ts`:
 * the mapping from a normalized content id onto a provider and an external id is
 * catalog data, and inventing entries for it would fabricate rights-bearing
 * facts. This registry invents no entries. It states the one thing that is
 * actually true of a fixture rig -- that it serves whatever content id it is
 * asked for, from a path named after that id -- so the mapping is the identity
 * and there is no table to populate.
 *
 * IT IS THEREFORE NOT A TEMPLATE FOR A REAL ONE. A licensed provider does not
 * serve every id, its external ids are not our ids, and its rights are a
 * catalog fact rather than a provider constant. Anything of this shape written
 * for a real provider would be fabricating all three.
 *
 * The id is validated before a ref is built, so an id that could walk out of the
 * origin's path prefix answers `null` rather than becoming a `CatalogItemRef`
 * that something else composes into a URL.
 */
export function fixtureCatalogItemRegistry(
  providerId: string,
  rights: ContentRights
): CatalogItemRegistry {
  return {
    lookup(contentId: string): CatalogItemRef | null {
      if (!normalizedContentIdSchema.safeParse(contentId).success) return null;
      return { providerId, externalId: contentId, rights };
    }
  };
}

function fail(
  reason: FixtureProviderRejectionReason,
  detail: string
): CreateFixtureProviderResult {
  return { ok: false, reason, detail };
}

/**
 * Joins a validated origin to a fixture path.
 *
 * Built through `URL` rather than by string concatenation. Three real
 * configurations break concatenation and none of them is exotic: a trailing
 * slash produces a doubled one, an origin carrying a query
 * (`https://rig.test/?v=2`) swallows the whole path into the query string, and a
 * fragment discards it entirely. In each case the resulting URL still passes an
 * outbound gate -- it is the operator's own https host -- and points somewhere
 * else, so the failure arrives as a 404 with nothing in the trail to explain it.
 *
 * The base is already free of query and fragment (they are dropped at
 * construction, for the same reason `defineStremioSource` drops them: they are
 * not part of an origin's identity), so this only ever appends.
 *
 * TOTAL, WITH NO CATCH, and that is a property of the argument rather than an
 * omission. `base` is a `URL` this module built from a string `checkUrl`
 * accepted, `contentId` matched `normalizedContentIdSchema` before this is
 * reached -- so it holds no `/`, no `..`, no `%` and no `?` -- and `file` is a
 * literal from `FIXTURE_VARIANTS`. Assigning a pathname made of those cannot
 * throw.
 */
function fixtureUri(base: URL, contentId: string, file: string): string {
  const url = new URL(base.toString());
  url.pathname = `${base.pathname.replace(/\/+$/, "")}/${contentId}/${file}`;
  return url.toString();
}

/**
 * The only constructor of a `FixtureProvider`.
 *
 * `runtime` is first because it is the reason this function is allowed to exist
 * at all, and it is a `NonProductionRuntime` rather than a boolean or a string
 * because a condition can be deleted and still compile while a missing argument
 * cannot. See `./environment.ts`.
 *
 * Returns a result rather than throwing, on the same division the rest of this
 * package draws: configuration is expected to be wrong, so a bad origin, a bad
 * id or an unusable latency is DATA a caller can report. The one thing that does
 * throw is `fixtureRightsBasis`, and it throws because reaching its failure
 * means somebody edited a rights constant in this package.
 *
 * The basis is built HERE, inside the factory, and never at module scope. A
 * module-level constant would be constructed on import in every runtime, and the
 * whole argument in `./environment.ts` would be about who may READ the
 * fabricated declaration rather than about whether it exists.
 */
export function createFixtureProvider(
  runtime: NonProductionRuntime,
  options: FixtureProviderOptions
): CreateFixtureProviderResult {
  const id = options.id ?? DEFAULT_FIXTURE_PROVIDER_ID;
  if (!FIXTURE_ID_PATTERN.test(id)) {
    return fail(
      "fixture_id_invalid",
      `fixture provider id ${JSON.stringify(truncate(id, 40))} must match ${String(FIXTURE_ID_PATTERN)}`
    );
  }

  const latencyMs = options.unmeasuredLatencyMs;
  if (!Number.isFinite(latencyMs) || latencyMs < 0) {
    return fail(
      "fixture_latency_not_stated",
      `unmeasuredLatencyMs must be a finite, non-negative number and was ${String(latencyMs)}; ` +
        "pass LATENCY_CEILING_MS from @liberty/media-engine so an untimed candidate is charged " +
        "the full latency penalty rather than rewarded for stating nothing"
    );
  }

  const allowLoopback = options.allowLoopback ?? false;
  const localDeployment = options.localDeployment ?? false;
  const checked = checkUrl(options.mediaOrigin, { allowLoopback, localDeployment });
  if (!checked.ok) return fail(checked.reason, checked.detail);

  // Search and hash dropped: they are not part of an origin's identity, and
  // keeping them would make every derived path inconsistent with the base it
  // came from. Cloned first so the `URL` this module keeps is its own.
  const origin = new URL(checked.url.toString());
  origin.search = "";
  origin.hash = "";

  const rightsBasis = fixtureRightsBasis(runtime);
  const rights = rightsBasis.rights;
  const healthPolicy = options.healthPolicy ?? DEFAULT_PROVIDER_HEALTH_POLICY;

  /*
   * Zero observations, permanently, because this provider makes no requests.
   * Built through `evaluateProviderHealth` rather than by calling
   * `healthPriorScore` directly, so the number a candidate ranks on and the
   * number a health dashboard shows come from one place and cannot drift --
   * exactly the routing `createStremioProvider` uses.
   *
   * `excludedByWindow: 0` is a FACT here rather than a placeholder: nothing was
   * excluded because nothing was ever observed. That reading holds under a
   * windowed policy too, which is why this provider does not need the Stremio
   * adapter's construction-time refusal of one.
   */
  const healthReport = (): ProviderHealthReport =>
    evaluateProviderHealth(id, { successes: 0, failures: 0, excludedByWindow: 0 }, healthPolicy);
  const healthScore = healthRankingScore(healthReport());

  const registry = fixtureCatalogItemRegistry(id, rights);

  function resolve(item: CatalogItemRef, context: ProviderContext): FixtureResolution {
    const empty = (reason: FixtureResolutionReason, detail: string): FixtureResolution => ({
      providerId: id,
      rights,
      rightsBasis,
      candidates: [],
      mapped: [],
      reason,
      detail,
      requestId: context.requestId
    });

    if (item.providerId !== id) {
      return empty(
        "item_provider_mismatch",
        `item is routed to provider ${truncate(item.providerId, 40)}, not ${id}`
      );
    }

    /*
     * The caller's idea of the item's rights must agree with this provider's
     * declaration, and disagreement is fatal rather than resolvable. Neither
     * value wins: two parts of the system disagree about what we are entitled to
     * serve, and picking one is resolving an unverifiable state in the
     * permissive direction. Same refusal, and the same wording, as
     * `createStremioProvider`.
     */
    if (item.rights !== rights) {
      return empty(
        "item_rights_conflict",
        `catalog claims rights ${JSON.stringify(item.rights)} but provider ${id} declares ` +
          `${JSON.stringify(rights)}; refusing to choose between them`
      );
    }

    /*
     * The external id is interpolated into a URL path, and `..` is not stopped
     * by percent-encoding because dots are unreserved -- so an unvalidated id
     * could walk out of the origin's path prefix. Checked here even though
     * `registry.lookup` already refuses a non-normalized id, for the reason
     * `mapping.ts` gives for its redundant rights check: an exported function
     * will eventually be called by something that did not come through the
     * constructor beside it.
     */
    if (!normalizedContentIdSchema.safeParse(item.externalId).success) {
      return empty(
        "item_id_not_normalized",
        `externalId ${JSON.stringify(truncate(item.externalId, 60))} is not a normalized content ` +
          "id, and this provider composes it into a URL path"
      );
    }

    /*
     * FAIL CLOSED ON A REFERENCE OF UNREVIEWED SHAPE. Unreachable while
     * `fixtureRightsBasis` is the only constructor of the basis -- it refuses to
     * build one whose reference does not conform -- and that is exactly what
     * this is for. It is the last point before a rights basis is attached to
     * something a caller will publish, and an empty list here is the reversible
     * direction: it lands as "no candidates" rather than putting a sentence, a
     * URL or a counterparty's name into a reason trail.
     */
    if (!isOpaqueRightsReference(rightsBasis.reference)) {
      return empty(
        "rights_reference_unreviewed",
        "the rights basis reference is not an opaque internal identifier; a rights declaration " +
          "nobody may read out loud is not one worth serving"
      );
    }

    const contentId = item.externalId;

    /*
     * Everything the same for all three except `protocol` and the address: four
     * `null`s -- the contract's word for unknown, never a placeholder -- plus
     * the two fields the contract will not let be unknown, each stating the
     * value that cannot flatter the candidate. Shared rather than repeated so a
     * future edit cannot make one fixture quietly more optimistic than its
     * siblings.
     */
    const unmeasured = {
      height: null,
      bitrateKbps: null,
      videoCodec: null,
      audioCodec: null,
      estimatedLatencyMs: latencyMs,
      healthScore
    } as const;

    const mapped: FixtureCandidate[] = FIXTURE_VARIANTS.map((variant) => {
      const candidate: StreamCandidate = {
        id: `${id}:${contentId}:${variant.key}`,
        providerId: id,
        rights,
        protocol: variant.protocol,
        ...unmeasured
      };
      return {
        candidate,
        uri: fixtureUri(origin, contentId, variant.file),
        mimeType: variant.mimeType,
        allowLoopback,
        unknownFacts: unknownMediaFacts(candidate)
      };
    });

    return {
      providerId: id,
      rights,
      rightsBasis,
      candidates: mapped.map((entry) => entry.candidate),
      mapped,
      reason: "resolved",
      /*
       * The unverified count is part of the trail rather than something a
       * debugger derives. "Three candidates" and "three candidates, none of
       * which states anything about its codecs" describe very different
       * expectations of what happens next at the <video> element.
       */
      detail:
        `${mapped.length} fixture candidates, ` +
        `${mapped.filter((entry) => entry.unknownFacts.length > 0).length} with unstated media ` +
        `facts; authorized as ${describeRightsBasis(rightsBasis)}`,
      requestId: context.requestId
    };
  }

  return {
    ok: true,
    provider: {
      id,
      displayName: options.displayName ?? id,
      runtime: runtime.name,
      rightsBasis,
      mediaOrigin: origin.toString(),
      allowLoopback,
      localDeployment,
      registry,

      /**
       * Whether this PROVIDER can answer, which is the only question it is in a
       * position to answer.
       *
       * There is no upstream to probe: nothing here opens a socket, so a health
       * check cannot report whether the rig is serving. What it reports is that
       * the provider is a pure function of its configuration and is able to
       * produce candidates, which it always is once constructed. `latencyMs` is
       * `0` because NO REQUEST WAS TIMED, not because a request was fast, and
       * the pair is documented here so the number is not mistaken for a
       * measurement.
       *
       * `providerHealthReport()` beside it is the one that answers the
       * availability question honestly: `unknown`, zero samples, a prior rather
       * than a rate.
       */
      async health(): Promise<{ ok: boolean; latencyMs: number }> {
        return { ok: true, latencyMs: 0 };
      },

      async resolveAuthorizedCandidates(
        item: CatalogItemRef,
        context: ProviderContext
      ): Promise<StreamCandidate[]> {
        return resolve(item, context).candidates;
      },

      providerHealthReport: healthReport,
      resolve
    }
  };
}
