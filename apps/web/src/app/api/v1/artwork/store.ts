import { ARTWORK_ASSET_REF_PATTERN } from "@liberty/contracts/shared/artwork";

/* -------------------------------------------------------------------------
 * The artwork resolution boundary's policy (PW-0302)
 *
 * THIS IS THE ONLY PLACE IN THE PRODUCT WHERE AN ARTWORK ORIGIN EXISTS, and it
 * is worth being precise about what that sentence means, because the obvious
 * reading of "resolution boundary" is a proxy and this is deliberately not one.
 *
 * A catalog or title payload carries an OPAQUE REFERENCE -- see
 * `@liberty/contracts/shared/artwork`, which has no url, uri, src, href or
 * origin field and constrains a reference so that none can be spelled inside
 * one. A client turns that reference into a request to THIS application, at a
 * path this module builds. This module turns it into a file in a directory the
 * OPERATOR configured. At no point does a client-supplied value become part of
 * an address this server fetches, because at no point does this server fetch an
 * address at all: there is no HTTP client in this boundary, no URL parsing and
 * no host. `docs/SECURITY.md`'s "never proxy arbitrary client-provided URLs" is
 * therefore not weakened for pictures -- it is satisfied by absence rather than
 * by a check, which is the difference between a rule and a property.
 *
 * WHY A FILESYSTEM STORE AND NOT AN UPSTREAM CDN. Because there is no licensed
 * provider. PL-0302 and PL-0602 are BLOCKED on exactly that, so an upstream
 * artwork origin is a capability this product does not have, and building the
 * transport allowlist, the fetch client, the redirect policy and the upstream
 * failure vocabulary that one would need would be machinery for a boundary
 * nothing can cross. It would also be the moment "no arbitrary URL proxy" stops
 * being a property and becomes a rule somebody maintains. When a real provider
 * arrives, the honest shape of that change is a SECOND store kind behind this
 * same resolution, with its own allowlist and its own review -- not a URL field
 * on a payload. That is stated here so the next person reaches for the right
 * one.
 *
 * NOTHING IN THIS MODULE READS `process.env`. Every function takes what it
 * needs, so the whole policy is reachable from a unit test without mutating the
 * environment -- the rule `catalog/home/handler.ts` and `build-target.ts`
 * already follow in this application.
 * ---------------------------------------------------------------------- */

/**
 * The operator's artwork directory. READ IN `route.ts` AND NOWHERE ELSE.
 *
 * One variable, naming one directory, because the store is one directory. An
 * operator who wants artwork served configures it; one who does not gets a
 * product whose posters are the designed gradient, which is a complete state
 * and not a broken one.
 */
export const ARTWORK_STORE_ENV_VAR = "LIBERTY_ARTWORK_STORE";

/**
 * The path prefix the boundary answers on.
 *
 * Exported so the artwork component builds its `src` from the boundary's own
 * declaration rather than from a string typed a second time in a component. That
 * is what makes "the client can only express this origin" structural: there is
 * one function in the repository that turns a reference into a URL, it lives
 * beside the handler that serves it, and it emits a relative path.
 */
export const ARTWORK_ROUTE_PREFIX = "/api/v1/artwork/";

/**
 * The URL a client uses to fetch one reference.
 *
 * RELATIVE, WITH NO ORIGIN, and that is the security property rather than a
 * style choice. A relative path resolves against the document's own origin, so
 * the returned value cannot name a host no matter what the reference contains --
 * and the reference cannot contain a host anyway, because
 * `ARTWORK_ASSET_REF_PATTERN` excludes `:`, `/` and `.`. Two independent reasons
 * the same arbitrary-host outcome is unreachable, which is the level of
 * redundancy a media address deserves.
 *
 * Refuses rather than emitting a path for a reference that does not match the
 * pattern. A caller holding a malformed reference has a data problem, and the
 * failure that helps is the one at the point the bad value appears, not a 400
 * from the server later.
 */
