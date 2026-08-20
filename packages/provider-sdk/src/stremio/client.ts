import type { StreamCandidate } from "@liberty/contracts/domains/playback";
import { PLAYABLE_CONTENT_RIGHTS, type ContentRights } from "@liberty/contracts/shared/rights";
import {
  DEFAULT_PROVIDER_HEALTH_POLICY,
  evaluateProviderHealth,
  healthRankingScore,
  type ProviderHealthPolicy,
  type ProviderHealthReport
} from "../health";
import type { AuthorizedMediaProvider, CatalogItemRef, ProviderContext } from "../provider";
import { fetchJson, type FetchLike, type HttpFailureReason, type HttpOptions } from "./http";
import {
  mapStremioStreams,
  type MappedStream,
  type RejectedStream,
  type StreamMappingContext
} from "./mapping";
import { compareCodePoint } from "./order";
import {
  manifestServes,
  parseStremioManifest,
  parseStremioStreamResponse,
  type StremioManifest
} from "./protocol";
import {
  describeRightsBasis,
  RIGHTS_BASES_FOR_RIGHTS,
  type AuthorizedStremioSource,
  type RightsBasis
} from "./source";
import { truncate } from "./url-policy";

/**
 * The Stremio addon adapter (PL-0301).
 *
 * This is the only part of the package that is not pure, and it is deliberately
 * thin: fetch, parse, hand the parsed objects to the pure mapper, report. Every
 * decision that could be wrong -- what counts as a playable URL, what rights a
 * candidate carries, which addresses may be contacted -- lives in a function
 * that can be tested without a network. What is left here is orchestration and
 * measurement.
 *
 * It takes an `AuthorizedStremioSource`, which cannot be constructed without
 * passing the rights gate in `source.ts`. There is no overload, no options bag
 * escape hatch, and no "unsafe" constructor: if you are holding a provider, its
 * source's rights were declared and validated.
 *
 * `estimatedLatencyMs` is measured here, from the request actually made.
 * `healthScore` is measured here TOO -- but only once there is something to
 * measure. Before the first completed request it is the policy prior, which
 * PL-0303 makes visible: `providerHealthReport()` reports `status: "unknown"`
 * with a null observed rate and a zero sample count, and the number the
 * candidate ranks on arrives as `priorScore` rather than as availability. The
 * previous header sentence here claimed both numbers were measured, which was
 * true of one of them and was exactly the confusion the health contract exists
 * to remove.
 *
 * Nothing else on a candidate is invented either: a stream whose codec,
 * resolution or bitrate the protocol does not state carries `null` for that
 * field, which is the contract's word for UNKNOWN, rather than a
 * plausible-looking value. Every
 * candidate this adapter produces today is therefore unverified on all four
 * media facts, `detail` says so, and media-engine ranks it accordingly without
 * ever treating the absence as either compatibility or incompatibility.
 */

export const DEFAULT_TIMEOUT_MS = 5_000;
/**
 * 1 MiB. A `/stream` response is a short JSON array; a manifest is smaller. An
 * addon that needs more than this to answer either is not answering either.
 */
export const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
/**
 * Two hops covers the http->https and bare-domain->canonical-host redirects real
 * deployments use. Anything longer is a chain worth refusing rather than
 * following: each hop is another chance for a target that passes the URL policy
 * at check time to be something else at connect time.
 */
export const DEFAULT_MAX_REDIRECTS = 2;
/** Manifests change when an operator redeploys an addon, not per request. */
export const DEFAULT_MANIFEST_TTL_MS = 900_000;
export const DEFAULT_USER_AGENT = "ProjectLiberty/0.1 (+@liberty/provider-sdk)";

export interface StremioProviderOptions {
  /** Injected for tests; every network path in this file goes through it. */
  readonly fetch?: FetchLike | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxResponseBytes?: number | undefined;
  readonly maxRedirects?: number | undefined;
  readonly manifestTtlMs?: number | undefined;
  /** Injected clock, so latency and cache expiry are testable without waiting. */
  readonly now?: (() => number) | undefined;
  readonly userAgent?: string | undefined;
  /**
   * How this provider's observed outcomes become a health verdict (PL-0303).
   *
   * Injectable so a deployment can adopt a newer policy version deliberately,
   * and so tests can exercise a band without arranging dozens of requests. The
   * default reproduces the arithmetic this adapter has always used, digit for
   * digit, so leaving it alone changes no candidate's `healthScore`.
   */
  readonly healthPolicy?: ProviderHealthPolicy | undefined;
}

