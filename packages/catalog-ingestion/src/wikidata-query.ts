import { z } from "zod";
import { languageTagSchema, type LanguageTag } from "./record";

/* -------------------------------------------------------------------------
 * Every request this package makes to Wikidata, and the rules that bound them
 *
 * WHY WIKIDATA AT ALL. It is a HUMAN-COMMANDER LICENSING DECISION, recorded on
 * PL-0305 as `licensingDecision` and in `control/events.jsonl` as a
 * `decision.licensing` event on 2026-09-17. `control/policies.json` lists
 * Licensing under `escalation.humanOnly`, so this module exists because that
 * decision was taken, not because an engineer picked a source. The decision's
 * own words: Wikidata is the INITIAL catalog metadata source, chosen because it
 * requires no credential and keeps the provider seam replaceable, and it is
 * explicitly "NOT AN EXCLUSIVE OR PERMANENT SOURCE MANDATE". Nothing in this
 * file may be read as "the catalog is Wikidata"; it is one adapter behind
 * `CatalogMetadataProvider`, and a second source joins or replaces it without
 * the port changing.
 *
 * ===================================================================
 * THE CC0 / CC BY-SA LINE, AND WHY IT IS ENFORCED HERE RATHER THAN IN
 * A COMMENT IN THE DOCS
 * ===================================================================
 *
 * The decision evidenced ONE thing about licensing: Wikidata's structured data
 * in the MAIN, PROPERTY and LEXEME namespaces is CC0. It evidenced nothing about
 * anything else, and text elsewhere in the Wikimedia estate -- a Wikipedia
 * article, an article extract, an abstract, a Commons file description -- is
 * CC BY-SA, which carries attribution and share-alike obligations this
 * repository has not discharged and this task is not authorised to accept. So
 * the distinction is made STRUCTURAL in four places, all of them in this file:
 *
 *   1. `WIKIDATA_CC0_HOSTS` is the only set of hosts a Wikidata provider may be
 *      composed over, and the composition REFUSES a runtime whose egress
 *      allowlist names anything else. A deployment that could reach
 *      `en.wikipedia.org` through this provider's policy does not get a
 *      provider. Fail closed, at construction, once.
 *   2. `CC0_ENTITY_ID_PATTERN` admits `Q`, `P` and `L` ids and nothing else.
 *      `M`-ids (Commons MediaInfo) are refused BY NAME even though their
 *      captions are also CC0 -- because the decision did not evidence them, and
 *      because a MediaInfo entity is attached to a media FILE whose own licence
 *      is separate and frequently not free at all.
 *   3. The query builders emit NO `SERVICE` CLAUSE. A SPARQL federated service
 *      call reaches an endpoint outside Wikidata whose licence is whatever that
 *      endpoint says it is, and `wikibase:label` -- the convenient one -- is a
 *      service. Labels are read with plain `rdfs:label` triples instead, which
 *      is more verbose and is the point. `containsServiceClause` is exported so
 *      a test can hold the line rather than a reviewer having to re-read the
 *      template.
 *   4. Nothing here requests `sitelinks`, `extracts`, `pageimages`, `P18`
 *      (image), `P154` (logo) or `P3383` (film poster). The projection has
 *      nowhere to put them -- artwork in `record.ts` is an opaque asset
 *      reference with its OWN required rights basis, and an operator's asset
 *      store is the only thing that can mint one -- so a Commons file could not
 *      be carried even if it were asked for.
 *
 * THE USER-AGENT OBLIGATION IS A CONDITION OF ACCESS, NOT A COURTESY. The
 * Wikimedia User-Agent policy requires an informative string carrying contact
 * information, and forbids impersonating a browser; a client that ignores it
 * "may be IP-blocked without notice". `CatalogDocumentOptions.userAgent` is
 * therefore required with no default -- see `transport.ts`, where that is
 * argued at length and where it must stay -- and `checkWikidataUserAgent` below
 * turns the two halves of the policy into two named construction refusals, so a
 * deployment with a bad agent string has no provider rather than an
 * IP-blocked one.
 *
 * INJECTION. Everything interpolated into a SPARQL string goes through a
 * validator first: entity ids through `CC0_ENTITY_ID_PATTERN`, language tags
 * through `languageTagSchema`, integers through `Number.isSafeInteger`. None of
 * those alphabets contains a quote, a brace, a backslash or whitespace, so
 * there is no value a caller can pass that closes a literal or opens a clause.
 * The search TERM is the one free-text input and it never reaches SPARQL at all
 * -- it goes to the Action API as a URL query parameter, encoded by
 * `URLSearchParams`.
 * ---------------------------------------------------------------------- */

