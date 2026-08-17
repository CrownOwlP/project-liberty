import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  EXIT_INVALID,
  EXIT_OK,
  EXIT_USAGE,
  buildSources,
  checkEnvironmentVariables,
  checkFormat,
  checkInstall,
  checkNodeVersion,
  checkServices,
  describeFormat,
  evaluate,
  formatFinding,
  parseArgs,
  parseEnvContract,
  parseEnvFile,
  probePort,
} from "./validate-env.mjs";

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

/** Minimal snapshot in the shape gatherRepoState() produces. */
function snapshotFor({
  manifest = { name: "fixture", workspaces: [], devDependencies: {} },
  lock = { name: "fixture", lockfileVersion: 3, packages: { "": { devDependencies: {} } } },
  hidden = { lockfileVersion: 3, packages: {} },
  nodeModulesExists = true,
  workspaces = [],
  emptyPatterns = [],
} = {}) {
  const json = (value) =>
    value === null
      ? { text: null, json: null, parseError: null }
      : { text: JSON.stringify(value), json: value, parseError: null };
  return {
    root: "/fixture",
    files: {
      "package.json": json(manifest),
      "package-lock.json": json(lock),
      "node_modules/.package-lock.json": json(hidden),
      ".nvmrc": { text: `${NODE_MAJOR}\n` },
      ".env.example": { text: "" },
      ".env.local": { text: null },
      ".env": { text: null },
    },
    nodeModulesExists,
    workspaces,
    emptyPatterns,
  };
}

function freshRepo({ envExample, envLocal, manifest, lock, hidden, nvmrc } = {}) {
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
  return repo;
}

/** Environment with the fixture's own variables stripped, so the parent shell cannot satisfy them. */
function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith("LIBERTY_TEST_")) delete env[name];
  }
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
    assert.deepEqual(parseArgs([]).options, { quiet: false, scope: "app", services: false, help: false });
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
    assert.deepEqual(
      fresh.map((f) => `${f.level}:${f.check}:${f.expected.split(" ")[0]}`),
      ["warn:env.default:CONTENT_RIGHTS_ENFORCEMENT"],
      "the cache-key concern survives as a warning rather than being discarded",
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

    // Both services are optional by design; docs/DATABASE.md pins no ORM yet
    // and Redis is an optional cache. If that changes, this assertion is the
    // reminder to change the contract deliberately rather than by accident.
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
      clean.sources.map((source) => source.label),
      ["process.env", ".env.local"],
    );

    const dirty = evaluate(snapshot, { actualVersion: "1.0.0", processEnv: {}, scope: "app" });
    assert.ok(dirty.findings.some((f) => f.check === "node.version"));

    assert.deepEqual(
      buildSources(snapshot, { A: "1" })[0].values.get("A"),
      "1",
    );
  }

  console.log("Environment validation tests passed (27 scenarios).");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
