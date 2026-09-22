import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { checkTurboGraph, compilesWithTsc, globPrefix, parseJsonc, samePackageDependencies, tsconfigFor } from "./validate-turbo-graph.mjs";
import { listWorkspaceDirectories } from "./validate-workspace-deps.mjs";

/**
 * Plain node + node:assert, for the same reason as its siblings: `scripts/` is
 * not an npm workspace, so `turbo run test` never visits it and a vitest suite
 * placed here would be executed by nothing.
 */

const SCRIPT = path.resolve("scripts/validate-turbo-graph.mjs");
const REPO = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "liberty-turbo-graph-"));
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

const check = (root) => checkTurboGraph(root, listWorkspaceDirectories);

/** The pre-fix shape: a web app whose tsconfig reads `.next/types`, unordered. */
function racingFixture(typecheckConfig) {
  return fixture({
    "package.json": { name: "f", workspaces: ["apps/*"] },
    "turbo.json": {
      tasks: {
        build: { dependsOn: ["^build"], outputs: [".next/**", "dist/**", "!.next/cache/**"] },
        typecheck: { dependsOn: ["^typecheck"], outputs: [] },
        ...(typecheckConfig ? { "@f/web#typecheck": typecheckConfig } : {})
      }
    },
    "apps/web/package.json": { name: "@f/web", scripts: { build: "next build", typecheck: "tsc --noEmit" } },
    "apps/web/tsconfig.json": { include: ["next-env.d.ts", ".next/types/**/*.ts", "**/*.ts"], exclude: ["node_modules"] }
  });
}

// ---------------------------------------------------------------------------
// The defect, and the fix
// ---------------------------------------------------------------------------