/** The source id every record from this adapter is namespaced by. */
export const WIKIDATA_SOURCE_ID = "wikidata";

/**
 * The Wikidata Query Service, which answers the enumeration and hydration
 * queries.
 *
 * Its default graph is the Wikidata RDF export -- main-namespace structured data
 * -- which is the CC0 material the licensing decision evidenced.
 */
export const WIKIDATA_SPARQL_ENDPOINT = "https://query.wikidata.org/sparql";

/**
 * The MediaWiki Action API on `www.wikidata.org`, which answers search.
 *
 * Used for `wbsearchentities` ONLY, and only for the ids it returns. Its result
 * rows also carry `url` and `concepturi` fields; those are never read, and if a
 * future edit started reading them `findMediaAddresses` would refuse the record
 * before the schema saw it.
 */
export const WIKIDATA_ACTION_API_ENDPOINT = "https://www.wikidata.org/w/api.php";

/**
 * The only hosts a Wikidata provider may be allowed to reach.
 *
 * FROZEN, and walked by index rather than with `Array.prototype.includes`, for
 * the reason `packages/contracts/src/shared/runtime.ts` gives about its own
 * allowlist: `includes` is a writable property of an object every module can
 * reach, so a single assignment to it would make this predicate answer `true`
 * for a host that is not in the array while the frozen array itself stayed
 * correct. The only trusted operations here are own-property reads on a frozen
 * object.
 */
export const WIKIDATA_CC0_HOSTS: readonly string[] = Object.freeze([
  "query.wikidata.org",
  "www.wikidata.org"
]);

export function isWikidataCc0Host(host: string): boolean {
  const normalized = host.toLowerCase();
  for (let index = 0; index < WIKIDATA_CC0_HOSTS.length; index += 1) {
    if (WIKIDATA_CC0_HOSTS[index] === normalized) return true;
  }
  return false;
}

/**
 * An entity id in one of the three namespaces the licensing decision evidenced.
 *
 * `Q` item, `P` property, `L` lexeme. No leading zero, because `Q007` and `Q7`
 * are the same entity spelled two ways and a cache keyed on the string would
 * hold both. `M` (Commons MediaInfo) is deliberately outside: see the header.
 */
export const CC0_ENTITY_ID_PATTERN = /^[QPL][1-9][0-9]*$/;

export type Cc0EntityIdRefusal = "entity_id_outside_cc0_namespace";

export function requireCc0EntityId(
  raw: string
): { readonly ok: true; readonly id: string } | { readonly ok: false; readonly reason: Cc0EntityIdRefusal } {
  if (!CC0_ENTITY_ID_PATTERN.test(raw)) {
    return { ok: false, reason: "entity_id_outside_cc0_namespace" };
  }
  return { ok: true, id: raw };
}

/** An item id specifically -- the only kind this adapter enumerates. */
export const CC0_ITEM_ID_PATTERN = /^Q[1-9][0-9]*$/;

/* -------------------------------------------------------------------------
 * The User-Agent policy, as two checks
 * ---------------------------------------------------------------------- */

export type UserAgentRefusal =
  | "user_agent_lacks_contact_information"
  | "user_agent_impersonates_a_browser";

/**
 * Tokens that appear in the agent strings of real browsers.
 *
 * MATCHED AS SUBSTRINGS, case-insensitively, and the list is deliberately short
 * rather than exhaustive. This is not a browser detector -- it cannot be, and a
 * determined impersonation would get past it. It is a check against the mistake
 * that actually happens: somebody copies their browser's agent string out of
 * devtools to "make the request work", which is precisely the thing the
 * Wikimedia policy names and precisely the thing that gets an operator blocked.
 * A short list that refuses the copy-paste is worth more than a long one that
 * invites an arms race.
 */
