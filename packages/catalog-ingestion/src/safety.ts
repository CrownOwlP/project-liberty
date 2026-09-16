import { isOpaqueRightsReference } from "@liberty/provider-sdk";
import type { IngestedRightsBasis, IngestedWork } from "./record";

/* -------------------------------------------------------------------------
 * The two checks that make ingestion a rights boundary rather than a pipe
 *
 * Invariant 1 says only licensed, user-owned or public-domain content may enter
 * playback resolution. Invariant 2 forbids anything that bypasses DRM, paywalls,
 * authentication, geography or rights. A metadata ingestion path threatens both
 * in one specific way, and it is not the obvious one: the danger is not that
 * ingestion plays something, it is that ingestion CARRIES AN ADDRESS a later
 * surface plays. A catalog payload with a `streamUrl` in it has already crossed
 * the boundary, whatever the playback code does afterwards.
 *
 * So this module answers two questions about every record, before it is
 * accepted:
 *
 *   1. Is there a media address anywhere in it? (`findMediaAddresses`)
 *   2. Did the source declare a rights basis, and is the reference opaque?
 *      (`checkRightsBasis`)
 *
 * NEITHER CHECK IS THE SURFACING ALLOWLIST. `isSurfaceable` in
 * `apps/web/src/lib/catalog.ts` decides which rights CATEGORIES may be shown,
 * it runs on every item on the way onto a rail, and a second copy of it here
 * would be a second place to review whenever the allowlist changes. What these
 * answer is the question that precedes it.
 *
 * THE OPAQUE-REFERENCE RULE IS IMPORTED, NOT RESTATED. `isOpaqueRightsReference`
 * comes from `@liberty/provider-sdk`, which is where the rule is written and
 * where its own comment says it must stay. `docs/CATALOG_SOURCE.md` records why
 * `apps/web` does not import it -- the SDK publishes a single root entry point,
 * so a browse surface that imported the predicate would pull the fixture
 * provider, health scoring and the Stremio vocabulary into the bundle of every
 * page that renders a card. THAT OBJECTION DOES NOT APPLY HERE: this package is
 * a server-side ingestion worker, nothing in it reaches a browser, and bundle
 * weight is not a cost it pays. So the catalog path finally applies the rule --
 * in the one place that can afford to import it -- rather than growing a second
 * spelling of it, which the SDK's comment exists to prevent.
 * ---------------------------------------------------------------------- */

/**
 * Object keys whose presence in a catalog payload is itself the defect.
 *
 * MATCHED ON THE KEY, NOT ONLY THE VALUE, because a key is the part that
 * survives. A provider that sends `{"streamUrl": ""}` today sends a real one
 * tomorrow, and a scan that only looked at values would pass the first and let
 * the second through whatever plumbing was built around the first. Refusing the
 * KEY means a catalog record shaped to carry an address never becomes a shape
 * anything downstream is written against.
 *
 * Lower-cased before comparison, and compared with the separators stripped, so
 * `stream_url`, `streamURL` and `stream-url` are one entry rather than three
 * that someone has to remember to add.
 *
 * DELIBERATELY NOT INCLUDED: `path`, `source`, `location`, `link`. Each has a
 * legitimate non-address meaning in metadata (a file path in an operator's own
 * asset store, a `source` attribution, a filming `location`), and an allowlist
 * that refuses honest records trains whoever runs it to disable the allowlist.
 * The value scan below catches those cases when they actually do contain a URL,
 * which is the check that has no false positives to trade away.
 */
const ADDRESS_KEYS: readonly string[] = [
  "url",
  "urls",
  "uri",
  "uris",
  "src",
  "srcset",
  "href",
  "manifest",
  "manifesturl",
  "playbackurl",
  "playlist",
  "playlisturl",
  "stream",
  "streamurl",
  "streams",
  "mediaurl",
  "downloadurl",
  "magnet",
  "magneturi",
  "infohash",
  "endpoint",
  "cdn",
  "cdnurl"
];

const normalizeKey = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Anything that would let a consumer open a connection.
 *
 * Three shapes, and the second and third are the ones a naive check misses:
 *
 *   - an absolute URL with a scheme (`https://`, but equally `file:`, `data:`,
 *     `magnet:`, `rtmp:`);
 *   - a PROTOCOL-RELATIVE reference (`//cdn.example.test/x.m3u8`), which has no
 *     scheme to match on and is fetched perfectly happily by a browser;
 *   - a BARE HOST with a path (`cdn.example.test/x.m3u8`), which `new URL()`
 *     rejects and which every HTTP client in common use accepts.
 *
 * The bare-host pattern is the one with false-positive risk -- a synopsis
 * sentence with no spaces around a dot and a slash could match. That risk is
 * accepted because the consequence of a false positive is one refused record
 * with a named reason, and the consequence of a false negative is a media
 * address in a catalog payload.
 */
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i;
const PROTOCOL_RELATIVE_PATTERN = /^\/\/[^/\s]+/;
const BARE_HOST_PATH_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)+\/\S*$/i;

