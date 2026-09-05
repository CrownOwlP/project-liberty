import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/* -------------------------------------------------------------------------
 * THE RULE PL-0704 EXISTS TO MAKE UNBREAKABLE
 *
 * No Suspense boundary may sit above a route segment that can call
 * `notFound()`.
 *
 * The reason is not a preference. A response's status line precedes the first
 * byte of its body, and React flushes the shell — body bytes — as soon as it
 * has a Suspense boundary to fall back to. Next can therefore only set a 404
 * from an access-fallback error that ESCAPES the HTML render; `app-render.tsx`
 * assigns `res.statusCode` from one in the catch around the render and nowhere
 * else. A `notFound()` under a boundary can swap what the page SAYS and can
 * never change what it IS, so every dead address answers 200 with a skeleton.
 *
 * That is not a hypothetical. `app/loading.tsx` wrapped every route in the
 * application — a segment's loading file installs the boundary around that
 * segment's child slots, and at the app root the children are the whole app —
 * and an executed Playwright run captured `/title/<unknown>` and
 * `/watch/<malformed>` both answering 200, on all four browser projects.
 *
 * WHY THIS IS A TEST AND NOT A COMMENT. The illegal state is created by ADDING
 * a file, in a directory that need not be anywhere near the route it breaks,
 * and it is invisible to `tsc`, to the type system and to review of the diff
 * that introduces it — the new `loading.tsx` looks entirely correct on its own.
 * Nothing else in the repository can notice. Three separate comments in the
 * routes below already stated the rule in prose and the defect still shipped
 * and survived a review; the difference here is that the unit gate fails.
 *
 * WHERE IT LIVES. This guards the whole `app/` tree, not the watch route, and
 * the honest reason it sits under `watch/` is that PL-0704's declared write
 * surface reaches `app/watch/**`, `app/title/**`, `app/page.tsx` and
 * `app/loading.tsx` — and of those, this route is the one that KEPT a Suspense
 * boundary (moved inside its page, below the decision), so it is the one where
 * a future contributor is most likely to reach for a `loading.tsx` again.
 * ---------------------------------------------------------------------- */

/** `src/app`, resolved from this file rather than from the process cwd. */
const APP_DIRECTORY = resolve(fileURLToPath(new URL("../", import.meta.url)));

const LOADING_FILE = /^loading\.(?:tsx|jsx|ts|js)$/;
const PAGE_FILE = /^page\.(?:tsx|jsx|ts|js)$/;

/**
 * A page that can answer "this address names nothing".
 *
 * Both halves are required. The import alone is satisfied by a file that only
 * mentions the symbol, and the call alone matches prose — the two routes this
 * covers discuss `notFound()` at length in their comments, which is how the
 * defect was recorded during the rounds that could not yet repair it.
 */
const IMPORTS_NOT_FOUND = /import\s*\{[^}]*\bnotFound\b[^}]*\}\s*from\s*["']next\/navigation["']/;
const CALLS_NOT_FOUND = /\bnotFound\s*\(/;

interface AppTree {
  /** Every directory holding a `loading.*` file, i.e. every boundary. */
  readonly loadingBoundaryDirectories: string[];
  /** Absolute paths of every `page.*` file. */
  readonly pageFiles: string[];
}

function walk(directory: string, tree: AppTree): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      walk(path, tree);
      continue;
    }
    if (!entry.isFile()) continue;

    if (LOADING_FILE.test(entry.name)) tree.loadingBoundaryDirectories.push(directory);
    if (PAGE_FILE.test(entry.name)) tree.pageFiles.push(path);
  }
}

function readAppTree(): AppTree {
  const tree: AppTree = { loadingBoundaryDirectories: [], pageFiles: [] };
  walk(APP_DIRECTORY, tree);
  return tree;
}

/**
 * The directory chain from a segment up to `app/`, both ends included.
 *
 * Inclusive at the bottom because a segment's own `loading.tsx` wraps that
 * segment's page — the nested boundary was half of the original defect, not an
 * innocent bystander — and inclusive at the top because `app/loading.tsx` was
 * the other half.
 */
