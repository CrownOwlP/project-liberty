import {
  fetchManifestText,
  type EgressPolicy,
  type ManifestFetchDependencies,
  type ManifestFetchFailure
} from "@liberty/media-inspection";

/* -------------------------------------------------------------------------
 * The only way this package may touch the network
 *
 * THERE IS NO `fetch` IN THIS PACKAGE AND THERE MUST NOT BE ONE. Ingestion is
 * untrusted third-party I/O -- a catalog provider's response is a document from
 * a machine we do not administer, reached over a name we did not choose -- and
 * PL-0304 already built the boundary for exactly that shape of request. This
 * module is a thin adapter onto it, NOT a second one.
 *
 * WHAT IS REUSED, AND WHY IT IS REUSED RATHER THAN REBUILT. `fetchManifestText`
 * in `@liberty/media-inspection` carries four controls this path needs
 * identically, and each of them took review rounds to get right:
 *
 *   - AN EGRESS ALLOWLIST THAT FAILS CLOSED. A host not named in the operator's
 *     `EgressPolicy.allowedHosts` is not fetchable, and an EMPTY allowlist
 *     fetches nothing. A missing configuration is an outage, not an open proxy.
 *   - DNS RESOLVED AND PRIVATE RANGES REJECTED BEFORE THE SOCKET, with EVERY
 *     resolved address checked rather than the first, and the surviving
 *     addresses carried forward as a `PinnedTarget` so nothing resolves the name
 *     a second time. That is what closes the DNS-rebinding window; a
 *     reimplementation that called `fetch` on the URL would reopen it silently,
 *     because every other check would still pass.
 *   - A BOUNDED BODY, metered incrementally rather than trusted from
 *     `Content-Length`.
 *   - REDIRECTS RE-AUTHORISED AT EVERY HOP, against the same policy, with the
 *     deadline spanning the whole chain.
 *
 * Writing any of that again here would produce a second SSRF filter to keep in
 * agreement with the first, and the one nobody updates is the one that decides.
 *
 * THE NAME `fetchManifestText` IS ABOUT ITS FIRST CALLER, NOT ITS CONTENTS.
 * Its own header describes it as fetching "ONE document, of bounded size, within
 * one deadline, over a redirect chain" -- there is nothing HLS- or DASH-specific
 * in it, and it returns text rather than a parsed manifest. Stated here because
 * reusing a function whose name names somebody else's domain deserves an
 * explanation rather than a shrug; the alternative reading, that a catalog
 * fetcher should have its own copy, is the one this comment rejects.
 *
 * WHAT IS NOT REUSED: the transport. `deps.fetchImpl` is a `PinnedFetch` and the
 * caller supplies it. A Node deployment passes
 * `@liberty/media-inspection/node/pinned-fetch`; this package deliberately does
 * not import that subpath, so nothing here drags `node:https` into a module
 * graph, and a composition root has to say which runtime it is composing for.
 * ---------------------------------------------------------------------- */

/**
 * Limits for a catalog document, distinct from a manifest's and larger.
 *
 * A manifest is a playlist; a catalog page is a page of records, so the cap is
 * set for the second. These numbers are a DEFAULT and not a policy -- they are
 * exported so an operator can see what they are and override them, and
 * `fetchCatalogDocument` takes them as an argument rather than reading them from
 * here, so an override cannot be defeated by a module-scope read.
 *
 * `maxRedirects` is 3 rather than 0 because content APIs genuinely redirect
 * (apex to www, http to https, versioned path moves) and rather than 20 because
 * a long chain against a re-authorising gate is just a slow way to spend a
 * deadline. Every hop is re-authorised, so the number bounds cost rather than
 * exposure.
 */
export const CATALOG_DOCUMENT_LIMITS = {
  timeoutMs: 10_000,
  maxResponseBytes: 4_000_000,
  maxRedirects: 3
} as const;

export interface CatalogDocumentOptions {
  readonly egress: EgressPolicy;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly maxRedirects: number;
  /**
   * Identifies this client to the provider.
   *
   * REQUIRED, with no default, because several metadata sources make it a
   * condition of access rather than a courtesy -- Wikimedia's User-Agent policy
   * says scripts "should use an informative User-Agent string with contact
   * information, or they may be IP-blocked without notice", and explicitly
   * forbids impersonating a browser. A default here would be a string this
   * package chose on an operator's behalf and attached their contact reputation
   * to. See `docs/CATALOG_SOURCE.md`.
   */
  readonly userAgent: string;
}

/**
 * Everything that can go wrong, including everything the egress gate can say.
 *
 * `ManifestFetchFailure` is spread in rather than remapped. A rejection reason
 * that is rewritten on the way out eventually stops matching what the code did,
 * and `url_host_not_on_egress_allowlist` is exactly the string an operator needs
 * to see to know the remedy is an allowlist entry.
 */
export type CatalogDocumentFailure = ManifestFetchFailure | "document_not_json";

export type CatalogDocumentResult =
  | {
      readonly ok: true;
      /** `unknown` on purpose: this is the parse boundary, not past it. */
      readonly document: unknown;
      readonly finalUrl: string;
      readonly elapsedMs: number;
    }
  | {
      readonly ok: false;
      readonly reason: CatalogDocumentFailure;
      readonly detail: string;
      readonly elapsedMs: number;
    };

/**
 * One catalog document, through the PL-0304 egress boundary.
 *
 * Returns `unknown`. A typed return would be an assertion about a payload
 * nobody has validated, and every field access after it would compile while
 * being a lie; `ingest.ts` parses with zod and refuses what does not fit.
 *
 * The JSON parse error is NOT reported. `JSON.parse` puts a slice of the input
 * in its message, the input here is a third party's response body, and an error
 * string is not a place to accumulate one. What is kept is the length, which is
 * the part anybody debugging actually uses.
 */
export async function fetchCatalogDocument(
  url: string,
  options: CatalogDocumentOptions,
  deps: ManifestFetchDependencies
): Promise<CatalogDocumentResult> {
  const fetched = await fetchManifestText(
    url,
    {
      egress: options.egress,
      timeoutMs: options.timeoutMs,
      maxResponseBytes: options.maxResponseBytes,
      maxRedirects: options.maxRedirects,
      userAgent: options.userAgent
    },
    deps
  );

  if (!fetched.ok) {
    return {
      ok: false,
      reason: fetched.reason,
      detail: fetched.detail,
      elapsedMs: fetched.elapsedMs
    };
  }

  let document: unknown;
  try {
    document = JSON.parse(fetched.text);
  } catch {
    return {
      ok: false,
      reason: "document_not_json",
      detail: `a ${fetched.text.length} byte body did not parse as JSON`,
      elapsedMs: fetched.elapsedMs
    };
  }

  return { ok: true, document, finalUrl: fetched.finalUrl, elapsedMs: fetched.elapsedMs };
}