export type ResolutionReason =
  | "resolved"
  | "no_streams_offered"
  | "no_playable_streams"
  | "item_provider_mismatch"
  | "item_rights_conflict"
  | "item_type_ambiguous"
  | "item_id_malformed"
  | "item_not_served_by_source"
  | "manifest_unavailable"
  | "stream_request_failed";

export interface StremioResolution {
  readonly sourceId: string;
  /** The source's declared rights -- the value every candidate carries. */
  readonly rights: ContentRights;
  /** The operator's stated basis for that declaration, carried into the trail. */
  readonly rightsBasis: RightsBasis;
  readonly candidates: StreamCandidate[];
  /** The same candidates plus what the adapter knows and the contract cannot hold. */
  readonly mapped: MappedStream[];
  readonly rejected: RejectedStream[];
  readonly reason: ResolutionReason;
  readonly detail: string;
  readonly requestId: string;
  readonly elapsedMs: number;
}

export interface StremioProvider extends AuthorizedMediaProvider {
  readonly source: AuthorizedStremioSource;
  /**
   * The full reason trail. `resolveAuthorizedCandidates` returns only the
   * candidates because that is what the `AuthorizedMediaProvider` contract says;
   * everything a support engineer needs to explain an empty result is here.
   */
  resolve(item: CatalogItemRef, context: ProviderContext): Promise<StremioResolution>;
  /**
   * What this provider object has observed, as a labelled verdict (PL-0303).
   *
   * SYNCHRONOUS AND MAKES NO REQUEST, which is the distinction from `health()`
   * beside it. `health()` probes -- it goes and asks the addon whether it is
   * answering right now, and it is what an uptime check wants. This reports the
   * accumulated record of the requests already made, and it is what a ranking
   * signal and a dashboard want. Collapsing the two would mean either a probe on
   * every candidate mapping or a dashboard that reports one request's outcome as
   * a provider's health.
   *
   * A provider that has made no requests yet reports `status: "unknown"` with a
   * null observed rate and a zero sample count. It does not report a pass, and
   * it does not report fifty percent availability -- the 0.5 it ranks on is
   * `priorScore`, named so nobody can read it as a measurement.
   */
  providerHealthReport(): ProviderHealthReport;
}

/**
 * Splits `"movie/tt0111161"` into a Stremio type and id.
 *
 * `CatalogItemRef` has no kind field and the Stremio /stream endpoint requires
 * one, so the type is carried in `externalId` behind a slash. A slash is safe as
 * the separator precisely because Stremio ids use colons for their own structure
 * (`tt1254207:1:1` is a series episode) and never contain a slash.
 *
 * When no type is given, it is inferred ONLY if the manifest declares exactly
 * one -- an unambiguous inference. Guessing "movie" when the addon serves three
 * types would silently ask the wrong endpoint and report "no streams" for
 * content the source has, which is the sort of empty result nobody can debug.
 *
 * The proper fix is a kind on `CatalogItemRef`; `@liberty/contracts` belongs to
 * another task, so this convention is documented here and revisited then.
 */
export function parseStremioItemId(
  externalId: string,
  declaredTypes: readonly string[]
): { readonly type: string; readonly id: string } | null {
  const separator = externalId.indexOf("/");
  if (separator > 0) {
    const type = externalId.slice(0, separator);
    const id = externalId.slice(separator + 1);
    return isSafeSegment(type) && id !== "" && id.length <= 256 ? { type, id } : null;
  }
  if (separator === 0 || externalId === "" || externalId.length > 256) return null;
  const only = declaredTypes.length === 1 ? declaredTypes[0] : undefined;
  return only !== undefined && isSafeSegment(only) ? { type: only, id: externalId } : null;
}

