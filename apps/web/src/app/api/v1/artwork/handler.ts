import {
  ARTWORK_MAX_BYTES,
  artworkCandidates,
  identifyArtworkBytes,
  resolveArtworkStore,
  type ArtworkMediaType
} from "./store";

/* -------------------------------------------------------------------------
 * The HTTP half of GET /api/v1/artwork/{assetRef} (PW-0302)
 *
 * SEPARATED FROM `route.ts` FOR THE REASON `catalog/home/handler.ts` GIVES: a
 * Next route module may export only the handlers and a fixed set of segment
 * config values, so a route file has nowhere to accept an injected dependency
 * and testing one means testing whatever filesystem and environment the suite
 * happens to run on. This module takes the environment value and a reader port,
 * so every branch -- including the two misconfiguration branches and the
 * ambiguous-store branch -- is reachable from a unit test that touches neither.
 *
 * WHAT "AUTHORIZED" MEANS HERE, stated plainly because the word carries two
 * readings and only one of them is true of this boundary.
 *
 * It is OPERATOR-authorized: the only references that resolve are the ones whose
 * bytes an operator put in the configured directory. Nothing here mints,
 * guesses, or derives a reference, and a reference that is not in the store is a
 * 404 whatever the caller is.
 *
 * It is NOT user-authorized, and that is deliberate rather than an omission.
 * Artwork illustrates catalog metadata, `GET /api/v1/catalog/home` requires no
 * session, and a poster behind an authentication gate the payload naming it does
 * not have would produce a signed-out browse page of broken images -- a worse
 * outcome with no secret protected, because the metadata the image illustrates
 * was already served. The rule this boundary follows is therefore stated as a
 * relationship rather than as a constant: THIS ENDPOINT IS EXACTLY AS OPEN AS
 * THE CATALOG SURFACE THAT NAMES ITS REFERENCES. If the catalog surface gains a
 * session requirement, this inherits it in the same change, and the reference
 * being unguessable is not treated as protection in the meantime.
 * ---------------------------------------------------------------------- */

/**
 * Why a request did not produce bytes.
 *
 * Codes, not sentences, for the reason the profile and playback contracts give:
 * a consumer that decides anything by matching prose turns a reworded message
 * into a behaviour change nothing can see. `detail` beside it is for humans and
 * is never parsed.
 */
export type ArtworkRefusalReason =
  | "artwork_store_not_configured"
  | "artwork_store_not_absolute"
  | "artwork_reference_malformed"
  | "artwork_not_found"
  | "artwork_reference_ambiguous"
  | "artwork_asset_too_large"
  | "artwork_media_type_unrecognised"
  | "artwork_store_unreadable";

/**
 * How each refusal is answered on the wire.
 *
 * Three groups, and the split is the one this application already draws:
 *
 *   - 400 is the caller's problem. Only `artwork_reference_malformed` is, and it
 *     is barely reachable through the product, because `artworkPathFor` refuses
 *     to build a path for a reference the pattern rejects. It is reachable by
 *     typing a URL, which is the case it exists for.
 *   - 404 is "this store does not hold that". The ONLY 404 here, and it does not
 *     distinguish "no such reference anywhere" from "not in this store", because
 *     there is nothing else it could mean: the store is the whole authority.
 *   - 503 is "this deployment is missing a dependency", which is what the
 *     profile, progress, watchlist and catalog routes already answer for an
 *     unconfigured one. Both store-configuration refusals are 503.
 *   - 500 is a fault on this side of the boundary that the caller cannot act on:
 *     a store holding two files for one reference, an asset over the cap, bytes
 *     that are not an image this boundary serves, or a directory that would not
 *     read. Every one of those is an operator defect with a specific remedy, and
 *     none of them is the request's fault.
 */
const REFUSAL_STATUS: Readonly<Record<ArtworkRefusalReason, number>> = {
  artwork_store_not_configured: 503,
  artwork_store_not_absolute: 503,
  artwork_reference_malformed: 400,
  artwork_not_found: 404,
  artwork_reference_ambiguous: 500,
  artwork_asset_too_large: 500,
  artwork_media_type_unrecognised: 500,
  artwork_store_unreadable: 500
};

export function artworkRefusalStatus(reason: ArtworkRefusalReason): number {
  return REFUSAL_STATUS[reason];
}

/**
 * The filesystem, as this handler needs it.
 *
 * TWO OPERATIONS, AND THE SPLIT IS THE SIZE CAP. `size` answers "does this exist
 * and how big is it" without reading anything, so an oversized asset is refused
 * BEFORE its bytes are in this process's memory -- which is the only ordering
 * under which `ARTWORK_MAX_BYTES` is a protection rather than a report. A single
 * `read` port would have had to read the file to find out it was too big.
 *
 * `size` answers `null` for a path that does not exist, and THROWS for a
 * directory that cannot be read at all. That is the split `CatalogMetadataSource`
 * documents and the reason it is worth repeating: "there is no such file" and
 * "this store did not answer" have opposite remedies, and a port that collapsed
 * them would report a permissions problem as a missing poster.
 */
export interface ArtworkReader {
  size(path: string): Promise<number | null>;
  read(path: string): Promise<Uint8Array>;
}

export interface ArtworkResolution {
  readonly bytes: Uint8Array;
  readonly mediaType: ArtworkMediaType;
}

export type ArtworkOutcome =
  | { readonly ok: true; readonly resolution: ArtworkResolution }
  | { readonly ok: false; readonly reason: ArtworkRefusalReason; readonly detail: string };

/**
 * Resolve one reference against the configured store.
 *
 * The whole decision, with no `Response` in it, so a test can assert the outcome
 * rather than parse one.
 */