const BROWSER_AGENT_TOKENS: readonly string[] = Object.freeze([
  "mozilla/",
  "applewebkit",
  "chrome/",
  "chromium/",
  "safari/",
  "firefox/",
  "gecko/",
  "edg/",
  "opr/",
  "trident/"
]);

/**
 * Something a human can be reached at.
 *
 * An `http(s)://` URL or an `@`-bearing token, which between them cover the two
 * shapes the Wikimedia policy's own examples use. Deliberately loose: the
 * requirement is that a Wikimedia operator can find somebody, and a regex that
 * insisted on RFC 5322 would reject `ops+catalog@example.test` shaped addresses
 * that are perfectly reachable while doing nothing about a well-formed address
 * nobody reads.
 */
const CONTACT_PATTERN = /https?:\/\/\S+|\S+@\S+\.\S+/;

/**
 * Whether an agent string satisfies the Wikimedia User-Agent policy.
 *
 * TWO REFUSALS RATHER THAN ONE BOOLEAN, because the remedies differ: one is
 * "add a contact address", the other is "stop copying your browser's string",
 * and an operator handed a single `invalid_user_agent` has to guess which.
 */
export function checkWikidataUserAgent(
  userAgent: string
): { readonly ok: true } | { readonly ok: false; readonly reason: UserAgentRefusal } {
  const lowered = userAgent.toLowerCase();
  for (let index = 0; index < BROWSER_AGENT_TOKENS.length; index += 1) {
    const token = BROWSER_AGENT_TOKENS[index];
    if (token !== undefined && lowered.includes(token)) {
      return { ok: false, reason: "user_agent_impersonates_a_browser" };
    }
  }
  if (!CONTACT_PATTERN.test(userAgent)) {
    return { ok: false, reason: "user_agent_lacks_contact_information" };
  }
  return { ok: true };
}

/* -------------------------------------------------------------------------
 * The SPARQL template
 * ---------------------------------------------------------------------- */

/**
 * Separators used to pack a multi-valued, language-tagged column into one cell.
 *
 * WHY PACK AT ALL. A page has to be one row per work, or the `LIMIT` that makes
 * paging work would be a limit on rows rather than on works -- a film with
 * twelve genres would consume a page on its own. `GROUP_CONCAT` collapses the
 * multi-valued columns; these two characters are what the client splits back
 * apart.
 *
 * WHY THESE TWO CHARACTERS. ASCII UNIT SEPARATOR and RECORD SEPARATOR are
 * control characters, so they cannot occur in a Wikidata label, description or
 * genre name -- the alternative candidates (`|`, `;`, `::`) all occur in real
 * titles, and a title containing the separator would be silently split into two
 * wrong titles. A control character cannot be typed into a Wikidata label field
 * by an editor, which makes the packing lossless rather than probably-lossless.
 *
 * THE SPARQL SPELLING IS DERIVED FROM THE CHARACTER, not written beside it, so
 * the literal this file sends and the character this file splits on cannot
 * drift apart. That drift is a silent one: the split simply stops matching and
 * every packed cell becomes one long value.
 */
export const UNIT_SEPARATOR = "";
export const RECORD_SEPARATOR = "";

const sparqlUchar = (character: string): string =>
  `\\u${character.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`;

/** `` as SPARQL source text. */
export const UNIT_SEPARATOR_SPARQL = sparqlUchar(UNIT_SEPARATOR);
/** `` as SPARQL source text. */
export const RECORD_SEPARATOR_SPARQL = sparqlUchar(RECORD_SEPARATOR);

/**
 * Wikidata properties this adapter reads, named so a reviewer does not have to
 * look each one up, and so a reader can check that no media-bearing property is
 * in the list.
 */
export const WIKIDATA_PROPERTIES = Object.freeze({
  /** instance of */
  instanceOf: "P31",
  /** genre */
  genre: "P136",
  /** publication date */
  publicationDate: "P577",
  /** duration */
  duration: "P2047",
  /** number of episodes */
  numberOfEpisodes: "P1113",
  /** IMDb ID */
  imdbId: "P345",
  /** copyright status */
  copyrightStatus: "P6216"
});

