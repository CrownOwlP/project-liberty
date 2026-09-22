import { lookup } from "node:dns/promises";
import { nodePinnedFetch } from "@liberty/media-inspection/node/pinned-fetch";
import {
  CATALOG_DOCUMENT_LIMITS,
  CC0_ITEM_ID_PATTERN,
  WIKIDATA_CAPABILITIES,
  WIKIDATA_CC0_HOSTS,
  WIKIDATA_SOURCE_ID,
  ingestedWorkKindSchema,
  languageTagSchema,
  noRightsBasisEstablished,
  territorySchema,
  validateCatalogRefreshSchedule,
  type CatalogProviderRuntime,
  type CatalogRefreshSchedule,
  type CatalogScheduleRefusal,
  type EgressPolicy,
  type HostResolver,
  type ManifestFetchDependencies,
  type UnstatedAvailability
} from "@liberty/catalog-ingestion";
import { classifyHost } from "@liberty/provider-sdk";
import { isLocalDeployment } from "../app/api/deployment-environment";
import type { CatalogIngestionReadOptions, CatalogIngestionRuntime } from "./catalog-ingestion-source";
import { registerCatalogIngestionRuntime } from "./catalog-source-registry";

/* -------------------------------------------------------------------------
 * The server composition root for the catalog metadata source
 *
 * WHAT THIS FILE CLOSES. `registerCatalogIngestionRuntime` has existed since
 * PL-0305 and NOTHING CALLED IT, so a hosted deployment answered
 * `no_metadata_source_configured` no matter how it was configured -- a true
 * statement about the deployment, and the entire gap PL-0308 owns. This is the
 * caller. It is also the ONE PLACE IN `apps/web` THAT CONSTRUCTS THE NODE
 * PINNED FETCH, which is why the runtime is built here and not somewhere
 * tidier: a runtime's transport is the thing that opens sockets, and it is
 * composed beside the transport rather than handed around.
 *
 * IT IS NOT IMPORTED BY ANY REQUEST PATH AND MUST NOT BECOME ONE. Everything
 * below runs once, in a server process, before requests. `node:dns/promises`
 * and the Node transport make that non-negotiable rather than a convention: the
 * module does not load anywhere else.
 *
 * ==========================================================================
 * WHY AN ENVIRONMENT READ HERE IS NOT THE ENVIRONMENT READ THE REGISTRY REFUSES
 * ==========================================================================
 *
 * `catalog-source-registry.ts` argues at length that a runtime read out of the
 * process would be "a hosted process describing its own catalog configuration
 * into existence", and that argument is about THE REGISTRY, which every request
 * reaches. The distinction it draws is between a registration -- "a call some
 * composition root makes on purpose, with a value it constructed, visible in a
 * stack trace" -- and an ambient read on the resolution path. This file is the
 * composition root that makes that call. What it reads is not a capability, a
 * rights basis or an egress allowlist; it is the OPERATOR'S STATEMENT of which
 * licensed source they want and how they want it read, which has to arrive from
 * outside the binary or it is not an operator's statement at all.
 *
 * The same split is already drawn in `next.config.ts`, which reads the
 * build-target variable in exactly one place, from something that is not on a
 * request path -- and whose own test forbids any module under `apps/web/src`
 * from so much as naming that variable, which is why this paragraph does not.
 *
 * ==========================================================================
 * WHAT AN OPERATOR CAN AND CANNOT SAY
 * ==========================================================================
 *
 * CAN: which licensed source, the User-Agent this deployment identifies itself
 * with, which slice of that source to read, which locales to serve, which
 * territory availability is evaluated for, how an unstated availability is to be
 * read, how many pages one query may pull, and -- since PL-0309's corrective --
 * HOW OLD AN ANSWER MAY BE AND HOW FAR A FAILING PROVIDER IS BACKED OFF.
 *
 * CANNOT, and each absence is deliberate:
 *
 *   - AN EGRESS ALLOWLIST. It is derived from the source name, below. An
 *     allowlist a deployment could widen is not an allowlist -- and the package
 *     refuses a Wikidata provider whose policy names anything outside the CC0
 *     hosts anyway, so an operator-supplied one could only ever fail or be
 *     redundant.
 *   - `localDeployment`. It is a property of the running process, asked of the
 *     process, for the reason `egress.ts` gives: on a hosted instance `127.0.0.1`
 *     is Liberty's own admin surface, so a source claiming to be local must not
 *     be able to reach it by saying so.
 *   - A RIGHTS BASIS. `noRightsBasisEstablished` is passed by name. It is the
 *     honest register for an operator who holds none, it refuses every record,
 *     and this deployment therefore publishes NOTHING and says per record why.
 *     The rights register is PL-0308's stated non-goal; supplying one quietly
 *     from here would be the worst available way to miss it.
 *   - A CREDENTIAL. There is no variable for one and no field to put one in.
 *     The initial licensed source needs none, and an ambient key read here would
 *     be the hidden credentialed source the PL-0305 review forbade. A keyed
 *     source is a `Credentials` escalation that has not been taken.
 *
 * NOTHING IS DEFAULTED, AND "NOTHING" IS MEANT LITERALLY. Every value an
 * operator must state is required, and a deployment that states some of them
 * gets a refusal listing the rest rather than a runtime built half out of this
 * file's opinions. The only numbers this module supplies are the package's own
 * published limits and the source's own page size -- neither is a product
 * decision, and both are cited rather than invented.
 *
 * ==========================================================================
 * THE REFRESH SCHEDULE IS REQUIRED, AND THAT IS A DELIBERATE BEHAVIOUR CHANGE
 * ==========================================================================
 *
 * PL-0309 gave the adapter a store and a scheduler and THIS FILE DID NOT STATE
 * A POLICY, so the runtime it built carried no `schedule`, the package read that
 * as `policy_not_stated`, and a hosted deployment refreshed on EVERY READ --
 * exactly the behaviour PL-0309 exists to remove, reached through a field that
 * was merely absent. An absence that silently reproduces the defect is not a
 * safe absence, so the three variables below joined the required set.
 *
 * THE CONSEQUENCE IS STATED RATHER THAN SOFTENED. A deployment that today sets
 * the source signal and none of the three schedule variables STOPS BEING
 * REGISTERED: it becomes `declaration-refused`, the startup log names the three
 * missing variables, and the browse surfaces answer
 * `no_metadata_source_configured` until an operator adds them. That is a real
 * regression for such a deployment and it is the intended one -- the behaviour
 * it loses is one full ingestion pass against a third party per catalog read,
 * which is the defect, not the service.
 *
 * WHY REQUIRED RATHER THAN OPTIONAL-WITH-A-WARNING. This file's doctrine is
 * already written above and in the record below: the source id is the signal,
 * and with it set every other variable becomes required. A refresh schedule is
 * as much a deployment decision as the page bound or the territory -- it governs
 * how hard this deployment leans on somebody else's service -- so making it the
 * one variable that may be omitted would be an exception with no reason behind
 * it. A warning, meanwhile, is a defect an operator reads once at startup and a
 * behaviour they keep forever.
 *
 * `policy_not_stated` IS NOT DELETED AND MUST NOT BE. It remains the honest
 * reading for a runtime that deliberately omits a policy, and
 * `CatalogIngestionRuntime.schedule` stays optional for it: nothing may be
 * described as fresh against a bound nobody wrote. What changed is narrower than
 * that -- THE PRODUCTION COMPOSITION ROOT now always states one. The two claims
 * are compatible because they are about different things: the package keeps an
 * unstated path reachable by name, and this file, which composes a hosted
 * deployment, declines to take it.
 *
 * THE CADENCE AND THE BACKOFF ARITHMETIC ARE NOT HERE. This module parses three
 * integers out of three strings -- which is a reading of an environment, and its
 * job -- and then asks `validateCatalogRefreshSchedule` whether what it read is
 * a coherent policy. There is no interval derived here, no cap applied here and
 * no comparison between the fresh bound and the stale bound written here: every
 * one of those lives in `@liberty/catalog-ingestion`, and a copy of any of them
 * in `apps/web` would be a second opinion that could drift from the one the
 * scheduler actually uses.
 * ---------------------------------------------------------------------- */

