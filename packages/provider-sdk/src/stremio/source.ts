import { z } from "zod";
import { PLAYABLE_CONTENT_RIGHTS, type ContentRights } from "@liberty/contracts";
import { compareCodePoint } from "./order";
import { formatIssues } from "./protocol";
import { checkUrl, truncate, type UrlRejectionReason } from "./url-policy";

/**
 * Configured Stremio sources, and the rights gate that guards them (PL-0301).
 *
 * THE INVARIANT THIS FILE EXISTS TO ENFORCE:
 *
 *   Rights are DECLARED BY THE OPERATOR, PER SOURCE. They are never read,
 *   inferred, or defaulted from anything an addon returns.
 *
 * The Stremio protocol has no rights model at all -- no licence field, no
 * ownership field, nothing that could distinguish a public-domain film archive
 * from an unlicensed scraper. Any code that tried to derive rights from a
 * response would therefore be deriving them from a title string or from the
 * absence of evidence, which is not a rights basis; it is a guess that would
 * eventually guess "playable".
 *
 * So the operator states the rights basis when they configure the source, and
 * every candidate the source produces carries that stated value verbatim. A
 * source whose rights are missing, misspelled, or outside
 * `PLAYABLE_CONTENT_RIGHTS` does not produce a degraded source or a source with
 * a warning -- `defineStremioSource` returns a failure and there is no object to
 * build an adapter from. Fail closed: unverifiable must never fall through to
 * permissive.
 *
 * That last point is why `AuthorizedStremioSource` is BRANDED. The rights check
 * being a function anyone can forget to call is a convention; the adapter
 * constructor being unable to accept anything but the output of that check is a
 * rule. `createStremioProvider` takes the branded type, so "these candidates
 * came from a source whose rights were validated" is a fact about the type
 * system rather than a fact about reviewer attention.
 */

/* -------------------------------------------------------------------------
 * How the declaration above is EVIDENCED.
 *
 * This was free text with a minimum length, which enforced nothing: an
 * eight-character string proves that somebody typed eight characters, and
 * "abcdefgh" passed while a genuine one-word collection id would not have. The
 * runtime demand for evidence was right; measuring evidence by length was not.
 *
 * So the basis is structured, and the structure is what is checked:
 *
 *   - `rights` restates the entitlement being evidenced;
 *   - `basis` names the KIND of authorization it rests on -- see
 *     `RightsBasisKind` and the compatibility table below it;
 *   - `reference` identifies the specific instance of that kind: the contract
 *     id, the collection id, or the documented determination.
 *
 * `reference` has no length rule on purpose. A short collection id is a real
 * reference and a long sentence of prose is not necessarily one, so length was
 * never the property worth testing; what is checked is that the reference exists
 * and that the classification around it is coherent.
 * ---------------------------------------------------------------------- */

/**
 * HOW the entitlement was established.
 *
 * `rights` answers WHAT CLASS of entitlement a candidate has; `basis` answers
 * HOW that entitlement came about. The vocabulary was previously one value per
 * rights class -- `licensed -> provider-contract`, `owned -> user-library`,
 * `public-domain -> public-domain` -- which made the field a restatement rather
 * than an explanation: it could be derived from `rights` mechanically, so it
 * added no auditable fact and its "coherence" check only ever caught a typo.
 *
 * Many-to-one instead. Each class has several genuinely different origins, and
 * which one applies changes what an operator has to be able to produce when
 * asked:
 *
 *   - `provider-contract` -- a commercial agreement with the party operating the
 *     source. Expires, has territory and window terms.
 *   - `direct-license` -- a licence obtained from the rightsholder for this
 *     work or catalogue, independent of who serves the bytes.
 *   - `partner-entitlement` -- served under a partner's own licence, on their
 *     authority rather than ours. The obligations sit with the partner, so a
 *     rights question about one of these goes to a different party entirely.
 *   - `user-owned-copy` -- media the viewer owns, accessed with their
 *     authorization. The docs/CONTENT_RIGHTS.md "owned by the user" case.
 *   - `operator-owned-master` -- first-party media the operator owns outright,
 *     with no third party to ask.
 *   - `public-domain-determination` -- a documented finding that this work is in
 *     the public domain in the relevant jurisdiction.
 *   - `public-domain-collection` -- membership of a curated public-domain
 *     collection whose curator made that determination.
 *
 * The distinctions are not cosmetic: `direct-license` and `partner-entitlement`
 * are both `licensed` and they fail differently -- one lapses when our contract
 * lapses, the other when the partner's does -- and a determination we can show
 * is a different position from one we inherited with a collection.
 */