/** unit: minute. `P2047` is also stated in seconds and in hours on some items. */
const UNIT_MINUTE = "Q7727";

const languageFilterList = (locales: readonly LanguageTag[]): string =>
  locales.map((locale) => `"${locale}"`).join(", ");

/**
 * The part of the query that selects which items are on this page.
 *
 * Two shapes, one template. Enumeration uses a KEYSET on the numeric part of the
 * item id; hydration pins an explicit `VALUES` set. Both keep the `?item wdt:P31
 * ?kind` constraint, which is what makes search results get filtered to the
 * configured class -- `wbsearchentities` happily returns an album called "The
 * Matrix" above the film, and that album has no `P31` edge to `Q11424`.
 */
type PageSelector =
  | { readonly mode: "keyset"; readonly afterNumericId: number; readonly limit: number }
  | { readonly mode: "identified"; readonly itemIds: readonly string[] };

const renderSelector = (classQid: string, selector: PageSelector): string => {
  const header = `      VALUES ?kind { wd:${classQid} }`;
  if (selector.mode === "identified") {
    const values = selector.itemIds.map((id) => `wd:${id}`).join(" ");
    return [
      "  { SELECT DISTINCT ?item ?n ?kind WHERE {",
      header,
      `      VALUES ?item { ${values} }`,
      `      ?item wdt:${WIKIDATA_PROPERTIES.instanceOf} ?kind .`,
      '      BIND(xsd:integer(STRAFTER(STR(?item), "/entity/Q")) AS ?n)',
      "    } }"
    ].join("\n");
  }
  return [
    "  { SELECT DISTINCT ?item ?n ?kind WHERE {",
    header,
    `      ?item wdt:${WIKIDATA_PROPERTIES.instanceOf} ?kind .`,
    '      BIND(xsd:integer(STRAFTER(STR(?item), "/entity/Q")) AS ?n)',
    `      FILTER(?n > ${String(selector.afterNumericId)})`,
    `    } ORDER BY ?n LIMIT ${String(selector.limit)} }`
  ].join("\n");
};

/**
 * The page query.
 *
 * THE KEYSET IS ON THE ITEM ID, NOT AN OFFSET, and that is the port's rule
 * (`provider.ts`: "an offset over a collection the provider is concurrently
 * editing skips and repeats records"). Wikidata is edited continuously, so an
 * `OFFSET` walk would do exactly that. The numeric part of a QID is immutable
 * and assigned monotonically, so `?n > watermark ORDER BY ?n` is a stable
 * enumeration: an item created during the pass sorts after everything already
 * read, and an item deleted during the pass simply does not appear.
 *
 * THE SUBQUERY IS WHAT MAKES THE OUTER JOINS CHEAP. Ordering 349,000 films and
 * then joining their labels and genres is a 30-second query; ordering them,
 * taking 50, and joining the labels of those 50 is a two-second one. Both were
 * measured against the live endpoint on 2026-09-17; the numbers are in
 * `docs/CATALOG_SOURCE.md`.
 *
 * `runtimeMinutes` GOES THROUGH THE FULL STATEMENT AND CHECKS THE UNIT.
 * `wdt:P2047` gives a bare number, and `P2047` is stated in seconds on some
 * items and in hours on others, so a truncated-value read would record a
 * 5400-minute film. The `psv:` path with `wikibase:quantityUnit wd:Q7727` reads
 * only the statements that say minutes; everything else contributes nothing and
 * the field ends up absent, which the schema refuses by name rather than
 * silently accepting a wrong number.
 *
 * `MIN(?year)` for the release year, because `P577` carries a publication date
 * per territory and per festival and the earliest is the one a catalog means by
 * "released". `SAMPLE` for the quantities, because a work with two contradictory
 * runtimes has a data problem this adapter cannot adjudicate and picking the
 * first is at least deterministic under `ORDER BY ?n`.
 */