/**
 * The variables an operator sets, as one frozen record.
 *
 * ONE OBJECT RATHER THAN EIGHT STRING LITERALS, so `server-bootstrap.test.ts`
 * can assert two things mechanically that a comment can only promise: that no
 * name this module reads is credential-shaped, and that the file mentions no
 * `LIBERTY_` name it has not declared here -- which is what makes "there is no
 * second, hidden read" checkable rather than asserted.
 *
 * `LIBERTY_CATALOG_SOURCE_ID` IS THE SIGNAL. Absent, this module registers
 * nothing and the deployment is refused by name; present, the operator has asked
 * for a real catalog and every other variable becomes required. There is no
 * value of any other variable that can turn a source on.
 */
export const CATALOG_SOURCE_ENV_VARS = Object.freeze({
  /** Which licensed source. The signal; nothing else switches a source on. */
  sourceId: "LIBERTY_CATALOG_SOURCE_ID",
  /** How this deployment identifies itself. See `docs/CATALOG_SOURCE.md`. */
  userAgent: "LIBERTY_CATALOG_USER_AGENT",
  /** The class whose instances are enumerated, e.g. `Q11424` (film). */
  classQid: "LIBERTY_CATALOG_CLASS_QID",
  /** `movie`, `series` or `episode`. Declared, never derived from the class. */
  workKind: "LIBERTY_CATALOG_WORK_KIND",
  /** Comma-separated locales, most preferred first. At least one. */
  locales: "LIBERTY_CATALOG_LOCALES",
  /** The territory availability is evaluated for: an ISO 3166-1 code, or `WW`. */
  territory: "LIBERTY_CATALOG_TERRITORY",
  /** `refuse` or `treat_as_worldwide`. Never synthesises a window. */
  unstatedAvailability: "LIBERTY_CATALOG_UNSTATED_AVAILABILITY",
  /** How many pages one query reads. A bound, and with no store, a catalog size. */
  maxPages: "LIBERTY_CATALOG_MAX_PAGES",
  /**
   * Below this age an answer is current -- AND the interval at which a pass
   * becomes due. One number for both, because the package derives the cadence
   * from the policy rather than taking a second one; see
   * `catalogRefreshCadence` on why two numbers that mean "how long an answer may
   * be trusted" fail silently and totally when they drift apart.
   */
  freshForMs: "LIBERTY_CATALOG_FRESH_FOR_MS",
  /** At or beyond this age an answer is too old to present as current. */
  staleAfterMs: "LIBERTY_CATALOG_STALE_AFTER_MS",
  /** The cap on exponential backoff after consecutive failures. */
  maxBackoffMs: "LIBERTY_CATALOG_MAX_BACKOFF_MS"
} as const);