export type RightsBasisKind =
  | "provider-contract"
  | "direct-license"
  | "partner-entitlement"
  | "user-owned-copy"
  | "operator-owned-master"
  | "public-domain-determination"
  | "public-domain-collection";

export interface RightsBasis {
  /** Must equal the source's declared `rights`. See `RIGHTS_BASES_FOR_RIGHTS`. */
  readonly rights: ContentRights;
  readonly basis: RightsBasisKind;
  /** Contract id, collection id, or documented public-domain determination. */
  readonly reference: string;
}

/**
 * Which bases can support which rights class -- the compatibility table.
 *
 * An allowlist per class, so every combination outside it is refused. A source
 * declaring `licensed` on a public-domain determination is not a stricter or a
 * looser source, it is a source whose config contradicts itself, and the two
 * halves imply different obligations: a licence has terms and an expiry, a
 * determination has neither. Refusing the contradiction is the only reading that
 * does not silently pick one half to believe. The redundancy is the point --
 * `rights` and `basis` are stated independently by the operator, so the common
 * config accident of copying an entry and updating one field fails closed.
 *
 * CUSTODY IS NOT A LEGAL BASIS, which is why the old `user-library` value is
 * gone rather than renamed. Where a file happens to be stored says nothing about
 * why we may serve it. A licensed film cached in a user's local library is still
 * `licensed`, and its basis is still the licence or contract that permits it; if
 * the media is genuinely the viewer's own, that is `owned` with
 * `user-owned-copy`. Allowing a storage location to evidence a licence would let
 * "we have a copy" stand in for "we are allowed to serve it", which is precisely
 * the inference docs/CONTENT_RIGHTS.md exists to forbid.
 *
 * Each list is in code-point order, and it is the order the error messages and
 * `RIGHTS_BASIS_KINDS` are derived from, so no published list depends on the
 * order an object literal happened to be written in.
 */
export const RIGHTS_BASES_FOR_RIGHTS: Readonly<Record<ContentRights, readonly RightsBasisKind[]>> = {
  licensed: ["direct-license", "partner-entitlement", "provider-contract"],
  owned: ["operator-owned-master", "user-owned-copy"],
  "public-domain": ["public-domain-collection", "public-domain-determination"]
};

/**
 * One line per basis, used to explain a refusal rather than merely name it.
 *
 * An operator who typed the wrong pair needs to know which fact the two halves
 * of their config disagree about, and "basis X is not permitted for rights Y" on
 * its own sends them to look up a table. Kept beside the table so a new basis
 * cannot be added without stating what it means -- `Record` makes omitting one a
 * compile error.
 */
export const RIGHTS_BASIS_MEANING: Readonly<Record<RightsBasisKind, string>> = {
  "provider-contract": "a commercial agreement with the party operating this source",
  "direct-license": "a licence obtained from the rightsholder for this work or catalogue",
  "partner-entitlement": "served under a partner's own licence, on the partner's authority",
  "user-owned-copy": "media the viewer owns, accessed with their authorization",
  "operator-owned-master": "first-party media the operator owns outright",
  "public-domain-determination": "a documented public-domain finding for the relevant jurisdiction",
  "public-domain-collection": "membership of a curated public-domain collection"
};

