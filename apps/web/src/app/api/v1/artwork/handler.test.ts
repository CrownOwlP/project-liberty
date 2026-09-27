import { describe, expect, it } from "vitest";

import {
  artworkRefusalStatus,
  artworkResponse,
  resolveArtwork,
  type ArtworkReader,
  type ArtworkRefusalReason
} from "./handler";
import { ARTWORK_MAX_BYTES } from "./store";

/**
 * The artwork resolution boundary's decisions (PW-0302).
 *
 * A FAKE FILESYSTEM, NOT A TEMPORARY DIRECTORY. Three of the eight outcomes --
 * an unreadable store, an asset over the size cap, a store holding two files for
 * one reference -- are awkward or slow to stage on a real disk and trivial to
 * state here, and the handler's whole design is that the filesystem arrives
 * through a two-method port so that this is possible.
 */

const STORE = "/srv/artwork";
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

/** A store described as `{ path: bytes }`, with an optional read/stat failure. */
function fakeStore(
  files: Readonly<Record<string, Uint8Array>>,
  options: { readonly failOn?: string; readonly sizeOverride?: number } = {}
): ArtworkReader {
  return {
    async size(path: string): Promise<number | null> {
      if (options.failOn === path) throw new Error("EACCES: permission denied");
      const bytes = files[path];
      if (bytes === undefined) return null;
      return options.sizeOverride ?? bytes.byteLength;
    },
    async read(path: string): Promise<Uint8Array> {
      const bytes = files[path];
      if (bytes === undefined) throw new Error("ENOENT");
      return bytes;
    }
  };
}

async function refusalOf(
  outcome: Awaited<ReturnType<typeof resolveArtwork>>
): Promise<ArtworkRefusalReason> {
  expect(outcome.ok).toBe(false);
  if (outcome.ok) throw new Error("unreachable");
  return outcome.reason;
}

describe("a deployment with no artwork store", () => {
  it("refuses with the variable named, rather than answering 404", () => {
    /*
     * The difference matters to the only person who can fix it. A 404 says "this
     * store does not hold that reference", which is a statement about a store
     * that does not exist. 503 with the variable named says what to do.
     */
    return resolveArtwork(undefined, "aurora-fall-poster", fakeStore({})).then(async (outcome) => {
      expect(await refusalOf(outcome)).toBe("artwork_store_not_configured");
      if (!outcome.ok) expect(outcome.detail).toContain("LIBERTY_ARTWORK_STORE");
    });
  });

  it("refuses a relative store setting as a separate, fixable state", async () => {
    const outcome = await resolveArtwork("artwork", "aurora-fall-poster", fakeStore({}));
    expect(await refusalOf(outcome)).toBe("artwork_store_not_absolute");
  });

  it("answers 503 for both, the status this app already uses for a missing dependency", () => {
    expect(artworkRefusalStatus("artwork_store_not_configured")).toBe(503);
    expect(artworkRefusalStatus("artwork_store_not_absolute")).toBe(503);
  });
});