export function artworkPathFor(assetRef: string): string | null {
  if (!ARTWORK_ASSET_REF_PATTERN.test(assetRef)) return null;
  return `${ARTWORK_ROUTE_PREFIX}${assetRef}`;
}

/**
 * The image formats this boundary will serve, and the file extensions each one
 * is stored under.
 *
 * AN ALLOWLIST, AND SVG IS NOT ON IT. An SVG is a document: it can carry script,
 * external references and foreign content, and serving one from this origin
 * would hand an operator's asset pipeline a stored-XSS surface on the product's
 * own domain. The four raster formats below cannot execute. `next.config.ts`
 * sets `dangerouslyAllowSVG: false` as well, so the framework's optimizer agrees
 * with this module even though this task's UI does not use it.
 *
 * `jpg` and `jpeg` both map to `image/jpeg` because both spellings are in
 * ordinary use and an operator should not have to learn which one this product
 * prefers. They are two names for one format, not two candidates -- see
 * `artworkCandidates` for why that distinction is load-bearing.
 */
export const ARTWORK_MEDIA_TYPES = {
  avif: "image/avif",
  webp: "image/webp",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg"
} as const satisfies Readonly<Record<string, string>>;

export type ArtworkExtension = keyof typeof ARTWORK_MEDIA_TYPES;
export type ArtworkMediaType = (typeof ARTWORK_MEDIA_TYPES)[ArtworkExtension];

/** The extensions, in a fixed order, so candidate lists are deterministic. */
export const ARTWORK_EXTENSIONS = Object.keys(ARTWORK_MEDIA_TYPES) as readonly ArtworkExtension[];

/**
 * The largest asset this boundary will read into memory and serve.
 *
 * A cap exists because the handler reads a whole file before it can identify the
 * format, and an unbounded read of an operator-writable directory is a way to
 * exhaust a server's memory with one request. 8 MiB is far above any poster and
 * far below anything that hurts: a 2000x3000 JPEG at high quality is under 2 MB.
 * An asset over the cap is a misconfigured store and is reported as one rather
 * than truncated, because half an image served as a whole one is a corruption
 * the client cannot detect.
 */
export const ARTWORK_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Where the store is, or why there is no store.
 *
 * `not_configured` and `not_absolute` are separate because they have different
 * remedies and an operator needs to know which one they have: the first means
 * nobody set the variable, the second means somebody set it to something this
 * boundary refuses to interpret.
 */
export type ArtworkStoreResolution =
  | { readonly ok: true; readonly directory: string }
  | { readonly ok: false; readonly reason: "not_configured" | "not_absolute" };

/**
 * Resolve the configured store directory.
 *
 * ABSOLUTE PATHS ONLY, and a relative one is REFUSED rather than resolved
 * against the working directory. `next dev` runs from `apps/web`, `next start`
 * on a standalone build runs from the emitted server directory, and the desktop
 * sidecar runs from wherever the installer put it -- so the same relative
 * setting names three different directories on three machines, and the failure
 * mode is silent: a store that resolves to a directory that does not exist looks
 * exactly like a store with no matching asset. Refusing is how that becomes a
 * message instead of a missing poster.
 *
 * Accepts a POSIX absolute path or a Windows drive-absolute one, because this
 * product ships on Windows and `D:\liberty\artwork` is what an operator there
 * will type. A UNC path (`\\server\share`) is absolute too and is accepted by
 * the same rule; whether the process can read it is a question for the
 * filesystem, not for this function.
 */
export function resolveArtworkStore(value: string | undefined): ArtworkStoreResolution {
  const trimmed = (value ?? "").trim();
  if (trimmed === "") return { ok: false, reason: "not_configured" };
  const absolute = trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith("\\\\");
  if (!absolute) return { ok: false, reason: "not_absolute" };
  return { ok: true, directory: trimmed };
}

/** One place the boundary will look for one reference. */
export interface ArtworkCandidate {
  readonly path: string;
  readonly extension: ArtworkExtension;
  readonly mediaType: ArtworkMediaType;
}