/**
 * The bases an operator is most likely to reach for by mistake, because they
 * describe where media is HELD.
 *
 * Refusing the combination is enough to be correct; saying why is what stops the
 * operator "fixing" it by changing the rights instead of the basis. Somebody
 * looking at a licensed film sitting in a user's local library will reasonably
 * think "the user has it, so it is theirs" -- and downgrading a licensed work to
 * `owned` to make the config validate is a rights error dressed up as a config
 * fix, which is a worse outcome than the original typo.
 */
const CUSTODY_BASES: readonly RightsBasisKind[] = ["user-owned-copy"];

/**
 * Compile-time proof that a source passed the rights gate.
 *
 * NOT exported, on purpose: an exported brand is a forgeable brand. The only way
 * to obtain a value of this type outside this module is `defineStremioSource`.
 */
const RIGHTS_DECLARED: unique symbol = Symbol("liberty.stremio.rights-declared");

export interface StremioSourceInput {
  /** Stable operator-chosen id; becomes the `providerId` on every candidate. */
  readonly id: string;
  readonly manifestUrl: string;
  /**
   * The operator's declaration of what Liberty is entitled to serve from this
   * source. Copied onto every candidate; never compared against, or corrected
   * by, anything the addon says.
   */
  readonly rights: ContentRights;
  /**
   * The auditable evidence for the declaration above. Required, and required to
   * classify itself consistently with `rights`.
   *
   * docs/CONTENT_RIGHTS.md asks for a documented rights basis on every provider
   * integration. Asking for it in a pull-request checklist means it exists for
   * the sources that were added through a pull request; asking for it here means
   * it exists for the ones an operator adds from a config file at 2am. It is
   * carried into the reason trail so that "why are we allowed to serve this"
   * is answerable from a playback decision rather than from repository history.
   */
  readonly rightsBasis: RightsBasis;
  readonly displayName?: string | undefined;
  /**
   * Declares this source as an addon running on THIS machine. NECESSARY for
   * loopback URLs (and plaintext http to them), and never sufficient: the
   * deployment must independently be a local one. Defaults to false -- a source
   * that did not say it was local is not local. See url-policy.ts.
   */
  readonly allowLoopback?: boolean | undefined;
  /**
   * Whether to keep streams the addon flags `notWebReady`. Defaults to false.
   *
   * The flag means the addon does not expect a browser to be able to play the
   * stream -- typically a container or codec that only an external player
   * handles. Liberty's player is a browser player, so admitting those by default
   * would fill the ranker with candidates that fail at the <video> element,
   * where the failure is a stall the viewer sees rather than a rejection an
   * engineer can read. An operator running a local library of MKVs can turn it
   * back on for that source.
   */
  readonly acceptNotWebReady?: boolean | undefined;
}

export interface AuthorizedStremioSource {
  readonly [RIGHTS_DECLARED]: true;
  readonly id: string;
  readonly displayName: string;
  readonly rights: ContentRights;
  readonly rightsBasis: RightsBasis;
  readonly manifestUrl: string;
  /** `manifestUrl` with the trailing `/manifest.json` removed. */
  readonly baseUrl: string;
  readonly allowLoopback: boolean;
  /**
   * The deployment mode this source was authorized UNDER, recorded so the
   * adapter built from it cannot be handed a different answer later.
   *
   * It is a property of the instance rather than of the source, and it is
   * carried here for the same reason `rights` is: the branded object is the
   * record of the conditions under which this source passed its gate, and
   * everything downstream reads those conditions from it rather than re-deriving
   * them from an environment it may be running in a different corner of.
   */
  readonly localDeployment: boolean;
  readonly acceptNotWebReady: boolean;
}

export type SourceRejectionReason =
  | "source_config_malformed"
  | "rights_not_declared"
  | "rights_not_playable"
  | "rights_basis_missing"
  | "rights_basis_malformed"
  | "rights_basis_incoherent"
  | "local_deployment_not_source_configurable"
  | "source_id_invalid"
  | "manifest_url_not_manifest_json"
  | UrlRejectionReason;