describe("resolving a reference against a configured store", () => {
  it("serves the bytes and the format read from them", async () => {
    const outcome = await resolveArtwork(
      STORE,
      "aurora-fall-poster",
      fakeStore({ "/srv/artwork/aurora-fall-poster.png": PNG })
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.resolution.mediaType).toBe("image/png");
      expect(outcome.resolution.bytes).toEqual(PNG);
    }
  });

  it("serves the TRUE format when the extension disagrees with the bytes", async () => {
    /*
     * `poster.webp` holding PNG bytes is served as `image/png`, not refused. The
     * response is then true, and a naming mistake costs nobody a page. The
     * extension chose which file to look at; it never decides what the file is.
     */
    const outcome = await resolveArtwork(
      STORE,
      "aurora-fall-poster",
      fakeStore({ "/srv/artwork/aurora-fall-poster.webp": PNG })
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.resolution.mediaType).toBe("image/png");
  });

  it("answers 404 when the store holds nothing under that reference", async () => {
    const outcome = await resolveArtwork(STORE, "missing-poster", fakeStore({}));
    expect(await refusalOf(outcome)).toBe("artwork_not_found");
    expect(artworkRefusalStatus("artwork_not_found")).toBe(404);
  });

  it("refuses a reference that is not one, without touching the store", async () => {
    let touched = false;
    const watcher: ArtworkReader = {
      async size() {
        touched = true;
        return null;
      },
      async read() {
        touched = true;
        return new Uint8Array();
      }
    };
    const outcome = await resolveArtwork(STORE, "../../etc/passwd", watcher);
    expect(await refusalOf(outcome)).toBe("artwork_reference_malformed");
    expect(artworkRefusalStatus("artwork_reference_malformed")).toBe(400);
    expect(touched).toBe(false);
  });

  it("reports an ambiguous store rather than silently picking a format", async () => {
    /*
     * Both alternatives to reporting are wrong in a way nobody would notice: a
     * fixed extension order serves AVIF to a browser that cannot decode it, and
     * `Accept`-based selection makes this endpoint a content negotiator with a
     * cache-key problem. An operator fixes this in one command.
     */
    const outcome = await resolveArtwork(
      STORE,
      "aurora-fall-poster",
      fakeStore({
        "/srv/artwork/aurora-fall-poster.png": PNG,
        "/srv/artwork/aurora-fall-poster.avif": PNG
      })
    );
    expect(await refusalOf(outcome)).toBe("artwork_reference_ambiguous");
    expect(artworkRefusalStatus("artwork_reference_ambiguous")).toBe(500);
  });

  it("refuses an oversized asset BEFORE reading it", async () => {
    /*
     * The ordering is the protection. `size` answers first and the refusal
     * happens on that answer, so the bytes never enter this process -- the fake
     * below proves it by throwing if `read` is reached at all.
     */
    const only = "/srv/artwork/huge-poster.png";
    const reader: ArtworkReader = {
      async size(path: string) {
        /*
         * Exactly ONE candidate exists. An earlier draft of this fake answered a
         * size for every extension, which is a store holding five files for one
         * reference -- so the handler correctly refused it as ambiguous before it
         * ever reached the size cap, and the test was asserting against a store
         * no operator has. The fake was wrong, not the ordering.
         */
        return path === only ? ARTWORK_MAX_BYTES + 1 : null;
      },
      async read() {
        throw new Error("read must not be reached for an oversized asset");
      }
    };
    const outcome = await resolveArtwork(STORE, "huge-poster", reader);
    expect(await refusalOf(outcome)).toBe("artwork_asset_too_large");
  });

  it("refuses bytes that are not an image this boundary serves", async () => {
    const svg = Uint8Array.from([...'<svg onload="alert(1)">'].map((c) => c.charCodeAt(0)));
    const outcome = await resolveArtwork(
      STORE,
      "hostile-poster",
      fakeStore({ "/srv/artwork/hostile-poster.png": svg })
    );
    expect(await refusalOf(outcome)).toBe("artwork_media_type_unrecognised");
  });

  it("keeps an unreadable store distinct from a missing asset", async () => {
    const outcome = await resolveArtwork(
      STORE,
      "aurora-fall-poster",
      fakeStore({}, { failOn: "/srv/artwork/aurora-fall-poster.avif" })
    );
    expect(await refusalOf(outcome)).toBe("artwork_store_unreadable");
    expect(artworkRefusalStatus("artwork_store_unreadable")).toBe(500);
    if (!outcome.ok) expect(outcome.detail).toContain("permission denied");
  });
});

describe("what goes on the wire", () => {
  it("carries the identified type, the length, and the hardening headers", async () => {
    const outcome = await resolveArtwork(
      STORE,
      "aurora-fall-poster",
      fakeStore({ "/srv/artwork/aurora-fall-poster.png": PNG })
    );
    const response = artworkResponse(outcome);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-length")).toBe(String(PNG.byteLength));
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
  });

  it("caches an asset but never a refusal", async () => {
    /*
     * The one documented exception to `docs/API_CONTRACTS.md`'s blanket
     * `no-store`. An asset addressed by an opaque reference is immutable content
     * and re-fetching every poster on every navigation is the cost of forbidding
     * its cache. A REFUSAL is still `no-store`, because a 503 from a deployment
     * with no store configured must not outlive the configuration that caused it.
     */
    const served = artworkResponse(
      await resolveArtwork(STORE, "aurora-fall-poster", fakeStore({
        "/srv/artwork/aurora-fall-poster.png": PNG
      }))
    );
    expect(served.headers.get("cache-control")).toBe("public, max-age=3600");

    const refused = artworkResponse(await resolveArtwork(undefined, "x", fakeStore({})));
    expect(refused.headers.get("cache-control")).toBe("no-store");
  });

  it("never answers a refusal with an empty body", async () => {
    /*
     * `docs/API_CONTRACTS.md` states this for every route, and an image endpoint
     * is where it is most tempting to break: the `<img>` that asked will not read
     * the body. The body is for the operator with `curl` trying to find out why
     * the posters are gradients.
     */
    for (const setting of [undefined, "relative/path", STORE]) {
      const response = artworkResponse(await resolveArtwork(setting, "nothing-here", fakeStore({})));
      expect(response.ok).toBe(false);
      const body = (await response.json()) as { error: string; detail: string };
      expect(body.error.length).toBeGreaterThan(0);
      expect(body.detail.length).toBeGreaterThan(0);
    }
  });
});
