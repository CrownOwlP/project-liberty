/* -------------------------------------------------------------------------
 * The link policy, against real links on the platform this runs on (PL-0758).
 *
 * WHY REAL LINKS AND NOT A MOCK. The defect this suite exists for was a
 * disagreement between two filesystems: the same Next build produces a
 * RELATIVE link on Linux and an ABSOLUTE one on Windows, and PL-0755's rule
 * accepted the first and refused the second. A test that stubbed `readlink`
 * would have agreed with whichever reading its author held. These fixtures are
 * made with `fs.symlink`, so the test asks the filesystem.
 *
 * `"junction"` ON WINDOWS, which is not a detail. Creating a directory SYMLINK
 * on Windows needs a privilege a CI user may not have; a junction needs none,
 * which is exactly why the tool that produced the failing layout made one --
 * and a junction stores an ABSOLUTE target, which is the whole reason the
 * Windows link pointed out of the standalone tree. So the Windows case here is
 * built the way the real one was.
 *
 *     node --test apps/desktop/scripts/external-links.test.mjs
 *
 * `package-sidecar.mjs` runs it. `apps/desktop` is not an npm workspace, so no
 * vitest project reaches this directory, and `.github/workflows/{ci,windows}.yml`
 * are reserved by PL-0736 -- so packaging is the only placement that makes
 * this execute at all, and in particular the only one that executes it on
 * windows-latest, where the behaviour it pins actually differs.
 * ---------------------------------------------------------------------- */
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  STAGING_SUFFIX,
  classifyLink,
  isInside,
  isUnderNodeModules,
  materialiseLink,
  missingPathsIn,
  pathsUnder,
  removeLinkOnly,
  symlinksUnder
} from "./external-links.mjs";

/** A directory link the way the platform makes them -- see the header. */
const linkDir = (target, path) =>
  symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");

const scratch = [];
after(() => {
  for (const path of scratch) rmSync(path, { recursive: true, force: true, maxRetries: 5 });
});

/**
 * A repository shaped like this one: a hoisted `node_modules` at the root and a
 * Next standalone tree under `apps/web/dist/desktop`, with its own
 * `node_modules` beside the flattened app.
 */
function repository({ pkg = "pg" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "liberty-links-"));
  scratch.push(root);

  const hoisted = join(root, "node_modules", pkg);
  mkdirSync(join(hoisted, "lib"), { recursive: true });
  writeFileSync(join(hoisted, "package.json"), `{"name":"${pkg}","version":"8.23.0"}\n`);
  writeFileSync(join(hoisted, "lib", "index.js"), "module.exports = {};\n");

  const standaloneRoot = join(root, "apps", "web", "dist", "desktop", "standalone");
  const traced = join(standaloneRoot, "node_modules", pkg);
  mkdirSync(join(traced, "lib"), { recursive: true });
  writeFileSync(join(traced, "package.json"), `{"name":"${pkg}","version":"8.23.0"}\n`);
  writeFileSync(join(traced, "lib", "index.js"), "module.exports = {};\n");

  const aliasDir = join(standaloneRoot, "apps", "web", "dist", "desktop", "node_modules");
  mkdirSync(aliasDir, { recursive: true });

  return { root, standaloneRoot, aliasDir, hoisted, traced };
}

const roots = (repo) => ({ repoRoot: repo.root, standaloneRoot: repo.standaloneRoot });
const classify = (repo, link) => classifyLink({ link, ...roots(repo) });