/**
 * The hosts a licensed source may be reached at.
 *
 * DERIVED FROM THE SOURCE NAME, NEVER SUPPLIED. An unknown name gets an EMPTY
 * allowlist, which is the safe direction of being wrong: an empty policy can
 * only cause a refusal, never a wider reach. The refusal it causes is the
 * package's, with the package's own detail, which is the point -- an unlicensed
 * name is answered `no_catalog_provider_licensed` by the one module that owns
 * the licensing decision, not second-guessed here.
 */
const EGRESS_HOSTS_BY_SOURCE: Readonly<Record<string, readonly string[]>> = Object.freeze({
  [WIKIDATA_SOURCE_ID]: WIKIDATA_CC0_HOSTS
});

const UNSTATED_AVAILABILITY_VALUES: readonly UnstatedAvailability[] = Object.freeze([
  "refuse",
  "treat_as_worldwide"
]);

/**
 * What an operator stated, once every value has been checked.
 *
 * A SEPARATE SHAPE FROM `CatalogIngestionRuntime` on purpose: this is the part a
 * deployment says, and the runtime is that plus the things a deployment does not
 * get to say. Keeping them apart is what makes the list of the second kind
 * readable in one place.
 */
export interface CatalogSourceDeclaration {
  readonly sourceId: string;
  readonly userAgent: string;
  readonly classQid: string;
  readonly workKind: "movie" | "series" | "episode";
  readonly locales: readonly string[];
  readonly territory: string;
  readonly unstatedAvailability: UnstatedAvailability;
  readonly maxPages: number;
  /**
   * The operator's refresh policy, already checked by the package.
   *
   * THE PACKAGE'S OWN TYPE, CARRIED WHOLE, for the reason the provider runtime
   * is carried whole: the moment this file declared its own two-number shape and
   * mapped it across, there would be a place for the mapping to be wrong.
   */
  readonly schedule: CatalogRefreshSchedule;
}