/**
 * Types the manifest says the stream resource serves.
 *
 * A resource entry may narrow the manifest-level list, so entry-level types win
 * when present. Used to skip requests the addon has already said it cannot
 * answer, and to infer an unambiguous type -- never as a security decision. See
 * `manifestServes`.
 */
export function declaredStreamTypes(manifest: StremioManifest): string[] {
  const perResource = manifest.resources
    .filter((entry) => typeof entry !== "string" && entry.name === "stream")
    .flatMap((entry) => (typeof entry === "string" ? [] : entry.types ?? []));
  return perResource.length > 0 ? perResource : [...manifest.types];
}

/**
 * A Stremio type is a path segment we build. `encodeURIComponent` already stops
 * traversal, so this is a second, narrower fence: an addon type is a short
 * lowercase word, and anything else is a sign we are about to construct a URL
 * from data that did not come from where we think it did.
 */
function isSafeSegment(value: string): boolean {
  return /^[a-z][a-z0-9_-]{0,31}$/i.test(value);
}

/**
 * Whether a value has the SHAPE of a rights basis, asked of `unknown`.
 *
 * `source.rightsBasis` is typed `RightsBasis`, so the type system believes the
 * three fields are there. This function exists to disbelieve it: the value being
 * checked arrived through a type assertion, and asking a typed value whether it
 * is `undefined` is a comparison TypeScript is entitled to reject as pointless.
 */
function statesRightsBasis(value: unknown): value is RightsBasis {
  if (typeof value !== "object" || value === null) return false;
  const stated = value as { readonly rights?: unknown; readonly basis?: unknown; readonly reference?: unknown };
  return (
    typeof stated.rights === "string" &&
    typeof stated.basis === "string" &&
    typeof stated.reference === "string"
  );
}

/**
 * The rights gate, re-established on the DECLARATION and on its EVIDENCE.
 *
 * `mapStremioStream` already re-checks `PLAYABLE_CONTENT_RIGHTS` against the
 * context it is handed, on the stated reasoning that an exported function will
 * eventually be called by something that did not come through the constructor.
 * The identical argument applies here and was not being made: the brand is
 * unforgeable, but `AuthorizedStremioSource` is exported as a TYPE, so
 * `whatever as AuthorizedStremioSource` produces one that satisfies the compiler
 * and never passed `defineStremioSource`. The redundancy was applied to the
 * rights value and withheld from the evidence for it, which is the half that
 * failed worse: a forged source with no `rightsBasis` reached
 * `describeRightsBasis` mid-resolution and threw an uncaught `TypeError` off
 * `basis.rights`. Failing on a `TypeError` is not failing closed, it is failing
 * wherever the first property read happens to be.
 *
 * The checks are the ones `defineStremioSource` makes, in the order it makes
 * them -- rights before shape, shape before coherence -- so that a source that
 * somehow acquired two faults reports the more fundamental one, and so that the
 * two gates cannot drift into disagreeing about what "authorized" means.
 *
 * It THROWS rather than returning a reason. `defineStremioSource` reports rights
 * failures as data because configuration is expected to be wrong; a source that
 * reached this function without passing that gate is a programming error, and
 * there is no honest provider object to hand back for one.
 */
function assertRightsRemainEvidenced(source: AuthorizedStremioSource): void {
  const refuse = (detail: string): Error =>
    new Error(
      `refusing to build a Stremio provider for source ${JSON.stringify(truncate(String(source.id), 40))}: ${detail}`
    );

  if (!PLAYABLE_CONTENT_RIGHTS.includes(source.rights)) {
    throw refuse(
      `declared rights ${JSON.stringify(source.rights)} are outside the playable allowlist ` +
        `(${PLAYABLE_CONTENT_RIGHTS.join(", ")})`
    );
  }

  const stated: unknown = source.rightsBasis;
  if (!statesRightsBasis(stated)) {
    throw refuse(
      "rightsBasis is absent or is not an object of {rights, basis, reference}; a declaration " +
        "with no evidence behind it is not a declaration"
    );
  }

  if (stated.rights !== source.rights) {
    throw refuse(
      `rightsBasis evidences ${JSON.stringify(stated.rights)} but the source declares ` +
        `${JSON.stringify(source.rights)}; refusing to choose between them`
    );
  }

  const permitted = RIGHTS_BASES_FOR_RIGHTS[source.rights];
  if (!permitted.includes(stated.basis)) {
    throw refuse(
      `rights ${JSON.stringify(source.rights)} cannot rest on ${JSON.stringify(stated.basis)}; ` +
        `permitted bases are ${permitted.join(", ")}`
    );
  }

  if (stated.reference.trim() === "") {
    throw refuse(
      "rightsBasis.reference is empty; it must identify the contract, collection or documented " +
        "public-domain source the declaration rests on"
    );
  }
}

