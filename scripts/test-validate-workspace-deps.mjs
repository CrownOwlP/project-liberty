import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  PRUNED_DIRECTORIES,
  SCANNED_EXTENSIONS,
  checkWorkspaceDependencies,
  listSourceFiles,
  listWorkspaceDirectories,
  moduleSpecifiers,
  packageNameOf,
  tokenize
} from "./validate-workspace-deps.mjs";
import { PRUNED_DIRECTORIES as REPO_PRUNED } from "./validate-repo.mjs";

/**
 * Plain node + node:assert, matching scripts/test-validate-repo.mjs and
 * scripts/test-ai-control-plane.mjs.
 *
 * vitest is a workspace-level dependency and `turbo run test` only visits
 * workspaces; `scripts/` is not one, so a vitest suite here would be written,
 * committed, and executed by nothing.
 */

const SCRIPT = path.resolve("scripts/validate-workspace-deps.mjs");
const REPO = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "liberty-workspace-deps-"));
let fixtureSeq = 0;

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failures.push(`${name}: ${error?.message ?? error}`);
  }
}

function fixture(files) {
  const root = path.join(temp, `repo-${(fixtureSeq += 1)}`);
  fs.mkdirSync(root, { recursive: true });
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof content === "string" ? content : JSON.stringify(content, null, 2), "utf8");
  }
  return root;
}

function runValidator(cwd = REPO) {
  return spawnSync(process.execPath, [SCRIPT], { cwd, encoding: "utf8" });
}

const ROOT_MANIFEST = { name: "fixture", private: true, workspaces: ["apps/*", "packages/*"] };

// ---------------------------------------------------------------------------
// The scanner. Every case below is a false positive a simpler scanner produced
// against a tree with no real defect in it -- six of them, from four files.
// ---------------------------------------------------------------------------

test("reads the four import forms plus vi.mock", () => {
  const source = `
    import a from "alpha";
    import "beta";
    export { c } from "gamma";
    import type { D } from "delta";
    const e = await import("epsilon");
    const f = require("zeta");
    vi.mock("eta", () => ({}));
  `;
  assert.deepEqual(moduleSpecifiers(source).sort(), ["alpha", "beta", "delta", "epsilon", "eta", "gamma", "zeta"]);
});

test("resolves a subpath import to its package, which is the shape of the real defect", () => {
  assert.equal(packageNameOf("@liberty/media-inspection/node/pinned-fetch"), "@liberty/media-inspection");
  assert.equal(packageNameOf("@liberty/media-inspection"), "@liberty/media-inspection");
  assert.equal(packageNameOf("next/server"), "next");
  assert.equal(packageNameOf("react"), "react");
});

test("ignores relative, absolute, builtin, protocol and subpath-imports specifiers", () => {
  for (const specifier of ["./local", "../sibling", "/abs", "node:fs", "fs", "path", "#internal/thing", "data:text/js,0"]) {
    assert.equal(packageNameOf(specifier), null, specifier);
  }
});

test("does not read an import out of a comment", () => {
  const source = `
    // import { x } from "commented-out";
    /* import y from "block-commented"; */
    import z from "real";
  `;
  assert.deepEqual(moduleSpecifiers(source), ["real"]);
});

test("does not read prose inside a string as a from-clause", () => {
  /*
   * VERBATIM from apps/web/src/lib/catalog-ingestion-source.test.ts. A regex
   * over raw text sees `from 'nothing there'` and reports a package called
   * "nothing there". Keeping string BODIES out of the code stream is the fix,
   * and it is why this needs a tokeniser rather than a comment stripper --
   * the text that lies is inside a string, and strings are also where the real
   * specifiers live.
   */
  const source = `it("tells 'nothing usable' apart from 'nothing there'", async () => {});`;
  assert.deepEqual(moduleSpecifiers(source), []);
});

test("does not read a regular expression's body as an import", () => {
  // VERBATIM from packages/contracts/src/module-boundary.test.ts, which scans
  // for imports itself and therefore contains one in a regex. A scanner blind
  // to regex literals reported a package named "[^".
  const source = 'for (const match of strippedSource.matchAll(/\\bfrom\\s*"([^"]+)"/g)) { void match; }';
  assert.deepEqual(moduleSpecifiers(source), []);
});