export type CatalogSourceDeclarationRead =
  | { readonly status: "absent" }
  | { readonly status: "refused"; readonly defects: readonly string[] }
  | { readonly status: "declared"; readonly declaration: CatalogSourceDeclaration };

const trimmed = (env: Readonly<Record<string, string | undefined>>, name: string): string | null => {
  const raw = env[name];
  if (raw === undefined) return null;
  const value = raw.trim();
  return value === "" ? null : value;
};

/**
 * What a schedule refusal means in terms of the variables that caused it.
 *
 * THE PACKAGE DECIDES, THIS TRANSLATES. `validateCatalogRefreshSchedule` answers
 * in its own vocabulary -- `policy_not_positive`, `policy_not_ordered`,
 * `backoff_cap_not_positive` -- and an operator holding an environment file
 * needs the variable names instead. So the RULE stays in the package and only
 * the naming happens here; there is no condition in this function that could
 * accept a policy the package refused, or refuse one it accepted.
 *
 * THE DEFAULT BRANCH IS NOT DEAD CODE DRESSED AS SAFETY. `CatalogScheduleRefusal`
 * is `FreshnessRefusal` plus the cap, and `FreshnessRefusal` also carries
 * `observed_at_unparseable` and `observed_in_the_future` -- reasons about a
 * stored timestamp that configuration validation cannot produce today. Naming
 * them individually here would be inventing an operator-facing sentence for a
 * state this path cannot reach; carrying the package's own word for it, beside
 * the three variables that make up a schedule, stays true if the vocabulary
 * grows.
 */
const describeScheduleRefusal = (reason: CatalogScheduleRefusal): string => {
  const { freshForMs, staleAfterMs, maxBackoffMs } = CATALOG_SOURCE_ENV_VARS;
  switch (reason) {
    case "policy_not_positive":
      return `${freshForMs} and ${staleAfterMs} must both be greater than zero`;
    case "policy_not_ordered":
      return `${freshForMs} must not be greater than ${staleAfterMs}`;
    case "backoff_cap_not_positive":
      return `${maxBackoffMs} must be greater than zero`;
    default:
      return `${freshForMs}, ${staleAfterMs} and ${maxBackoffMs} were refused as a schedule: ${reason}`;
  }
};

/**
 * Reads the declaration, or says what is wrong with it.
 *
 * EVERY DEFECT AT ONCE, not the first. An operator restarting a deployment to
 * discover one more missing variable per attempt is the failure mode this costs
 * six lines to avoid, and the list is the whole remedy in one message.
 *
 * DEFECTS NAME THE VARIABLE AND NEVER QUOTE ITS VALUE. Nothing read here is
 * secret today, and nothing here is the place to start assuming that stays true
 * of every future variable the list grows.
 *
 * THE VOCABULARIES ARE THE PACKAGE'S. Territory, work kind and language tag are
 * checked with the exported schemas, and the class id with the exported CC0
 * pattern, so a tightened rule upstream tightens here rather than drifting.
 */
