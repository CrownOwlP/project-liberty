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
   * Free text recording WHY the declaration above is true -- the licence, the
   * public-domain determination, or the fact that this is the operator's own
   * library. Required, and required to be non-trivial.
   *
   * docs/CONTENT_RIGHTS.md asks for a documented rights basis on every provider
   * integration. Asking for it in a pull-request checklist means it exists for
   * the sources that were added through a pull request; asking for it here means
   * it exists for the ones an operator adds from a config file at 2am. It is
   * carried into the reason trail so that "why are we allowed to serve this"
   * is answerable from a playback decision rather than from repository history.
   */
  readonly rightsBasis: string;
  readonly displayName?: string | undefined;
  /**
   * Declares this source as an addon running on THIS machine, permitting
   * loopback URLs (and plaintext http to them). Defaults to false: a source that
   * did not say it was local is not local. See url-policy.ts.
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
  readonly rightsBasis: string;
  readonly manifestUrl: string;
  /** `manifestUrl` with the trailing `/manifest.json` removed. */
  readonly baseUrl: string;
  readonly allowLoopback: boolean;
  readonly acceptNotWebReady: boolean;
}

export type SourceRejectionReason =
  | "source_config_malformed"
  | "rights_not_declared"
  | "rights_not_playable"
  | "rights_basis_missing"
  | "source_id_invalid"
  | "manifest_url_not_manifest_json"
  | UrlRejectionReason;

export type DefineStremioSourceResult =
  | { readonly ok: true; readonly source: AuthorizedStremioSource }
  | { readonly ok: false; readonly reason: SourceRejectionReason; readonly detail: string };

/**
 * Ids appear in candidate ids, log lines and metric labels. Constrained to a
 * boring charset so a source id can never smuggle a delimiter into the
 * `${sourceId}:${key}` candidate id and make two different sources produce
 * colliding, or deliberately overlapping, candidate identities.
 */
const SOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/** Long enough that "yes" and "ok" do not count as a documented rights basis. */
export const MIN_RIGHTS_BASIS_LENGTH = 8;

const sourceShapeSchema = z.object({
  id: z.string(),
  manifestUrl: z.string().min(1),
  // Optional in the SHAPE so that an absent basis is reported as the missing
  // rights basis it is, rather than as a generic malformed config.
  rightsBasis: z.string().optional(),
  displayName: z.string().min(1).optional(),
  allowLoopback: z.boolean().optional(),
  acceptNotWebReady: z.boolean().optional()
});

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
 */
export function defineStremioSource(input: unknown): DefineStremioSourceResult {
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

  const shape = sourceShapeSchema.safeParse(input);
  if (!shape.success) {
    return fail("source_config_malformed", formatIssues(shape.error.issues));
  }
  const config = shape.data;

  const rightsBasis = (config.rightsBasis ?? "").trim();
  if (rightsBasis.length < MIN_RIGHTS_BASIS_LENGTH) {
    return fail(
      "rights_basis_missing",
      `rightsBasis must be at least ${MIN_RIGHTS_BASIS_LENGTH} characters describing why this ` +
        "source may be served"
    );
  }

  if (!SOURCE_ID_PATTERN.test(config.id)) {
    return fail(
      "source_id_invalid",
      `source id ${JSON.stringify(truncate(config.id, 40))} must match ${String(SOURCE_ID_PATTERN)}`
    );
  }

  const allowLoopback = config.allowLoopback ?? false;
  const checked = checkUrl(config.manifestUrl, { allowLoopback });
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
export function defineStremioSources(inputs: readonly unknown[]): {
  readonly sources: AuthorizedStremioSource[];
  readonly rejected: Array<{ readonly index: number; readonly reason: SourceRejectionReason; readonly detail: string }>;
} {
  const sources: AuthorizedStremioSource[] = [];
  const rejected: Array<{ index: number; reason: SourceRejectionReason; detail: string }> = [];

  inputs.forEach((input, index) => {
    const result = defineStremioSource(input);
    if (result.ok) sources.push(result.source);
    else rejected.push({ index, reason: result.reason, detail: result.detail });
  });

  return { sources, rejected };
}