function segmentChain(directory: string): string[] {
  const chain: string[] = [];
  let current = directory;

  for (;;) {
    chain.push(current);
    if (current === APP_DIRECTORY) break;

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return chain;
}

/**
 * Lines that are unambiguously code.
 *
 * Deliberately crude, and stated so: it drops whole lines whose first non-space
 * characters open or continue a comment, which is the style the routes under
 * `app/` are written in. It does not parse. A trailing comment on the same line as
 * code is still read as code, so this can only make the ordering check below
 * STRICTER than it should be, never weaker — a false failure is a nuisance, a
 * false pass is the defect coming back.
 */
function codeLines(source: string): string[] {
  return source.split("\n").map((line) => {
    const trimmed = line.trimStart();
    const isComment = trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*");
    return isComment ? "" : line;
  });
}

function firstLineContaining(lines: readonly string[], needle: string): number {
  return lines.findIndex((line) => line.includes(needle));
}

const APP_TREE = readAppTree();

const NOT_FOUND_PAGES = APP_TREE.pageFiles
  .map((path) => ({ path, source: readFileSync(path, "utf8") }))
  .filter(({ source }) => IMPORTS_NOT_FOUND.test(source) && CALLS_NOT_FOUND.test(source));

describe("route loading boundaries", () => {
  it("finds the pages that can answer not-found, so the rule below is not vacuous", () => {
    /*
     * Without this the whole file passes by finding nothing — a rename, a move
     * or a refactor that stops matching the patterns above would silently turn
     * the guard off and leave a green gate behind it.
     */
    const routes = NOT_FOUND_PAGES.map(({ path }) => relative(APP_DIRECTORY, path)).sort();
    expect(routes).toEqual(
      /*
       * Containment rather than equality. A third route that legitimately gains
       * a not-found path should be picked up by the rule below, not fought with
       * by this one; what must never happen is the set going empty.
       */
      expect.arrayContaining([
        join("title", "[titleId]", "page.tsx"),
        join("watch", "[contentId]", "page.tsx")
      ])
    );
  });

  it("puts no loading boundary above a page that can call notFound()", () => {
    const violations: string[] = [];

    for (const { path } of NOT_FOUND_PAGES) {
      for (const segment of segmentChain(dirname(path))) {
        if (!APP_TREE.loadingBoundaryDirectories.includes(segment)) continue;
        violations.push(
          `${relative(APP_DIRECTORY, path)} renders inside the Suspense boundary declared by ` +
            `the loading file in app/${relative(APP_DIRECTORY, segment)}, so its notFound() ` +
            `cannot reach the wire as a 404 — delete that file`
        );
      }
    }

    /*
     * Asserted as the whole list rather than as a count, because the failure
     * message is the entire value of this test: it has to name the file to
     * delete and the route it breaks, to someone who did not know the two were
     * connected.
     */
    expect(violations).toEqual([]);
  });

  it("calls notFound() before any Suspense boundary the page declares itself", () => {
    /*
     * The other direction of the same rule. Removing the `loading.tsx` files is
     * not enough on its own: a `<Suspense>` written inside the page has exactly
     * the same effect on the status once the decision moves below it.
     * `watch/[contentId]/page.tsx` deliberately has both — the identity gate
     * above, the provider round-trip below — and that ordering is the entire
     * reason it can still show a skeleton.
     */
    const violations: string[] = [];

    for (const { path, source } of NOT_FOUND_PAGES) {
      const lines = codeLines(source);
      const suspenseAt = firstLineContaining(lines, "<Suspense");
      if (suspenseAt === -1) continue;

      const notFoundAt = lines.findIndex((line) => CALLS_NOT_FOUND.test(line));
      if (notFoundAt !== -1 && notFoundAt < suspenseAt) continue;

      violations.push(
        `${relative(APP_DIRECTORY, path)} renders <Suspense> at line ${suspenseAt + 1} and does ` +
          `not call notFound() above it, so the shell is flushed at 200 before the address is judged`
      );
    }

    expect(violations).toEqual([]);
  });
});