export function buildPageQuery(
  classQid: string,
  locales: readonly LanguageTag[],
  selector: PageSelector
): string {
  const languages = languageFilterList(locales);
  const unit = UNIT_SEPARATOR_SPARQL;
  const record = RECORD_SEPARATOR_SPARQL;
  const properties = WIKIDATA_PROPERTIES;

  return [
    "SELECT ?item ?n",
    `  (GROUP_CONCAT(DISTINCT ?titleTag; separator="${unit}") AS ?titles)`,
    `  (GROUP_CONCAT(DISTINCT ?synopsisTag; separator="${unit}") AS ?synopses)`,
    `  (GROUP_CONCAT(DISTINCT ?genreTag; separator="${unit}") AS ?genres)`,
    "  (MIN(?year) AS ?releaseYear)",
    "  (SAMPLE(?minutes) AS ?runtimeMinutes)",
    "  (SAMPLE(?episodes) AS ?episodeCount)",
    `  (GROUP_CONCAT(DISTINCT ?imdb; separator="${unit}") AS ?imdbIds)`,
    `  (GROUP_CONCAT(DISTINCT ?copyrightQid; separator="${unit}") AS ?copyrightStatuses)`,
    "WHERE {",
    renderSelector(classQid, selector),
    `  OPTIONAL { ?item rdfs:label ?label . FILTER(LANG(?label) IN (${languages}))`,
    `             BIND(CONCAT(LANG(?label), "${record}", STR(?label)) AS ?titleTag) }`,
    `  OPTIONAL { ?item schema:description ?description . FILTER(LANG(?description) IN (${languages}))`,
    `             BIND(CONCAT(LANG(?description), "${record}", STR(?description)) AS ?synopsisTag) }`,
    `  OPTIONAL { ?item wdt:${properties.genre} ?genreItem . ?genreItem rdfs:label ?genreLabel .`,
    `             FILTER(LANG(?genreLabel) IN (${languages}))`,
    `             BIND(CONCAT(LANG(?genreLabel), "${record}", STR(?genreLabel)) AS ?genreTag) }`,
    `  OPTIONAL { ?item wdt:${properties.publicationDate} ?published . BIND(YEAR(?published) AS ?year) }`,
    `  OPTIONAL { ?item p:${properties.duration}/psv:${properties.duration} ?durationValue .`,
    `             ?durationValue wikibase:quantityAmount ?minutes ; wikibase:quantityUnit wd:${UNIT_MINUTE} . }`,
    `  OPTIONAL { ?item wdt:${properties.numberOfEpisodes} ?episodes }`,
    `  OPTIONAL { ?item wdt:${properties.imdbId} ?imdb }`,
    `  OPTIONAL { ?item wdt:${properties.copyrightStatus} ?copyrightItem .`,
    '             BIND(STRAFTER(STR(?copyrightItem), "/entity/") AS ?copyrightQid) }',
    "}",
    "GROUP BY ?item ?n",
    "ORDER BY ?n"
  ].join("\n");
}

/**
 * Whether a query text contains a federated `SERVICE` call.
 *
 * Exported so the rule in this module's header is a test rather than a promise.
 * Word-bounded and case-insensitive: SPARQL keywords are case-insensitive, and
 * an unanchored substring search would fire on the word "service" inside a
 * label filter.
 */
export function containsServiceClause(query: string): boolean {
  return /\bSERVICE\b/i.test(query);
}

export type QueryBuildRefusal =
  | "class_id_outside_cc0_namespace"
  | "entity_id_outside_cc0_namespace"
  | "no_locales_requested"
  | "locale_not_a_language_tag"
  | "page_size_not_a_positive_integer"
  | "cursor_not_a_provider_issued_watermark";

export type QueryBuild =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly reason: QueryBuildRefusal; readonly detail: string };

const checkLocales = (
  locales: readonly string[]
): { readonly ok: true; readonly locales: readonly LanguageTag[] } | { readonly ok: false; readonly reason: QueryBuildRefusal; readonly detail: string } => {
  if (locales.length === 0) {
    return { ok: false, reason: "no_locales_requested", detail: "at least one locale is required" };
  }
  const parsed = z.array(languageTagSchema).safeParse(locales);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "locale_not_a_language_tag",
      detail: parsed.error.issues.map((issue) => issue.path.join(".") || "(root)").join(", ")
    };
  }
  return { ok: true, locales: parsed.data };
};

const sparqlUrl = (query: string): string => {
  const url = new URL(WIKIDATA_SPARQL_ENDPOINT);
  url.searchParams.set("query", query);
  url.searchParams.set("format", "json");
  return url.toString();
};

