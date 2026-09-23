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

  it("contains no fragment anchors", () => {
    /* The four it replaced were `#featured` and `#catalog` three times. */
    const fragments = PRIMARY_NAVIGATION.filter((entry) => entry.href?.includes("#"));
    expect(fragments).toEqual([]);
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