export type DefineStremioSourceResult =
  | { readonly ok: true; readonly source: AuthorizedStremioSource }
  | { readonly ok: false; readonly reason: SourceRejectionReason; readonly detail: string };

/**
 * Facts about the running instance, not about any source.
 *
 * Passed as a separate argument rather than read from `process.env` inside this
 * module, and rather than accepted as a field of the source config: this gate is
 * pure and testable, and the deployment's answer must come from the deployment.
 * Absent, it is false -- an instance that has not said it is local is hosted.
 */
export interface DeploymentContext {
  readonly localDeployment?: boolean | undefined;
}

/**
 * Ids appear in candidate ids, log lines and metric labels. Constrained to a
 * boring charset so a source id can never smuggle a delimiter into the
 * `${sourceId}:${key}` candidate id and make two different sources produce
 * colliding, or deliberately overlapping, candidate identities.
 */
const SOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/**
 * The whole vocabulary, DERIVED from the compatibility table rather than written
 * out beside it.
 *
 * A second hand-maintained list is a second thing to forget: a basis added to
 * the table but not to the list would be rejected as unrecognised even though
 * the table permits it, and one added to the list but not the table would be
 * recognised and then refused as incoherent for every rights class -- two
 * different confusing failures, both from the same duplication. Sorted by code
 * point so the enumeration in the error messages is stable regardless of the
 * order the table's entries happen to be written in.
 *
 * Walked through `PLAYABLE_CONTENT_RIGHTS` rather than the table's own keys, so
 * a rights value the contract stops treating as playable takes its bases out of
 * the recognised vocabulary with it.
 */
export const RIGHTS_BASIS_KINDS: readonly RightsBasisKind[] = [
  ...new Set(PLAYABLE_CONTENT_RIGHTS.flatMap((rights) => RIGHTS_BASES_FOR_RIGHTS[rights]))
].sort(compareCodePoint);

/**
 * Validated as a shape, not as a length. Only the field TYPES are checked here;
 * membership of the two closed vocabularies is checked against the same
 * allowlists the rest of the package uses, rather than against a second copy of
 * them written as a zod enum. `reference` only has to exist -- see the
 * `RightsBasis` header for why measuring it would be measuring the wrong thing.
 */
const rightsBasisSchema = z.object({
  rights: z.string(),
  basis: z.string(),
  reference: z.string()
});

const sourceShapeSchema = z.object({
  id: z.string(),
  manifestUrl: z.string().min(1),
  // `unknown` in the SHAPE so that a basis which is absent, or present but
  // malformed, is reported as the specific rights-basis fault it is rather than
  // as a generic malformed config.
  rightsBasis: z.unknown(),
  displayName: z.string().min(1).optional(),
  allowLoopback: z.boolean().optional(),
  acceptNotWebReady: z.boolean().optional()
});

