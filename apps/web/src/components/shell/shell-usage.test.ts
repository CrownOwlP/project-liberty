/* -------------------------------------------------------------------------
 * The guard that stops the eight topbars coming back (PW-0301).
 *
 * The duplication this task removed did not arrive deliberately. Each route
 * added a header because the one beside it had one, and by the time anyone
 * counted there were eight, each with a different status badge and a different
 * or absent nav. A rule enforced by memory decays the same way; this is the
 * mechanical version.
 * ---------------------------------------------------------------------- */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { PRIMARY_NAVIGATION, activeEntryId, isReachable } from "./navigation";
import {
  BROWSE_PATH,
  BROWSE_SORT_LABEL,
  MOVIES_PATH,
  TV_PATH,
  UNFILTERED,
  buildBrowseHref,
  type BrowseKindFilter,
  type BrowseSortKey
} from "../../app/browse/browse";
import { titleHref } from "../../app/title/title-detail";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "app");

/** Every route file Next renders as a page-like surface. */
function routeFiles(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      /* `api` holds route handlers, which render nothing. */
      if (entry.name !== "api") routeFiles(full, found);
    } else if (/^(page|layout|not-found|error|loading|global-error)\.tsx$/.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

const show = (file: string): string => relative(APP_DIR, file).split(sep).join("/");

describe("one shell, not eight", () => {
  const files = routeFiles(APP_DIR);

  it("finds the routes it is supposed to be guarding", () => {
    /* Non-vacuity. A walker that resolved nothing would satisfy every assertion
     * below, which is the characteristic failure of this kind of guard. */
    expect(files.length).toBeGreaterThan(6);
    expect(files.map(show)).toContain("page.tsx");
    expect(files.map(show)).toContain("watch/[contentId]/page.tsx");
  });

  it("no route hand-rolls a header", () => {
    const offenders = files
      .filter((file) => readFileSync(file, "utf8").includes('className="topbar"'))
      .map(show);
    expect(
      offenders,
      "a route grew its own topbar again; render <AppShell> instead"
    ).toEqual([]);
  });

  it("no route hand-rolls the main frame either", () => {
    /* `<main className="shell">` is what the copied headers were attached to.
     * `global-error.tsx` is exempt and named: it replaces the whole document and
     * must not import the shell, because the shell may be what failed. */
    const offenders = files
      .filter((file) => show(file) !== "global-error.tsx")
      .filter((file) => readFileSync(file, "utf8").includes('<main className="shell'))
      .map(show);
    expect(offenders).toEqual([]);
  });

  it("every route that renders a frame renders the shell", () => {
    const framed = files.filter((file) => {
      const name = show(file);
      /* `layout.tsx` deliberately does not -- see its own comment -- and
       * `global-error.tsx` deliberately cannot. */
      return name !== "layout.tsx" && name !== "global-error.tsx";
    });
    const missing = framed
      .filter((file) => !readFileSync(file, "utf8").includes("<AppShell"))
      .map(show);
    expect(missing).toEqual([]);
  });
});

describe("the navigation model", () => {
  it("links only to destinations that exist, and says why for the rest", () => {
    for (const entry of PRIMARY_NAVIGATION) {
      if (isReachable(entry)) {
        expect(entry.href).toMatch(/^\//);
        expect(entry.plannedReason).toBeNull();
      } else {
        /* A planned entry with no reason is a dead link with extra steps. */
        expect(entry.plannedReason, `${entry.id} is planned with no reason`).not.toBeNull();
        expect(entry.plannedReason).not.toBe("");
      }
    }
  });

  it("reaches search, which was previously linked from nowhere", () => {
    const search = PRIMARY_NAVIGATION.find((entry) => entry.id === "search");
    expect(search?.href).toBe("/search");
  });

  it("links only to routes that actually exist, which nothing checked before", () => {
    /*
     * THE PROMISE IN THIS MODULE'S HEADER, ENFORCED (PL-0756).
     *
     * It says "every entry goes somewhere that exists" and explains that a dead
     * link is worse than an absent one, because it teaches a viewer the feature
     * is broken rather than absent. The assertion above only checks that a live
     * href STARTS WITH a slash -- which `/browse` satisfied before the route
     * existed, and which every typo satisfies. The four fragment anchors this
     * file replaced were dead links too; the guard that was supposed to stop
     * them coming back could not tell a destination from a string.
     *
     * Resolved against the filesystem rather than against a list, so adding a
     * nav entry and forgetting the page fails here instead of in somebody's
     * browser. Only static paths are resolvable this way, and every entry in
     * `PRIMARY_NAVIGATION` is static -- a dynamic one would need the segment
     * pattern and is refused below rather than silently excused, because an
     * exemption nobody notices is how this guard would stop guarding.
     */
    const pages = routeFiles(APP_DIR);
    /* Non-vacuity: a walker that resolved nothing would satisfy the loop below
     * for every entry, which is the characteristic failure of this guard. */
    expect(pages).toContain(join(APP_DIR, 'page.tsx'));

    const missing: string[] = [];
    for (const entry of PRIMARY_NAVIGATION) {
      const href = entry.href;
      if (href === null) continue;
      expect(href, `${entry.id} has a dynamic path; this guard cannot resolve one`).not.toMatch(
        /[[\]]/
      );
      const segments = href.split("/").filter((segment) => segment !== "");
      const page = join(APP_DIR, ...segments, "page.tsx");
      if (!pages.includes(page)) missing.push(`${entry.id} -> ${href}`);
    }
    expect(
      missing,
      "a navigation entry points at a route with no page.tsx; build it or mark the entry planned"
    ).toEqual([]);
  });

  it("contains no fragment anchors", () => {
    /* The four it replaced were `#featured` and `#catalog` three times. */
    const fragments = PRIMARY_NAVIGATION.filter((entry) => entry.href?.includes("#"));
    expect(fragments).toEqual([]);
  });

  it("marks the two kind-locked routes as themselves, not as browse", () => {
    /* `/movies` and `/tv` are the browse surface with the kind fixed by the
     * path, but they are separate destinations in the nav and the highlight has
     * to agree with that -- a viewer on /movies is not "in Browse". */
    expect(activeEntryId("/movies")).toBe("movies");
    expect(activeEntryId("/tv")).toBe("tv");
    expect(activeEntryId("/browse")).toBe("browse");
  });

  it("marks the entry a path is inside, longest match first", () => {
    expect(activeEntryId("/")).toBe("home");
    expect(activeEntryId("/search")).toBe("search");
    expect(activeEntryId("/search?q=x")).toBe(null);
    expect(activeEntryId("/search/anything")).toBe("search");
  });

  it("marks nothing for the player, rather than claiming the viewer is on home", () => {
    /* Highlighting a nav item for a full-screen player would be a lie about
     * where the viewer is, and `/` must not win by prefix. */
    expect(activeEntryId("/watch/aurora-fall")).toBeNull();
    expect(activeEntryId("/title/aurora-fall")).toBeNull();
  });
});

/* -------------------------------------------------------------------------
 * THE SAME GUARD, EXTENDED PAST THE NAV LIST (Wave 132, worker C).
 *
 * THE DEFECT CLASS: a link whose destination nothing resolves.
 *
 * The guard above answers "does every NAVIGATION ENTRY have a page.tsx", which
 * is where the four dead fragment anchors lived. It cannot answer for the two
 * other families of address this application builds, and both are now larger
 * than the nav list:
 *
 *  - `buildBrowseHref` produces an address per filter COMBINATION, and Wave 132
 *    added a third filter (`sort`). The nav links to `/browse` and the guard
 *    above resolves it; nothing resolved `/browse?genre=Drama&sort=title`, and
 *    nothing would have noticed if the sort control had been pointed at a route
 *    that does not exist.
 *  - `titleHref` produces a DYNAMIC address, which the guard above refuses by
 *    name -- "this guard cannot resolve one" -- and therefore skips entirely.
 *    `activeEntryId("/title/aurora-fall")` is asserted to be null up there, so
 *    the title route is mentioned by this file while its existence is checked by
 *    nothing in it.
 *
 * `resolvePage` below is the piece that was missing: a resolver that walks
 * segments and accepts a DYNAMIC directory when no literal one matches, which
 * is what Next itself does. It is deliberately stricter than Next in one way --
 * it accepts exactly one dynamic directory per level and fails on an ambiguous
 * pair rather than guessing which would win -- because a guard that guesses is
 * a guard that passes for the wrong reason.
 * ---------------------------------------------------------------------- */

/**
 * The `page.tsx` a pathname would render, or `null`.
 *
 * The QUERY STRING IS DROPPED FIRST, because a query selects no route: it is
 * the thing `/search?q=` and `/browse?sort=` vary without changing which file
 * answers. A hash would be dropped the same way, and `PRIMARY_NAVIGATION` is
 * asserted above to contain none.
 */
function resolvePage(href: string): string | null {
  const path = href.split(/[?#]/)[0] ?? "";
  const segments = path.split("/").filter((segment) => segment !== "");
  let directory = APP_DIR;

  for (const segment of segments) {
    const children = readdirSync(directory, { withFileTypes: true }).filter((entry) =>
      entry.isDirectory()
    );
    const literal = children.find((entry) => entry.name === segment);
    if (literal !== undefined) {
      directory = join(directory, literal.name);
      continue;
    }
    /*
     * A dynamic segment -- `[titleId]`, `[contentId]`. Catch-all forms
     * (`[...slug]`) are deliberately NOT accepted: this application has none,
     * and silently matching one would let a future catch-all make every
     * assertion in this file pass by swallowing every unresolvable address.
     */
    const dynamic = children.filter(
      (entry) => entry.name.startsWith("[") && entry.name.endsWith("]") && !entry.name.includes("...")
    );
    if (dynamic.length !== 1) return null;
    directory = join(directory, dynamic[0]!.name);
  }

  const page = join(directory, "page.tsx");
  return routeFiles(APP_DIR).includes(page) ? page : null;
}

describe("every address this application builds resolves to a route", () => {
  it("resolves the routes it is supposed to be guarding, and refuses an invented one", () => {
    /* Non-vacuity in both directions. A resolver that answered for everything
     * would satisfy every assertion below; one that answered for nothing would
     * fail them loudly, which is the safer of the two failures and still worth
     * pinning. */
    expect(resolvePage("/")).not.toBeNull();
    expect(resolvePage("/browse")).not.toBeNull();
    expect(resolvePage("/no-such-route-w132c")).toBeNull();
    expect(resolvePage("/browse/deeper-than-the-route-goes")).toBeNull();
  });

  it("agrees with the nav guard on every live entry", () => {
    for (const entry of PRIMARY_NAVIGATION) {
      if (!isReachable(entry)) continue;
      expect(resolvePage(entry.href!), `${entry.id} -> ${entry.href}`).not.toBeNull();
    }
  });

  it("resolves the title detail route through its dynamic segment", () => {
    /*
     * The route the nav guard above refuses to resolve and this file otherwise
     * only mentions. `titleHref` percent-encodes its argument, so the awkward
     * ids are part of the case rather than a separate one.
     */
    expect(resolvePage("/title/aurora-fall")).not.toBeNull();
    expect(resolvePage(titleHref("aurora-fall"))).not.toBeNull();
    expect(resolvePage(titleHref("a title with spaces"))).not.toBeNull();
    expect(resolvePage(titleHref("../../etc/passwd"))).not.toBeNull();
    /* A bare `/title` is NOT a route -- the 404 boundary lives under the
     * dynamic segment -- and claiming it resolved would hide that. */
    expect(resolvePage("/title")).toBeNull();
  });

  it("resolves every address the browse filters can produce, on all three routes", () => {
    /*
     * THE WHOLE CROSS PRODUCT, because the point of `buildBrowseHref` is that
     * the three routes emit different parameters for the same filters: a
     * kind-locked route must not repeat its kind, and the default sort must not
     * be emitted at all. Every one of those addresses has to land on a page.
     */
    const basePaths = [BROWSE_PATH, MOVIES_PATH, TV_PATH];
    const kinds: BrowseKindFilter[] = ["all", "movie", "series"];
    const sorts = Object.keys(BROWSE_SORT_LABEL) as BrowseSortKey[];
    const genres: (string | null)[] = [null, "Drama", "Science fiction"];

    let checked = 0;
    for (const basePath of basePaths) {
      for (const kind of kinds) {
        for (const sort of sorts) {
          for (const genre of genres) {
            const href = buildBrowseHref({ kind, genre, sort }, basePath);
            expect(resolvePage(href), href).not.toBeNull();
            checked += 1;
          }
        }
      }
    }
    /* Non-vacuity: an empty loop proves nothing. */
    expect(checked).toBe(basePaths.length * kinds.length * sorts.length * genres.length);
  });

  it("keeps the unfiltered, default-ordered address as the bare route", () => {
    /* The property the sort control relies on: a reader who has changed nothing
     * is on the same address the nav links to, so the nav highlight and the
     * page agree. */
    expect(buildBrowseHref(UNFILTERED, BROWSE_PATH)).toBe(BROWSE_PATH);
    expect(buildBrowseHref({ ...UNFILTERED, kind: "movie" }, MOVIES_PATH)).toBe(MOVIES_PATH);
    expect(buildBrowseHref({ ...UNFILTERED, kind: "series" }, TV_PATH)).toBe(TV_PATH);
    for (const path of [BROWSE_PATH, MOVIES_PATH, TV_PATH]) {
      expect(activeEntryId(path), path).not.toBeNull();
    }
  });
});