describe("the link a build leaves for an externalised package", () => {
  it("accepts the RELATIVE link Linux produces, which lands inside the build output", () => {
    const repo = repository();
    const link = join(repo.aliasDir, "pg-587764f78a6c7a9c");
    /* Five levels up from `standalone/apps/web/dist/desktop/node_modules` is
     * `standalone`, which is what Next writes and what PL-0755 measured. */
    linkDir(join("..", "..", "..", "..", "..", "node_modules", "pg"), link);

    const verdict = classify(repo, link);
    assert.equal(verdict.ok, true, verdict.detail);
    assert.equal(verdict.reason, "traced_package");
    assert.equal(verdict.target, repo.traced);
  });

  it("accepts the ABSOLUTE link Windows produces, which lands on the hoisted copy", () => {
    /*
     * THE REGRESSION. This is the layout from the failing run: the alias
     * resolves to the workspace's own `node_modules/pg` rather than to the one
     * inside the standalone tree. PL-0755 refused it as "links OUT of the
     * standalone tree" and the Windows package job went red. It is a
     * dependency-traced package in this repository's own hoisted tree, and
     * refusing it was the defect.
     */
    const repo = repository();
    const link = join(repo.aliasDir, "pg-587764f78a6c7a9c");
    linkDir(repo.hoisted, link);

    const verdict = classify(repo, link);
    assert.equal(verdict.ok, true, verdict.detail);
    assert.equal(verdict.reason, "traced_package");
    assert.equal(verdict.target, repo.hoisted);
    /* Non-vacuity: the fixture really is the shape the old rule refused. */
    assert.equal(isInside(repo.standaloneRoot, repo.hoisted), false);
    assert.equal(isInside(repo.root, repo.hoisted), true);
  });

  it("refuses a link out of the repository, which is the traversal worth refusing", () => {
    const repo = repository();
    const elsewhere = mkdtempSync(join(tmpdir(), "liberty-elsewhere-"));
    scratch.push(elsewhere);
    const store = join(elsewhere, "node_modules", "pg");
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, "package.json"), '{"name":"pg"}\n');

    const link = join(repo.aliasDir, "pg-587764f78a6c7a9c");
    linkDir(store, link);

    const verdict = classify(repo, link);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, "outside_the_repository");
    /* It would have satisfied every other check -- node_modules, a real
     * directory, a package.json. Only the boundary catches it. */
    assert.equal(isUnderNodeModules(store), true);
    assert.ok(verdict.detail.includes(repo.root));
  });

  it("refuses a dangling link rather than packaging the shape the MSI had", () => {
    const repo = repository();
    const link = join(repo.aliasDir, "pg-587764f78a6c7a9c");
    linkDir(join(repo.root, "node_modules", "absent"), link);

    const verdict = classify(repo, link);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, "dangling");
  });

  it("refuses an alias aimed at something in the repository that is not a dependency", () => {
    const repo = repository();
    const source = join(repo.root, "apps", "web", "src");
    mkdirSync(source, { recursive: true });
    const link = join(repo.aliasDir, "pg-587764f78a6c7a9c");
    linkDir(source, link);

    const verdict = classify(repo, link);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, "alias_outside_node_modules");
  });

  it("refuses an alias aimed at a directory that is not a package", () => {
    const repo = repository();
    const notAPackage = join(repo.root, "node_modules", ".cache", "turbopack");
    mkdirSync(notAPackage, { recursive: true });
    const link = join(repo.aliasDir, "pg-587764f78a6c7a9c");
    linkDir(notAPackage, link);

    const verdict = classify(repo, link);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, "alias_target_is_not_a_package");
  });

  it("refuses a non-dependency link that leaves the build output", () => {
    const repo = repository();
    const inside = join(repo.standaloneRoot, "apps", "web", "somewhere");
    mkdirSync(inside, { recursive: true });
    const ok = join(repo.standaloneRoot, "apps", "web", "link-inside");
    linkDir(inside, ok);
    assert.equal(classify(repo, ok).ok, true);

    const source = join(repo.root, "apps", "web", "src");
    mkdirSync(source, { recursive: true });
    const out = join(repo.standaloneRoot, "apps", "web", "link-outside");
    linkDir(source, out);
    const verdict = classify(repo, out);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, "non_dependency_link_leaves_the_build_output");
  });
});