test("treats a template literal with a substitution as unknowable rather than guessing", () => {
  // VERBATIM shape from
  // apps/web/src/app/api/v1/playback/session/playback-session-implementation.desktop.test.ts.
  // A specifier assembled at runtime cannot be checked against a manifest;
  // reporting "${forbidden}" as a missing package is worse than saying nothing.
  const source = 'expect(source).not.toContain(`from "${forbidden}"`);';
  assert.deepEqual(moduleSpecifiers(source), []);
});

test("still reads a template literal with no substitution", () => {
  assert.deepEqual(moduleSpecifiers("const m = await import(`static-name`);"), ["static-name"]);
});

test("division is not mistaken for a regex", () => {
  const source = 'const ratio = width / height; import x from "real";';
  assert.deepEqual(moduleSpecifiers(source), ["real"]);
});

test("an escaped quote does not end a string early", () => {
  const source = 'const message = "he said \\"from \'fake\'\\""; import x from "real";';
  assert.deepEqual(moduleSpecifiers(source), ["real"]);
});

test("tokenize keeps string bodies but drops comments", () => {
  const tokens = tokenize('const x = "body"; // import y from "no"\n');
  assert.deepEqual(
    tokens.filter((token) => token.type === "string").map((token) => token.value),
    ["body"]
  );
});

// ---------------------------------------------------------------------------
// Workspace enumeration
// ---------------------------------------------------------------------------

test("expands the workspace globs this repository uses", () => {
  const root = fixture({
    "package.json": ROOT_MANIFEST,
    "apps/web/package.json": { name: "@x/web" },
    "packages/one/package.json": { name: "@x/one" },
    "packages/loose/README.md": "no manifest here\n"
  });
  assert.deepEqual(
    listWorkspaceDirectories(root).map((directory) => path.relative(root, directory).split(path.sep).join("/")),
    ["apps/web", "packages/one"]
  );
});

test("an unsupported workspace pattern throws instead of silently skipping a workspace", () => {
  // A workspace the enumerator cannot see is one this gate goes blind on, while
  // still reporting a pass. That is strictly worse than having no gate.
  const root = fixture({ "package.json": { name: "f", workspaces: ["apps/**/pkg"] } });
  assert.throws(() => listWorkspaceDirectories(root), /cannot expand the workspace pattern/);
});

test("the scan never descends into node_modules or build output", () => {
  const root = fixture({
    "package.json": ROOT_MANIFEST,
    "apps/web/package.json": { name: "@x/web" },
    "apps/web/src/real.ts": 'import x from "declared";\n',
    "apps/web/node_modules/dep/index.js": 'import x from "a-dependencys-own-import";\n',
    "apps/web/.next/types/routes.d.ts": 'import x from "generated";\n',
    "apps/web/dist/bundle.js": 'import x from "built";\n'
  });
  const found = listSourceFiles(path.join(root, "apps/web")).map((file) =>
    path.relative(root, file).split(path.sep).join("/")
  );
  assert.deepEqual(found, ["apps/web/src/real.ts"]);
});

test("the prune list agrees with validate-repo.mjs on the mandatory entries", () => {
  // Two lists, kept apart only because validate-repo.mjs imports this module and
  // a cycle between validators is the worse trade. They must not drift on the
  // entries that are correctness rather than cost.
  for (const name of ["node_modules", ".git", ".next", ".turbo", "dist", "build", "coverage"]) {
    assert.ok(PRUNED_DIRECTORIES.has(name), `${name} must be pruned here`);
    assert.ok(REPO_PRUNED.has(name), `${name} must be pruned in validate-repo.mjs`);
  }
});

test("test files are scanned, because the real defect was in one too", () => {
  assert.ok(SCANNED_EXTENSIONS.has(".ts"));
  const root = fixture({
    "package.json": ROOT_MANIFEST,
    "apps/web/package.json": { name: "@x/web", dependencies: {} },
    "apps/web/src/thing.test.ts": 'import { f } from "@x/only-in-a-test/sub/path";\n'
  });
  const errors = checkWorkspaceDependencies(root);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /@x\/only-in-a-test/);
  assert.match(errors[0], /thing\.test\.ts/);
});

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

