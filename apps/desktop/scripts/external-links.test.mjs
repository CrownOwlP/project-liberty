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

const classify = (repo, link) =>
  classifyLink({ link, repoRoot: repo.root, standaloneRoot: repo.standaloneRoot });

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

    const result = materialiseLink(link);
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
    materialiseLink(link);
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
    assert.throws(() => materialiseLink(link), /did not finish/);
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

  it("reaches a fixed point when materialising one link exposes another", () => {
    /*
     * A copied package may itself contain a link. One pass is not enough, and
     * the loop in `package-sidecar.mjs` is what handles it; this pins the
     * underlying fact that a second pass has something to find.
     */
    const repo = repository();
    const nested = join(repo.root, "node_modules", "pg-pool");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "package.json"), '{"name":"pg-pool"}\n');
    linkDir(nested, join(repo.hoisted, "vendored"));

    const link = join(repo.aliasDir, "pg-587764f78a6c7a9c");
    linkDir(repo.hoisted, link);

    materialiseLink(link);
    const remaining = symlinksUnder(repo.aliasDir);
    assert.equal(remaining.length, 1, "the copy carries the nested link, so a second pass is needed");
    assert.equal(classify(repo, remaining[0]).ok, true);
    materialiseLink(remaining[0]);
    assert.deepEqual(symlinksUnder(repo.aliasDir), []);
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
