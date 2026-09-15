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

  /*
   * THE CLAUSE THE TWO RULES ABOVE WOULD OTHERWISE LET A DELETION SATISFY.
   *
   * PL-0704's acceptance says a fix "must keep the loading skeletons rather than
   * deleting them to move a status code", and both rules above are satisfied
   * perfectly by a repository with no skeletons in it at all -- deleting every
   * boundary is the cheapest way to have none above a `notFound()`. The
   * relocation is the work; the deletion is the shortcut it was chosen over, and
   * nothing in this file could tell the two apart.
   *
   * So the two boundaries that were MOVED are named, and are required to still be
   * there. Named explicitly rather than derived, because the property is about
   * these two specific relocations and a rule inferred from the tree would be
   * satisfied by whatever the tree happens to contain.
   *
   * `title/[titleId]/page.tsx` is deliberately NOT in this list, and that is now
   * a RULED EXEMPTION rather than a disagreement left open. The round that wrote
   * this comment flagged the title route as the one point where the clause and
   * the code conflicted; the clause was amended on 2026-09-15 rather than the
   * code, and the exemption carries its reasoning: a well-formed unknown title id
   * is indistinguishable from a real one until the catalog answers, a status line
   * precedes the first body byte, so no byte may be sent before that load
   * resolves -- which is the definition of having nothing to stream. A full-page
   * skeleton there IS the defect this task exists to remove.
   *
   * The exemption is EMPIRICAL AND REVERSIBLE, and the test below is what makes
   * the reversal checkable rather than merely written down.
   */
  it("keeps the two skeletons PL-0704 relocated, rather than deleting them", () => {
    const relocated = [
      { file: "page.tsx", fallback: "CatalogSkeleton" },
      { file: join("watch", "[contentId]", "page.tsx"), fallback: "PlaybackLoading" }
    ];

    const missing: string[] = [];

    for (const { file, fallback } of relocated) {
      const source = readFileSync(join(APP_DIRECTORY, file), "utf8");

      if (!source.includes(`function ${fallback}(`)) {
        missing.push(
          `app/${file} no longer defines ${fallback}. PL-0704 MOVED this skeleton out of a ` +
            `loading file and into this page, below the route's existence decision; deleting ` +
            `it instead is the shortcut its acceptance forbids`
        );
      }

      if (!source.includes(`<Suspense fallback={<${fallback} />}>`)) {
        missing.push(
          `app/${file} no longer renders <Suspense fallback={<${fallback} />}>, so nothing on ` +
            `this route shows a wait that is really happening`
        );
      }
    }

    expect(missing).toEqual([]);
  });

  /*
   * THE TITLE ROUTE'S EXEMPTION, ASSERTED RATHER THAN DOCUMENTED.
   *
   * The amended acceptance exempts `title/[titleId]/page.tsx` from the clause
   * above "EMPIRICAL AND REVERSIBLE, not permanent: the moment the title page
   * grows a section whose data does not depend on the title existing --
   * recommendations, continue-watching, anything PL-0301 or PL-0501 fetches
   * separately -- it gains an in-page Suspense below the decision exactly as the
   * watch route has, and this clause binds again."
   *
   * That sentence is a condition, so it is written here as one. The page is
   * allowed exactly two states and the assertion self-adjusts between them:
   *
   *   - NO `<Suspense>` at all, which is today's tree. The exemption's premise
   *     holds: there is nothing on the route that can stream ahead of the
   *     existence decision, so there is no skeleton to keep.
   *   - A `<Suspense>`, which means the route has grown something that CAN wait
   *     independently -- and then the clause binds and the fallback must be a
   *     real named skeleton defined in the page, not `null` and not a fragment.
   *     `notFound()` above it is required separately, by the ordering test below.
   *
   * WHAT THIS CANNOT SEE, stated because a guard whose blind spot is unrecorded
   * is worse than none. The clause's trigger is semantic -- a section whose data
   * does not depend on the title existing -- and no static check can recognise
   * one. What is observable is the MARKER the clause says such a section brings
   * with it: the in-page boundary. A contributor who adds an independent section
   * and streams nothing for it leaves this test green and the clause unsatisfied,
   * and neither the e2e suite nor `tsc` would notice either. The reversal is
   * caught at the point it becomes visible, which is not the same as caught at
   * the point it becomes true.
   */
  it("holds the title route to its exemption, and to the clause the moment it lapses", () => {
    const source = readFileSync(join(APP_DIRECTORY, "title", "[titleId]", "page.tsx"), "utf8");
    const lines = codeLines(source);

    /*
     * The premise first, and asserted rather than assumed: this route decides
     * existence at all. If `notFound()` ever leaves this page the exemption stops
     * being an exemption from anything, and the branch below would go quiet for
     * the wrong reason. The route is also required to be in NOT_FOUND_PAGES by
     * the first test in this file, which is what keeps the two from drifting.
     */
    expect(
      IMPORTS_NOT_FOUND.test(source) && CALLS_NOT_FOUND.test(source),
      "title/[titleId]/page.tsx no longer decides existence, so PL-0704's exemption for it " +
        "describes a route that no longer exists"
    ).toBe(true);

    /*
     * The condition itself, written without an early return so that this test
     * always evaluates it. It is satisfied TODAY by its first branch -- the page
     * declares no boundary -- and a reader should know that: the value here is
     * the day the first branch stops being true, not the assertion it makes
     * meanwhile. The message is the whole of it, because it has to tell somebody
     * who has just added a recommendations rail why a task they have never read
     * now governs their diff.
     */
    const declaresSuspense = firstLineContaining(lines, "<Suspense") !== -1;
    const fallback = /<Suspense\s+fallback=\{<([A-Z][A-Za-z0-9_]*)\s*\/>\}/.exec(
      lines.join("\n")
    );
    const keepsANamedSkeleton =
      fallback?.[1] !== undefined && source.includes(`function ${fallback[1]}(`);

    expect(
      !declaresSuspense || keepsANamedSkeleton,
      `title/[titleId]/page.tsx now declares a <Suspense>, so it has grown a section that waits ` +
        `on something other than the title's existence. PL-0704's exemption for this route was ` +
        `conditional on there being nothing to stream here, and it has lapsed: the boundary must ` +
        `have a named skeleton component defined in this page as its fallback -- relocated below ` +
        `the notFound(), the way watch/[contentId]/page.tsx does it -- rather than null, a ` +
        `fragment or an inline element. Add it to the relocated list above and to docs/E2E.md ` +
        `while you are here`
    ).toBe(true);
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