describe("materialising a link", () => {
  it("replaces it with real files and LEAVES THE TARGET ALONE", () => {
    /*
     * THE PROPERTY THAT MATTERS MOST HERE. The call this replaces was
     * `rmSync(link, { recursive: true })`, and on Windows a junction is
     * removed with `rmdir` -- so a recursive delete aimed at the link is a
     * recursive delete aimed at the real package. If that ever regresses, the
     * build machine's own `node_modules/pg` disappears and packaging reports
     * something else entirely.
     */
    const repo = repository();
    const link = join(repo.aliasDir, "pg-587764f78a6c7a9c");
    linkDir(repo.hoisted, link);

    const result = materialiseLink(link, roots(repo));
    assert.equal(result.target, repo.hoisted);
    assert.equal(result.asDirectory, true);

    assert.equal(lstatSync(link).isSymbolicLink(), false);
    assert.equal(lstatSync(link).isDirectory(), true);
    assert.deepEqual(readdirSync(link).sort(), ["lib", "package.json"]);
    assert.match(readFileSync(join(link, "package.json"), "utf8"), /"name":"pg"/);

    assert.ok(existsSync(repo.hoisted), "the target must survive");
    assert.ok(existsSync(join(repo.hoisted, "package.json")));
    assert.ok(existsSync(join(repo.hoisted, "lib", "index.js")));
  });

  it("leaves no staging directory behind", () => {
    const repo = repository();
    const link = join(repo.aliasDir, "pg-587764f78a6c7a9c");
    linkDir(repo.hoisted, link);
    materialiseLink(link, roots(repo));
    assert.equal(existsSync(`${link}${STAGING_SUFFIX}`), false);
    assert.deepEqual(
      readdirSync(repo.aliasDir).filter((name) => name.endsWith(STAGING_SUFFIX)),
      []
    );
  });

  it("refuses to merge into a staging directory a previous run left", () => {
    const repo = repository();
    const link = join(repo.aliasDir, "pg-587764f78a6c7a9c");
    linkDir(repo.hoisted, link);
    mkdirSync(`${link}${STAGING_SUFFIX}`);
    assert.throws(() => materialiseLink(link, roots(repo)), /did not finish/);
  });

  it("removes a link without recursing, whichever call the platform needs", () => {
    const repo = repository();
    const link = join(repo.aliasDir, "pg-587764f78a6c7a9c");
    linkDir(repo.hoisted, link);
    const how = removeLinkOnly(link);
    assert.ok(how === "unlink" || how === "rmdir", `unexpected removal route ${how}`);
    assert.equal(existsSync(link), false);
    assert.ok(existsSync(join(repo.hoisted, "lib", "index.js")), "the target must survive");
  });

  it("materialises a NESTED link too, in one pass, on every platform", () => {
    /*
     * THE TEST THIS REPLACES ASSERTED A MECHANISM AND IT WAS PLATFORM-SPECIFIC.
     *
     * It copied with `cpSync` and then asserted that exactly ONE link remained
     * -- the nested one, carried into the copy as a link -- so a second pass
     * was needed. That is measured behaviour on Linux (node v22.22.2: a nested
     * link survives a copy with `dereference: false` AND with `dereference:
     * true`). On the Windows runner the same copy over a junction left ZERO
     * links, and the Windows package job went red on the count.
     *
     * Either reading of that is a problem: if Windows dereferences, the pass
     * count is platform-dependent; if it DROPS the entry, the packaged
     * dependency has a hole in it and "no links in the packaged tree" is
     * satisfied by content that was thrown away.
     *
     * So the copy no longer goes through `cpSync`. `copyMaterialised` walks the
     * source and resolves every link it meets, which makes the result
     * link-free BY CONSTRUCTION in ONE pass -- and this test asserts the
     * property rather than the route: no links left, and the nested content
     * present as real files with its bytes intact.
     */
    const repo = repository();
    const nested = join(repo.root, "node_modules", "pg-pool");
    mkdirSync(join(nested, "deep"), { recursive: true });
    writeFileSync(join(nested, "package.json"), '{"name":"pg-pool"}\n');
    writeFileSync(join(nested, "deep", "pool.js"), "module.exports = 1;\n");
    linkDir(nested, join(repo.hoisted, "vendored"));

    const link = join(repo.aliasDir, "pg-587764f78a6c7a9c");
    linkDir(repo.hoisted, link);

    const result = materialiseLink(link, roots(repo));

    /* One pass, no second round, on whatever filesystem this is. */
    assert.deepEqual(symlinksUnder(repo.aliasDir), []);

    /* And the nested content is really there, which is the half the old test
     * never checked and the half a silent drop would have failed. */
    assert.equal(lstatSync(join(link, "vendored")).isSymbolicLink(), false);
    assert.equal(lstatSync(join(link, "vendored")).isDirectory(), true);
    assert.match(readFileSync(join(link, "vendored", "package.json"), "utf8"), /pg-pool/);
    assert.equal(readFileSync(join(link, "vendored", "deep", "pool.js"), "utf8"), "module.exports = 1;\n");

    /* The copier reports what it followed, so a build log records it. */
    assert.equal(result.nested.length, 1);
    assert.equal(result.nested[0].target, nested);
    assert.equal(result.nested[0].reason, "traced_package");
  });

  it("refuses a NESTED link that leaves the repository, which cpSync would have followed", () => {
    const repo = repository();
    const elsewhere = mkdtempSync(join(tmpdir(), "liberty-elsewhere-"));
    scratch.push(elsewhere);
    const store = join(elsewhere, "node_modules", "evil");
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, "package.json"), '{"name":"evil"}\n');
    linkDir(store, join(repo.hoisted, "vendored"));

    const link = join(repo.aliasDir, "pg-587764f78a6c7a9c");
    linkDir(repo.hoisted, link);

    assert.throws(() => materialiseLink(link, roots(repo)), /outside_the_repository/);
    /* And nothing was moved: the alias is still a link, so packaging will stop
     * rather than ship a half-materialised tree. */
    assert.equal(lstatSync(link).isSymbolicLink(), true);
  });

  it("refuses a cycle instead of copying until the disk fills", () => {
    const repo = repository();
    /* `self` points at the package that contains it. */
    linkDir(repo.hoisted, join(repo.hoisted, "self"));
    const link = join(repo.aliasDir, "pg-587764f78a6c7a9c");
    linkDir(repo.hoisted, link);
    assert.throws(() => materialiseLink(link, roots(repo)), /cycle/);
  });

  it("loses nothing: every path in the target is present in the copy", () => {
    const repo = repository();
    mkdirSync(join(repo.hoisted, "a", "b", "c"), { recursive: true });
    writeFileSync(join(repo.hoisted, "a", "b", "c", "deep.txt"), "deep\n");
    writeFileSync(join(repo.hoisted, "a", "top.txt"), "top\n");
    const link = join(repo.aliasDir, "pg-587764f78a6c7a9c");
    linkDir(repo.hoisted, link);

    materialiseLink(link, roots(repo));
    for (const rel of ["package.json", "lib/index.js", "a/top.txt", "a/b/c/deep.txt"]) {
      assert.ok(existsSync(join(link, ...rel.split("/"))), `${rel} is missing from the copy`);
    }
    assert.equal(readFileSync(join(link, "a", "b", "c", "deep.txt"), "utf8"), "deep\n");
  });
});