export function readCatalogSourceDeclaration(
  env: Readonly<Record<string, string | undefined>>
): CatalogSourceDeclarationRead {
  const sourceId = trimmed(env, CATALOG_SOURCE_ENV_VARS.sourceId);
  if (sourceId === null) return { status: "absent" };

  const defects: string[] = [];
  const required = (name: string): string | null => {
    const value = trimmed(env, name);
    if (value === null) defects.push(`${name} is not set`);
    return value;
  };

  const userAgent = required(CATALOG_SOURCE_ENV_VARS.userAgent);

  const classQid = required(CATALOG_SOURCE_ENV_VARS.classQid);
  if (classQid !== null && !CC0_ITEM_ID_PATTERN.test(classQid)) {
    defects.push(`${CATALOG_SOURCE_ENV_VARS.classQid} must be an item id such as Q11424`);
  }

  const rawKind = required(CATALOG_SOURCE_ENV_VARS.workKind);
  const kind = rawKind === null ? null : ingestedWorkKindSchema.safeParse(rawKind);
  if (kind !== null && !kind.success) {
    defects.push(
      `${CATALOG_SOURCE_ENV_VARS.workKind} must be one of ${ingestedWorkKindSchema.options.join(", ")}`
    );
  }

  const rawLocales = required(CATALOG_SOURCE_ENV_VARS.locales);
  const locales = (rawLocales ?? "")
    .split(",")
    .map((locale) => locale.trim())
    .filter((locale) => locale !== "");
  if (rawLocales !== null && locales.length === 0) {
    defects.push(`${CATALOG_SOURCE_ENV_VARS.locales} must name at least one locale`);
  }
  for (const locale of locales) {
    if (!languageTagSchema.safeParse(locale).success) {
      defects.push(`${CATALOG_SOURCE_ENV_VARS.locales} contains a locale that is not a language tag`);
      break;
    }
  }

  const rawTerritory = required(CATALOG_SOURCE_ENV_VARS.territory);
  const territory = rawTerritory === null ? null : territorySchema.safeParse(rawTerritory);
  if (territory !== null && !territory.success) {
    defects.push(
      `${CATALOG_SOURCE_ENV_VARS.territory} must be an ISO 3166-1 alpha-2 code or WW`
    );
  }

  const rawUnstated = required(CATALOG_SOURCE_ENV_VARS.unstatedAvailability);
  const unstated = UNSTATED_AVAILABILITY_VALUES.find((value) => value === rawUnstated) ?? null;
  if (rawUnstated !== null && unstated === null) {
    defects.push(
      `${CATALOG_SOURCE_ENV_VARS.unstatedAvailability} must be one of ${UNSTATED_AVAILABILITY_VALUES.join(", ")}`
    );
  }

  const rawMaxPages = required(CATALOG_SOURCE_ENV_VARS.maxPages);
  const maxPages = rawMaxPages === null ? null : Number(rawMaxPages);
  if (maxPages !== null && (!Number.isSafeInteger(maxPages) || maxPages < 1)) {
    defects.push(`${CATALOG_SOURCE_ENV_VARS.maxPages} must be a whole number of at least 1`);
  }

  /*
   * A DURATION IS READ, NOT JUDGED. This checks only that the string is a whole
   * number of milliseconds a `number` can hold -- `Number("2m")` is `NaN` and
   * `Number("1e400")` is `Infinity`, and neither is something to hand a
   * scheduler. Whether the three durations make a COHERENT POLICY is the
   * package's question and is asked below, once, through
   * `validateCatalogRefreshSchedule`. Nothing here compares them.
   */
  const milliseconds = (name: string): number | null => {
    const raw = required(name);
    if (raw === null) return null;
    const value = Number(raw);
    if (!Number.isSafeInteger(value)) {
      defects.push(`${name} must be a whole number of milliseconds`);
      return null;
    }
    return value;
  };

  const freshForMs = milliseconds(CATALOG_SOURCE_ENV_VARS.freshForMs);
  const staleAfterMs = milliseconds(CATALOG_SOURCE_ENV_VARS.staleAfterMs);
  const maxBackoffMs = milliseconds(CATALOG_SOURCE_ENV_VARS.maxBackoffMs);

  /*
   * THE COHERENCE CHECK IS THE PACKAGE'S, AT CONFIGURATION TIME. Asking it here
   * is the whole reason `validateCatalogRefreshSchedule` is exported: a
   * transposed policy would otherwise mark every answer expired at runtime and
   * present to an operator as a provider outage. It is asked only when all three
   * durations were readable, because a schedule assembled out of nulls would
   * produce a second, misleading defect on top of the three that already name
   * the real problem.
   */
  const schedule: CatalogRefreshSchedule | null =
    freshForMs === null || staleAfterMs === null || maxBackoffMs === null
      ? null
      : { policy: { freshForMs, staleAfterMs }, maxBackoffMs };
  if (schedule !== null) {
    const checked = validateCatalogRefreshSchedule(schedule);
    if (!checked.ok) defects.push(describeScheduleRefusal(checked.reason));
  }

  if (
    defects.length > 0 ||
    userAgent === null ||
    classQid === null ||
    kind === null ||
    !kind.success ||
    territory === null ||
    !territory.success ||
    unstated === null ||
    maxPages === null ||
    schedule === null
  ) {
    return { status: "refused", defects };
  }

  return {
    status: "declared",
    declaration: {
      sourceId,
      userAgent,
      classQid,
      workKind: kind.data,
      locales,
      territory: territory.data,
      unstatedAvailability: unstated,
      maxPages,
      schedule
    }
  };
}