test("a declaration in any of the four dependency fields satisfies the check", () => {
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const root = fixture({
      "package.json": ROOT_MANIFEST,
      "packages/one/package.json": { name: "@x/one", [field]: { "@x/two": "0.1.0" } },
      "packages/one/src/a.ts": 'import x from "@x/two/deep";\n'
    });
    assert.deepEqual(checkWorkspaceDependencies(root), [], field);
  }
});

test("a root declaration does NOT satisfy a workspace's import", () => {
  // Resolution through the root is the exact mechanism that hid the defect.
  // Accepting it here would encode the bug as the rule.
  const root = fixture({
    "package.json": { ...ROOT_MANIFEST, dependencies: { "@x/two": "0.1.0" } },
    "packages/one/package.json": { name: "@x/one" },
    "packages/one/src/a.ts": 'import x from "@x/two";\n'
  });
  const errors = checkWorkspaceDependencies(root);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /undeclared dependency: @x\/one imports "@x\/two"/);
  assert.match(errors[0], /packages\/one\/package\.json does not list it/);
});

test("a package importing itself is not a finding", () => {
  const root = fixture({
    "package.json": ROOT_MANIFEST,
    "packages/one/package.json": { name: "@x/one" },
    "packages/one/src/a.ts": 'import x from "@x/one/sub";\n'
  });
  assert.deepEqual(checkWorkspaceDependencies(root), []);
});

test("one error per package, listing the sites and naming the remedy", () => {
  const root = fixture({
    "package.json": ROOT_MANIFEST,
    "apps/web/package.json": { name: "@x/web" },
    "apps/web/src/a.ts": 'import x from "@x/dep/one";\n',
    "apps/web/src/b.ts": 'import y from "@x/dep/two";\n'
  });
  const errors = checkWorkspaceDependencies(root);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /undeclared dependency: @x\/web imports "@x\/dep"/);
  assert.match(errors[0], /src\/a\.ts/);
  assert.match(errors[0], /src\/b\.ts/);
  assert.match(errors[0], /npm install --package-lock-only/);
});

// ---------------------------------------------------------------------------
// The real defect, reconstructed from git history rather than invented.
//
// `24ed3c4` is the commit that added `"@liberty/media-inspection": "0.1.0"` to
// apps/web/package.json. `24ed3c4^` is therefore the tree as it actually
// shipped, with the import present and the declaration absent. A detector
// nobody has watched fire against the thing it was written for is not known
// to work, and a synthetic fixture would not settle it.
//
// The real files are copied into a temp tree rather than the working tree being
// edited: an interrupted test must not be able to leave a tracked manifest
// broken on disk.
// ---------------------------------------------------------------------------

const FIX_COMMIT = "24ed3c4e7598361e40f7b5280302f6c88377a7c0";

