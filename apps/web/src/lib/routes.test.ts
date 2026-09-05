import { describe, expect, it } from "vitest";
import type {
  EpisodeCatalogItem,
  MovieCatalogItem,
  SeriesCatalogItem
} from "@liberty/contracts/domains/catalog";
import { appearsOnHome } from "./catalog";
import { demoCatalog } from "./demo-catalog";
import { resolveCatalogItemRoute } from "./routes";

/*
 * Per-kind builders, for the reason `catalog.test.ts` gives: `CatalogItem` is a
 * discriminated union, so `Partial<CatalogItem>` distributes into a union of
 * partials and stops being a usable override bag. Repeated here rather than
 * imported because `catalog.test.ts` does not export them and a test file that
 * exports helpers becomes a module other suites depend on.
 */
type Overrides<T> = Partial<Omit<T, "kind">> & { id: string };

const movie = (over: Overrides<MovieCatalogItem>): MovieCatalogItem => ({
  title: "Untitled",
  rights: "owned",
  genre: "Drama",
  releaseYear: 2024,
  runtimeMinutes: 100,
  episodeCount: null,
  ...over,
  kind: "movie"
});

const series = (over: Overrides<SeriesCatalogItem>): SeriesCatalogItem => ({
  title: "Untitled",
  rights: "owned",
  genre: "Drama",
  releaseYear: 2024,
  runtimeMinutes: null,
  episodeCount: 6,
  ...over,
  kind: "series"
});

const episode = (over: Overrides<EpisodeCatalogItem>): EpisodeCatalogItem => ({
  title: "Untitled",
  rights: "owned",
  genre: "Drama",
  releaseYear: 2024,
  runtimeMinutes: 47,
  episodeCount: null,
  ...over,
  kind: "episode"
});

/**
 * Ids `normalizedContentIdSchema` accepts: lower-case alphanumeric groups joined
 * by single hyphens. Listed as data so the address assertion below is made
 * against several shapes rather than against one memorable example.
 */
const NORMALIZED_IDS = [
  "a",
  "2024",
  "northstar",
  "aurora-fall",
  "harbor-lights-s1e6",
  "a-1-b"
] as const;

/**
 * Ids it refuses, each for a different reason a real provider id might carry
 * one: case, whitespace, punctuation the pattern does not admit, an empty
 * string, a doubled or dangling separator, a path separator, a relative path
 * segment, and an already-encoded slash.
 */
const NON_NORMALIZED_IDS = [
  "",
  "Aurora-Fall",
  "AURORA",
  "aurora fall",
  "aurora_fall",
  "aurora.fall",
  "aurora--fall",
  "-aurora",
  "aurora-",
  "aurora/fall",
  "..",
  "../admin",
  "aurora%2Ffall",
  "café"
] as const;

describe("resolveCatalogItemRoute: items that open", () => {
  it("sends a movie to its own title page", () => {
    expect(resolveCatalogItemRoute(movie({ id: "aurora-fall" }))).toEqual({
      status: "routable",
      href: "/title/aurora-fall"
    });
  });

  it("sends a series to its own title page", () => {
    expect(resolveCatalogItemRoute(series({ id: "harbor-lights" }))).toEqual({
      status: "routable",
      href: "/title/harbor-lights"
    });
  });

  /*
   * The anti-constant test. Every other assertion in this block would still pass
   * against an implementation that returned one hardcoded address, which is
   * precisely the stub a card would render identically for every title -- and
   * the failure would be invisible, because each card would still look like a
   * link. Two items must produce two addresses, and each must contain its own
   * id.
   */
  it("gives two different items two different addresses", () => {
    const first = resolveCatalogItemRoute(movie({ id: "alpha-one" }));
    const second = resolveCatalogItemRoute(series({ id: "beta-two" }));

    expect(first).toEqual({ status: "routable", href: "/title/alpha-one" });
    expect(second).toEqual({ status: "routable", href: "/title/beta-two" });
    expect(first).not.toEqual(second);
  });

  /*
   * NORMALIZED IDS REACH THE ADDRESS UNCHANGED. `titleHref` percent-encodes, and
   * for an id the schema has already accepted that encoding is a no-op -- every
   * character in the pattern is unreserved. Asserted rather than assumed,
   * because an encoder applied twice, or one that escaped hyphens or digits,
   * would produce an address that resolves to nothing while still looking like a
   * link. The acceptance for this task is that a result OPENS its details page.
   */
  it("carries a normalized id into the address verbatim", () => {
    for (const id of NORMALIZED_IDS) {
      const route = resolveCatalogItemRoute(movie({ id }));

      expect(route, id).toEqual({ status: "routable", href: `/title/${id}` });
    }
  });

  /*
   * Only `kind` and `id` decide. A route that varied with the title, the genre
   * or the year would mean two renders of one work could disagree about where it
   * lives -- and a card whose address changed when its metadata was refreshed is
   * a bookmark that stops working for no visible reason.
   */
  it("ignores every field except kind and id", () => {
    const plain = resolveCatalogItemRoute(movie({ id: "same-id" }));
    const decorated = resolveCatalogItemRoute(
      movie({
        id: "same-id",
        title: "A Completely Different Title",
        genre: "Documentary",
        releaseYear: 1899,
        runtimeMinutes: 7
      })
    );

    expect(decorated).toEqual(plain);
  });

  it("is deterministic: the same item resolves the same way twice", () => {
    const item = series({ id: "northstar" });
    expect(resolveCatalogItemRoute(item)).toEqual(resolveCatalogItemRoute(item));
  });
});