export async function resolveArtwork(
  storeSetting: string | undefined,
  assetRef: string,
  reader: ArtworkReader
): Promise<ArtworkOutcome> {
  const store = resolveArtworkStore(storeSetting);
  if (!store.ok) {
    return store.reason === "not_configured"
      ? {
          ok: false,
          reason: "artwork_store_not_configured",
          detail: "this deployment has no artwork store; set LIBERTY_ARTWORK_STORE to an absolute directory"
        }
      : {
          ok: false,
          reason: "artwork_store_not_absolute",
          detail: "LIBERTY_ARTWORK_STORE must name an absolute directory; a relative path means a different directory in each of this product's three run modes"
        };
  }

  const candidates = artworkCandidates(store.directory, assetRef);
  if (candidates === null) {
    return {
      ok: false,
      reason: "artwork_reference_malformed",
      detail: "an artwork reference is a lower-case opaque token; this one is not"
    };
  }

  let present: { path: string; size: number } | null = null;
  let presentCount = 0;
  for (const candidate of candidates) {
    let size: number | null;
    try {
      size = await reader.size(candidate.path);
    } catch (cause) {
      return {
        ok: false,
        reason: "artwork_store_unreadable",
        detail: `the artwork store did not answer for this reference: ${describe(cause)}`
      };
    }
    if (size === null) continue;
    presentCount += 1;
    if (present === null) present = { path: candidate.path, size };
  }

  if (present === null) {
    return {
      ok: false,
      reason: "artwork_not_found",
      detail: "this artwork store holds no asset under that reference"
    };
  }
  if (presentCount > 1) {
    return {
      ok: false,
      reason: "artwork_reference_ambiguous",
      detail: `${presentCount} files in the artwork store match this reference; a reference names one asset, so remove all but one`
    };
  }
  if (present.size > ARTWORK_MAX_BYTES) {
    return {
      ok: false,
      reason: "artwork_asset_too_large",
      detail: `this asset is ${present.size} bytes; the artwork boundary serves at most ${ARTWORK_MAX_BYTES}`
    };
  }

  let bytes: Uint8Array;
  try {
    bytes = await reader.read(present.path);
  } catch (cause) {
    return {
      ok: false,
      reason: "artwork_store_unreadable",
      detail: `the artwork store did not answer for this reference: ${describe(cause)}`
    };
  }

  /*
   * THE HEADER DECIDES THE CONTENT TYPE, NOT THE FILENAME.
   *
   * The extension selected which file to look at; it says nothing about what is
   * in it. A `.png` holding JPEG bytes is served as `image/jpeg` rather than
   * refused, because that response is TRUE and a refusal would break a page over
   * a naming mistake that harms nobody. A file holding something that is not one
   * of the four allowed raster formats is refused, because there is no true
   * content type this boundary is willing to state for it -- that branch is what
   * keeps an SVG, an HTML document or an executable unservable from this origin
   * regardless of what it was named.
   */
  const mediaType = identifyArtworkBytes(bytes);
  if (mediaType === null) {
    return {
      ok: false,
      reason: "artwork_media_type_unrecognised",
      detail: "this asset is not one of the raster image formats the artwork boundary serves"
    };
  }

  return { ok: true, resolution: { bytes, mediaType } };
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Headers every served asset carries.
 *
 * `cache-control` IS NOT `no-store` HERE, and this is the one place in this
 * application's API that departs from `docs/API_CONTRACTS.md`'s blanket rule --
 * deliberately, and the doc now records the exception. The rule exists so a JSON
 * answer about mutable state is never served from a cache that outlives the
 * state; an artwork asset is immutable content addressed by an opaque reference,
 * and forbidding its cache would re-fetch every poster on every rail on every
 * navigation. REFUSALS are still `no-store`: a 503 from a deployment with no
 * store configured must not outlive the configuration that caused it.
 *
 * `nosniff` because a browser that sniffs its own content type would undo the
 * identification this handler just performed. `default-src 'none'; sandbox`
 * because an asset should not be a document even if something one day serves one
 * -- defence for the branch that is currently unreachable. `same-origin` on the
 * resource policy because nothing outside this product has a reason to embed an
 * operator's licensed artwork, and the licence it is carried under is very often
 * the reason.
 */
export function artworkAssetHeaders(mediaType: ArtworkMediaType, byteLength: number): HeadersInit {
  return {
    "content-type": mediaType,
    "content-length": String(byteLength),
    "cache-control": "public, max-age=3600",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "cross-origin-resource-policy": "same-origin"
  };
}

/**
 * The outcome, as a response.
 *
 * A REFUSAL IS NEVER AN EMPTY BODY -- `docs/API_CONTRACTS.md` states that for
 * every route in this application, and an image endpoint is where it is most
 * tempting to break it, because the client rendering the result is an `<img>`
 * that will not read the body. The body is not for the `<img>`; it is for the
 * operator with `curl` trying to find out why the posters are gradients, and
 * that is precisely the person a bare 404 strands.
 */
export function artworkResponse(outcome: ArtworkOutcome): Response {
  if (outcome.ok) {
    const { bytes, mediaType } = outcome.resolution;
    return new Response(toBody(bytes), {
      status: 200,
      headers: artworkAssetHeaders(mediaType, bytes.byteLength)
    });
  }
  return new Response(JSON.stringify({ error: outcome.reason, detail: outcome.detail }), {
    status: artworkRefusalStatus(outcome.reason),
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}

/**
 * `Uint8Array` is not itself a `BodyInit` under this repository's TypeScript
 * configuration, because a `Uint8Array` may be backed by a `SharedArrayBuffer`
 * and a response body may not. Copying into a fresh, exactly-sized view is the
 * narrowing that makes the type true rather than asserted, and it also detaches
 * the response from a buffer the reader may reuse.
 */
function toBody(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}
