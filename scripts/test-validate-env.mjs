import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  ALL_ENV_FILES,
  EXIT_INVALID,
  EXIT_OK,
  EXIT_USAGE,
  buildSources,
  checkEnvironmentVariables,
  checkFormat,
  checkInstall,
  checkNodeVersion,
  checkServices,
  dedupeEnvFindings,
  defaultModes,
  describeFormat,
  envFilesForMode,
  evaluate,
  formatFinding,
  parseArgs,
  parseEnvContract,
  parseEnvFile,
  probePort,
  resolveVariable,
} from "./validate-env.mjs";
/*
 * The runtime loader is exercised from THIS suite rather than from one of its
 * own, deliberately. It shares `envFilesForMode` and `parseEnvFile` with the
 * validator, and the property worth pinning is not "the loader works" but "the
 * loader and the validator cannot disagree" -- which is only assertable where
 * both are in scope, against one set of bytes. A separate file would be free to
 * build its own fixture, and two fixtures is the same failure as two parsers.
 */
import { findRepoRoot, nextEnvMode, resolveRootEnv } from "./with-root-env.mjs";

/**
 * Plain node + node:assert, matching scripts/test-ai-control-plane.mjs.
 *
 * vitest is a workspace-level dependency and `turbo run test` only visits
 * workspaces; scripts/ is not one, so a vitest suite placed here would be
 * written, committed, and never executed by any gate -- which is worse than no
 * suite, because the coverage would be believed.
 */

const SCRIPT = path.resolve("scripts/validate-env.mjs");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "liberty-validate-env-"));
let repoSeq = 0;

const NODE_MAJOR = process.versions.node.split(".")[0];

function render(findings) {
  return findings.map(formatFinding).join("\n\n");
}

function sources(...entries) {
  return entries.map(([label, values]) => ({ label, values: new Map(Object.entries(values)) }));
}

function contractOf(text) {
  const parsed = parseEnvContract(text);
  assert.deepEqual(parsed.defects, [], `contract fixture should be clean:\n${parsed.defects.join("\n")}`);
  return parsed;
}

/**
 * Minimal snapshot in the shape gatherRepoState() produces.
 *
 * Every file any mode can read is represented, and missing by default, so a
 * scenario that cares about one names it in `envFiles` and the rest stay absent.
 * Enumerating ALL_ENV_FILES rather than listing two of them by hand is what
 * keeps this honest as the list grows: a file the snapshot forgot would be
 * `undefined` here and skipped by buildSources for the wrong reason -- the
 * scenario would pass while proving nothing.
 */
function snapshotFor({
  manifest = { name: "fixture", workspaces: [], devDependencies: {} },
  lock = { name: "fixture", lockfileVersion: 3, packages: { "": { devDependencies: {} } } },
  hidden = { lockfileVersion: 3, packages: {} },
  nodeModulesExists = true,
  workspaces = [],
  emptyPatterns = [],
  envFiles = {},
} = {}) {
  const json = (value) =>
    value === null
      ? { text: null, json: null, parseError: null }
      : { text: JSON.stringify(value), json: value, parseError: null };
  const files = {
    "package.json": json(manifest),
    "package-lock.json": json(lock),
    "node_modules/.package-lock.json": json(hidden),
    ".nvmrc": { text: `${NODE_MAJOR}\n` },
    ".env.example": { text: "" },
  };
  for (const file of ALL_ENV_FILES) {
    files[file] = { text: envFiles[file] ?? null };
  }
  for (const name of Object.keys(envFiles)) {
    assert.ok(ALL_ENV_FILES.includes(name), `${name} is not a file any mode reads`);
  }
  return {
    root: "/fixture",
    files,
    nodeModulesExists,
    workspaces,
    emptyPatterns,
  };
}

function freshRepo({ envExample, envLocal, envFiles = {}, manifest, lock, hidden, nvmrc } = {}) {
  const repo = path.join(temp, `repo-${++repoSeq}`);
  fs.mkdirSync(path.join(repo, "node_modules"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, "package.json"),
    JSON.stringify(
      manifest ?? {
        name: "fixture",
        version: "0.0.0",
        private: true,
        // Pinned to whatever runtime the suite is running on, so these scenarios
        // test the script rather than the tester's Node installation.
        engines: { node: `>=${NODE_MAJOR}` },
        workspaces: [],
        devDependencies: {},
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(repo, "package-lock.json"),
    JSON.stringify(
      lock ?? {
        name: "fixture",
        lockfileVersion: 3,
        packages: { "": { name: "fixture", devDependencies: {} } },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(repo, "node_modules", ".package-lock.json"),
    JSON.stringify(hidden ?? { name: "fixture", lockfileVersion: 3, packages: {} }, null, 2),
  );
  fs.writeFileSync(path.join(repo, ".nvmrc"), `${nvmrc ?? NODE_MAJOR}\n`);
  fs.writeFileSync(
    path.join(repo, ".env.example"),
    envExample ??
      ["# A variable the fixture requires.", "# @required", "# @format nonempty", "LIBERTY_TEST_REQUIRED=example", ""].join("\n"),
  );
  if (envLocal !== undefined) fs.writeFileSync(path.join(repo, ".env.local"), envLocal);
  // The mode-specific files are written by name, so a scenario about
  // `.env.production.local` cannot quietly become a scenario about a typo.
  for (const [name, text] of Object.entries(envFiles)) {
    assert.ok(ALL_ENV_FILES.includes(name), `${name} is not a file any mode reads`);
    fs.writeFileSync(path.join(repo, name), text);
  }
  return repo;
}

/**
 * Environment with the fixture's own variables stripped, so the parent shell
 * cannot satisfy them.
 *
 * NODE_ENV goes too. It selects the default mode, and therefore which .env files
 * a scenario reads at all -- a suite whose answer depends on the shell that
 * launched it is not testing the script. Scenarios that care pass `--mode`
 * explicitly; the rest get `development`, deterministically.
 */
function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith("LIBERTY_TEST_")) delete env[name];
  }
  delete env.NODE_ENV;
  return { ...env, ...extra };
}

function runScript(repo, args = [], env = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: repo,
    encoding: "utf8",
    env: cleanEnv(env),
  });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