describe("the copy-coverage postcondition", () => {
  it("enumerates a tree, naming a link by its own path and not descending it", () => {
    const repo = repository();
    mkdirSync(join(repo.hoisted, "a", "b"), { recursive: true });
    writeFileSync(join(repo.hoisted, "a", "b", "deep.txt"), "x\n");
    linkDir(join(repo.root, "node_modules"), join(repo.hoisted, "ln"));
    const paths = pathsUnder(repo.hoisted).sort();
    assert.deepEqual(paths, ["a", "a/b", "a/b/deep.txt", "lib", "lib/index.js", "ln", "package.json"].sort());
  });

  it("reports exactly what a copy is missing", () => {
    const repo = repository();
    mkdirSync(join(repo.hoisted, "a"), { recursive: true });
    writeFileSync(join(repo.hoisted, "a", "kept.txt"), "k\n");
    writeFileSync(join(repo.hoisted, "a", "lost.txt"), "l\n");

    const partial = join(repo.root, "partial");
    mkdirSync(join(partial, "a", ""), { recursive: true });
    mkdirSync(join(partial, "lib"), { recursive: true });
    writeFileSync(join(partial, "package.json"), "{}\n");
    writeFileSync(join(partial, "lib", "index.js"), "\n");
    writeFileSync(join(partial, "a", "kept.txt"), "k\n");

    assert.deepEqual(missingPathsIn(repo.hoisted, partial), ["a/lost.txt"]);
    assert.deepEqual(missingPathsIn(repo.hoisted, repo.hoisted), []);
  });
});

describe("the helpers the policy is built from", () => {
  it("isInside excludes the root itself and refuses a sibling with a shared prefix", () => {
    assert.equal(isInside(join("/a", "b"), join("/a", "b")), false);
    assert.equal(isInside(join("/a", "b"), join("/a", "b", "c")), true);
    assert.equal(isInside(join("/a", "b"), join("/a", "bc")), false);
    assert.equal(isInside(join("/a", "b"), join("/a")), false);
  });

  it("isUnderNodeModules finds the directory at any depth and nowhere else", () => {
    assert.equal(isUnderNodeModules(join("/r", "node_modules", "pg")), true);
    assert.equal(isUnderNodeModules(join("/r", "node_modules")), true);
    assert.equal(isUnderNodeModules(join("/r", "a", "node_modules", "b", "c")), true);
    assert.equal(isUnderNodeModules(join("/r", "apps", "web", "src")), false);
    assert.equal(isUnderNodeModules(join("/r", "node_modules_old", "pg")), false);
  });

  it("symlinksUnder finds links at depth and reports nothing for a clean tree", () => {
    const repo = repository();
    assert.deepEqual(symlinksUnder(repo.standaloneRoot), []);
    const link = join(repo.aliasDir, "pg-587764f78a6c7a9c");
    linkDir(repo.hoisted, link);
    assert.deepEqual(symlinksUnder(repo.standaloneRoot), [link]);
  });
});