describe("resolveCatalogItemRoute: items that do not open", () => {
  /*
   * THE INTERESTING BRANCH. The union exists so the card cannot forget it, and
   * an item that cannot be linked is the case a card renders as plain text --
   * which looks like a rendering choice rather than a refusal, so nothing about
   * the running application would reveal a mistake here.
   */
  it("refuses a standalone episode, even with a perfectly formed id", () => {
    expect(resolveCatalogItemRoute(episode({ id: "harbor-lights-s1e6" }))).toEqual({
      status: "unrouted",
      reason: "kind_has_no_catalog_route"
    });
  });

  /*
   * ORDER MATTERS AND IS PINNED. An episode with a malformed id fails both
   * checks, and the reason it reports has to be the one whose remedy is real:
   * the kind has no page at all, so "fix the id" would send whoever reads this
   * trail after a change that could not help. It also proves the two conditions
   * are evaluated in the order the file documents rather than incidentally.
   */
  it("reports the kind, not the id, when an episode also has a malformed id", () => {
    expect(resolveCatalogItemRoute(episode({ id: "Season 1 / Episode 6" }))).toEqual({
      status: "unrouted",
      reason: "kind_has_no_catalog_route"
    });
  });

  it("refuses an id that could not name a title, for every routable kind", () => {
    for (const id of NON_NORMALIZED_IDS) {
      expect(resolveCatalogItemRoute(movie({ id })), `movie ${JSON.stringify(id)}`).toEqual({
        status: "unrouted",
        reason: "id_is_not_a_normalized_content_id"
      });
      expect(resolveCatalogItemRoute(series({ id })), `series ${JSON.stringify(id)}`).toEqual({
        status: "unrouted",
        reason: "id_is_not_a_normalized_content_id"
      });
    }
  });

  /*
   * A REFUSAL, NOT AN ENCODED LINK. `titleHref` would happily turn `../admin`
   * into `/title/..%2Fadmin`, which is a well-formed address for a page that
   * cannot exist -- so without this guard the card would render a link that is
   * known-broken at the moment it is drawn. Asserting the absence of `href` is
   * the load-bearing half: a branch that carried both keys would let a caller
   * read the address off an answer that said no.
   */
  it("never attaches an address to a refusal", () => {
    for (const id of ["../admin", "..", "aurora/fall"]) {
      const route = resolveCatalogItemRoute(movie({ id }));

      expect(route.status, id).toBe("unrouted");
      expect("href" in route, id).toBe(false);
    }

    const unroutedKind = resolveCatalogItemRoute(episode({ id: "aurora-fall" }));
    expect("href" in unroutedKind).toBe(false);
  });

  /*
   * The two reasons are distinct and both are reachable. A union whose second
   * member nothing ever returns is a union the caller learns to ignore, and a
   * pair of refusals collapsed onto one code would send two different problems
   * to the same remedy.
   */
  it("uses both declared reasons and no others", () => {
    const reasons = [
      resolveCatalogItemRoute(episode({ id: "aurora-fall" })),
      resolveCatalogItemRoute(movie({ id: "Aurora Fall" })),
      resolveCatalogItemRoute(series({ id: "" }))
    ].map((route) => (route.status === "unrouted" ? route.reason : "routable"));

    expect(reasons).toEqual([
      "kind_has_no_catalog_route",
      "id_is_not_a_normalized_content_id",
      "id_is_not_a_normalized_content_id"
    ]);
  });

  /*
   * ROUTING IS NOT A SECOND RIGHTS GATE, and this pins that boundary rather than
   * endorsing a link to unrightsed media. `isSurfaceable` runs before an item
   * can reach a card at all -- `buildHomeCatalog` filters on it and
   * `searchCatalog` checks it before anything else can keep an item -- so a
   * non-surfaceable item is never rendered and never asked about here. Deciding
   * rights a second time in this function would put the gate in two places, and
   * the copy that lives beside a URL builder is the one that gets forgotten.
   */
  it("does not decide rights: that gate runs before an item reaches a card", () => {
    const offAllowlist = movie({ id: "aurora-fall", rights: "unlicensed" as never });

    expect(resolveCatalogItemRoute(offAllowlist)).toEqual({
      status: "routable",
      href: "/title/aurora-fall"
    });
  });
});

describe("resolveCatalogItemRoute: against the fixtures the surfaces actually render", () => {
  /*
   * The acceptance for PL-0104 is that EVERY catalog and search result opens its
   * title details page. The builders above prove the rules; this proves the rules
   * cover the data. A fixture id that stopped being normalized would silently
   * turn a card into plain text, and no test built from hand-written items could
   * see it.
   */
  it("routes every fixture that reaches a home rail", () => {
    const eligible = demoCatalog.filter(appearsOnHome);

    /* Guards the loop: an empty fixture set satisfies every assertion inside it
     * while proving none of them. */
    expect(eligible.length).toBeGreaterThan(0);

    for (const item of eligible) {
      expect(resolveCatalogItemRoute(item), item.id).toEqual({
        status: "routable",
        href: `/title/${item.id}`
      });
    }
  });

  it("gives every fixture a distinct address", () => {
    const addresses = demoCatalog
      .map(resolveCatalogItemRoute)
      .flatMap((route) => (route.status === "routable" ? [route.href] : []));

    expect(addresses.length).toBe(demoCatalog.length);
    expect(new Set(addresses).size).toBe(addresses.length);
  });
});