function gitShow(ref) {
  const result = spawnSync("git", ["show", ref], { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
}

test("FAILS on the historical tree that actually shipped the undeclared import", () => {
  const manifestBefore = gitShow(`${FIX_COMMIT}^:apps/web/package.json`);
  const sourceBefore = gitShow(`${FIX_COMMIT}^:apps/web/src/lib/server-bootstrap.ts`);
  const testBefore = gitShow(`${FIX_COMMIT}^:apps/web/src/lib/server-bootstrap.test.ts`);
  if (manifestBefore === null || sourceBefore === null || testBefore === null) {
    // A shallow clone without that commit. Say so rather than pass quietly.
    throw new Error(
      `cannot reach ${FIX_COMMIT}^ in this checkout, so the real-defect regression did not run. ` +
        `CI clones with fetch-depth: 0; if this fires there, the commit was rewritten and this test needs a new ref.`
    );
  }

  assert.ok(!manifestBefore.includes('"@liberty/media-inspection"'), "the historical manifest must lack the entry");
  assert.ok(
    sourceBefore.includes('from "@liberty/media-inspection/node/pinned-fetch"'),
    "the historical source must carry the import"
  );

  const root = fixture({
    "package.json": ROOT_MANIFEST,
    "apps/web/package.json": manifestBefore,
    "apps/web/src/lib/server-bootstrap.ts": sourceBefore,
    "apps/web/src/lib/server-bootstrap.test.ts": testBefore
  });

  const errors = checkWorkspaceDependencies(root);
  const finding = errors.find((error) => error.includes("@liberty/media-inspection"));
  assert.ok(finding, `expected a finding for @liberty/media-inspection, got:\n${errors.join("\n")}`);
  assert.match(finding, /undeclared dependency: @liberty\/web imports "@liberty\/media-inspection"/);
  assert.match(finding, /server-bootstrap\.ts imports "@liberty\/media-inspection\/node\/pinned-fetch"/);
  assert.match(finding, /server-bootstrap\.test\.ts imports "@liberty\/media-inspection\/node\/pinned-fetch"/);
});

test("PASSES once the manifest declares it, which is the commit that landed", () => {
  const manifestAfter = gitShow(`${FIX_COMMIT}:apps/web/package.json`);
  const sourceAfter = gitShow(`${FIX_COMMIT}:apps/web/src/lib/server-bootstrap.ts`);
  const testAfter = gitShow(`${FIX_COMMIT}:apps/web/src/lib/server-bootstrap.test.ts`);
  if (manifestAfter === null) throw new Error(`cannot reach ${FIX_COMMIT} in this checkout`);

  const root = fixture({
    "package.json": ROOT_MANIFEST,
    "apps/web/package.json": manifestAfter,
    "apps/web/src/lib/server-bootstrap.ts": sourceAfter,
    "apps/web/src/lib/server-bootstrap.test.ts": testAfter
  });

  const errors = checkWorkspaceDependencies(root).filter((error) => error.includes("@liberty/media-inspection"));
  assert.deepEqual(errors, [], "the one-line manifest fix must be enough to turn this green");
});

// ---------------------------------------------------------------------------
// Assumptions this check rests on, pinned so they cannot go quietly false
// ---------------------------------------------------------------------------

test("no workspace tsconfig declares compilerOptions.paths", () => {
  // A path alias would look exactly like an undeclared bare package to this
  // scanner. None exists today; if one is added, the scanner needs to learn
  // about it, and this is where that gets noticed.
  for (const directory of listWorkspaceDirectories(REPO)) {
    const configPath = path.join(directory, "tsconfig.json");
    if (!fs.existsSync(configPath)) continue;
    const text = fs.readFileSync(configPath, "utf8");
    assert.ok(!/"paths"\s*:/.test(text), `${configPath} declares compilerOptions.paths; teach the scanner first`);
  }
  const base = fs.readFileSync(path.join(REPO, "tsconfig.base.json"), "utf8");
  assert.ok(!/"paths"\s*:/.test(base), "tsconfig.base.json declares compilerOptions.paths");
});

test("no workspace uses a `#` subpath import, which this scanner skips", () => {
  // `#name` specifiers resolve through the manifest's own `imports` field, which
  // this check does not model. The gap is bounded only while nobody uses them.
  for (const directory of listWorkspaceDirectories(REPO)) {
    for (const file of listSourceFiles(directory)) {
      for (const specifier of moduleSpecifiers(fs.readFileSync(file, "utf8"))) {
        assert.ok(!specifier.startsWith("#"), `${file} imports ${specifier}; the scanner does not resolve those`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// This repository, and the script as a script
// ---------------------------------------------------------------------------

test("this repository declares every package it imports", () => {
  assert.deepEqual(checkWorkspaceDependencies(REPO), []);
});

test("the script exits 0 here and prints the workspace count", () => {
  const result = runValidator();
  assert.equal(result.status, 0, `expected a pass, got:\n${result.stderr}`);
  assert.match(result.stdout, /workspace dependency validation passed \(\d+ workspaces\)/);
});

test("the script exits 1 -- not 0 with a warning -- on a defective tree", () => {
  // A warning inside a passing pipeline is how the original defect survived
  // every gate this repository runs.
  const root = fixture({
    "package.json": ROOT_MANIFEST,
    "apps/web/package.json": { name: "@x/web" },
    "apps/web/src/a.ts": 'import x from "@x/undeclared";\n'
  });
  const result = runValidator(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /undeclared dependency/);
  assert.doesNotMatch(result.stdout, /passed/);
});

fs.rmSync(temp, { recursive: true, force: true });

if (failures.length) {
  console.error(`validate-workspace-deps tests FAILED (${passed} passed, ${failures.length} failed):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`validate-workspace-deps tests passed (${passed} assertion groups).`);
