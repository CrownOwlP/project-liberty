import { readFile, stat } from "node:fs/promises";
import { artworkResponse, resolveArtwork, type ArtworkReader } from "../handler";
import { ARTWORK_STORE_ENV_VAR } from "../store";

/**
 * GET /api/v1/artwork/{assetRef}
 *
 * THE ARTWORK RESOLUTION BOUNDARY (PW-0302). An opaque reference from a catalog
 * or title payload goes in; the bytes of one image come out, or a refusal that
 * says which of eight things went wrong. See `../handler.ts` for what
 * "authorized" means on this endpoint and `../store.ts` for why this boundary
 * reads a directory rather than fetching an upstream URL.
 *
 * This module is the wiring Next deploys and nothing else: it reads the one
 * environment variable, supplies the real filesystem, and hands both to a
 * decision that is pure. That is the split `catalog/home/route.ts` records, and
 * it is what makes the refusal branches testable without a filesystem.
 *
 * ONLY `GET` IS EXPORTED. Next serves 405 for every method a route module does
 * not export, so the absence of `POST`, `PUT` and `DELETE` here is the refusal
 * -- there is no upload path into the artwork store through this application,
 * and an operator's store is written by an operator.
 */

/**
 * The real filesystem, behind the two-operation port.
 *
 * A path that does not exist, or whose parent is not a directory, answers
 * `null`: both are ordinary "this store does not hold that" and become a 404.
 * ANY OTHER ERROR IS RETHROWN -- a permissions failure, a broken mount, a name
 * too long for the filesystem -- because those are the store failing to answer,
 * which is a different fact with a different remedy and a different status.
 * Collapsing them here would turn an unreadable directory into a page of missing
 * posters and no signal anywhere.
 *
 * `isFile()` rather than mere existence, so a DIRECTORY named `poster.png` is
 * "not here" instead of an eight-megabyte read that fails later with a confusing
 * message.
 */
const nodeArtworkReader: ArtworkReader = {
  async size(path: string): Promise<number | null> {
    try {
      const stats = await stat(path);
      return stats.isFile() ? stats.size : null;
    } catch (cause) {
      if (isAbsentPath(cause)) return null;
      throw cause;
    }
  },
  async read(path: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(path));
  }
};

function isAbsentPath(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null) return false;
  const code = (cause as { code?: unknown }).code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "ENAMETOOLONG";
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ assetRef: string }> }
): Promise<Response> {
  const { assetRef } = await context.params;
  return artworkResponse(
    await resolveArtwork(process.env[ARTWORK_STORE_ENV_VAR], assetRef, nodeArtworkReader)
  );
}