/**
 * Every file that could hold this reference.
 *
 * THE JOIN IS A PLAIN CONCATENATION AND THAT IS SAFE BY CONSTRUCTION, not by
 * sanitisation. `ARTWORK_ASSET_REF_PATTERN` admits only lower-case letters,
 * digits and single hyphens: no `/`, no `\`, no `.`, no `%`, no `:`, no NUL. So
 * there is no reference that escapes the directory, none that names a parent,
 * none that percent-decodes into one later, and none that differs from another
 * only by case. A `path.join` with a traversal check would be the same result
 * reached by inspection instead of by construction, and inspection is what gets
 * refactored away.
 *
 * The caller has already validated the reference -- `artworkCandidates` refuses
 * an invalid one rather than trusting that, because this function is the last
 * thing standing between a URL path segment and a filesystem path.
 *
 * WHY THIS RETURNS EVERY CANDIDATE RATHER THAN THE FIRST MATCH. A store maps one
 * reference to ONE file. If two exist -- `poster.avif` and `poster.png` -- the
 * store is ambiguous, and the two ways to resolve that silently are both wrong:
 * picking by a fixed extension order serves a format the requesting browser may
 * not decode, and picking by `Accept` makes this boundary a content negotiator
 * with a cache-key problem. Reporting the ambiguity is the honest third option,
 * and it is a defect an operator can fix in a second. `jpg` and `jpeg` are the
 * one pair that is not ambiguous in principle but is in practice, and they are
 * treated the same way: two files, one reference, still a store to fix.
 */
export function artworkCandidates(
  directory: string,
  assetRef: string
): readonly ArtworkCandidate[] | null {
  if (!ARTWORK_ASSET_REF_PATTERN.test(assetRef)) return null;
  const separator = directory.endsWith("/") || directory.endsWith("\\") ? "" : "/";
  return ARTWORK_EXTENSIONS.map((extension) => ({
    path: `${directory}${separator}${assetRef}.${extension}`,
    extension,
    mediaType: ARTWORK_MEDIA_TYPES[extension]
  }));
}

/**
 * The format the bytes actually are, read from their own header.
 *
 * WHY THE EXTENSION IS NOT TRUSTED. The extension is what somebody named the
 * file; the header is what the file is. Serving `poster.png` as `image/png` when
 * it is in fact an HTML document would be a content-type confusion on this
 * product's own origin, and `nosniff` protects the browser from acting on the
 * mislabel only because the label is at least refused elsewhere. Reading eight
 * bytes to answer "is this one of four raster formats" is cheap and turns the
 * response's `content-type` from a restatement of a filename into a claim this
 * server checked.
 *
 * The four signatures:
 *   PNG  -- the eight-byte signature, which includes the CRLF/EOF pair that
 *           exists to detect a corrupting text-mode transfer.
 *   JPEG -- SOI followed by any marker introducer.
 *   WebP -- a RIFF container whose form type is `WEBP`.
 *   AVIF -- an ISO-BMFF `ftyp` box whose major brand is `avif` or `avis`.
 *           `avis` is the image-sequence brand; both decode as images.
 *
 * Returns `null` for anything else, INCLUDING a valid image in a format this
 * boundary does not serve. An SVG reaching here is exactly the case the
 * allowlist exists for, and `null` is the answer that keeps it unservable.
 */
export function identifyArtworkBytes(bytes: Uint8Array): ArtworkMediaType | null {
  const at = (index: number): number => (index < bytes.length ? (bytes[index] as number) : -1);
  const ascii = (start: number, text: string): boolean => {
    for (let index = 0; index < text.length; index += 1) {
      if (at(start + index) !== text.charCodeAt(index)) return false;
    }
    return true;
  };

  if (
    at(0) === 0x89 && ascii(1, "PNG") && at(4) === 0x0d && at(5) === 0x0a &&
    at(6) === 0x1a && at(7) === 0x0a
  ) {
    return "image/png";
  }
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  if (ascii(4, "ftyp") && (ascii(8, "avif") || ascii(8, "avis"))) return "image/avif";
  return null;
}