try {
  /* ---------------------------------------------------------------------
   * 1. dotenv parsing: comments, quotes, `export`, junk lines.
   * ------------------------------------------------------------------- */
  {
    const values = parseEnvFile(
      [
        "# comment",
        "",
        "PLAIN=value",
        'QUOTED="spaced value"',
        "SINGLE='single'",
        "export EXPORTED=yes",
        "EMPTY=",
        "WITH_EQUALS=postgresql://u:p@h:5432/db?x=1",
        "not-an-assignment",
        "=novalue",
      ].join("\n"),
    );
    assert.equal(values.get("PLAIN"), "value");
    assert.equal(values.get("QUOTED"), "spaced value");
    assert.equal(values.get("SINGLE"), "single");
    assert.equal(values.get("EXPORTED"), "yes");
    assert.equal(values.get("EMPTY"), "");
    assert.equal(values.get("WITH_EQUALS"), "postgresql://u:p@h:5432/db?x=1");
    assert.equal(values.has("not-an-assignment"), false);
    // The exact key set rather than a count: the two junk lines contribute
    // nothing, and asserting a number is how you write down the wrong one.
    assert.deepEqual(
      [...values.keys()],
      ["PLAIN", "QUOTED", "SINGLE", "EXPORTED", "EMPTY", "WITH_EQUALS"],
    );
    assert.equal(parseEnvFile(null).size, 0);
  }

  /* ---------------------------------------------------------------------
   * 2. Contract parsing: annotations become structure, not prose.
   * ------------------------------------------------------------------- */
  {
    const { variables, defects } = parseEnvContract(
      [
        "# The origin the app is served from.",
        "# @required",
        "# @format url",
        "APP_ORIGIN=http://localhost:3000",
        "",
        "# A credential used only by automation.",
        "# @optional",
        "# @secret",
        "# @scope ci",
        "TOKEN=",
        "",
      ].join("\n"),
    );
    assert.deepEqual(defects, []);
    assert.equal(variables.length, 2);
    assert.deepEqual(
      { ...variables[0], line: undefined },
      {
        name: "APP_ORIGIN",
        example: "http://localhost:3000",
        line: undefined,
        description: "The origin the app is served from.",
        required: true,
        secret: false,
        scope: "app",
        format: "url",
        defaultValue: null,
        cacheKey: false,
      },
    );
    assert.equal(variables[1].scope, "ci");
    assert.equal(variables[1].secret, true);
    assert.equal(variables[1].required, false);

    // @default is the third answer to "what if it is unset", and a complete
    // one, so it stands in for @required/@optional rather than needing one.
    const defaulted = parseEnvContract(
      [
        "# A mode with a documented fallback.",
        "# @default strict",
        "# @cache-key",
        "# @format enum:strict",
        "MODE=strict",
        "",
        "# A default that contains a space.",
        "# @optional",
        "# @default Project Liberty",
        "TITLE=Project Liberty",
        "",
      ].join("\n"),
    );
    assert.deepEqual(defaulted.defects, []);
    assert.equal(defaulted.variables[0].defaultValue, "strict");
    assert.equal(defaulted.variables[0].cacheKey, true);
    assert.equal(defaulted.variables[0].required, false);
    assert.equal(defaulted.variables[1].defaultValue, "Project Liberty");
  }

  /* ---------------------------------------------------------------------
   * 2b. Prose that merely mentions an @-name is prose.
   *
   *     This is a regression: `@` at the start of a wrapped description line
   *     was read as an annotation, which made the repository's own
   *     .env.example fail its own parser -- ordinary English broke the
   *     contract. A typo'd annotation on a line by itself must still be
   *     caught, so the two cases are asserted together.
   * ------------------------------------------------------------------- */
  {
    const { variables, defects } = parseEnvContract(
      [
        "# Minimum log level. The accepted set mirrors `LogLevel` in",
        "# @liberty/observability; a value outside it is silently ignored by the",
        "# logger rather than rejected.",
        "# @optional",
        "# @format enum:debug,info,warn,error",
        "LOG_LEVEL=info",
        "",
      ].join("\n"),
    );
    assert.deepEqual(defects, [], `prose was read as annotation:\n${defects.join("\n")}`);
    assert.equal(variables[0].format, "enum:debug,info,warn,error");
    assert.ok(
      variables[0].description.includes("@liberty/observability"),
      "the sentence must survive intact into the description",
    );

    // Other shapes of ordinary English that begin with @, none of them
    // annotations, none of them defects.
    for (const prose of [
      "@liberty/provider-sdk is the only import boundary here.",
      "@see docs/CONTENT_RIGHTS.md for the policy.",
      "@ops-team owns rotation for this credential.",
    ]) {
      const parsed = parseEnvContract(["# d", `# ${prose}`, "# @optional", "NAME=v"].join("\n"));
      assert.deepEqual(parsed.defects, [], `"${prose}" should be prose, not an annotation`);
    }
  }

  /* ---------------------------------------------------------------------
   * 3. A section banner is not adopted as the next variable's documentation.
   *    The blank line is what separates them, and that is the only thing
   *    keeping the "every variable has a description" rule honest.
   * ------------------------------------------------------------------- */
  {
    const { variables, defects } = parseEnvContract(
      [
        "# ===========================",
        "# Section banner",
        "# ===========================",
        "",
        "# The real description.",
        "# @optional",
        "NAME=value",
        "",
      ].join("\n"),
    );
    assert.deepEqual(defects, []);
    assert.equal(variables[0].description, "The real description.");
  }

  /* ---------------------------------------------------------------------
   * 4. A malformed contract fails the run rather than silently covering less.
   * ------------------------------------------------------------------- */
  {
    const cases = [
      [["# described", "NAME=value"], /must be annotated @required, @optional, or @default/],
      [["# @optional", "NAME=value"], /has no description/],
      [["# d", "# @required", "# @optional", "NAME=v"], /both @required and @optional/],
      [["# d", "# @optional", "# @format nonsense", "NAME=v"], /unknown @format "nonsense"/],
      [["# d", "# @optional", "# @scope nowhere", "NAME=v"], /unknown @scope "nowhere"/],
      [["# d", "# @optional", "# @bogus", "NAME=v"], /unknown annotation "@bogus"/],
      [["# d", "# @format", "NAME=v"], /@format has no value/],
      [["# d", "# @optional", "# @scope app ci", "NAME=v"], /@scope takes exactly one value/],
      [["# d", "# @required extra", "NAME=v"], /@required takes no value/],
      // A default and a requirement are two different answers to the same
      // question, and a file that gives both has answered nothing.
      [["# d", "# @required", "# @default x", "NAME=v"], /both @required and @default/],
      [["# d", "# @optional", "# @secret", "# @default x", "SECRET="], /cannot carry a @default/],
      [["# d", "# @optional", "# @cache-key", "NAME=v"], /@cache-key requires @default/],
      [["# d", "# @default strict", "NAME=lax"], /the example value and @default disagree/],
      [
        ["# d", "# @default nope", "# @cache-key", "# @format enum:strict", "NAME=strict"],
        /the @default value is a value outside the accepted set/,
      ],
      [["# d", "# @optional", "lower_case=v"], /is not a valid environment variable name/],
      [["# d", "# @optional", "NAME=v", "", "# d2", "# @optional", "NAME=v2"], /declared twice/],
      [["# d", "# @optional", "# @secret", "SECRET=sk-live-realvalue"], /non-placeholder value/],
      [["# d", "# @optional", "# @format url", "URLV=not a url"], /the example value in .env.example is/],
      [["just junk"], /not a comment and not a NAME=value assignment/],
    ];
    for (const [lines, matcher] of cases) {
      const { defects } = parseEnvContract(lines.join("\n"));
      assert.ok(
        defects.some((defect) => matcher.test(defect)),
        `expected a defect matching ${matcher} for:\n${lines.join("\n")}\ngot: ${JSON.stringify(defects)}`,
      );
    }
    assert.deepEqual(parseEnvContract(null).defects, ["`.env.example` is missing"]);
  }

  /* ---------------------------------------------------------------------
   * 5. Value formats.
   * ------------------------------------------------------------------- */
  {
    assert.equal(checkFormat("nonempty", "x"), null);
    assert.match(checkFormat("nonempty", "   "), /empty/);

    assert.equal(checkFormat("url", "https://example.test/path"), null);
    assert.match(checkFormat("url", "example.test"), /not a parseable absolute URL/);
    assert.match(checkFormat("url", "ftp://example.test"), /not http:\/\/ or https:\/\//);

    assert.equal(checkFormat("postgres-url", "postgresql://u:p@localhost:5432/liberty"), null);
    assert.equal(checkFormat("postgres-url", "postgres://localhost:5432/liberty"), null);
    assert.match(checkFormat("postgres-url", "mysql://localhost:3306/liberty"), /not postgresql/);
    assert.match(checkFormat("postgres-url", "postgresql://localhost:5432"), /no database name/);

    assert.equal(checkFormat("redis-url", "redis://localhost:6379"), null);
    assert.equal(checkFormat("redis-url", "rediss://localhost:6380"), null);
    assert.match(checkFormat("redis-url", "postgresql://localhost:5432/x"), /not redis/);

    assert.equal(checkFormat("integer", "400000"), null);
    assert.match(checkFormat("integer", "400_000"), /not a base-10 integer/);

    assert.equal(checkFormat("hex40", "a".repeat(40)), null);
    assert.match(checkFormat("hex40", "A".repeat(40)), /lowercase hex sha/);

    assert.equal(checkFormat("enum:a,b", "a"), null);
    assert.match(checkFormat("enum:a,b", "A"), /outside the accepted set/);
    assert.equal(describeFormat("enum:a,b"), "one of: a, b");
  }

  /* ---------------------------------------------------------------------
   * 6. Node version: both directions are reported, with different remedies
   *    ("install it" and "you have it, use it" are different instructions)
   *    and different severities.
   *
   *    Too old fails: the repo may not run, and npm agrees via engines.
   *    Too new warns: everything runs, and what is wrong is the strength of
   *    the evidence rather than the machine. Failing there would mean anyone
   *    whose shell defaults to the current Node release cannot run the gate at
   *    all, and the reliable outcome of that is a skipped gate. Under
   *    `--scope ci` it fails, because there the runtime is chosen by a
   *    workflow file and the evidence is the point.
   * ------------------------------------------------------------------- */
  {
    const base = { nvmrcText: "22\n", enginesNode: ">=22" };
    assert.deepEqual(checkNodeVersion({ ...base, actualVersion: "22.14.0" }), []);

    const older = checkNodeVersion({ ...base, actualVersion: "20.11.1" });
    assert.equal(older.filter((f) => f.check === "node.version").length, 1);
    assert.equal(older[0].level, "error");
    assert.match(older[0].expected, /Node 22\.x, pinned by \.nvmrc/);
    assert.match(older[0].found, /Node 20\.11\.1/);
    assert.match(older[0].fix, /install Node 22/);
    assert.ok(
      older.some((f) => f.check === "node.engines"),
      "a runtime below engines.node is also an engines failure",
    );

    const newer = checkNodeVersion({ ...base, actualVersion: "24.0.0" });
    assert.equal(newer.length, 1);
    assert.equal(newer[0].level, "warn", "a newer runtime must not block a local gate run");
    assert.match(newer[0].found, /Node 24\.0\.0/);
    assert.match(newer[0].fix, /switch to the pinned major/);
    assert.match(newer[0].fix, /gate evidence/);

    const newerInCi = checkNodeVersion({ ...base, actualVersion: "24.0.0", scope: "ci" });
    assert.equal(newerInCi.length, 1);
    assert.equal(
      newerInCi[0].level,
      "error",
      "CI chooses its own runtime, so an unpinned one is a misconfiguration",
    );
    assert.match(newerInCi[0].fix, /CI is where that evidence gets recorded/);

    // Too old is still a failure in either scope.
    const olderInCi = checkNodeVersion({ ...base, actualVersion: "20.11.1", scope: "ci" });
    assert.equal(olderInCi[0].level, "error");

    assert.match(
      checkNodeVersion({ nvmrcText: null, enginesNode: ">=22", actualVersion: "22.0.0" })[0].check,
      /node\.pin/,
    );
    assert.match(
      checkNodeVersion({ nvmrcText: "lts/*\n", enginesNode: ">=22", actualVersion: "22.0.0" })[0]
        .found,
      /does not start with a version number/,
    );

    // .nvmrc and engines disagreeing is a repo defect, not a machine defect.
    const inconsistent = checkNodeVersion({
      nvmrcText: "20\n",
      enginesNode: ">=22",
      actualVersion: "20.0.0",
    });
    assert.ok(inconsistent.some((f) => f.check === "node.pin-consistency"));
  }

  /* ---------------------------------------------------------------------
   * 7. Missing / empty / placeholder / malformed are four distinct states.
   * ------------------------------------------------------------------- */
  {
    const contract = contractOf(
      [
        "# Required plain value.",
        "# @required",
        "# @format nonempty",
        "NEEDED=example",
        "",
        "# Required credential.",
        "# @required",
        "# @secret",
        "SECRET=replace-me",
        "",
        "# Optional url.",
        "# @optional",
        "# @format url",
        "OPT_URL=https://example.test",
        "",
      ].join("\n"),
    );

    const missing = checkEnvironmentVariables({
      contract,
      sources: sources(["process.env", {}]),
      scope: "app",
    });
    assert.deepEqual(missing.map((f) => f.check).sort(), ["env.missing", "env.missing"]);
    assert.match(missing[0].found, /not set in process\.env/);

    const empty = checkEnvironmentVariables({
      contract,
      sources: sources(["process.env", { NEEDED: "  ", SECRET: "real" }]),
      scope: "app",
    });
    assert.deepEqual(
      empty.map((f) => f.check),
      ["env.empty"],
    );
    assert.match(empty[0].found, /declared in process\.env but empty/);

    const placeholder = checkEnvironmentVariables({
      contract,
      sources: sources(["process.env", { NEEDED: "x", SECRET: "replace-me" }]),
      scope: "app",
    });
    assert.deepEqual(
      placeholder.map((f) => f.check),
      ["env.placeholder"],
    );
    assert.match(placeholder[0].found, /still the placeholder/);

    const malformed = checkEnvironmentVariables({
      contract,
      sources: sources(["process.env", { NEEDED: "x", SECRET: "real", OPT_URL: "nope" }]),
      scope: "app",
    });
    assert.deepEqual(
      malformed.map((f) => f.check),
      ["env.malformed"],
    );
    assert.match(malformed[0].expected, /OPT_URL to be an absolute http/);

    assert.deepEqual(
      checkEnvironmentVariables({
        contract,
        sources: sources(["process.env", { NEEDED: "x", SECRET: "real", OPT_URL: "https://ok.test" }]),
        scope: "app",
      }),
      [],
    );
  }

  /* ---------------------------------------------------------------------
   * 7b. A documented default: absence is well-defined, so it is a warning
   *     that names the consequence -- not a failure that stops a correct
   *     checkout from validating. Being set to a WRONG value is still a
   *     failure, because that is not absence.
   * ------------------------------------------------------------------- */
  {
    const contract = contractOf(
      [
        "# Rights-enforcement mode.",
        "# @optional",
        "# @default strict",
        "# @cache-key",
        "# @format enum:strict",
        "MODE=strict",
        "",
        "# A defaulted variable nothing hashes.",
        "# @optional",
        "# @default info",
        "# @format enum:debug,info",
        "LEVEL=info",
        "",
      ].join("\n"),
    );

    const unset = checkEnvironmentVariables({
      contract,
      sources: sources(["process.env", {}], [".env.local", {}]),
      scope: "app",
    });
    assert.deepEqual(
      unset.map((f) => `${f.level}:${f.check}`),
      ["warn:env.default", "warn:env.default"],
      "a fresh checkout must not fail on a variable whose absence is documented",
    );
    assert.match(unset[0].found, /not set in process\.env, \.env\.local/);
    assert.match(unset[0].found, /the documented default `strict` applies/);
    // The cache consequence is named, because a warning nobody can act on is noise.
    assert.match(unset[0].fix, /hashed into the build cache key/);
    assert.match(unset[0].fix, /one cache entry can then serve builds that meant different values/);
    // ...and is not claimed for a variable that turbo does not hash.
    assert.equal(/cache/.test(unset[1].fix), false);

    // Empty is the same state: the value the project runs with is the default.
    const empty = checkEnvironmentVariables({
      contract,
      sources: sources(["process.env", { MODE: "  ", LEVEL: "debug" }]),
      scope: "app",
    });
    assert.deepEqual(
      empty.map((f) => `${f.level}:${f.check}`),
      ["warn:env.default"],
    );
    assert.match(empty[0].found, /declared in process\.env but empty/);

    // CI is where cache entries are shared between machines, so there an unset
    // cache-key variable is a misconfiguration rather than a preference.
    const ci = checkEnvironmentVariables({
      contract,
      sources: sources(["process.env", {}]),
      scope: "ci",
    });
    assert.deepEqual(
      ci.map((f) => `${f.level}:${f.check}`),
      ["error:env.default", "warn:env.default"],
    );

    // Set to something outside the accepted set: a wrong answer, and a failure
    // in every scope.
    const wrong = checkEnvironmentVariables({
      contract,
      sources: sources(["process.env", { MODE: "lax", LEVEL: "info" }]),
      scope: "app",
    });
    assert.deepEqual(
      wrong.map((f) => `${f.level}:${f.check}`),
      ["error:env.malformed"],
    );
    assert.match(wrong[0].expected, /MODE to be one of: strict/);

    // Set to the default explicitly: nothing to say at all.
    assert.deepEqual(
      checkEnvironmentVariables({
        contract,
        sources: sources(["process.env", { MODE: "strict", LEVEL: "info" }]),
        scope: "ci",
      }),
      [],
    );
  }

  /* ---------------------------------------------------------------------
   * 8. Precedence, source attribution, scope, and undeclared-name drift.
   * ------------------------------------------------------------------- */
  {
    const contract = contractOf(
      ["# A value.", "# @required", "# @format enum:one,two", "PICK=one", ""].join("\n"),
    );

    // process.env wins over .env.local wins over .env: the reported source is
    // the whole answer to "but I set that".
    const findings = checkEnvironmentVariables({
      contract,
      sources: sources(["process.env", {}], [".env.local", { PICK: "three" }], [".env", { PICK: "one" }]),
      scope: "app",
    });
    assert.equal(findings.length, 1);
    assert.match(findings[0].found, /from \.env\.local/);

    const undeclared = checkEnvironmentVariables({
      contract,
      sources: sources(["process.env", { STRAY_FROM_SHELL: "x" }], [".env.local", { PICK: "one", STRAY: "x" }]),
      scope: "app",
    });
    assert.deepEqual(
      undeclared.map((f) => `${f.level}:${f.check}`),
      ["warn:env.undeclared"],
    );
    assert.match(undeclared[0].found, /STRAY is set there but not declared/);

    // Scope: a ci-only requirement is not imposed on a developer machine.
    const ciContract = contractOf(
      ["# CI only.", "# @required", "# @scope ci", "CI_ONLY=", ""].join("\n"),
    );
    assert.deepEqual(
      checkEnvironmentVariables({ contract: ciContract, sources: sources(["process.env", {}]), scope: "app" }),
      [],
    );
    assert.deepEqual(
      checkEnvironmentVariables({ contract: ciContract, sources: sources(["process.env", {}]), scope: "ci" }).map(
        (f) => f.check,
      ),
      ["env.missing"],
    );
  }

  /* ---------------------------------------------------------------------
   * 9. Values are never printed -- not the malformed one, not the enum typo,
   *    not the undeclared variable's value, not the URL's password.
   * ------------------------------------------------------------------- */
  {
    const contract = contractOf(
      [
        "# A url.",
        "# @required",
        "# @format url",
        "APP_ORIGIN=https://example.test",
        "",
        "# A mode.",
        "# @required",
        "# @format enum:development,production",
        "MODE=development",
        "",
        "# A credential.",
        "# @required",
        "# @secret",
        "TOKEN=replace-me",
        "",
      ].join("\n"),
    );
    const output = render(
      checkEnvironmentVariables({
        contract,
        sources: sources(
          ["process.env", {}],
          [
            ".env.local",
            {
              APP_ORIGIN: "SENTINEL-malformed-url",
              MODE: "SENTINEL-enum-typo",
              TOKEN: "replace-me",
              EXTRA: "SENTINEL-undeclared-value",
            },
          ],
        ),
        scope: "app",
      }),
    );
    assert.equal(output.includes("SENTINEL"), false, `values leaked into output:\n${output}`);
    // ...while still naming every variable, which is what makes it actionable.
    for (const name of ["APP_ORIGIN", "MODE", "TOKEN", "EXTRA"]) {
      assert.ok(output.includes(name), `${name} should be named in:\n${output}`);
    }
    assert.ok(output.includes("one of: development, production"), "the accepted set is public");
  }

  /* ---------------------------------------------------------------------
   * 10. Install state: a missing node_modules reports once, as itself.
   * ------------------------------------------------------------------- */
  {
    const findings = checkInstall(
      snapshotFor({
        nodeModulesExists: false,
        workspaces: [{ dir: "packages/a", name: "@liberty/a", parseError: null, link: null }],
      }),
    );
    assert.deepEqual(
      findings.map((f) => f.check),
      ["install.node_modules"],
      "the root cause must not be buried under its own consequences",
    );
    assert.equal(findings[0].fix, "npm install");
  }

  /* ---------------------------------------------------------------------
   * 11. Install state: lockfile presence, identity, drift, and staleness.
   * ------------------------------------------------------------------- */
  {
    const missingLock = checkInstall(snapshotFor({ lock: null }));
    assert.deepEqual(
      missingLock.map((f) => f.check),
      ["install.lockfile"],
    );

    const wrongProject = checkInstall(
      snapshotFor({ lock: { name: "other", lockfileVersion: 3, packages: { "": {} } } }),
    );
    assert.ok(wrongProject.some((f) => /describes "other"/.test(f.found)));

    const legacy = checkInstall(snapshotFor({ lock: { name: "fixture", lockfileVersion: 1 } }));
    assert.ok(legacy.some((f) => /lockfileVersion 1/.test(f.found)));

    const staleRoot = checkInstall(
      snapshotFor({
        manifest: { name: "fixture", workspaces: [], devDependencies: { vitest: "^3.0.0" } },
        lock: { name: "fixture", lockfileVersion: 3, packages: { "": { devDependencies: {} } } },
      }),
    );
    assert.deepEqual(
      staleRoot.map((f) => f.check),
      ["install.lockfile-drift"],
    );

    const newWorkspace = checkInstall(
      snapshotFor({
        workspaces: [{ dir: "packages/new", name: "@liberty/new", parseError: null, link: { state: "ok" } }],
      }),
    );
    assert.ok(newWorkspace.some((f) => /a lockfile entry for workspace packages\/new/.test(f.expected)));
  }

  /* ---------------------------------------------------------------------
   * 12. Install state: the tree must contain what the lockfile requires --
   *     minus the entries that are absent by design on this platform.
   * ------------------------------------------------------------------- */
  {
    const lock = {
      name: "fixture",
      lockfileVersion: 3,
      packages: {
        "": { devDependencies: {} },
        "node_modules/present": { version: "1.0.0" },
        "node_modules/absent": { version: "1.0.0" },
        "node_modules/optional-thing": { version: "1.0.0", optional: true },
        "node_modules/@esbuild/linux-x64": { version: "1.0.0", os: ["linux"], cpu: ["x64"] },
        "node_modules/@liberty/a": { resolved: "packages/a", link: true },
      },
    };
    const findings = checkInstall(
      snapshotFor({ lock, hidden: { lockfileVersion: 3, packages: { "node_modules/present": {} } } }),
    );
    assert.deepEqual(
      findings.map((f) => f.check),
      ["install.tree"],
    );
    assert.match(findings[0].found, /^1 package\(s\)/);
    assert.match(findings[0].found, /\(absent\)/);

    assert.deepEqual(
      checkInstall(
        snapshotFor({
          lock,
          hidden: { lockfileVersion: 3, packages: { "node_modules/present": {}, "node_modules/absent": {} } },
        }),
      ),
      [],
    );

    const noHidden = checkInstall(snapshotFor({ hidden: null }));
    assert.deepEqual(
      noHidden.map((f) => f.check),
      ["install.tree"],
    );
    assert.match(noHidden[0].found, /was not produced by npm install/);
  }

  /* ---------------------------------------------------------------------
   * 13. Workspace links: missing, broken and shadowed get different fixes,
   *     because a published package sitting on a workspace name is not the
   *     same problem as nothing being there.
   * ------------------------------------------------------------------- */
  {
    const withLink = (link) =>
      checkInstall(
        snapshotFor({
          lock: {
            name: "fixture",
            lockfileVersion: 3,
            packages: { "": { devDependencies: {} }, "packages/a": { name: "@liberty/a" } },
          },
          workspaces: [{ dir: "packages/a", name: "@liberty/a", parseError: null, link }],
        }),
      );

    assert.deepEqual(withLink({ state: "ok" }), []);
    assert.match(withLink({ state: "missing" })[0].found, /nothing is linked at that name/);
    assert.match(withLink({ state: "broken" })[0].found, /link exists but its target does not/);

    const foreign = withLink({ state: "foreign", target: "node_modules/.store/@liberty/a" });
    assert.match(foreign[0].found, /resolves to node_modules\/\.store/);
    assert.match(foreign[0].fix, /shadowing the workspace/);
  }

  /* ---------------------------------------------------------------------
   * 14. Malformed workspace manifests and empty workspace globs.
   * ------------------------------------------------------------------- */
  {
    const broken = checkInstall(
      snapshotFor({
        workspaces: [
          { dir: "packages/a", name: null, parseError: "Unexpected token }", link: null },
          { dir: "packages/b", name: null, parseError: null, link: null },
        ],
        emptyPatterns: ["apps/*"],
      }),
    );
    const checks = broken.map((f) => f.check);
    assert.ok(checks.includes("workspaces.declaration"));
    assert.equal(checks.filter((c) => c === "workspaces.package").length, 2);

    const noWorkspaces = checkInstall(snapshotFor({ manifest: { name: "fixture" } }));
    assert.ok(noWorkspaces.some((f) => f.check === "workspaces.declaration"));

    const duplicate = checkInstall(
      snapshotFor({
        lock: {
          name: "fixture",
          lockfileVersion: 3,
          packages: { "": { devDependencies: {} }, "packages/a": {}, "packages/b": {} },
        },
        workspaces: [
          { dir: "packages/a", name: "@liberty/dup", parseError: null, link: { state: "ok" } },
          { dir: "packages/b", name: "@liberty/dup", parseError: null, link: { state: "ok" } },
        ],
      }),
    );
    assert.ok(duplicate.some((f) => /unique package name/.test(f.expected)));
  }

  /* ---------------------------------------------------------------------
   * 15. Service probing: opt-in, and it never prints the credentials that
   *     live in the middle of a connection string.
   * ------------------------------------------------------------------- */
  {
    const contract = contractOf(
      [
        "# db",
        "# @optional",
        "# @format postgres-url",
        "DATABASE_URL=postgresql://liberty:liberty@localhost:5432/liberty",
        "",
        "# cache",
        "# @optional",
        "# @format redis-url",
        "REDIS_URL=redis://localhost:6379",
        "",
      ].join("\n"),
    );
    assert.equal(contract.variables.length, 2);

    const probed = [];
    const findings = await checkServices({
      sources: sources([
        ".env.local",
        {
          DATABASE_URL: "postgresql://liberty:SENTINELPASSWORD@db.internal:5433/liberty",
          REDIS_URL: "redis://cache.internal:6379",
        },
      ]),
      probe: async (target) => {
        probed.push(target);
        return { ok: false, reason: "nothing is listening on that port" };
      },
    });
    assert.deepEqual(probed, [
      { host: "db.internal", port: 5433 },
      { host: "cache.internal", port: 6379 },
    ]);
    const output = render(findings);
    assert.equal(output.includes("SENTINELPASSWORD"), false, `credential leaked:\n${output}`);
    assert.ok(output.includes("db.internal:5433"));
    assert.ok(output.includes("docker compose -f infra/docker-compose.yml up -d"));

    // Unset services warn rather than fail: the stack is documented as optional.
    const unset = await checkServices({ sources: sources(["process.env", {}]), probe: async () => ({ ok: true }) });
    assert.deepEqual(
      unset.map((f) => f.level),
      ["warn", "warn"],
    );
  }

  /* ---------------------------------------------------------------------
   * 16. probePort against a real socket, since the whole point of the flag
   *     is that it touches the network rather than the config.
   * ------------------------------------------------------------------- */
  {
    const server = net.createServer();
    const port = await new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve(server.address().port));
    });
    assert.deepEqual(await probePort({ host: "127.0.0.1", port, timeoutMs: 2000 }), { ok: true });
    await new Promise((resolve) => server.close(resolve));

    const refused = await probePort({ host: "127.0.0.1", port, timeoutMs: 2000 });
    assert.equal(refused.ok, false);
    assert.equal(typeof refused.reason, "string");
  }

  /* ---------------------------------------------------------------------
   * 17. Argument parsing, including the usage/invalid distinction.
   * ------------------------------------------------------------------- */
  {
    assert.deepEqual(parseArgs([]).options, {
      quiet: false,
      scope: "app",
      services: false,
      help: false,
      modes: [],
    });
    assert.equal(parseArgs(["--quiet", "--services", "--scope", "ci"]).options.scope, "ci");
    assert.equal(parseArgs(["--scope=ci"]).options.scope, "ci");
    assert.match(parseArgs(["--scope", "nowhere"]).error, /--scope must be app or ci/);
    assert.match(parseArgs(["--nope"]).error, /unknown option "--nope"/);
  }

  /* ---------------------------------------------------------------------
   * 18. End to end: a clean fixture repository exits 0 and says so.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    const ok = runScript(repo, [], { LIBERTY_TEST_REQUIRED: "set" });
    assert.equal(ok.code, EXIT_OK, `expected success, got:\n${ok.stdout}${ok.stderr}`);
    assert.match(ok.stdout, /environment validation passed/);
    assert.equal(ok.stderr, "");

    const quiet = runScript(repo, ["--quiet"], { LIBERTY_TEST_REQUIRED: "set" });
    assert.equal(quiet.code, EXIT_OK);
    assert.equal(quiet.stdout, "", "--quiet must say nothing on success");
    assert.equal(quiet.stderr, "");
  }

  /* ---------------------------------------------------------------------
   * 19. End to end: failures go to stderr, exit 1, and survive --quiet.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    const failed = runScript(repo);
    assert.equal(failed.code, EXIT_INVALID);
    assert.match(failed.stderr, /environment validation failed \(1 problem\)/);
    assert.match(failed.stderr, /FAIL env\.missing/);
    assert.match(failed.stderr, /LIBERTY_TEST_REQUIRED/);
    assert.match(failed.stderr, /fix: {6}add LIBERTY_TEST_REQUIRED to \.env\.local/);

    const quiet = runScript(repo, ["--quiet"]);
    assert.equal(quiet.code, EXIT_INVALID, "--quiet must not suppress failure");
    assert.match(quiet.stderr, /FAIL env\.missing/);
  }

  /* ---------------------------------------------------------------------
   * 20. End to end: a bad flag is exit 2, distinct from a broken machine.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    const usage = runScript(repo, ["--scope", "banana"], { LIBERTY_TEST_REQUIRED: "set" });
    assert.equal(usage.code, EXIT_USAGE);
    assert.match(usage.stderr, /Usage: node scripts\/validate-env\.mjs/);

    const help = runScript(repo, ["--help"]);
    assert.equal(help.code, EXIT_OK);
    assert.match(help.stdout, /--services/);
  }

  /* ---------------------------------------------------------------------
   * 21. End to end: a Node major other than the pinned one is always
   *     reported, and the severity depends on the direction and the scope.
   * ------------------------------------------------------------------- */
  {
    // Runtime older than the pin: a hard failure, in every scope.
    const pinAhead = freshRepo({ nvmrc: String(Number(NODE_MAJOR) + 2) });
    const result = runScript(pinAhead, [], { LIBERTY_TEST_REQUIRED: "set" });
    assert.equal(result.code, EXIT_INVALID);
    assert.match(result.stderr, /FAIL node\.version/);
    assert.match(result.stderr, /install Node/);

    /*
     * Runtime newer than the pin: reported, but it does not make the
     * repository unusable. This is the case that actually happens -- a shell
     * defaulting to the current Node release -- and a gate that cannot be run
     * at all is not a stricter gate, it is a skipped one.
     *
     * engines.node is lowered to match the older pin, so this scenario tests
     * the pin/runtime relationship rather than tripping the separate
     * pin-consistency check.
     */
    const olderPin = String(Number(NODE_MAJOR) - 2);
    const behind = freshRepo({
      nvmrc: olderPin,
      manifest: {
        name: "fixture",
        version: "0.0.0",
        private: true,
        engines: { node: `>=${olderPin}` },
        workspaces: [],
        devDependencies: {},
      },
    });
    const warned = runScript(behind, [], { LIBERTY_TEST_REQUIRED: "set" });
    assert.equal(warned.code, EXIT_OK, `expected a warning, not a failure:\n${warned.stderr}`);
    assert.match(warned.stderr, /WARN node\.version/);
    assert.match(warned.stderr, /switch to the pinned major/);
    assert.equal(warned.stderr.includes("FAIL"), false);
    // The success line admits the warning, since the two streams may be split.
    assert.match(warned.stdout, /with 1 warning above/);

    // ...and under --scope ci the same machine is a misconfiguration.
    const inCi = runScript(behind, ["--scope", "ci"], { LIBERTY_TEST_REQUIRED: "set" });
    assert.equal(inCi.code, EXIT_INVALID);
    assert.match(inCi.stderr, /FAIL node\.version/);
  }

  /* ---------------------------------------------------------------------
   * 22. End to end: an uninstalled repository is told to run npm install and
   *     is not also told forty other things.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    fs.rmSync(path.join(repo, "node_modules"), { recursive: true, force: true });
    const result = runScript(repo, [], { LIBERTY_TEST_REQUIRED: "set" });
    assert.equal(result.code, EXIT_INVALID);
    assert.match(result.stderr, /FAIL install\.node_modules/);
    assert.equal((result.stderr.match(/FAIL /g) ?? []).length, 1);
  }

  /* ---------------------------------------------------------------------
   * 23. End to end: an undeclared name in .env.local warns without failing,
   *     and the warning survives --quiet.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo({ envLocal: "LIBERTY_TEST_REQUIRED=set\nUNDOCUMENTED=x\n" });
    const result = runScript(repo, ["--quiet"]);
    assert.equal(result.code, EXIT_OK);
    assert.match(result.stderr, /WARN env\.undeclared/);
    assert.match(result.stderr, /UNDOCUMENTED/);
    assert.equal(result.stderr.includes("FAIL"), false);
  }

  /* ---------------------------------------------------------------------
   * 24. The repository's own .env.example is a valid contract.
   *
   *     This is the check that keeps the file honest: every rule the parser
   *     enforces -- a description on every variable, exactly one answer to
   *     "what if it is unset", no non-placeholder secret, examples and
   *     defaults that satisfy their own declared format -- is asserted against
   *     the real file, so a careless edit fails here rather than on someone's
   *     first day. And a fresh clone of it must pass.
   * ------------------------------------------------------------------- */
  {
    const text = fs.readFileSync(path.resolve(".env.example"), "utf8");
    const { variables, defects } = parseEnvContract(text);
    assert.deepEqual(defects, [], `.env.example is not a valid contract:\n${defects.join("\n")}`);
    assert.ok(variables.length >= 7);

    const byName = new Map(variables.map((variable) => [variable.name, variable]));
    const rights = byName.get("CONTENT_RIGHTS_ENFORCEMENT");
    assert.ok(rights, "CONTENT_RIGHTS_ENFORCEMENT must be declared");
    assert.equal(rights.format, "enum:strict");
    assert.equal(rights.required, false);
    assert.equal(rights.defaultValue, "strict");
    assert.equal(rights.cacheKey, true, "turbo.json hashes it into the build cache key");

    // LOG_LEVEL's description mentions @liberty/observability mid-sentence.
    // That is prose, and the file must not stop being a valid contract
    // because somebody wrote an ordinary English sentence in it.
    assert.ok(
      byName.get("LOG_LEVEL").description.includes("@liberty/observability"),
      "the @-name in LOG_LEVEL's description must be read as prose",
    );

    /*
     * The load-bearing assertion: a fresh clone -- no .env.local, nothing
     * exported -- produces no failures against the real contract. A validator
     * that fails a correct checkout trains people to ignore it, and an ignored
     * validator catches nothing.
     */
    const fresh = checkEnvironmentVariables({
      contract: { variables, defects },
      sources: sources(["process.env", {}]),
      scope: "app",
    });
    assert.deepEqual(
      fresh.filter((f) => f.level === "error"),
      [],
      `a fresh clone must pass:\n${render(fresh)}`,
    );
    /*
     * Derived from the contract rather than naming a variable. The property is
     * that a defaulted variable's absence SURVIVES as a warning instead of being
     * discarded -- not that one particular variable carries it.
     *
     * This assertion previously named CONTENT_RIGHTS_ENFORCEMENT, so declaring a
     * second defaulted variable broke it. The tempting repair is to append the
     * new name, and that is precisely the move to avoid: appending a name to
     * make a red suite green is byte-for-byte indistinguishable from appending
     * one to silence a warning that should never have appeared, and the diff
     * gives a reviewer no way to tell which happened.
     */
    const defaulted = variables.filter((variable) => variable.defaultValue !== null);
    assert.ok(
      defaulted.some((variable) => variable.cacheKey),
      "at least one defaulted variable must be @cache-key, or this scenario no longer covers the cache concern",
    );
    assert.deepEqual(
      fresh.map((f) => `${f.level}:${f.check}:${f.expected.split(" ")[0]}`).sort(),
      defaulted.map((variable) => `warn:env.default:${variable.name}`).sort(),
      "on a fresh clone the findings are exactly one warning per defaulted variable, and nothing else",
    );

    /*
     * Every name turbo hashes into the build cache key must be declared here.
     * An undeclared one is the exact failure the cache concern is about: it
     * changes what a build means, nothing documents it, and the collision is
     * invisible afterwards because the cache entry looks like a hit.
     */
    const turbo = JSON.parse(fs.readFileSync(path.resolve("turbo.json"), "utf8"));
    for (const name of turbo.globalEnv ?? []) {
      assert.ok(
        byName.has(name),
        `${name} is in turbo.json globalEnv but not declared in .env.example`,
      );
    }

    /*
     * Both services stay optional by design, and the reason is narrower than it
     * used to be. This comment said "docs/DATABASE.md pins no ORM yet", which
     * stopped being true when packages/persistence pinned drizzle and
     * drizzle.config.ts began reading DATABASE_URL -- a stale reason outliving
     * the fact it was a reason for, which is the same drift .env.example and
     * docs/DEVELOPMENT.md had. The ASSERTIONS did not change, because the
     * conclusion did not: no gate runs a migration, so an unset DATABASE_URL
     * breaks nothing until someone invokes db:migrate, and requiring it would
     * fail a correct clone that simply has no database -- header rule 4. If a
     * gate ever does need a database, this is the reminder to change the
     * contract deliberately rather than by accident.
     */
    assert.equal(byName.get("DATABASE_URL").required, false);
    assert.equal(byName.get("DATABASE_URL").format, "postgres-url");
    assert.equal(byName.get("REDIS_URL").required, false);
    assert.equal(byName.get("REDIS_URL").format, "redis-url");

    for (const variable of variables) {
      if (!variable.secret) continue;
      assert.equal(
        variable.scope,
        "ci",
        `${variable.name} is a secret, so it must not be part of the local template`,
      );
    }
  }

  /* ---------------------------------------------------------------------
   * 25. evaluate() is pure over its snapshot: no filesystem, no process.
   * ------------------------------------------------------------------- */
  {
    const snapshot = snapshotFor();
    snapshot.files[".env.example"] = {
      text: ["# A value.", "# @required", "# @format nonempty", "V=example", ""].join("\n"),
    };
    snapshot.files[".env.local"] = { text: "V=from-file\n" };

    const clean = evaluate(snapshot, {
      actualVersion: `${NODE_MAJOR}.0.0`,
      processEnv: {},
      scope: "app",
    });
    assert.deepEqual(clean.findings, []);
    assert.deepEqual(
      clean.sourcesByMode.get("development").map((source) => source.label),
      ["process.env", ".env.local"],
    );

    const dirty = evaluate(snapshot, { actualVersion: "1.0.0", processEnv: {}, scope: "app" });
    assert.ok(dirty.findings.some((f) => f.check === "node.version"));

    assert.deepEqual(
      buildSources(snapshot, { A: "1" })[0].values.get("A"),
      "1",
    );
  }

  /* ---------------------------------------------------------------------
   * 26. The file list each mode reads, asserted literally.
   *
   *     There is no cleverer form for this. The arrays ARE the contract with
   *     @next/env, and paraphrasing them into a property ("the .local variants
   *     come first") would restate the same assumption the original defect was
   *     made of. If Next.js ever changes the order, this is the assertion that
   *     has to be edited deliberately rather than drifted past.
   * ------------------------------------------------------------------- */
  {
    assert.deepEqual(envFilesForMode("development"), [
      ".env.development.local",
      ".env.local",
      ".env.development",
      ".env",
    ]);
    assert.deepEqual(envFilesForMode("test"), [".env.test.local", ".env.test", ".env"]);
    assert.deepEqual(envFilesForMode("production"), [
      ".env.production.local",
      ".env.local",
      ".env.production",
      ".env",
    ]);

    // .env.local is omitted under test, not merely demoted.
    assert.equal(envFilesForMode("test").includes(".env.local"), false);

    // The snapshot has to cover every file any mode can reach, exactly once, or
    // a mode would be evaluated against bytes that were never read.
    assert.equal(ALL_ENV_FILES.length, 8);
    assert.equal(new Set(ALL_ENV_FILES).size, ALL_ENV_FILES.length);
    for (const mode of ["development", "test", "production"]) {
      for (const file of envFilesForMode(mode)) {
        assert.ok(
          ALL_ENV_FILES.includes(file),
          `${file} is readable in ${mode} but is not in the snapshot`,
        );
      }
    }

    // With no --mode, NODE_ENV picks the one mode to validate when it names one.
    // (A default, not a reproduction of @next/env: `next build` under
    // NODE_ENV=staging reads the production files while this says development,
    // which is why env:validate names all three modes rather than relying on it.)
    assert.deepEqual(defaultModes({ NODE_ENV: "production" }), ["production"]);
    assert.deepEqual(defaultModes({ NODE_ENV: "staging" }), ["development"]);
    assert.deepEqual(defaultModes({}), ["development"]);
  }

  /* ---------------------------------------------------------------------
   * 27. The mode-specific files outrank the shared ones.
   *
   *     This is the regression for the defect itself. Resolving .env.local and
   *     then .env means a value in .env.production.local wins at runtime while
   *     the validator never opens the file that won -- so it validates one
   *     value and the app runs with another, and the run still passes.
   * ------------------------------------------------------------------- */
  {
    const layered = snapshotFor({
      envFiles: {
        ".env.production.local": "PICK=production-local\n",
        ".env.local": "PICK=local\n",
        ".env.production": "PICK=production\n",
        ".env": "PICK=env\n",
      },
    });
    assert.deepEqual(
      buildSources(layered, {}, "production").map((source) => source.label),
      ["process.env", ".env.production.local", ".env.local", ".env.production", ".env"],
    );
    assert.deepEqual(resolveVariable("PICK", buildSources(layered, {}, "production")), {
      value: "production-local",
      source: ".env.production.local",
    });

    // ...and .env.production still beats .env once the .local files are gone.
    // That is the second half of the same override and can break separately.
    const committed = snapshotFor({
      envFiles: { ".env.production": "PICK=production\n", ".env": "PICK=env\n" },
    });
    assert.deepEqual(resolveVariable("PICK", buildSources(committed, {}, "production")), {
      value: "production",
      source: ".env.production",
    });

    // Files that do not exist are skipped rather than searched, so `found:`
    // names the places that were really looked in.
    assert.deepEqual(
      buildSources(committed, {}, "production").map((source) => source.label),
      ["process.env", ".env.production", ".env"],
    );
  }

  /* ---------------------------------------------------------------------
   * 28. .env.local does not exist as far as test mode is concerned.
   *
   *     Next.js skips it so a test run means the same thing on every machine.
   *     The consequence cuts both ways and both directions are asserted: a
   *     value living only there does not satisfy a required variable in test,
   *     and a malformed value there is not reported in test either -- reporting
   *     it would describe a value that mode never loads.
   * ------------------------------------------------------------------- */
  {
    const snapshot = snapshotFor({ envFiles: { ".env.local": "PICK=local\n" } });
    assert.deepEqual(
      buildSources(snapshot, {}, "test").map((source) => source.label),
      ["process.env"],
    );
    assert.equal(resolveVariable("PICK", buildSources(snapshot, {}, "test")), null);

    const repo = freshRepo({ envLocal: "LIBERTY_TEST_REQUIRED=set\n" });
    assert.equal(runScript(repo, ["--mode", "development"]).code, EXIT_OK);
    const inTest = runScript(repo, ["--mode", "test"]);
    assert.equal(inTest.code, EXIT_INVALID, "test mode must not be satisfied by .env.local");
    assert.match(inTest.stderr, /FAIL env\.missing/);
    assert.match(inTest.stderr, /LIBERTY_TEST_REQUIRED/);

    const malformed = freshRepo({
      envExample: [
        "# An origin.",
        "# @optional",
        "# @format url",
        "LIBERTY_TEST_URL=https://example.test",
        "",
      ].join("\n"),
      envLocal: "LIBERTY_TEST_URL=SENTINEL-not-a-url\n",
    });
    const quiet = runScript(malformed, ["--mode", "test"]);
    assert.equal(quiet.code, EXIT_OK, `test mode must not read .env.local:\n${quiet.stderr}`);
    assert.equal(quiet.stderr.includes("SENTINEL"), false);
    assert.equal(runScript(malformed, ["--mode", "development"]).code, EXIT_INVALID);
  }

  /* ---------------------------------------------------------------------
   * 29. process.env outranks every file, in every mode. This is the one part
   *     of the precedence that does not vary, and a mode-aware rewrite is
   *     exactly the change that could accidentally make it vary.
   * ------------------------------------------------------------------- */
  {
    const everywhere = snapshotFor({
      envFiles: Object.fromEntries(ALL_ENV_FILES.map((file) => [file, `PICK=from-${file}\n`])),
    });
    for (const mode of ["development", "test", "production"]) {
      assert.deepEqual(
        resolveVariable("PICK", buildSources(everywhere, { PICK: "from-process" }, mode)),
        { value: "from-process", source: "process.env" },
        `process.env must win in ${mode}`,
      );
    }
  }

  /* ---------------------------------------------------------------------
   * 30. One problem prints once.
   *
   *     Validating three modes finds the same broken variable three times, and
   *     the reader wants one line unless the modes genuinely disagree. Note
   *     what dedupe cannot key on: `found` embeds the list of files that were
   *     searched, and that list differs per mode by construction, so comparing
   *     the sentence would collapse nothing at all.
   * ------------------------------------------------------------------- */
  {
    const modes = ["development", "test", "production"];

    const everyMode = snapshotFor();
    everyMode.files[".env.example"] = {
      text: ["# A required value.", "# @required", "# @format nonempty", "V=example", ""].join("\n"),
    };
    const shared = evaluate(everyMode, {
      actualVersion: `${NODE_MAJOR}.0.0`,
      processEnv: {},
      scope: "app",
      modes,
    });
    const missing = shared.findings.filter((finding) => finding.check === "env.missing");
    assert.equal(missing.length, 1, `one problem must print once:\n${render(shared.findings)}`);
    assert.equal(missing[0].key, "env.missing:V");
    assert.equal(missing[0].modes, undefined, "a problem true of every mode needs no annotation");
    assert.equal(formatFinding(missing[0]).includes("modes:"), false);
    assert.deepEqual([...shared.sourcesByMode.keys()], modes);

    const oneMode = snapshotFor({ envFiles: { ".env.test.local": "V=not a url\n" } });
    oneMode.files[".env.example"] = {
      text: ["# An origin.", "# @optional", "# @format url", "V=https://example.test", ""].join("\n"),
    };
    const specific = evaluate(oneMode, {
      actualVersion: `${NODE_MAJOR}.0.0`,
      processEnv: {},
      scope: "app",
      modes,
    });
    const malformed = specific.findings.filter((finding) => finding.check === "env.malformed");
    assert.equal(malformed.length, 1, `one mode, one finding:\n${render(specific.findings)}`);
    assert.deepEqual(malformed[0].modes, ["test"]);
    assert.match(formatFinding(malformed[0]), /\n {2}modes: {4}test$/);
    assert.equal(malformed[0].key, "env.malformed:V");
  }

  /* ---------------------------------------------------------------------
   * 31. --mode parsing: repeatable, deduplicated, and a typo is a usage error
   *     rather than a machine that looks broken.
   * ------------------------------------------------------------------- */
  {
    assert.deepEqual(parseArgs(["--mode", "production"]).options.modes, ["production"]);
    assert.deepEqual(parseArgs(["--mode=production"]).options.modes, ["production"]);
    // Duplicates collapse and the order is the order first asked for, because
    // that is the order the output is going to be read in.
    assert.deepEqual(
      parseArgs(["--mode", "test", "--mode", "development", "--mode=test"]).options.modes,
      ["test", "development"],
    );
    const badMode = /--mode must be development, test, or production/;
    assert.match(parseArgs(["--mode", "bogus"]).error, badMode);
    assert.match(parseArgs(["--mode=bogus"]).error, badMode);
    assert.match(parseArgs(["--mode"]).error, badMode);

    const repo = freshRepo({ envLocal: "LIBERTY_TEST_REQUIRED=set\n" });
    const usage = runScript(repo, ["--mode", "bogus"]);
    assert.equal(usage.code, EXIT_USAGE, "a mistyped flag is not a broken machine");
    assert.match(usage.stderr, badMode);
    assert.match(usage.stderr, /Usage: node scripts\/validate-env\.mjs/);

    // The success line names the modes, because they decide which files were
    // opened at all: "passed" alone cannot be told apart from a pass that never
    // read the file the reader is asking about.
    const one = runScript(repo, ["--mode", "production"]);
    assert.equal(one.code, EXIT_OK, `expected success, got:\n${one.stdout}${one.stderr}`);
    assert.match(one.stdout, /mode production,/);

    const both = runScript(repo, ["--mode", "development", "--mode=production"]);
    assert.equal(both.code, EXIT_OK, `expected success, got:\n${both.stdout}${both.stderr}`);
    assert.match(both.stdout, /modes development, production,/);
  }

  /* ---------------------------------------------------------------------
   * 32. End to end, the defect as reported: a good value in .env.local and a
   *     malformed one in .env.production.local. Before the fix this passed --
   *     the validator read the file that loses and never opened the file that
   *     wins, so it certified a value the production build does not use.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo({
      envExample: [
        "# The database this deployment connects to.",
        "# @optional",
        "# @format postgres-url",
        "LIBERTY_TEST_DATABASE_URL=postgresql://liberty:liberty@localhost:5432/liberty",
        "",
      ].join("\n"),
      envLocal: "LIBERTY_TEST_DATABASE_URL=postgresql://liberty:SENTINELGOOD@localhost:5432/liberty\n",
      envFiles: { ".env.production.local": "LIBERTY_TEST_DATABASE_URL=SENTINELBAD-not-a-url\n" },
    });

    const production = runScript(repo, ["--mode", "production"]);
    assert.equal(
      production.code,
      EXIT_INVALID,
      `the overriding file must be read:\n${production.stdout}${production.stderr}`,
    );
    assert.match(production.stderr, /FAIL env\.malformed/);
    assert.match(production.stderr, /LIBERTY_TEST_DATABASE_URL/);
    assert.match(production.stderr, /from \.env\.production\.local/);
    // Rule 3 still holds on the new path: neither the malformed value nor the
    // good one it overrode appears, and neither does the password in either.
    assert.equal(
      production.stderr.includes("SENTINEL"),
      false,
      `values leaked into output:\n${production.stderr}`,
    );

    // The same checkout is fine in development, where that file is not read --
    // which is precisely why validating one mode and calling it "the
    // environment" was the defect rather than a shortcut.
    const development = runScript(repo, ["--mode", "development"]);
    assert.equal(development.code, EXIT_OK, `expected success, got:\n${development.stderr}`);

    const both = runScript(repo, ["--mode", "development", "--mode", "production"]);
    assert.equal(both.code, EXIT_INVALID);
    assert.equal((both.stderr.match(/FAIL env\.malformed/g) ?? []).length, 1);
    assert.match(both.stderr, /modes: {4}production/);
  }

  /* ---------------------------------------------------------------------
   * 33. A fresh clone with no .env files at all passes in every mode.
   *
   *     The constraint the whole warn/fail split exists to protect, restated
   *     per mode: adding modes must not turn absence into failure anywhere,
   *     or the check becomes one people run with their eyes closed.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo({
      envExample: [
        "# An optional value.",
        "# @optional",
        "# @format nonempty",
        "LIBERTY_TEST_OPTIONAL=example",
        "",
        "# A value with a documented fallback.",
        "# @default info",
        "# @format enum:debug,info",
        "LIBERTY_TEST_LEVEL=info",
        "",
      ].join("\n"),
    });
    for (const mode of ["development", "test", "production"]) {
      const result = runScript(repo, ["--mode", mode]);
      assert.equal(
        result.code,
        EXIT_OK,
        `a clone with no .env files must pass in ${mode}:\n${result.stderr}`,
      );
    }
    const all = runScript(repo, ["--mode", "development", "--mode", "test", "--mode", "production"]);
    assert.equal(all.code, EXIT_OK, `...and with all three at once:\n${all.stderr}`);
    // The defaulted variable warns once, not once per mode.
    assert.equal((all.stderr.match(/WARN env\.default/g) ?? []).length, 1);
    assert.equal(
      all.stderr.includes("modes:"),
      false,
      "a warning true of every mode needs no annotation",
    );
  }

  /* ---------------------------------------------------------------------
   * 34. dedupeEnvFindings, directly.
   *
   *     The branch that distinguishes the design -- one key, several distinct
   *     details, each annotated with the modes that produced it -- was reachable
   *     only through evaluate() and never asserted on its own, which is how a
   *     defect in what counts as "the same detail" got through review. Asserted
   *     here at the level it is decided.
   * ------------------------------------------------------------------- */
  {
    const modes = ["development", "test", "production"];
    const under = (mode, extra) => ({
      level: "warn",
      check: "env.default",
      key: "env.default:LEVEL",
      mode,
      expected: "LEVEL to be set explicitly (A value with a documented fallback.)",
      fix: "set LEVEL=info in .env.local to pin it explicitly",
      ...extra,
    });

    // One key, two genuinely different facts: both survive, each carrying the
    // modes that produced it, sorted so the annotation does not depend on the
    // order the modes happened to be validated in.
    const split = dedupeEnvFindings(
      [
        under("development", { found: "set to something outside the accepted set" }),
        under("production", { found: "set to something outside the accepted set" }),
        under("test", { found: "not set" }),
      ],
      modes,
    );
    assert.equal(split.length, 2, `two facts, two findings:\n${render(split)}`);
    const byModes = new Map(split.map((finding) => [finding.modes.join(","), finding]));
    assert.deepEqual([...byModes.keys()].sort(), ["development,production", "test"]);
    assert.deepEqual(byModes.get("development,production").modes, ["development", "production"]);
    assert.deepEqual(byModes.get("test").modes, ["test"]);
    assert.equal(byModes.get("test").found, "not set");
    assert.match(
      formatFinding(byModes.get("development,production")),
      /modes: {4}development, production$/,
    );

    /*
     * ...and `dedupeFound` is what decides that. Three per-mode sentences that
     * describe one unset variable collapse to one unannotated finding, and the
     * internal field does not survive the collapse: it names no value today, but
     * a field that outlives its purpose is one a later formatter prints.
     */
    const collapsed = dedupeEnvFindings(
      [
        under("development", {
          found: "not set in process.env, .env.local, so the documented default `info` applies",
          dedupeFound: "not set, so the documented default `info` applies",
        }),
        under("test", {
          found: "not set in process.env, so the documented default `info` applies",
          dedupeFound: "not set, so the documented default `info` applies",
        }),
        under("production", {
          found: "not set in process.env, .env.local, so the documented default `info` applies",
          dedupeFound: "not set, so the documented default `info` applies",
        }),
      ],
      modes,
    );
    assert.equal(collapsed.length, 1, `one problem, one finding:\n${render(collapsed)}`);
    assert.equal(collapsed[0].modes, undefined, "a problem true of every mode needs no annotation");
    assert.equal(
      collapsed[0].found,
      "not set in process.env, .env.local, so the documented default `info` applies",
      "the printed sentence is the one the first mode produced, unchanged",
    );
    assert.equal(Object.hasOwn(collapsed[0], "dedupeFound"), false, "internal field must not survive");
    assert.equal(Object.hasOwn(collapsed[0], "mode"), false);

    // A single-mode run has no disagreement to annotate, even when one key
    // yields two findings -- the same undeclared name sitting in two files.
    const stray = (label) => ({
      level: "warn",
      check: "env.undeclared",
      key: "env.undeclared:STRAY",
      mode: "development",
      expected: `every variable in ${label} to be declared in .env.example`,
      found: "STRAY is set there but not declared",
      fix: "document STRAY in .env.example, or remove it if it is a typo",
    });
    const oneMode = dedupeEnvFindings([stray(".env.local"), stray(".env")], ["development"]);
    assert.equal(oneMode.length, 2, "two files are two lines to edit");
    for (const finding of oneMode) {
      assert.equal(finding.modes, undefined);
      assert.equal(
        formatFinding(finding).includes("modes:"),
        false,
        `one mode validated is nothing to annotate:\n${formatFinding(finding)}`,
      );
    }
  }

  /* ---------------------------------------------------------------------
   * 35. The same collapse end to end, on a repo that HAS a .env.local.
   *
   *     Scenario 33 asserts the same "warns once" property on a clone with no
   *     .env files, and that is exactly why it could not catch this: with no
   *     .env.local every mode searches the identical list, the sentences match,
   *     and the collapse fires for the wrong reason. On the documented developer
   *     setup they do not match -- development and production search
   *     "process.env, .env.local", test searches "process.env" -- so keying the
   *     collapse on the printed sentence reports one unset variable twice, once
   *     annotated `development, production` and once `test`.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo({
      envExample: [
        "# A variable the fixture requires.",
        "# @required",
        "# @format nonempty",
        "LIBERTY_TEST_REQUIRED=example",
        "",
        "# A value with a documented fallback that nobody sets.",
        "# @default info",
        "# @format enum:debug,info",
        "LIBERTY_TEST_LEVEL=info",
        "",
        "# Declared only so .env.local has a reason to exist and be read.",
        "# @optional",
        "# @format nonempty",
        "LIBERTY_TEST_OPTIONAL=example",
        "",
      ].join("\n"),
      envLocal: "LIBERTY_TEST_OPTIONAL=set\n",
    });

    const all = runScript(
      repo,
      ["--mode", "development", "--mode", "test", "--mode", "production"],
      // The required variable is satisfied from the real environment rather than
      // .env.local, because test mode does not read that file and a failure there
      // would be scenario 28 rather than this one.
      { LIBERTY_TEST_REQUIRED: "set" },
    );
    assert.equal(all.code, EXIT_OK, `expected success, got:\n${all.stdout}${all.stderr}`);

    /*
     * The precondition, asserted rather than assumed. If .env.local ever stopped
     * being read in development this scenario would silently become scenario 33
     * -- passing while proving nothing -- and the defect it exists for would be
     * reachable again.
     */
    assert.match(
      all.stderr,
      /not set in process\.env, \.env\.local/,
      `the modes must really search different lists here:\n${all.stderr}`,
    );
    assert.equal(
      (all.stderr.match(/WARN env\.default/g) ?? []).length,
      1,
      `one unset default is one warning, not one per searched-source list:\n${all.stderr}`,
    );
    assert.equal(
      all.stderr.includes("modes:"),
      false,
      `a problem true of every mode needs no annotation:\n${all.stderr}`,
    );
  }

  /* ---------------------------------------------------------------------
   * 36. The runtime loader resolves from the same implementation the validator
   *     does, so a value cannot validate clean and behave differently.
   *
   *     This is the regression for the second half of the wrong-bytes defect.
   *     Scenario 27 pins that the VALIDATOR reads the files Next reads. It could
   *     not catch the other half: `next dev` runs with cwd `apps/web`, so it
   *     resolved dotenv files from there while the validator resolved them from
   *     the repository root, and a value written at the root was invisible to
   *     the application while passing validation. `scripts/with-root-env.mjs`
   *     closes that by loading the root files into `process.env` before Next
   *     starts -- and the only thing that keeps the two in step afterwards is
   *     that they share `envFilesForMode` and `parseEnvFile`. That sharing is
   *     what is asserted here: same bytes in, same winner out, in every mode.
   * ------------------------------------------------------------------- */
  {
    /*
     * (a) Which mode a `next` command runs in.
     *
     * Derived from the SUBCOMMAND, because that is what @next/env derives it
     * from -- `isTest ? "test" : dev ? "development" : "production"`, where
     * `dev` is the phase. `defaultModes` above documents this gap and cannot
     * close it: a validator has no command to inspect. A wrapper does.
     */
    assert.equal(nextEnvMode(["next", "dev"], {}), "development");
    assert.equal(nextEnvMode(["next", "build"], {}), "production");
    assert.equal(nextEnvMode(["next", "start"], {}), "production");
    assert.equal(nextEnvMode(["next", "dev", "--port", "3100"], {}), "development");
    assert.equal(nextEnvMode(["next", "build"], { NODE_ENV: "test" }), "test");
    assert.equal(nextEnvMode(["next", "dev"], { NODE_ENV: "test" }), "test");
    // The two cases that prove it is not merely reading NODE_ENV. `next dev`
    // under NODE_ENV=production still loads the development file set, and
    // `next build` under NODE_ENV=development still loads the production one.
    assert.equal(nextEnvMode(["next", "dev"], { NODE_ENV: "production" }), "development");
    assert.equal(nextEnvMode(["next", "build"], { NODE_ENV: "development" }), "production");
    // No phase to read, so no guess: the caller is made to say --mode. Including
    // under NODE_ENV=test, where a confident "test" would be an answer about a
    // command this function cannot see the phase of.
    assert.equal(nextEnvMode(["vitest", "run"], {}), null);
    assert.equal(nextEnvMode(["vitest", "run"], { NODE_ENV: "test" }), null);
    assert.equal(nextEnvMode([], {}), null);
    // The spelling of the command must not matter.
    assert.equal(nextEnvMode(["./node_modules/.bin/next", "build"], {}), "production");
    assert.equal(nextEnvMode(["next.cmd", "dev"], {}), "development");
    // Flags before the subcommand are skipped, not mistaken for it.
    assert.equal(nextEnvMode(["next", "--turbopack", "dev"], {}), "development");

    /*
     * (b) One set of bytes, read by both, resolving identically.
     *
     * The loader's fixture IS the validator's snapshot, so there is no room for
     * the two to be given different files by accident -- which is exactly how a
     * test like this passes while proving nothing.
     */
    const layered = snapshotFor({
      envFiles: {
        ".env.production.local": "PICK=production-local\nONLY_PROD_LOCAL=x\n",
        ".env.local": "PICK=local\nONLY_LOCAL=y\n",
        ".env.production": "PICK=production\n",
        ".env.test": "PICK=test\n",
        ".env": "PICK=env\nONLY_SHARED=z\n",
      },
    });
    const readEnvFile = (file) => layered.files[file]?.text ?? null;

    for (const mode of ["development", "test", "production"]) {
      const { applied, bySource } = resolveRootEnv({ mode, processEnv: {}, readEnvFile });
      const validatorSources = buildSources(layered, {}, mode);

      for (const [name, value] of applied) {
        const resolved = resolveVariable(name, validatorSources);
        assert.equal(value, resolved.value, `${name} resolves differently in ${mode}`);
        const from = [...bySource].find(([, names]) => names.includes(name))[0];
        assert.equal(from, resolved.source, `${name} came from a different file in ${mode}`);
      }

      /*
       * And nothing is silently dropped in either direction. Under `test` this
       * is the assertion that carries the weight: `.env.local` is omitted from
       * that mode's list, so ONLY_LOCAL must be absent from BOTH sides. A loader
       * that read it would hand the application a value the validator never
       * checked -- the same defect, pointed the other way.
       */
      const validatorNames = new Set(
        validatorSources
          .filter((source) => source.label !== "process.env")
          .flatMap((source) => [...source.values.keys()]),
      );
      assert.deepEqual(
        [...applied.keys()].sort(),
        [...validatorNames].sort(),
        `the loader and the validator see different names in ${mode}`,
      );
      assert.equal(
        mode === "test",
        !validatorNames.has("ONLY_LOCAL"),
        `.env.local must be read in ${mode} exactly when the validator reads it`,
      );
    }

    /*
     * (c) process.env outranks every file, and PRESENT is the test -- not
     * truthy. @next/env's merge is `typeof initialEnv[name] === "undefined"`, so
     * an exported empty string wins over a file. `.github/workflows/ci.yml` and
     * `e2e/playwright.config.ts` both depend on an exported value winning.
     */
    const exported = resolveRootEnv({
      mode: "production",
      processEnv: { PICK: "exported", ONLY_LOCAL: "" },
      readEnvFile,
    });
    assert.equal(exported.applied.has("PICK"), false);
    assert.equal(exported.applied.has("ONLY_LOCAL"), false);
    assert.equal(exported.applied.get("ONLY_PROD_LOCAL"), "x");

    /*
     * (d) NODE_ENV is never applied from a file.
     *
     * `.env.example` ships `NODE_ENV=development` and README says to copy it to
     * `.env.local`, while `next/dist/bin/next` does
     * `process.env.NODE_ENV = process.env.NODE_ENV || defaultEnv` -- it respects
     * a pre-set value. A loader that injected it would quietly turn every
     * `npm run build` into a development build. The conflict is reported as the
     * FILE, never the value.
     */
    const declaresNodeEnv = (file) =>
      file === ".env.local" ? "NODE_ENV=development\nKEEP=yes\n" : null;
    const skipped = resolveRootEnv({
      mode: "production",
      processEnv: {},
      readEnvFile: declaresNodeEnv,
    });
    assert.equal(skipped.applied.has("NODE_ENV"), false);
    assert.equal(skipped.applied.get("KEEP"), "yes");
    assert.equal(skipped.nodeEnvConflict, ".env.local");
    // Agreeing with the mode in force is not a conflict, and a note printed on
    // every `next dev` is a note nobody reads by the time it matters.
    assert.equal(
      resolveRootEnv({ mode: "development", processEnv: {}, readEnvFile: declaresNodeEnv })
        .nodeEnvConflict,
      null,
    );

    /*
     * (e) The root is found, not assumed. `apps/web` has a package.json too, and
     * accepting it would reproduce the original defect inside the fix.
     */
    const fixtureRoot = path.resolve(path.sep, "liberty-root-fixture");
    const fixtureWeb = path.join(fixtureRoot, "apps", "web");
    const tree = new Map([
      [path.join(fixtureRoot, "package.json"), JSON.stringify({ workspaces: ["apps/*"] })],
      [path.join(fixtureWeb, "package.json"), JSON.stringify({ name: "@liberty/web" })],
    ]);
    assert.equal(findRepoRoot(fixtureWeb, { readFile: (file) => tree.get(file) ?? null }), fixtureRoot);
    // No root, no guess. Refusing loudly is the whole point.
    assert.throws(
      () => findRepoRoot(fixtureWeb, { readFile: () => null }),
      /could not find the repository root/,
    );

    /*
     * (f) The wiring itself, because a correct loader nobody calls is the defect
     * with extra steps -- and, just as load-bearing, the two scripts that must
     * stay OUT of it. Each exclusion has its own reason and neither is an
     * oversight, so both are pinned rather than left to be re-derived:
     *
     *   - `test`: vitest reads no dotenv file at all today, so routing it
     *     through the loader would newly make the unit gate depend on `.env` and
     *     on a git-ignored `.env.test.local`;
     *   - `build`: `turbo.json` hashes `globalEnv` from the environment it sees
     *     BEFORE launching the task, and the loader sets those variables INSIDE
     *     it, so wrapping `build` means turbo hashing the absence of exactly the
     *     variables the build used. `LIBERTY_FIXTURE_MEDIA_ORIGIN` is read at
     *     module scope by `authorized-candidates.ts` and `watch-session.ts`, so
     *     it is baked into the output; whether `globalDependencies` still covers
     *     it when `.gitignore` ignores `.env*` is an open question recorded in
     *     `docs/DEVELOPMENT.md`, along with the experiment that settles it. CI
     *     pins those variables in the job `env:`, where turbo hashes them
     *     correctly, so the build that ships was never relying on the loader.
     *
     * This assertion changed when `build` was unwrapped: it previously required
     * all three of dev/build/start to match. It was pinning the behaviour that
     * turned out to be the risk, so it now pins the split instead -- and it is
     * the reason re-wrapping `build` after the experiment is a deliberate edit
     * in two files rather than a silent one in one.
     */
    const webScripts = JSON.parse(
      fs.readFileSync(path.resolve("apps/web/package.json"), "utf8"),
    ).scripts;
    for (const name of ["dev", "start"]) {
      assert.match(
        webScripts[name],
        /with-root-env\.mjs/,
        `apps/web "${name}" runs with cwd apps/web and must load the root env first`,
      );
    }
    assert.equal(
      /with-root-env/.test(webScripts.build),
      false,
      'apps/web "build" must not load the root env: turbo hashes globalEnv before the task ' +
        "starts, so the loader would set cache-key variables the cache key cannot see",
    );
    assert.equal(/with-root-env/.test(webScripts.test), false);

    /*
     * The same defect had a second location, and it is pinned here rather than
     * in a scenario of its own because it is the same fact: a package script
     * runs with cwd set to its own directory, so it does not see the root
     * `.env.local` the setup instructions tell people to write.
     *
     * `packages/persistence`'s `db:*` scripts run drizzle-kit, whose bundled
     * dotenv opens `<cwd>/.env` and nothing else -- so `drizzle.config.ts` read
     * an empty `DATABASE_URL`. That failed loudly, unlike the `apps/web` case,
     * which is the only reason it survived being noticed.
     *
     * The `--mode` is asserted, not just the wrapper. Without it the wrapper
     * refuses to run at all (only `next` has a subcommand it can derive a phase
     * from), and WHICH mode is the load-bearing part: `test` omits `.env.local`
     * and would reintroduce the defect, `production` reads
     * `.env.production.local` first and would point a migration at the wrong
     * database by default. The reasoning is in `drizzle.config.ts`; this stops
     * it being edited away by accident.
     *
     * `test` stays out for the same reason `apps/web`'s does: vitest reads no
     * dotenv file, and wrapping it would newly make the unit gate depend on one.
     */
    const persistenceScripts = JSON.parse(
      fs.readFileSync(path.resolve("packages/persistence/package.json"), "utf8"),
    ).scripts;
    for (const name of ["db:generate", "db:migrate", "db:check"]) {
      assert.match(
        persistenceScripts[name],
        /with-root-env\.mjs/,
        `@liberty/persistence "${name}" runs with cwd packages/persistence and must load the ` +
          `root env first: drizzle-kit's dotenv only opens <cwd>/.env`,
      );
      assert.match(
        persistenceScripts[name],
        /--mode development\b/,
        `@liberty/persistence "${name}" must state --mode development: drizzle-kit has no ` +
          `subcommand the wrapper can derive a phase from, test omits .env.local, and ` +
          `production reads .env.production.local first`,
      );
    }
    assert.equal(/with-root-env/.test(persistenceScripts.test), false);
  }

  console.log("Environment validation tests passed (38 scenarios).");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
