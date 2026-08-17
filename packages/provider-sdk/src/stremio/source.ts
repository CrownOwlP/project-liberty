import { z } from "zod";
import { PLAYABLE_CONTENT_RIGHTS, type ContentRights } from "@liberty/contracts";
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

/**
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
 *   - `basis` names the KIND of authorization -- a contract with the provider,
 *     the operator's own library, or a public-domain determination;
 *   - `reference` identifies the specific instance of that kind: the contract
 *     id, the collection id, or the documented determination.
 *
 * `reference` has no length rule on purpose. A short collection id is a real
 * reference and a long sentence of prose is not necessarily one, so length was
 * never the property worth testing; what is checked is that the reference exists
 * and that the classification around it is internally consistent.
 */
export type RightsBasisKind = "provider-contract" | "user-library" | "public-domain";

export interface RightsBasis {
  /** Must equal the source's declared `rights`. See `RIGHTS_BASIS_FOR_RIGHTS`. */
  readonly rights: ContentRights;
  readonly basis: RightsBasisKind;
  /** Contract id, collection id, or documented public-domain source. */
  readonly reference: string;
}

/**
 * The one basis that can support each rights class.
 *
 * Each rights value is a claim about WHY we may serve something, and each basis
 * names WHERE that permission comes from; there is exactly one origin per claim.
 * A source declaring `licensed` with a `public-domain` basis is not a stricter
 * or a looser source, it is a source whose config contradicts itself, and the
 * two halves imply different obligations -- a licence has terms and an expiry, a
 * public-domain determination has neither. Refusing the contradiction is the
 * only reading that does not silently pick one half to believe.
 *
 * The redundancy between `rights` and `basis` is the point. They are stated
 * independently by the operator and must agree, so the common config accident --
 * copying an entry for a new source and updating one field but not the other --
 * fails closed instead of producing candidates under rights nobody declared for
 * them.
 */
export const RIGHTS_BASIS_FOR_RIGHTS: Readonly<Record<ContentRights, RightsBasisKind>> = {
  licensed: "provider-contract",
  owned: "user-library",
  "public-domain": "public-domain"
};

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

const RIGHTS_BASIS_KINDS: readonly RightsBasisKind[] = [
  "provider-contract",
  "user-library",
  "public-domain"
];

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

  const expectedBasis = RIGHTS_BASIS_FOR_RIGHTS[rights];
  if (declaredBasis.basis !== expectedBasis) {
    return fail(
      "rights_basis_incoherent",
      `rights ${JSON.stringify(rights)} is evidenced by ${JSON.stringify(expectedBasis)}, not by ` +
        `${JSON.stringify(declaredBasis.basis)}`
    );
  }

  const rightsBasis: RightsBasis = {
    rights,
    basis: declaredBasis.basis as RightsBasisKind,
    reference
  };

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

  return { sources, rejected };
}