export function createStremioProvider(
  source: AuthorizedStremioSource,
  options: StremioProviderOptions = {}
): StremioProvider {
  // Before the clock, the fetch wrapper or anything that could make a request:
  // an unauthorized source must not reach a state where it has an adapter.
  assertRightsRemainEvidenced(source);

  const now = options.now ?? (() => Date.now());
  const fetchImpl: FetchLike =
    options.fetch ??
    // Wrapped rather than passed by reference: an unbound `fetch` throws in some
    // hosts, and capturing it now would also freeze a test's later stubbing.
    ((input, init) => globalThis.fetch(input, init));

  const http = (): HttpOptions => ({
    fetchImpl,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxResponseBytes: options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    maxRedirects: options.maxRedirects ?? DEFAULT_MAX_REDIRECTS,
    allowLoopback: source.allowLoopback,
    // Read from the source the rights gate produced, never re-derived here: the
    // conditions this source was authorized under are the conditions it is
    // fetched under.
    localDeployment: source.localDeployment,
    userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
    now
  });

  const healthPolicy = options.healthPolicy ?? DEFAULT_PROVIDER_HEALTH_POLICY;

  /*
   * Observed reliability, not a constant. Every completed request -- manifest,
   * stream, health probe -- moves these, and `evaluateProviderHealth` turns them
   * into a labelled verdict. A source that has just failed twice therefore ranks
   * below one that has not, without anyone configuring anything.
   *
   * COUNTS, not a list of timestamped observations, and that is a deliberate
   * limit rather than an oversight. A list would let the shipped policy's window
   * do something, but it would also mean an unbounded array growing for the life
   * of a long-lived provider object, and it would change every candidate's
   * `healthScore` the moment old observations started dropping out. PL-0303 is
   * explicitly not a re-ranking. `summariseHealthObservations` is the pure entry
   * point a persisted, shared observation store will use when there is one; this
   * process keeps two integers.
   *
   * `excludedByWindow: 0` is therefore a FACT here and not a placeholder:
   * nothing was excluded because nothing was ever eligible for exclusion.
   */
  let successes = 0;
  let failures = 0;
  const record = (ok: boolean): void => {
    if (ok) successes++;
    else failures++;
  };
  const healthReport = (): ProviderHealthReport =>
    evaluateProviderHealth(source.id, { successes, failures, excludedByWindow: 0 }, healthPolicy);

  let cachedManifest: { manifest: StremioManifest; fetchedAt: number } | null = null;

  /**
   * Failures are never cached. A cached failure turns one bad minute into a
   * TTL-long outage for a source that recovered thirty seconds later, and the
   * cost of retrying is one request against a source we are already talking to.
   */
  async function loadManifest(
    forceRefresh: boolean
  ): Promise<
    { ok: true; manifest: StremioManifest; elapsedMs: number; cached: boolean }
    | { ok: false; reason: HttpFailureReason | "malformed_manifest"; detail: string; elapsedMs: number }
  > {
    const ttl = options.manifestTtlMs ?? DEFAULT_MANIFEST_TTL_MS;
    if (!forceRefresh && cachedManifest && now() - cachedManifest.fetchedAt < ttl) {
      return { ok: true, manifest: cachedManifest.manifest, elapsedMs: 0, cached: true };
    }

    const response = await fetchJson(source.manifestUrl, http());
    if (!response.ok) {
      record(false);
      return { ok: false, reason: response.reason, detail: response.detail, elapsedMs: response.elapsedMs };
    }

    const parsed = parseStremioManifest(response.value);
    if (!parsed.ok) {
      /*
       * A manifest that does not parse counts as a FAILURE of the source, not
       * merely of the request. It is the addon's own description of itself; if
       * that is malformed, nothing else it says is worth more trust, and health
       * should reflect that rather than staying flat because we got a 200.
       */
      record(false);
      return {
        ok: false,
        reason: "malformed_manifest",
        detail: parsed.detail,
        elapsedMs: response.elapsedMs
      };
    }

    record(true);
    cachedManifest = { manifest: parsed.value, fetchedAt: now() };
    return { ok: true, manifest: parsed.value, elapsedMs: response.elapsedMs, cached: false };
  }

  function empty(
    reason: ResolutionReason,
    detail: string,
    requestId: string,
    elapsedMs: number,
    rejected: RejectedStream[] = []
  ): StremioResolution {
    return {
      sourceId: source.id,
      rights: source.rights,
      rightsBasis: source.rightsBasis,
      candidates: [],
      mapped: [],
      rejected,
      reason,
      detail,
      requestId,
      elapsedMs
    };
  }

  async function resolve(item: CatalogItemRef, context: ProviderContext): Promise<StremioResolution> {
    const startedAt = now();
    const elapsed = (): number => Math.max(0, Math.round(now() - startedAt));

    if (item.providerId !== source.id) {
      return empty(
        "item_provider_mismatch",
        `item is routed to provider ${truncate(item.providerId, 40)}, not ${source.id}`,
        context.requestId,
        elapsed()
      );
    }

    /*
     * The caller's idea of the item's rights must agree with the source's
     * declaration, and disagreement is fatal rather than resolvable.
     *
     * The source's value is the authority -- it is the only one an operator
     * declared -- so this is not "whose value wins", it is "two parts of the
     * system disagree about what we are entitled to serve". That is exactly the
     * unverifiable state this adapter is not allowed to resolve in the
     * permissive direction, and picking either value would be doing so. It also
     * catches the real bug behind such a mismatch: a catalog entry pointing at
     * the wrong source.
     */
    if (item.rights !== source.rights) {
      return empty(
        "item_rights_conflict",
        `catalog claims rights ${JSON.stringify(item.rights)} but source ${source.id} declares ` +
          `${JSON.stringify(source.rights)}; refusing to choose between them`,
        context.requestId,
        elapsed()
      );
    }

    const manifest = await loadManifest(false);
    if (!manifest.ok) {
      return empty(
        "manifest_unavailable",
        `${manifest.reason}: ${manifest.detail}`,
        context.requestId,
        elapsed()
      );
    }

    const declaredTypes = declaredStreamTypes(manifest.manifest);
    const parsedId = parseStremioItemId(item.externalId, declaredTypes);
    if (!parsedId) {
      /*
       * Two different faults, reported as two different reasons. "The id names no
       * type and the addon serves several" is a caller convention problem an
       * operator can fix by qualifying the id; "the id is not addressable" is a
       * bad id. Collapsing them into one reason sends whoever reads it to the
       * wrong half of the system.
       */
      const ambiguous = !item.externalId.includes("/") && declaredTypes.length !== 1;
      return empty(
        ambiguous ? "item_type_ambiguous" : "item_id_malformed",
        ambiguous
          ? `externalId ${truncate(item.externalId, 60)} names no Stremio type (expected ` +
            `"<type>/<id>") and the manifest declares ${declaredTypes.length}`
          : `externalId ${truncate(item.externalId, 60)} is not an addressable Stremio id`,
        context.requestId,
        elapsed()
      );
    }

    if (!manifestServes(manifest.manifest, "stream", parsedId.type, parsedId.id)) {
      return empty(
        "item_not_served_by_source",
        `manifest does not declare stream support for ${parsedId.type}/${truncate(parsedId.id, 40)}`,
        context.requestId,
        elapsed()
      );
    }

    const streamUrl =
      `${source.baseUrl}/stream/${encodeURIComponent(parsedId.type)}/` +
      `${encodeURIComponent(parsedId.id)}.json`;

    /*
     * `context.profileId` is deliberately not sent, and neither is `requestId`.
     * An addon needs the content id to answer; it does not need to know which
     * viewer asked, and a per-profile identifier handed to a third party on every
     * playback is a tracking identifier whether or not it was meant as one.
     */
    const response = await fetchJson(streamUrl, http());
    if (!response.ok) {
      record(false);
      return empty(
        "stream_request_failed",
        `${response.reason}: ${response.detail}`,
        context.requestId,
        elapsed()
      );
    }

    const parsed = parseStremioStreamResponse(response.value);
    if (!parsed.ok) {
      record(false);
      return empty(
        "stream_request_failed",
        `malformed stream response: ${parsed.detail}`,
        context.requestId,
        elapsed()
      );
    }

    record(true);

    const mappingContext: StreamMappingContext = {
      sourceId: source.id,
      rights: source.rights,
      allowLoopback: source.allowLoopback,
      localDeployment: source.localDeployment,
      acceptNotWebReady: source.acceptNotWebReady,
      observedLatencyMs: response.elapsedMs,
      /*
       * The ranking signal off the health verdict, which is the same number the
       * old `observedHealthScore(successes, failures)` produced -- the default
       * policy is that arithmetic. Routed through the report rather than the
       * bare function so the value a candidate ranks on and the value a health
       * dashboard shows cannot drift apart, and so the one place that flattens a
       * prior and a measurement into a single number is a named function a
       * reviewer can find.
       */
      healthScore: healthRankingScore(healthReport())
    };

    const batch = mapStremioStreams(parsed.value.streams, mappingContext);

    if (parsed.value.streams.length === 0) {
      return empty("no_streams_offered", "addon returned an empty stream list", context.requestId, elapsed());
    }

    if (batch.mapped.length === 0) {
      return empty(
        "no_playable_streams",
        summarise(batch.rejected),
        context.requestId,
        elapsed(),
        batch.rejected
      );
    }

    return {
      sourceId: source.id,
      rights: source.rights,
      rightsBasis: source.rightsBasis,
      candidates: batch.mapped.map((entry) => entry.candidate),
      mapped: batch.mapped,
      rejected: batch.rejected,
      reason: "resolved",
      /*
       * The unverified count is part of the trail, not a detail for a debugger
       * to derive. "Two playable candidates" and "two playable candidates, both
       * of which state nothing about their codecs" describe very different
       * expectations of what happens next at the <video> element, and a support
       * engineer reading a stalled playback needs the second sentence.
       */
      detail:
        `${batch.mapped.length} playable of ${parsed.value.streams.length} offered, ` +
        `${batch.mapped.filter((entry) => entry.unknownFacts.length > 0).length} with unstated ` +
        `media facts; authorized as ${describeRightsBasis(source.rightsBasis)}`,
      requestId: context.requestId,
      elapsedMs: elapsed()
    };
  }

  return {
    id: source.id,
    displayName: source.displayName,

    async health(): Promise<{ ok: boolean; latencyMs: number }> {
      // Forces a refresh: a health check answered from cache reports the state of
      // the source at some point in the last fifteen minutes, which is not what
      // anybody asks a health check for.
      const manifest = await loadManifest(true);
      return { ok: manifest.ok, latencyMs: manifest.elapsedMs };
    },

    async resolveAuthorizedCandidates(
      item: CatalogItemRef,
      context: ProviderContext
    ): Promise<StreamCandidate[]> {
      return (await resolve(item, context)).candidates;
    },

    providerHealthReport: healthReport,
    resolve,
    source
  };
}

/** One line naming every distinct refusal and how many streams hit it. */
function summarise(rejected: readonly RejectedStream[]): string {
  const counts = new Map<string, number>();
  for (const entry of rejected) counts.set(entry.reason, (counts.get(entry.reason) ?? 0) + 1);
  return [...counts.entries()]
    // Map iteration is insertion-ordered, so without this the summary line would
    // reorder itself whenever the addon reordered its streams.
    .sort((a, b) => compareCodePoint(a[0], b[0]))
    .map(([reason, count]) => `${reason}=${count}`)
    .join(" ");
}