/** One line naming the authorization, for reason trails and logs. */
export function describeRightsBasis(basis: RightsBasis): string {
  return `${basis.rights} via ${basis.basis} (${truncate(basis.reference, 60)})`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Orders a permission flag, closed position first.
 *
 * The direction is arbitrary as far as determinism goes -- what matters is that
 * there IS one. It is `false` first so that if a human ever reads the list, the
 * more restricted of two otherwise identical sources is the one at the top,
 * which is the reading least likely to be mistaken for an endorsement.
 */
function comparePermission(a: boolean, b: boolean): number {
  return a === b ? 0 : a ? 1 : -1;
}

function fail(reason: SourceRejectionReason, detail: string): DefineStremioSourceResult {
  return { ok: false, reason, detail };
}

/**
 * The only constructor of an `AuthorizedStremioSource`.
 *
 * Takes `unknown` rather than `StremioSourceInput` deliberately. Source
 * configuration arrives from a JSON file, an environment variable or an admin
 * API -- all places where the TypeScript type is an assertion about data that
 * was never checked. Typing the parameter would move the rights gate to compile
 * time, which is precisely where the data is not.
 *
 * Rights are checked FIRST, before the shape, so that a config which is both
 * missing its rights and missing its id reports the rights problem. The ordering
 * mirrors media-engine's `firstRejectionReason`: the most fundamental reason a
 * thing was refused is the one worth reporting.
 *
 * `deployment` is the second parameter and not a config field. See
 * `DeploymentContext`.
 */
export function defineStremioSource(
  input: unknown,
  deployment: DeploymentContext = {}
): DefineStremioSourceResult {
  if (!isRecord(input)) {
    return fail("source_config_malformed", `expected an object, received ${typeof input}`);
  }

  const declaredRights = input["rights"];
  if (declaredRights === undefined || declaredRights === null || declaredRights === "") {
    return fail(
      "rights_not_declared",
      "source declares no content rights; a source with no declared rights yields no candidates"
    );
  }

  if (
    typeof declaredRights !== "string" ||
    !PLAYABLE_CONTENT_RIGHTS.includes(declaredRights as ContentRights)
  ) {
    return fail(
      "rights_not_playable",
      `declared rights ${JSON.stringify(declaredRights)} are outside the playable allowlist ` +
        `(${PLAYABLE_CONTENT_RIGHTS.join(", ")})`
    );
  }
  const rights = declaredRights as ContentRights;

  /*
   * A source config that tries to declare the DEPLOYMENT's mode is refused
   * rather than ignored.
   *
   * Ignoring it would be safe -- the value is never read -- and it would leave
   * an operator looking at a config file that says `localDeployment: true`,
   * believing they enabled something, while the adapter behaves as though they
   * had not. For a flag whose whole purpose is to be a SECOND, independently
   * owned condition on reaching this machine, silently accepting the config's
   * opinion of it and then discarding it is the worst of both readings.
   */
  if ("localDeployment" in input) {
    return fail(
      "local_deployment_not_source_configurable",
      "localDeployment describes the running deployment, not a source; it is supplied by the " +
        "process that defines sources and cannot be granted by source configuration"
    );
  }

  const shape = sourceShapeSchema.safeParse(input);
  if (!shape.success) {
    return fail("source_config_malformed", formatIssues(shape.error.issues));
  }
  const config = shape.data;

  if (config.rightsBasis === undefined || config.rightsBasis === null) {
    return fail(
      "rights_basis_missing",
      "source states no rightsBasis; a declaration with no evidence behind it is not a declaration"
    );
  }

  const parsedBasis = rightsBasisSchema.safeParse(config.rightsBasis);
  if (!parsedBasis.success) {
    return fail(
      "rights_basis_malformed",
      "rightsBasis must be an object of {rights, basis, reference}, not free text: " +
        formatIssues(parsedBasis.error.issues)
    );
  }
  const declaredBasis = parsedBasis.data;

  if (!PLAYABLE_CONTENT_RIGHTS.includes(declaredBasis.rights as ContentRights)) {
    return fail(
      "rights_basis_malformed",
      `rightsBasis.rights ${JSON.stringify(declaredBasis.rights)} is outside the playable ` +
        `allowlist (${PLAYABLE_CONTENT_RIGHTS.join(", ")})`
    );
  }

  if (!RIGHTS_BASIS_KINDS.includes(declaredBasis.basis as RightsBasisKind)) {
    return fail(
      "rights_basis_malformed",
      `rightsBasis.basis ${JSON.stringify(declaredBasis.basis)} is not a kind of authorization ` +
        `this system recognises (${RIGHTS_BASIS_KINDS.join(", ")})`
    );
  }

  const reference = declaredBasis.reference.trim();
  if (reference === "") {
    return fail(
      "rights_basis_malformed",
      "rightsBasis.reference is empty; it must identify the contract, collection or documented " +
        "public-domain source the declaration rests on"
    );
  }

  /*
   * The evidence must classify itself the way the source does.
   *
   * Two independent statements of the same fact, refused when they disagree
   * rather than reconciled. Picking one to believe would mean the system serves
   * content under an entitlement nobody actually declared for it -- the same
   * unverifiable state `resolve` refuses to resolve when a catalog item and its
   * source disagree.
   */
  if (declaredBasis.rights !== rights) {
    return fail(
      "rights_basis_incoherent",
      `source declares rights ${JSON.stringify(rights)} but its rightsBasis evidences ` +
        `${JSON.stringify(declaredBasis.rights)}; refusing to choose between them`
    );
  }

  /*
   * The compatibility table, applied. Membership of the vocabulary was already
   * checked above; this asks the different question of whether this KIND of
   * authorization can support this CLASS of entitlement.
   */
  const basis = declaredBasis.basis as RightsBasisKind;
  const permitted = RIGHTS_BASES_FOR_RIGHTS[rights];
  if (!permitted.includes(basis)) {
    return fail(
      "rights_basis_incoherent",
      `rights ${JSON.stringify(rights)} cannot rest on ${JSON.stringify(basis)} ` +
        `(${RIGHTS_BASIS_MEANING[basis]}); permitted bases are ${permitted.join(", ")}` +
        (CUSTODY_BASES.includes(basis) && rights !== "owned"
          ? ". Where a copy is STORED is not a legal basis: a licensed film cached in a user's " +
            "library is still licensed, and its basis is still the licence or contract that permits it"
          : "")
    );
  }

  const rightsBasis: RightsBasis = { rights, basis, reference };

  if (!SOURCE_ID_PATTERN.test(config.id)) {
    return fail(
      "source_id_invalid",
      `source id ${JSON.stringify(truncate(config.id, 40))} must match ${String(SOURCE_ID_PATTERN)}`
    );
  }

  const allowLoopback = config.allowLoopback ?? false;
  const localDeployment = deployment.localDeployment ?? false;
  const checked = checkUrl(config.manifestUrl, { allowLoopback, localDeployment });
  if (!checked.ok) return fail(checked.reason, checked.detail);

  /*
   * The configured URL must be an actual manifest.
   *
   * Without this, `manifestUrl` is a general-purpose "fetch whatever I say"
   * primitive that happens to live behind a rights check, and the base URL for
   * every subsequent /stream request would be whatever path the operator
   * happened to type. Requiring the protocol's own entry point keeps the derived
   * endpoints predictable and keeps a typo from turning into a request to an
   * unrelated path on that host.
   */
  if (!checked.url.pathname.endsWith("/manifest.json")) {
    return fail(
      "manifest_url_not_manifest_json",
      `manifest URL path ${truncate(checked.url.pathname)} must end with /manifest.json`
    );
  }

  // Search and hash are dropped: Stremio carries addon configuration in the PATH
  // (`/<config>/manifest.json`), so a query string is not part of the addon's
  // identity, and keeping it would make the derived /stream URLs inconsistent
  // with the manifest they came from.
  const manifestUrl = `${checked.url.origin}${checked.url.pathname}`;
  const baseUrl = manifestUrl.slice(0, manifestUrl.length - "/manifest.json".length);

  return {
    ok: true,
    source: {
      [RIGHTS_DECLARED]: true,
      id: config.id,
      displayName: config.displayName ?? config.id,
      rights,
      rightsBasis,
      manifestUrl,
      baseUrl,
      allowLoopback,
      localDeployment,
      acceptNotWebReady: config.acceptNotWebReady ?? false
    }
  };
}

/**
 * Convenience for configuring several sources at once.
 *
 * Returns the accepted sources AND the rejections rather than throwing on the
 * first bad entry: one misconfigured source must not take the other five
 * offline, and a silently shorter list is how a source disappears from
 * production without anyone noticing.
 *
 * `sources` is sorted so that the accepted set does not depend on the order the
 * operator happened to list their config in -- whatever consumes this must not
 * acquire a preference for whichever source was typed first. Two entries may
 * legitimately share an id AND a manifest URL, since nothing here enforces
 * uniqueness of either, which is why the comparator below runs on to every
 * remaining field instead of stopping at those two.
 *
 * `rejected` keeps `index` and stays in index order, and that is deliberate
 * rather than an oversight of the same rule. A rejected config entry may have
 * failed before it had a usable id -- that is the commonest case, since rights
 * are checked before shape -- so its position is the only handle an operator
 * has on it. Position is part of a config array's identity in a way it is never
 * part of a `/stream` response's, so reordering the config is a different input,
 * not the same input in a different order.
 */
export function defineStremioSources(
  inputs: readonly unknown[],
  deployment: DeploymentContext = {}
): {
  readonly sources: AuthorizedStremioSource[];
  readonly rejected: Array<{ readonly index: number; readonly reason: SourceRejectionReason; readonly detail: string }>;
} {
  const sources: AuthorizedStremioSource[] = [];
  const rejected: Array<{ index: number; reason: SourceRejectionReason; detail: string }> = [];

  inputs.forEach((input, index) => {
    const result = defineStremioSource(input, deployment);
    if (result.ok) sources.push(result.source);
    else rejected.push({ index, reason: result.reason, detail: result.detail });
  });

  /*
   * A TOTAL order, and total is the requirement rather than a refinement of it.
   *
   * Sorting by id then manifest URL left a tie between two accepted entries that
   * share both -- which this function explicitly permits, since nothing here
   * enforces id uniqueness -- and `Array.prototype.sort` is stable, so that tie
   * resolved to the operator's config order: exactly the preference this sort
   * exists to remove, surviving in the one case where it does damage. Two such
   * entries can still differ in `rights`, `rightsBasis`, `displayName` or either
   * permission flag, so a downstream `new Map(sources.map((s) => [s.id, s]))`
   * would resolve the source as `licensed` or as `owned` depending on which line
   * was typed first.
   *
   * Every field that can differ is therefore compared, and a remaining tie now
   * means the two entries are equal in every field, so their relative order
   * carries no information. Two are deliberately absent: `baseUrl`, which is
   * `manifestUrl` with a fixed suffix removed and so cannot differ once that
   * matches, and `rightsBasis.rights`, which the gate above refused the source
   * unless it equalled `rights`. `localDeployment` IS compared even though one
   * call passes one `deployment` to every entry -- that is a fact about this
   * function's argument list, not about the type, and the next reader should not
   * have to reconstruct it to trust the sort.
   */
  sources.sort((a, b) => {
    const byId = compareCodePoint(a.id, b.id);
    if (byId !== 0) return byId;
    const byManifestUrl = compareCodePoint(a.manifestUrl, b.manifestUrl);
    if (byManifestUrl !== 0) return byManifestUrl;
    const byRights = compareCodePoint(a.rights, b.rights);
    if (byRights !== 0) return byRights;
    const byBasis = compareCodePoint(a.rightsBasis.basis, b.rightsBasis.basis);
    if (byBasis !== 0) return byBasis;
    const byReference = compareCodePoint(a.rightsBasis.reference, b.rightsBasis.reference);
    if (byReference !== 0) return byReference;
    const byDisplayName = compareCodePoint(a.displayName, b.displayName);
    if (byDisplayName !== 0) return byDisplayName;
    const byLoopback = comparePermission(a.allowLoopback, b.allowLoopback);
    if (byLoopback !== 0) return byLoopback;
    const byLocalDeployment = comparePermission(a.localDeployment, b.localDeployment);
    if (byLocalDeployment !== 0) return byLocalDeployment;
    return comparePermission(a.acceptNotWebReady, b.acceptNotWebReady);
  });

  /*
   * Index order, kept on purpose and not an oversight of the rule above. See
   * this function's header: a rejected entry may have failed before it had a
   * usable id, since rights are checked before shape, so its position is the
   * only handle an operator has on it -- and position is part of a config
   * array's identity in a way it is never part of a `/stream` response's.
   * Re-sorted rather than left as built, so a future change to the loop cannot
   * quietly make the output depend on the loop again.
   */
  rejected.sort((a, b) => a.index - b.index);

  return { sources, rejected };
}