function looksLikeAddress(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  if (PROTOCOL_RELATIVE_PATTERN.test(trimmed)) return true;
  if (BARE_HOST_PATH_PATTERN.test(trimmed)) return true;
  if (!SCHEME_PATTERN.test(trimmed)) return false;
  // A scheme alone is not enough: `Season 1: The Return` has a colon after a
  // word, and refusing that would refuse a large fraction of real titles. What
  // distinguishes a scheme from a sentence is that nothing follows the colon
  // until a non-space character, and real prose puts a space there.
  const afterColon = trimmed.slice(trimmed.indexOf(":") + 1);
  return afterColon.length > 0 && !afterColon.startsWith(" ");
}

export interface MediaAddressFinding {
  /** Dotted path to the offending node, e.g. `artwork.0.assetRef`. */
  readonly path: string;
  readonly kind: "address_key" | "address_value";
}

/**
 * Walks an arbitrary value and reports every place an address could hide.
 *
 * TAKES `unknown` AND NOT A TYPED RECORD, which is the whole point. The typed
 * shapes in `record.ts` have no address field, so a scan over a parsed
 * `IngestedWork` would be checking something already proved by construction. The
 * value worth scanning is the RAW provider payload, before parsing, where the
 * extra fields a schema is about to discard are still visible -- because a field
 * a schema discards is still a field somebody can later decide to keep.
 *
 * Cycles are tolerated. A provider payload arriving from `JSON.parse` cannot
 * contain one, but this function is exported and a caller could hand it anything
 * -- and an unbounded recursion here would be a denial of service reachable from
 * a provider response, which is exactly the class of bug this module exists for.
 */
export function findMediaAddresses(value: unknown): readonly MediaAddressFinding[] {
  const findings: MediaAddressFinding[] = [];
  const seen = new WeakSet<object>();

  const walk = (node: unknown, path: string): void => {
    if (typeof node === "string") {
      if (looksLikeAddress(node)) findings.push({ path, kind: "address_value" });
      return;
    }
    if (node === null || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      node.forEach((entry, index) => {
        walk(entry, path === "" ? String(index) : `${path}.${index}`);
      });
      return;
    }

    for (const [key, entry] of Object.entries(node)) {
      const childPath = path === "" ? key : `${path}.${key}`;
      if (ADDRESS_KEYS.includes(normalizeKey(key))) {
        findings.push({ path: childPath, kind: "address_key" });
        // Still walked: a payload nesting a second address under a refused key
        // should report both, so an operator reading the refusal sees the extent
        // of what the provider sent rather than the first thing found.
      }
      walk(entry, childPath);
    }
  };

  walk(value, "");
  return findings;
}

export type RightsRefusal =
  | "rights_basis_not_declared"
  | "rights_basis_reference_not_opaque"
  | "artwork_rights_reference_not_opaque";

export type RightsCheck =
  | { readonly ok: true; readonly basis: IngestedRightsBasis }
  | { readonly ok: false; readonly reason: RightsRefusal };

/**
 * Whether a work may be published, on rights grounds alone.
 *
 * `rights: null` IS REFUSED AND NEVER DEFAULTED. It means the source established
 * no basis, which is not the same as the work having none, and the direction
 * that fails safe is to publish nothing. The work's own `category` field is not
 * read as a substitute, for the reason `apps/web/src/lib/catalog-source.ts`
 * gives at length: a field the schema forces to hold one of three values says
 * nothing about whether anybody checked.
 *
 * ARTWORK IS CHECKED TOO, and its basis is non-nullable in the schema, so the
 * only failure available to it is a non-opaque reference. An image is the one
 * thing in a catalog record that is itself a copy of somebody's file.
 *
 * WHAT A NON-OPAQUE REFERENCE MEANS IN PRACTICE: a counterparty name, a contract
 * URL, a term date, a free-text note. `docs/CONTENT_RIGHTS.md` is why those may
 * not be carried -- the agreements are not this repository's to hold -- and the
 * predicate mechanically excludes whitespace, prose and addresses. `null` stays
 * legal: "there is no register entry" is a truthful answer and the fixtures give
 * it.
 */
export function checkRightsBasis(work: IngestedWork): RightsCheck {
  const basis = work.rights;
  if (basis === null) return { ok: false, reason: "rights_basis_not_declared" };
  if (basis.reference !== null && !isOpaqueRightsReference(basis.reference)) {
    return { ok: false, reason: "rights_basis_reference_not_opaque" };
  }
  for (const artwork of work.artwork) {
    const reference = artwork.rights.reference;
    if (reference !== null && !isOpaqueRightsReference(reference)) {
      return { ok: false, reason: "artwork_rights_reference_not_opaque" };
    }
  }
  return { ok: true, basis };
}