/**
 * The Node host resolver.
 *
 * `lookup` RATHER THAN `resolve4`/`resolve6`, because the addresses that get
 * pinned must be the addresses a socket would otherwise have used: `lookup` goes
 * through the operating system's resolver, so `/etc/hosts`, a container's DNS
 * policy and a search domain are all honoured. A DNS-only query would authorise
 * one set of addresses and leave the transport connecting to another, which is
 * the second resolution the whole pinning design exists to remove.
 *
 * `verbatim` IS STATED rather than inherited from the Node version's default,
 * because the order this returns is the order the transport tries.
 */
const nodeHostResolver: HostResolver = async (hostname) => {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
};

/**
 * The transport a Node deployment reaches a catalog source through.
 *
 * THE ONE PINNED-FETCH CONSTRUCTION IN `apps/web`. `nodePinnedFetch` is used
 * unmodified and is not wrapped: a wrapper is a second fetch path, and the
 * transport's whole reason to exist is that the address it connects to is the
 * one egress authorised.
 *
 * `classifyHost` COMES THROUGH `@liberty/provider-sdk`, which re-exports
 * `@liberty/net-policy`'s. That is the same function object the playback
 * candidate path classifies with, so two subsystems cannot disagree about what
 * a private address is.
 */
export function nodeCatalogTransport(): ManifestFetchDependencies {
  return {
    fetchImpl: nodePinnedFetch,
    classifyHost,
    resolveHost: nodeHostResolver,
    now: () => Date.now()
  };
}

const egressFor = (sourceId: string): EgressPolicy => ({
  allowedHosts: [...(EGRESS_HOSTS_BY_SOURCE[sourceId] ?? [])],
  /*
   * A LICENSED METADATA SOURCE IS ON THE PUBLIC INTERNET. There is no
   * deployment of this application in which the catalog provider needs to
   * address the machine Liberty runs on, so the permission is withheld here
   * rather than derived from anything.
   */
  allowLoopback: false,
  localDeployment: isLocalDeployment()
});

/**
 * The runtime a declaration composes to.
 *
 * WHAT IS OPERATOR-STATED AND WHAT IS NOT is visible field by field: the
 * selection, the User-Agent and the read options come from the declaration; the
 * egress policy, the rights register, the page size and the document limits do
 * not, and each has a reason above.
 *
 * `pageSize` IS THE SOURCE'S OWN BATCH LIMIT, not a number this file chose:
 * `WIKIDATA_CAPABILITIES.maxPageSize` is what the Action API serves anonymously
 * and what `ingest.ts` clamps to anyway, so asking for it is asking for one page
 * rather than tuning anything.
 *
 * THE CLOCK IS THE TRANSPORT'S. One injected clock for the pass, the projection
 * and the fetch deadline, so the three cannot be a millisecond apart for no
 * reason.
 *
 * `schedule` IS ALWAYS SET HERE, AND THAT IS THE LINE THE CORRECTIVE TURNS ON.
 * Before it, this function returned a runtime with the field absent, the adapter
 * resolved that to `null`, and the package refreshed on every read. The field is
 * optional on `CatalogIngestionRuntime` and stays optional -- see the header on
 * why `policy_not_stated` survives -- but a production composition that reached
 * that path by forgetting to fill a field was not stating a policy, it was
 * omitting one, and the two are indistinguishable from outside.
 *
 * `store` IS STILL NOT SET, and that is unchanged and still honest. The adapter
 * gives each registered runtime an in-memory store that lives as long as the
 * runtime does, which is what makes a schedule worth having inside one process;
 * a durable store is a `CatalogStore` implementation nobody has written, and
 * supplying nothing is how this file says so. A restart is still a cold start.
 */