/**
 * The URL for one enumeration page.
 *
 * `afterNumericId` is the watermark the previous page issued. `0` starts at the
 * beginning; `Q1` is the lowest possible item, and `?n > 0` therefore includes
 * it.
 */
export function buildPageRequestUrl(
  classQid: string,
  locales: readonly string[],
  afterNumericId: number,
  pageSize: number
): QueryBuild {
  if (!CC0_ITEM_ID_PATTERN.test(classQid)) {
    return {
      ok: false,
      reason: "class_id_outside_cc0_namespace",
      detail: "a class must be a Wikidata item id in the main namespace"
    };
  }
  const checked = checkLocales(locales);
  if (!checked.ok) return checked;
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0) {
    return {
      ok: false,
      reason: "page_size_not_a_positive_integer",
      detail: `received ${String(pageSize)}`
    };
  }
  if (!Number.isSafeInteger(afterNumericId) || afterNumericId < 0) {
    return {
      ok: false,
      reason: "cursor_not_a_provider_issued_watermark",
      detail: `received ${String(afterNumericId)}`
    };
  }
  return {
    ok: true,
    url: sparqlUrl(
      buildPageQuery(classQid, checked.locales, {
        mode: "keyset",
        afterNumericId,
        limit: pageSize
      })
    )
  };
}

/**
 * The URL that hydrates a named set of items.
 *
 * Used by search: `wbsearchentities` answers ids, and the records themselves
 * come back through the SAME query the enumeration uses, so a searched record
 * and a paged record are built by one code path and cannot diverge in what they
 * carry or in what the rights and safety checks see.
 */
export function buildHydrationRequestUrl(
  classQid: string,
  locales: readonly string[],
  itemIds: readonly string[]
): QueryBuild {
  if (!CC0_ITEM_ID_PATTERN.test(classQid)) {
    return {
      ok: false,
      reason: "class_id_outside_cc0_namespace",
      detail: "a class must be a Wikidata item id in the main namespace"
    };
  }
  const checked = checkLocales(locales);
  if (!checked.ok) return checked;
  for (const id of itemIds) {
    if (!CC0_ITEM_ID_PATTERN.test(id)) {
      return {
        ok: false,
        reason: "entity_id_outside_cc0_namespace",
        detail: "an item id outside the main namespace was offered for hydration"
      };
    }
  }
  return {
    ok: true,
    url: sparqlUrl(
      buildPageQuery(classQid, checked.locales, { mode: "identified", itemIds })
    )
  };
}

/**
 * The URL for one page of `wbsearchentities`.
 *
 * THE TERM IS NOT INTERPOLATED INTO ANYTHING. It is set with
 * `URLSearchParams.set`, which percent-encodes it, and it never reaches the
 * SPARQL endpoint -- so the free-text input and the query language never meet.
 *
 * `type=item` restricts the answer to the main namespace. The class filter is
 * applied afterwards, by the hydration query, because `wbsearchentities` has no
 * way to express it.
 */
export function buildSearchRequestUrl(
  term: string,
  locale: string,
  offset: number,
  pageSize: number
): QueryBuild {
  const checked = checkLocales([locale]);
  if (!checked.ok) return checked;
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0) {
    return {
      ok: false,
      reason: "page_size_not_a_positive_integer",
      detail: `received ${String(pageSize)}`
    };
  }
  if (!Number.isSafeInteger(offset) || offset < 0) {
    return {
      ok: false,
      reason: "cursor_not_a_provider_issued_watermark",
      detail: `received ${String(offset)}`
    };
  }
  const url = new URL(WIKIDATA_ACTION_API_ENDPOINT);
  url.searchParams.set("action", "wbsearchentities");
  url.searchParams.set("format", "json");
  url.searchParams.set("formatversion", "2");
  url.searchParams.set("search", term);
  url.searchParams.set("language", locale);
  url.searchParams.set("uselang", locale);
  url.searchParams.set("type", "item");
  url.searchParams.set("limit", String(pageSize));
  url.searchParams.set("continue", String(offset));
  return { ok: true, url: url.toString() };
}