test("FAILS on the exact pre-fix configuration: tsconfig reads .next/types, no edge to build", () => {
  const errors = check(racingFixture(null));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /racing tasks: @f\/web#typecheck/);
  assert.match(errors[0], /\.next\/types/);
  assert.match(errors[0], /@f\/web#build declares "\.next\/\*\*" as an output/);
  assert.match(errors[0], /Add "build" to @f\/web#typecheck's dependsOn/);
});

test("PASSES once a package-scoped entry adds the edge", () => {
  assert.deepEqual(check(racingFixture({ dependsOn: ["^typecheck", "build"], outputs: [] })), []);
});

test("an upstream-only edge does not count: `^build` is other packages, not this one", () => {
  // The race is between two tasks of ONE package over ONE directory. `^build`
  // orders nothing about `@f/web#build`.
  const errors = check(racingFixture({ dependsOn: ["^typecheck", "^build"], outputs: [] }));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /racing tasks/);
});

test("the edge counts when it is reached transitively", () => {
  const root = fixture({
    "package.json": { name: "f", workspaces: ["apps/*"] },
    "turbo.json": {
      tasks: {
        build: { outputs: [".next/**"] },
        prepare: { dependsOn: ["build"] },
        typecheck: { dependsOn: ["prepare"], outputs: [] }
      }
    },
    "apps/web/package.json": {
      name: "@f/web",
      scripts: { build: "next build", prepare: "node p.mjs", typecheck: "tsc --noEmit" }
    },
    "apps/web/tsconfig.json": { include: [".next/types/**/*.ts", "**/*.ts"] }
  });
  assert.deepEqual(check(root), []);
});

test("an explicit `pkg#task` edge counts, and another package's does not", () => {
  assert.deepEqual(check(racingFixture({ dependsOn: ["@f/web#build"], outputs: [] })), []);
  assert.equal(check(racingFixture({ dependsOn: ["@f/other#build"], outputs: [] })).length, 1);
});

// ---------------------------------------------------------------------------
// Not raising things that are not races
// ---------------------------------------------------------------------------

test("a recursive include alone is not a read of .next, because tsc skips dotted directories", () => {
  // This is the reason Next has to name `.next/types/**/*.ts` explicitly instead
  // of relying on the `**/*.ts` already present. If the truncation rule were
  // wrong here, every package in the repository would raise a finding.
  const root = fixture({
    "package.json": { name: "f", workspaces: ["apps/*"] },
    "turbo.json": { tasks: { build: { outputs: [".next/**"] }, typecheck: { outputs: [] } } },
    "apps/web/package.json": { name: "@f/web", scripts: { build: "next build", typecheck: "tsc --noEmit" } },
    "apps/web/tsconfig.json": { include: ["**/*.ts"] }
  });
  assert.deepEqual(check(root), []);
});

test("a task is never required to depend on itself", () => {
  // `next build` writes `.next/types` and reads it back in one process, which is
  // ordered by construction.
  const root = fixture({
    "package.json": { name: "f", workspaces: ["apps/*"] },
    "turbo.json": { tasks: { build: { outputs: [".next/**"] } } },
    "apps/web/package.json": { name: "@f/web", scripts: { build: "tsc --noEmit && next build" } },
    "apps/web/tsconfig.json": { include: [".next/types/**/*.ts"] }
  });
  assert.deepEqual(check(root), []);
});

test("a task with no turbo definition is not checked", () => {
  const root = fixture({
    "package.json": { name: "f", workspaces: ["apps/*"] },
    "turbo.json": { tasks: { build: { outputs: [".next/**"] } } },
    "apps/web/package.json": { name: "@f/web", scripts: { build: "next build", "typecheck:local": "tsc --noEmit" } },
    "apps/web/tsconfig.json": { include: [".next/types/**/*.ts"] }
  });
  assert.deepEqual(check(root), []);
});

test("an excluded include entry is not treated as read", () => {
  const root = fixture({
    "package.json": { name: "f", workspaces: ["apps/*"] },
    "turbo.json": { tasks: { build: { outputs: [".next/**"] }, typecheck: { outputs: [] } } },
    "apps/web/package.json": { name: "@f/web", scripts: { build: "next build", typecheck: "tsc --noEmit" } },
    "apps/web/tsconfig.json": { include: [".next/types/**/*.ts", "**/*.ts"], exclude: ["node_modules", ".next"] }
  });
  assert.deepEqual(check(root), []);
});

test("a negated output is not a directory anybody writes", () => {
  const root = fixture({
    "package.json": { name: "f", workspaces: ["apps/*"] },
    "turbo.json": { tasks: { build: { outputs: ["!generated/**"] }, typecheck: { outputs: [] } } },
    "apps/web/package.json": { name: "@f/web", scripts: { build: "next build", typecheck: "tsc --noEmit" } },
    "apps/web/tsconfig.json": { include: ["generated/**/*.ts"] }
  });
  assert.deepEqual(check(root), []);
});

test("a cross-package read of another package's output needs `^task`", () => {
  const withEdge = (dependsOn) =>
    fixture({
      "package.json": { name: "f", workspaces: ["packages/*"] },
      "turbo.json": { tasks: { build: { dependsOn: ["^build"], outputs: ["dist/**"] }, typecheck: { dependsOn, outputs: [] } } },
      "packages/one/package.json": { name: "@f/one", scripts: { build: "tsc -b", typecheck: "tsc --noEmit" } },
      "packages/one/tsconfig.json": { include: ["src/**/*.ts", "../two/dist/**/*.d.ts"] },
      "packages/two/package.json": { name: "@f/two", scripts: { build: "tsc -b" } }
    });
  assert.equal(check(withEdge(["^typecheck"])).length, 1);
  assert.deepEqual(check(withEdge(["^typecheck", "^build"])), []);
});

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

test("globPrefix truncates at the first wildcard", () => {
  assert.equal(globPrefix(".next/types/**/*.ts"), ".next/types");
  assert.equal(globPrefix(".next/**"), ".next");
  assert.equal(globPrefix("**/*.ts"), "");
  assert.equal(globPrefix("next-env.d.ts"), "next-env.d.ts");
  assert.equal(globPrefix("coverage/**"), "coverage");
});

test("compilesWithTsc recognises a compiler and not a lookalike", () => {
  assert.ok(compilesWithTsc("tsc --noEmit"));
  assert.ok(compilesWithTsc("tsc -b"));
  assert.ok(compilesWithTsc("node x.mjs && tsc --noEmit"));
  assert.ok(!compilesWithTsc("next build"));
  assert.ok(!compilesWithTsc("eslint . --ignore-pattern \"dist/**\""));
  assert.ok(!compilesWithTsc("vitest run"));
  assert.ok(!compilesWithTsc("tscheck --all"));
});

test("tsconfigFor honours -p and --project", () => {
  assert.equal(tsconfigFor("/w", "tsc --noEmit"), path.join("/w", "tsconfig.json"));
  assert.equal(tsconfigFor("/w", "tsc -p tsconfig.build.json --noEmit"), path.resolve("/w", "tsconfig.build.json"));
  assert.equal(tsconfigFor("/w", 'tsc --project "cfg/t.json"'), path.resolve("/w", "cfg/t.json"));
});

test("samePackageDependencies ignores `^` and other packages", () => {
  const turbo = { tasks: { typecheck: { dependsOn: ["^typecheck", "build", "@other/pkg#lint"] }, build: { dependsOn: ["^build"] } } };
  assert.deepEqual([...samePackageDependencies(turbo, "@f/web", "typecheck")], ["build"]);
});

test("parseJsonc survives the comments and trailing commas tsconfig files use", () => {
  // packages/catalog-ingestion/tsconfig.json carries a long block comment inside
  // its `include` array; JSON.parse chokes on it.
  const parsed = parseJsonc('{\n  // line\n  "include": [\n    "a", /* why */ "b",\n  ]\n}');
  assert.deepEqual(parsed, { include: ["a", "b"] });
  assert.deepEqual(parseJsonc('{"s": "not // a comment /* either */"}'), { s: "not // a comment /* either */" });
});

// ---------------------------------------------------------------------------
// This repository
// ---------------------------------------------------------------------------

test("the shipped turbo.json orders @liberty/web#typecheck after @liberty/web#build", () => {
  // The claim the acceptance rests on, asserted against turbo.json rather than
  // against a run. A green run is not evidence a race is gone; this is.
  const turbo = parseJsonc(fs.readFileSync(path.join(REPO, "turbo.json"), "utf8"), "turbo.json");
  const scoped = turbo.tasks["@liberty/web#typecheck"];
  assert.ok(scoped, "turbo.json must carry a package-scoped @liberty/web#typecheck entry");
  assert.ok(scoped.dependsOn.includes("build"), "it must depend on this package's build");
  assert.ok(scoped.dependsOn.includes("^typecheck"), "it must keep the upstream typecheck edge");
  assert.deepEqual([...samePackageDependencies(turbo, "@liberty/web", "typecheck")], ["build"]);
});

test("the edge is scoped: no other workspace's typecheck waits on a build", () => {
  const turbo = parseJsonc(fs.readFileSync(path.join(REPO, "turbo.json"), "utf8"), "turbo.json");
  for (const directory of listWorkspaceDirectories(REPO)) {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
    if (manifest.name === "@liberty/web") continue;
    assert.deepEqual(
      [...samePackageDependencies(turbo, manifest.name, "typecheck")],
      [],
      `${manifest.name}#typecheck must not have been coupled to its build`
    );
  }
});

test("apps/web's tsconfig still reads .next/types, so the edge is still load-bearing", () => {
  // If this stops being true the edge is dead weight and should be removed --
  // but it must be removed deliberately, not left because nobody noticed.
  const config = parseJsonc(fs.readFileSync(path.join(REPO, "apps/web/tsconfig.json"), "utf8"), "tsconfig.json");
  assert.ok(config.include.includes(".next/types/**/*.ts"));
});

test("this repository's turbo graph has no unordered read of a build output", () => {
  assert.deepEqual(check(REPO), []);
});

test("the script exits 0 here, and 1 on a racing tree", () => {
  const green = spawnSync(process.execPath, [SCRIPT], { cwd: REPO, encoding: "utf8" });
  assert.equal(green.status, 0, `expected a pass, got:\n${green.stderr}`);
  assert.match(green.stdout, /turbo graph validation passed/);

  const red = spawnSync(process.execPath, [SCRIPT], { cwd: racingFixture(null), encoding: "utf8" });
  assert.equal(red.status, 1, "a race must FAIL, not warn");
  assert.match(red.stderr, /racing tasks/);
});

fs.rmSync(temp, { recursive: true, force: true });

if (failures.length) {
  console.error(`validate-turbo-graph tests FAILED (${passed} passed, ${failures.length} failed):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`validate-turbo-graph tests passed (${passed} assertion groups).`);