export function catalogRuntimeFor(
  declaration: CatalogSourceDeclaration,
  transport: ManifestFetchDependencies
): CatalogIngestionRuntime {
  const provider: CatalogProviderRuntime = {
    sourceId: declaration.sourceId,
    selection: {
      classQid: declaration.classQid,
      kind: declaration.workKind,
      locales: declaration.locales
    },
    document: {
      egress: egressFor(declaration.sourceId),
      timeoutMs: CATALOG_DOCUMENT_LIMITS.timeoutMs,
      maxResponseBytes: CATALOG_DOCUMENT_LIMITS.maxResponseBytes,
      maxRedirects: CATALOG_DOCUMENT_LIMITS.maxRedirects,
      userAgent: declaration.userAgent
    },
    transport,
    rightsRegister: noRightsBasisEstablished
  };

  const read: CatalogIngestionReadOptions = {
    locales: declaration.locales,
    territory: declaration.territory,
    unstatedAvailability: declaration.unstatedAvailability,
    pageSize: WIKIDATA_CAPABILITIES.maxPageSize,
    maxPages: declaration.maxPages
  };

  return { provider, read, now: transport.now, schedule: declaration.schedule };
}

/**
 * What the bootstrap did.
 *
 * THREE OUTCOMES, ALL NAMED, because the caller has to be able to log the
 * difference: nothing was asked for, something was asked for and could not be
 * read, or a runtime is registered.
 *
 * `registered` IS NOT "THE SOURCE WORKS". It means a runtime was handed to the
 * registry. Whether the package will build a provider over it is the registry's
 * answer, per resolution, and a source name nobody licensed comes back from
 * there as `catalog_metadata_source_configuration_refused` with the package's
 * own detail -- which is the right remedy to show an operator who configured
 * something, and the wrong one to replace with "no source configured".
 */
export type CatalogBootstrapOutcome =
  | { readonly status: "not-requested" }
  | { readonly status: "declaration-refused"; readonly defects: readonly string[] }
  | { readonly status: "registered"; readonly sourceId: string };

/**
 * Registers this deployment's catalog metadata runtime, if it stated one.
 *
 * THE CALL PL-0308 EXISTS FOR. Everything above is how the value is built;
 * this is the line that makes a hosted deployment's answer stop being
 * `no_metadata_source_configured`.
 *
 * A REFUSED DECLARATION REGISTERS NOTHING AND DOES NOT THROW. Throwing was
 * considered and rejected: this runs at process start, and a catalog
 * misconfiguration that takes down playback, search and the whole application
 * with it is a worse outcome than a named refusal on the browse surfaces plus
 * the defect list in the server log. The caller logs it; see
 * `docs/CATALOG_SOURCE.md` for what an operator does next.
 *
 * `env` AND `transport` ARE PARAMETERS WITH PRODUCTION DEFAULTS, so the test
 * path and the production path are the same expression rather than two
 * expressions that have to be kept in agreement. The defaults are evaluated per
 * call, never at module scope, for the reason `deployment-environment.ts` gives
 * about a serverless cold start freezing an answer.
 */
export function bootstrapCatalogMetadataSource(
  env: Readonly<Record<string, string | undefined>> = process.env,
  transport: ManifestFetchDependencies = nodeCatalogTransport()
): CatalogBootstrapOutcome {
  const read = readCatalogSourceDeclaration(env);
  if (read.status === "absent") return { status: "not-requested" };
  if (read.status === "refused") return { status: "declaration-refused", defects: read.defects };

  registerCatalogIngestionRuntime(catalogRuntimeFor(read.declaration, transport));
  return { status: "registered", sourceId: read.declaration.sourceId };
}

/**
 * One log line for an outcome.
 *
 * HERE RATHER THAN IN THE ENTRY POINT so that the entry point is the three lines
 * a framework convention file should be, and so the wording is covered by this
 * module's tests rather than by nothing.
 */
export function describeCatalogBootstrapOutcome(outcome: CatalogBootstrapOutcome): string {
  switch (outcome.status) {
    case "not-requested":
      return `catalog metadata source: none requested (set ${CATALOG_SOURCE_ENV_VARS.sourceId} to configure one)`;
    case "declaration-refused":
      return `catalog metadata source: NOT configured -- ${outcome.defects.join("; ")}`;
    case "registered":
      return `catalog metadata source: runtime registered for ${outcome.sourceId}`;
  }
}
