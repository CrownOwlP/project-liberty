#!/usr/bin/env node
/**
 * Environment validation.
 *
 * `scripts/validate-repo.mjs` answers "is this checkout structurally intact".
 * This answers a different question: "can this machine actually run the thing,
 * and will anything it produces mean what it claims to mean". Those failures
 * look nothing alike. A missing file is obvious the moment you look; a gate
 * recorded as `pass` under Node 20 when the repo pins 22, or a `node_modules`
 * that silently predates the lockfile, produces evidence that is wrong rather
 * than absent -- and wrong evidence is worse, because the control plane trusts
 * it and unlocks dependent work on the strength of it.
 *
 * Three rules shape everything below.
 *
 * 1. FAIL CLOSED, AND SAY WHY. "Environment invalid" costs the reader a
 *    bisect. Every finding carries expected / found / fix, because the point of
 *    running this is to be told what to type next.
 *
 * 2. MISSING IS NOT THE SAME AS WRONG. "DATABASE_URL is not set" and
 *    "DATABASE_URL is set to something that is not a postgres URL" have
 *    different causes and different fixes, and collapsing them into "invalid"
 *    sends whoever is debugging to the wrong file. Every check that can
 *    distinguish the two does.
 *
 * 3. VALUES ARE NEVER PRINTED. Not even to show that one is malformed, and not
 *    even when the variable is not marked `@secret` -- because whether a given
 *    value is a credential is a property of the machine it is running on, not
 *    of this file's annotations. Findings name the variable and the nature of
 *    the problem. A validator that echoes environment into CI logs is a
 *    credential-disclosure bug wearing a helpful face. (Text taken from the
 *    committed contract -- an accepted enum set, a `@default` -- is not a
 *    value in this sense: it is already public in `.env.example`.)
 *
 * 4. A CHECK THAT FAILS A CORRECT CHECKOUT IS WORSE THAN NO CHECK. A fresh
 *    clone with no `.env.local` must pass, or people learn to run this with
 *    their eyes closed and it stops catching anything. So where absence is
 *    well-defined -- a variable with a documented `@default`, a runtime NEWER
 *    than the pin, which still runs the repo -- the finding is a WARNING that
 *    names the consequence, not a failure. Both escalate to failures under
 *    `--scope ci`, which is where "unset" and "unpinned" stop describing
 *    someone's laptop and start describing the evidence the control plane
 *    trusts. Being set to an INVALID value stays a failure everywhere; that is
 *    not absence, it is a wrong answer.
 *
 * The contract itself lives in `.env.example`, which is parsed rather than
 * merely copied. Keeping the declaration next to the human explanation is the
 * only arrangement where the two cannot drift apart.
 *
 * Usage:
 *   node scripts/validate-env.mjs [--quiet] [--scope app|ci] [--services]
 *
 *   --quiet      suppress success output; failures and warnings still print
 *   --scope ci   also require variables annotated `@scope ci`
 *   --services   additionally probe PostgreSQL/Redis reachability (opt-in;
 *                the local stack is documented as optional)
 *
 * Exit codes: 0 clean, 1 validation failed, 2 usage error. Usage error is
 * distinct so a CI step that mistypes a flag is not silently indistinguishable
 * from a machine that is genuinely broken.
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const EXIT_OK = 0;
export const EXIT_INVALID = 1;
export const EXIT_USAGE = 2;

/** Sources are consulted in this order; the first one holding a name wins. */
const ENV_FILES = [".env.local", ".env"];

const NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const KNOWN_SCOPES = new Set(["app", "ci"]);

/**
 * What counts as "not a real value" in `.env.example`.
 *
 * Used in two directions: a `@secret` whose example is NOT a placeholder is a
 * defect in the committed file, and a live value that still IS one means the
 * developer copied the template and never filled it in. The second case reports
 * as unconfigured rather than satisfied, because a placeholder passed to a
 * provider fails at the worst possible moment with an authentication error
 * nobody connects back to a `cp` from three weeks ago.
 */
const PLACEHOLDER = /^(|replace-me(-[a-z0-9-]+)?|changeme|placeholder|<.*>)$/i;

/* ==========================================================================
 * Findings
 * ========================================================================== */

/**
 * A finding is structured rather than a string so tests can assert on the
 * check id without pinning prose, and so the expected/found/fix discipline is
 * enforced by the shape instead of by reviewer vigilance.
 */
export function fail(check, detail) {
  return { level: "error", check, ...detail };
}
export function warn(check, detail) {
  return { level: "warn", check, ...detail };
}

export function formatFinding(finding) {
  const lines = [`${finding.level === "error" ? "FAIL" : "WARN"} ${finding.check}`];
  if (finding.expected) lines.push(`  expected: ${finding.expected}`);
  if (finding.found) lines.push(`  found:    ${finding.found}`);
  if (finding.fix) lines.push(`  fix:      ${finding.fix}`);
  return lines.join("\n");
}

/* ==========================================================================
 * .env parsing
 * ========================================================================== */

function unquote(value) {
  const quoted =
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")));
  return quoted ? value.slice(1, -1) : value;
}

/**
 * Parse a dotenv file into name -> value.
 *
 * Deliberately minimal: no interpolation, no multi-line values. Next.js's own
 * loader supports more, but this parser only ever decides whether a name is
 * present and whether its shape is right, and a richer parser here could
 * disagree with the real loader about what the value IS -- reporting a variable
 * as malformed that the app resolves perfectly well, or the reverse.
 */
export function parseEnvFile(text) {
  const values = new Map();
  if (!text) return values;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    values.set(body.slice(0, eq).trim(), unquote(body.slice(eq + 1).trim()));
  }
  return values;
}

/* ==========================================================================
 * Value formats
 * ========================================================================== */

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * Format checkers return null when the value is acceptable, or a description of
 * the problem that CONTAINS NO PART OF THE VALUE -- not the value, not its
 * scheme, not its host. Rule 3 in the header.
 */
const FORMATS = {
  nonempty: {
    describe: () => "a non-empty value",
    check: (value) => (value.trim() ? null : "set but empty"),
  },
  url: {
    describe: () => "an absolute http:// or https:// URL",
    check: (value) => {
      const url = parseUrl(value);
      if (!url) return "not a parseable absolute URL";
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return "an absolute URL, but not http:// or https://";
      }
      if (!url.hostname) return "a URL with no host";
      return null;
    },
  },
  "postgres-url": {
    describe: () => "a postgresql:// URL including host, port, and database name",
    check: (value) => {
      const url = parseUrl(value);
      if (!url) return "not a parseable URL";
      if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
        return "a URL, but not postgresql:// or postgres://";
      }
      if (!url.hostname) return "a postgres URL with no host";
      if (url.pathname.replace(/^\//, "") === "") return "a postgres URL with no database name";
      return null;
    },
  },
  "redis-url": {
    describe: () => "a redis:// or rediss:// URL including host",
    check: (value) => {
      const url = parseUrl(value);
      if (!url) return "not a parseable URL";
      if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
        return "a URL, but not redis:// or rediss://";
      }
      if (!url.hostname) return "a redis URL with no host";
      return null;
    },
  },
  integer: {
    describe: () => "a base-10 integer",
    check: (value) => (/^-?\d+$/.test(value.trim()) ? null : "not a base-10 integer"),
  },
  hex40: {
    describe: () => "a full 40-character hex sha",
    check: (value) =>
      /^[0-9a-f]{40}$/.test(value.trim()) ? null : "not a full 40-character lowercase hex sha",
  },
};

function enumMembers(format) {
  return format.slice("enum:".length).split(",").map((member) => member.trim()).filter(Boolean);
}

export function isKnownFormat(format) {
  if (format.startsWith("enum:")) return enumMembers(format).length > 0;
  return Object.hasOwn(FORMATS, format);
}

export function describeFormat(format) {
  if (format.startsWith("enum:")) return `one of: ${enumMembers(format).join(", ")}`;
  return FORMATS[format].describe();
}

export function checkFormat(format, value) {
  if (format.startsWith("enum:")) {
    /*
     * The unaccepted value is NOT echoed, even though an enum's accepted set is
     * public and seeing the typo would shorten the diagnosis considerably.
     * Whether a value is sensitive depends on what the operator actually put
     * there, not on what this file predicted they would put there, and a
     * validator that is safe only for correctly-configured environments is not
     * safe. The variable name plus the accepted set is enough to look.
     */
    return enumMembers(format).includes(value) ? null : "a value outside the accepted set";
  }
  return FORMATS[format].check(value);
}

/* ==========================================================================
 * .env.example -- the contract
 * ========================================================================== */

/**
 * The annotation vocabulary and the arity of each entry.
 *
 * `0` is a bare flag. `1` takes exactly one whitespace-delimited token.
 * `"rest"` takes the remainder of the line, because a default value may
 * legitimately contain a space.
 */
const ANNOTATION_ARITY = new Map([
  ["@required", 0],
  ["@optional", 0],
  ["@secret", 0],
  ["@cache-key", 0],
  ["@format", 1],
  ["@scope", 1],
  ["@default", "rest"],
]);

/** `@word` or `@two-words` and nothing else: no slashes, no trailing punctuation. */
const ANNOTATION_TOKEN = /^@[a-z][a-z0-9-]*$/;

/**
 * Decide whether a comment line is an annotation or prose.
 *
 * "Starts with @" is not the test, and using it was a bug: a description that
 * happens to wrap onto a line beginning `@liberty/observability;` is ordinary
 * English, and reading it as an annotation made the contract reject itself. The
 * file has to survive being written in sentences, because that is what the
 * descriptions are.
 *
 * So a line is an annotation when EITHER its first token is a known annotation
 * keyword, OR the entire line is one lone annotation-shaped token. The second
 * clause is what keeps a typo loud: `@bogus` on a line by itself is reported as
 * an unknown annotation rather than silently absorbed into the prose, where it
 * would look exactly like a correctly annotated variable that just happens not
 * to be annotated. Anything else -- a sentence, a package name, an email
 * address, a decorator mentioned in passing -- is prose.
 */
export function matchAnnotation(body) {
  if (!body.startsWith("@")) return null;
  const separator = body.search(/\s/);
  const keyword = separator === -1 ? body : body.slice(0, separator);
  const rest = separator === -1 ? "" : body.slice(separator + 1).trim();
  if (ANNOTATION_ARITY.has(keyword)) return { keyword, rest };
  if (rest === "" && ANNOTATION_TOKEN.test(keyword)) return { keyword, rest };
  return null;
}

/**
 * Parse `.env.example` into declarations plus defects IN THE FILE ITSELF.
 *
 * The second list matters as much as the first. A contract that is unparseable,
 * self-contradictory, or missing a description does not fail loudly on its own;
 * it just quietly stops covering the variable it was supposed to describe, and
 * the check keeps reporting success over a shrinking set. So a malformed
 * contract fails the run.
 *
 * Annotation lines are recognised by `matchAnnotation`; every other comment
 * line is description. Both accumulate until a blank line, which resets them --
 * that is what keeps a section banner from being adopted as the next variable's
 * documentation.
 */
export function parseEnvContract(text) {
  const variables = [];
  const defects = [];
  if (text === null || text === undefined) {
    return { variables, defects: ["`.env.example` is missing"] };
  }

  const seen = new Map();
  let description = [];
  let annotations = [];

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i].trim();

    if (!line) {
      description = [];
      annotations = [];
      continue;
    }
    if (line.startsWith("#")) {
      const body = line.slice(1).trim();
      const annotation = matchAnnotation(body);
      if (annotation) annotations.push(annotation);
      else if (body) description.push(body);
      continue;
    }

    const eq = line.indexOf("=");
    if (eq <= 0) {
      defects.push(`line ${lineNo}: not a comment and not a NAME=value assignment`);
      description = [];
      annotations = [];
      continue;
    }

    const name = line.slice(0, eq).trim();
    const example = unquote(line.slice(eq + 1).trim());
    const declaration = {
      name,
      example,
      line: lineNo,
      description: description.join(" "),
      required: false,
      secret: false,
      scope: "app",
      format: null,
      defaultValue: null,
      cacheKey: false,
    };

    let required = null;
    for (const { keyword, rest } of annotations) {
      const arity = ANNOTATION_ARITY.get(keyword);
      if (arity === undefined) {
        defects.push(`${name}: unknown annotation "${keyword}"`);
        continue;
      }
      // Arity is checked before meaning, so `@required strict` is reported as a
      // malformed annotation rather than quietly acting like `@required`.
      if (arity === 0 && rest) {
        defects.push(`${name}: ${keyword} takes no value, but "${rest}" follows it`);
        continue;
      }
      if (arity !== 0 && !rest) {
        defects.push(`${name}: ${keyword} has no value`);
        continue;
      }
      if (arity === 1 && /\s/.test(rest)) {
        defects.push(`${name}: ${keyword} takes exactly one value, got "${rest}"`);
        continue;
      }
      switch (keyword) {
        case "@required":
          if (required === false) defects.push(`${name}: declared both @required and @optional`);
          required = true;
          break;
        case "@optional":
          if (required === true) defects.push(`${name}: declared both @required and @optional`);
          required = false;
          break;
        case "@secret":
          declaration.secret = true;
          break;
        case "@cache-key":
          declaration.cacheKey = true;
          break;
        case "@format":
          if (!isKnownFormat(rest)) defects.push(`${name}: unknown @format "${rest}"`);
          else declaration.format = rest;
          break;
        case "@scope":
          if (!KNOWN_SCOPES.has(rest))
            defects.push(`${name}: unknown @scope "${rest}" (expected app or ci)`);
          else declaration.scope = rest;
          break;
        case "@default":
          declaration.defaultValue = unquote(rest);
          break;
      }
    }

    if (!NAME_PATTERN.test(name)) {
      defects.push(`line ${lineNo}: "${name}" is not a valid environment variable name`);
    }
    if (seen.has(name)) {
      defects.push(`${name}: declared twice (lines ${seen.get(name)} and ${lineNo})`);
    }
    seen.set(name, lineNo);

    /*
     * `@default` is the third answer to "what happens when this is unset", and
     * it is a complete one, so it satisfies the same rule `@required` and
     * `@optional` do. What it cannot be is BOTH: a variable with a documented
     * fallback is by definition not one whose absence is an error, and a file
     * claiming otherwise has no single answer to the only question the
     * annotation exists to settle.
     */
    if (required === true && declaration.defaultValue !== null) {
      defects.push(
        `${name}: declared both @required and @default; a variable with a documented ` +
          `default is not required, so say which one it is`,
      );
    }
    if (required === null && declaration.defaultValue === null) {
      defects.push(`${name}: must be annotated @required, @optional, or @default`);
    }
    declaration.required = required === true && declaration.defaultValue === null;

    // A committed default for a credential is a committed credential.
    if (declaration.secret && declaration.defaultValue !== null) {
      defects.push(`${name}: is @secret, so it cannot carry a @default in a committed file`);
    }

    /*
     * `@cache-key` only means something alongside `@default`: it is the reason
     * the warning about an unset variable is worth printing at all, and on a
     * variable that has no fallback there is nothing for it to qualify. Left
     * inert it would read as a check that is running when it is not.
     */
    if (declaration.cacheKey && declaration.defaultValue === null) {
      defects.push(
        `${name}: @cache-key requires @default; it describes what an unset variable ` +
          `hashes as, which is only well-defined when the fallback is documented`,
      );
    }

    /*
     * The default must satisfy its own declared format, for the same reason the
     * example must: it is the value that applies on every machine that has not
     * set the variable, so a malformed one is malformed everywhere at once.
     */
    if (declaration.format && declaration.defaultValue) {
      const problem = checkFormat(declaration.format, declaration.defaultValue);
      if (problem) {
        defects.push(
          `${name}: the @default value is ${problem}; expected ${describeFormat(declaration.format)}`,
        );
      }
    }

    /*
     * The example on the assignment line and the `@default` must agree. They
     * are read by different audiences -- one by whoever runs `cp .env.example
     * .env.local`, the other by the validator -- and when they disagree, the
     * documented behaviour and the copied behaviour are quietly different.
     */
    if (declaration.defaultValue !== null && example !== declaration.defaultValue) {
      defects.push(
        `${name}: the example value and @default disagree ("${example}" vs ` +
          `"${declaration.defaultValue}"); copying this file must produce the documented default`,
      );
    }

    if (!declaration.description) {
      defects.push(`${name}: has no description; say what the variable is for`);
    }

    /*
     * The committed file must never carry a live credential, so a `@secret`
     * whose example is anything other than a placeholder fails the run. This is
     * the one check whose purpose is to stop a mistake from being committed
     * rather than to describe the current machine.
     */
    if (declaration.secret && !PLACEHOLDER.test(example)) {
      defects.push(
        `${name}: is @secret but .env.example carries a non-placeholder value; ` +
          `blank it and rotate the credential if it was ever real`,
      );
    }

    /*
     * The example must satisfy its own declared format. Otherwise the template
     * everyone copies is the source of the malformed value this script will
     * later report on every machine at once.
     */
    if (declaration.format && example && !PLACEHOLDER.test(example)) {
      const problem = checkFormat(declaration.format, example);
      if (problem) {
        defects.push(
          `${name}: the example value in .env.example is ${problem}; ` +
            `expected ${describeFormat(declaration.format)}`,
        );
      }
    }

    variables.push(declaration);
    description = [];
    annotations = [];
  }

  return { variables, defects };
}

/* ==========================================================================
 * Node runtime
 * ========================================================================== */

function majorOf(version) {
  const match = /^v?(\d+)/.exec(String(version).trim());
  return match ? Number(match[1]) : null;
}

/**
 * The runtime should be the pinned MAJOR, in both directions -- but the two
 * directions are not the same kind of problem, so they do not get the same
 * severity.
 *
 * Too old is a failure: the repo may genuinely not run, and below
 * `engines.node` npm agrees.
 *
 * Too new is a WARNING under the default scope. Everything works; what is wrong
 * is the evidence, not the machine. Failing here would mean a developer whose
 * shell defaults to the current Node release cannot run `npm run check` at all
 * until they fix their shell, and the reliable outcome of that is that the
 * check gets skipped rather than that the runtime gets pinned. So it is
 * reported loudly and it does not block -- except under `--scope ci`, where the
 * runtime is chosen by a workflow file rather than by whoever is sitting there,
 * an unpinned one is a misconfiguration, and the gate evidence being recorded
 * is exactly the thing this check protects.
 *
 * The remedies differ too, because the fixes genuinely differ -- one is
 * "install it", the other is usually "you have it, you are just not using it".
 */
export function checkNodeVersion({ nvmrcText, enginesNode, actualVersion, scope = "app" }) {
  const findings = [];
  const actual = majorOf(actualVersion);

  if (nvmrcText === null || nvmrcText === undefined) {
    findings.push(
      fail("node.pin", {
        expected: "`.nvmrc` pinning the Node major this repo is built and gated on",
        found: "no .nvmrc in the repository root",
        fix: "restore .nvmrc (this repo pins Node 22)",
      }),
    );
  }

  const pinned = nvmrcText ? majorOf(nvmrcText) : null;
  if (nvmrcText && pinned === null) {
    findings.push(
      fail("node.pin", {
        expected: "a Node major version in .nvmrc, e.g. `22`",
        found: "an .nvmrc that does not start with a version number",
        fix: "write the major version into .nvmrc",
      }),
    );
  }

  if (pinned !== null && actual !== null && actual !== pinned) {
    const tooOld = actual < pinned;
    const detail = {
      expected: `Node ${pinned}.x, pinned by .nvmrc`,
      found: `Node ${actualVersion}`,
      fix: tooOld
        ? `install Node ${pinned} (nvm install ${pinned} / fnm install ${pinned}), then re-run`
        : `switch to the pinned major (nvm use ${pinned} / fnm use ${pinned}) before recording ` +
          `gate evidence: this run is on Node ${actual}, which is not the runtime this repo ` +
          `ships, so anything it proves is weaker than it looks` +
          (scope === "ci" ? " -- and CI is where that evidence gets recorded" : ""),
    };
    findings.push(
      tooOld || scope === "ci" ? fail("node.version", detail) : warn("node.version", detail),
    );
  }

  /*
   * package.json `engines` and .nvmrc are two statements of the same fact, and
   * nothing keeps them in step. When they disagree the repo has no single
   * answer to "which Node", so this is reported as a defect in the repo rather
   * than in the developer's machine -- a distinction that decides whether the
   * reader edits their shell or edits the manifest.
   */
  const engineMin = enginesNode ? majorOf(String(enginesNode).replace(/^[^\d]*/, "")) : null;
  if (pinned !== null && engineMin !== null && pinned < engineMin) {
    findings.push(
      fail("node.pin-consistency", {
        expected: `.nvmrc (${pinned}) to satisfy package.json engines.node (${enginesNode})`,
        found: `.nvmrc pins ${pinned}, which the engines range excludes`,
        fix: "reconcile .nvmrc and package.json engines.node; they must name the same runtime",
      }),
    );
  }
  if (engineMin !== null && actual !== null && actual < engineMin) {
    findings.push(
      fail("node.engines", {
        expected: `Node satisfying package.json engines.node (${enginesNode})`,
        found: `Node ${actualVersion}`,
        fix: `install a Node that satisfies ${enginesNode}`,
      }),
    );
  }

  return findings;
}

/* ==========================================================================
 * Install state: workspaces, node_modules, lockfile
 * ========================================================================== */

/**
 * Lock entries that are legitimately absent from an installed tree.
 *
 * Platform-gated optional dependencies (esbuild/rollup/swc binaries and the
 * like) are in the lockfile for every platform and installed on exactly one.
 * Comparing them would report dozens of phantom failures on every machine that
 * is not the one the lockfile was last refreshed on, and a check that cries
 * wolf on a healthy tree is a check people learn to ignore -- which costs more
 * than the drift it was meant to catch.
 *
 * Workspace links are excluded too: they are verified directly, against the
 * directory they resolve to, which is a stronger check than presence in a list.
 */
function isExpectedInTree(entry) {
  if (!entry || typeof entry !== "object") return false;
  if (entry.link === true) return false;
  if (entry.optional === true) return false;
  if (Array.isArray(entry.os) || Array.isArray(entry.cpu)) return false;
  return true;
}

function sameDependencySet(a = {}, b = {}) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if (a[key] !== b[key]) return false;
  return true;
}

/**
 * Pure over the snapshot produced by `gatherRepoState`, so every branch here is
 * reachable from a test without constructing a real npm install on disk.
 */
export function checkInstall(snapshot) {
  const findings = [];
  const pkg = snapshot.files["package.json"];

  if (!pkg || pkg.text === null) {
    return [
      fail("workspaces.manifest", {
        expected: "package.json in the repository root",
        found: "no package.json",
        fix: "run this from the repository root",
      }),
    ];
  }
  if (pkg.parseError) {
    return [
      fail("workspaces.manifest", {
        expected: "package.json to be valid JSON",
        found: `a parse error: ${pkg.parseError}`,
        fix: "repair package.json",
      }),
    ];
  }

  const manifest = pkg.json;
  if (!Array.isArray(manifest.workspaces)) {
    findings.push(
      fail("workspaces.declaration", {
        expected: "a `workspaces` array in package.json",
        found: "no workspaces declaration",
        fix: "restore the workspaces globs (apps/*, packages/*)",
      }),
    );
  }

  for (const pattern of snapshot.emptyPatterns ?? []) {
    findings.push(
      fail("workspaces.declaration", {
        expected: `workspace pattern "${pattern}" to match at least one package`,
        found: "it matched nothing",
        fix: "remove the pattern or add the package it refers to",
      }),
    );
  }

  const names = new Map();
  for (const workspace of snapshot.workspaces) {
    if (workspace.parseError) {
      findings.push(
        fail("workspaces.package", {
          expected: `${workspace.dir}/package.json to be valid JSON`,
          found: `a parse error: ${workspace.parseError}`,
          fix: `repair ${workspace.dir}/package.json`,
        }),
      );
      continue;
    }
    if (!workspace.name) {
      findings.push(
        fail("workspaces.package", {
          expected: `${workspace.dir}/package.json to declare a name`,
          found: "no name field",
          fix: `add a name to ${workspace.dir}/package.json`,
        }),
      );
      continue;
    }
    if (names.has(workspace.name)) {
      findings.push(
        fail("workspaces.package", {
          expected: "each workspace to have a unique package name",
          found: `${workspace.name} is declared by both ${names.get(workspace.name)} and ${workspace.dir}`,
          fix: "rename one of them; npm cannot link two packages to the same name",
        }),
      );
    }
    names.set(workspace.name, workspace.dir);
  }

  /*
   * `node_modules` missing is the root cause of every link and hidden-lockfile
   * failure below, so the derived checks are skipped rather than allowed to
   * pile forty consequences on top of one cause. The single actionable line
   * survives; it does not get buried.
   */
  if (!snapshot.nodeModulesExists) {
    findings.push(
      fail("install.node_modules", {
        expected: "node_modules/ in the repository root",
        found: "dependencies are not installed",
        fix: "npm install",
      }),
    );
    return findings;
  }

  const lock = snapshot.files["package-lock.json"];
  const hidden = snapshot.files["node_modules/.package-lock.json"];

  if (!lock || lock.text === null) {
    findings.push(
      fail("install.lockfile", {
        expected: "package-lock.json in the repository root",
        found: "no lockfile",
        fix: "npm install (and commit the lockfile: without it no two runs install the same tree)",
      }),
    );
    return findings;
  }
  if (lock.parseError) {
    findings.push(
      fail("install.lockfile", {
        expected: "package-lock.json to be valid JSON",
        found: `a parse error: ${lock.parseError}`,
        fix: "restore the lockfile from version control; do not hand-edit it",
      }),
    );
    return findings;
  }

  const lockDoc = lock.json;
  if (lockDoc.name !== manifest.name) {
    findings.push(
      fail("install.lockfile", {
        expected: `the lockfile to describe "${manifest.name}"`,
        found: `it describes "${lockDoc.name}"`,
        fix: "the lockfile belongs to a different project; restore the correct one",
      }),
    );
  }
  if (!lockDoc.packages || typeof lockDoc.packages !== "object") {
    findings.push(
      fail("install.lockfile", {
        expected: "a lockfileVersion 2+ lockfile (one with a `packages` map)",
        found: `lockfileVersion ${lockDoc.lockfileVersion ?? "unknown"}`,
        fix: "npm install with npm 10+ to upgrade the lockfile",
      }),
    );
    return findings;
  }

  // A workspace absent from the lockfile means the lockfile predates it: npm ci
  // would then install a tree that has never contained that package, and the
  // failure surfaces as an unresolved import rather than as a lockfile problem.
  for (const workspace of snapshot.workspaces) {
    if (!workspace.name) continue;
    const entry = lockDoc.packages[workspace.dir];
    if (!entry) {
      findings.push(
        fail("install.lockfile-drift", {
          expected: `a lockfile entry for workspace ${workspace.dir}`,
          found: "no entry",
          fix: "npm install to refresh package-lock.json, then commit it",
        }),
      );
    } else if (entry.name && entry.name !== workspace.name) {
      findings.push(
        fail("install.lockfile-drift", {
          expected: `the lockfile entry for ${workspace.dir} to name ${workspace.name}`,
          found: `it names ${entry.name}`,
          fix: "npm install to refresh package-lock.json, then commit it",
        }),
      );
    }
  }

  const lockRoot = lockDoc.packages[""] ?? {};
  if (
    !sameDependencySet(manifest.devDependencies, lockRoot.devDependencies) ||
    !sameDependencySet(manifest.dependencies, lockRoot.dependencies)
  ) {
    findings.push(
      fail("install.lockfile-drift", {
        expected: "package-lock.json to agree with package.json about root dependencies",
        found: "the two disagree, so the lockfile is stale",
        fix: "npm install to refresh package-lock.json, then commit it",
      }),
    );
  }

  if (!hidden || hidden.text === null) {
    findings.push(
      fail("install.tree", {
        expected: "node_modules/.package-lock.json, which npm writes on every install",
        found: "node_modules exists but was not produced by npm install",
        fix: "rm -rf node_modules && npm install",
      }),
    );
    return findings;
  }
  if (hidden.parseError) {
    findings.push(
      fail("install.tree", {
        expected: "node_modules/.package-lock.json to be valid JSON",
        found: `a parse error: ${hidden.parseError}`,
        fix: "rm -rf node_modules && npm install",
      }),
    );
    return findings;
  }

  const installed = hidden.json.packages ?? {};
  const missing = [];
  for (const [key, entry] of Object.entries(lockDoc.packages)) {
    if (!key.startsWith("node_modules/")) continue;
    if (!isExpectedInTree(entry)) continue;
    if (!installed[key]) missing.push(key.replace(/^node_modules\//, ""));
  }
  if (missing.length) {
    missing.sort();
    const sample = missing.slice(0, 5).join(", ");
    findings.push(
      fail("install.tree", {
        expected: "the installed tree to contain every package the lockfile requires",
        found:
          `${missing.length} package(s) in package-lock.json are not installed ` +
          `(${sample}${missing.length > 5 ? ", ..." : ""})`,
        fix: "npm install (or npm ci for an exact lockfile install)",
      }),
    );
  }

  /*
   * Workspaces are checked by where the link RESOLVES, not by whether something
   * exists at the name. A registry package that happens to share a workspace
   * name will sit in node_modules looking entirely healthy while every import
   * quietly reaches the wrong code -- present, but wrong, which is the failure
   * mode the whole script is organised around.
   */
  for (const workspace of snapshot.workspaces) {
    if (!workspace.name || !workspace.link) continue;
    if (workspace.link.state === "ok") continue;
    if (workspace.link.state === "missing") {
      findings.push(
        fail("install.workspace-link", {
          expected: `node_modules/${workspace.name} to link to ${workspace.dir}`,
          found: "nothing is linked at that name",
          fix: "npm install (workspace links are created by install, not by the lockfile)",
        }),
      );
    } else if (workspace.link.state === "broken") {
      findings.push(
        fail("install.workspace-link", {
          expected: `node_modules/${workspace.name} to link to ${workspace.dir}`,
          found: "a link exists but its target does not",
          fix: "rm -rf node_modules && npm install",
        }),
      );
    } else {
      findings.push(
        fail("install.workspace-link", {
          expected: `node_modules/${workspace.name} to resolve to ${workspace.dir}`,
          found: `it resolves to ${workspace.link.target}`,
          fix:
            "rm -rf node_modules && npm install; a published package is shadowing the " +
            "workspace, so imports are reaching code this repo does not build",
        }),
      );
    }
  }

  return findings;
}

/* ==========================================================================
 * Environment variables
 * ========================================================================== */

/**
 * @param sources ordered [{ label, values: Map }]; the first hit wins, matching
 *        the precedence Next.js applies (process.env, then .env.local, then
 *        .env). Reporting WHICH source supplied a name is not a value
 *        disclosure and is usually the whole answer to "but I set that".
 */
export function resolveVariable(name, sources) {
  for (const source of sources) {
    if (source.values.has(name)) {
      return { value: source.values.get(name), source: source.label };
    }
  }
  return null;
}

/**
 * First sentence of the contract's description, capped.
 *
 * The descriptions in `.env.example` are paragraphs, because that is the right
 * length for a file someone reads once. Pasted whole into a finding they are
 * the wrong length entirely: the reader is scanning for which variable and what
 * to type, and a four-line rationale between those two facts hides both.
 */
function summarize(description) {
  const match = /^(.*?\.)(\s|$)/.exec(description);
  const first = match ? match[1] : description;
  return first.length > 120 ? `${first.slice(0, 117)}...` : first;
}

/**
 * A variable with a `@default` that nobody set.
 *
 * This is the case the whole warn/fail split exists for. Absence is not an
 * error here -- the fallback is documented, committed, and identical on every
 * machine -- so failing the run would mean a correct clone cannot pass its own
 * validation, and a validator that fails a correct checkout gets ignored, which
 * costs more than the drift it was meant to prevent.
 *
 * It is not nothing either. When the variable is `@cache-key` -- listed in
 * turbo.json `globalEnv` -- an unset value hashes as ABSENT, so a machine that
 * leaves it alone and a machine that sets it explicitly can share a cache entry
 * while meaning different things. That consequence is named in the fix, because
 * a warning nobody can act on is just noise.
 *
 * Under `--scope ci` a cache-key variable being unset stops being a laptop's
 * business: CI is where cache entries are shared between machines and where
 * gate evidence is recorded, so there it is a failure.
 *
 * The default IS printed. It comes from the committed contract, not from the
 * environment -- the same reason an enum's accepted set may be printed while
 * the value that missed it may not.
 */
function unsetWithDefault({ variable, resolved, where, scope }) {
  const detail = {
    expected: `${variable.name} to be set explicitly (${summarize(variable.description)})`,
    found: resolved
      ? `declared in ${resolved.source} but empty, so the documented default \`${variable.defaultValue}\` applies`
      : `not set in ${where}, so the documented default \`${variable.defaultValue}\` applies`,
    fix: variable.cacheKey
      ? `set ${variable.name}=${variable.defaultValue} in .env.local. turbo.json lists it in ` +
        `globalEnv, so it is hashed into the build cache key; while it is unset it hashes as ` +
        `absent, and one cache entry can then serve builds that meant different values`
      : `set ${variable.name}=${variable.defaultValue} in .env.local to pin it explicitly`,
  };
  return variable.cacheKey && scope === "ci"
    ? fail("env.default", detail)
    : warn("env.default", detail);
}

export function checkEnvironmentVariables({ contract, sources, scope }) {
  const findings = [];
  const applicable = contract.variables.filter(
    (variable) => variable.scope === "app" || variable.scope === scope,
  );

  for (const variable of applicable) {
    const resolved = resolveVariable(variable.name, sources);
    const where = sources.map((source) => source.label).join(", ");

    // Unset and set-to-empty are the same state for a defaulted variable: in
    // both, the value the project runs with is the one in .env.example.
    if (variable.defaultValue !== null && (!resolved || resolved.value.trim() === "")) {
      findings.push(unsetWithDefault({ variable, resolved, where, scope }));
      continue;
    }

    if (!resolved) {
      if (variable.required) {
        findings.push(
          fail("env.missing", {
            expected: `${variable.name} to be set (${summarize(variable.description)})`,
            found: `not set in ${where}`,
            fix: `add ${variable.name} to .env.local (see .env.example for the accepted values)`,
          }),
        );
      }
      continue;
    }

    // Present but empty is its own state: the line exists, so the fix is to
    // give it a value, not to add it. Telling someone to add a line they are
    // looking at is how a two-minute fix becomes an argument with the tool.
    if (resolved.value.trim() === "") {
      if (variable.required) {
        findings.push(
          fail("env.empty", {
            expected: `${variable.name} to have a value (${summarize(variable.description)})`,
            found: `declared in ${resolved.source} but empty`,
            fix: `set a value for ${variable.name}; see .env.example`,
          }),
        );
      }
      continue;
    }

    // A secret still equal to the committed placeholder was never configured,
    // whatever the presence check says. Reported separately because "you have
    // not filled this in yet" and "this is missing" send the reader to
    // different places.
    if (variable.secret && PLACEHOLDER.test(resolved.value)) {
      const finding = {
        expected: `${variable.name} to hold a real credential (${summarize(variable.description)})`,
        found: `still the placeholder from .env.example, in ${resolved.source}`,
        fix: `put the real value in ${resolved.source === "process.env" ? "the environment" : resolved.source}`,
      };
      findings.push(
        variable.required ? fail("env.placeholder", finding) : warn("env.placeholder", finding),
      );
      continue;
    }

    if (variable.format) {
      const problem = checkFormat(variable.format, resolved.value);
      if (problem) {
        findings.push(
          fail("env.malformed", {
            expected: `${variable.name} to be ${describeFormat(variable.format)}`,
            found: `${problem} (from ${resolved.source}; value not shown)`,
            fix: `correct ${variable.name} in ${resolved.source === "process.env" ? "the environment" : resolved.source}`,
          }),
        );
      }
    }
  }

  /*
   * Drift the other way: a name set in a repo-local .env file that the contract
   * does not declare. A warning rather than a failure -- it is usually a
   * feature landing slightly ahead of its documentation, and failing the build
   * for that would teach people to stop declaring things. But it is reported,
   * because the other cause is a typo in a name that is therefore doing
   * nothing, and nothing is exactly what a typo'd variable looks like.
   */
  const declared = new Set(contract.variables.map((variable) => variable.name));
  for (const source of sources) {
    if (source.label === "process.env") continue;
    for (const name of source.values.keys()) {
      if (declared.has(name)) continue;
      findings.push(
        warn("env.undeclared", {
          expected: `every variable in ${source.label} to be declared in .env.example`,
          found: `${name} is set there but not declared`,
          fix: `document ${name} in .env.example, or remove it if it is a typo`,
        }),
      );
    }
  }

  return findings;
}

/* ==========================================================================
 * Service reachability (opt-in)
 * ========================================================================== */

/**
 * TCP connect only.
 *
 * This proves a port is open. It does NOT prove PostgreSQL is healthy, that the
 * credentials work, or that the database exists -- a real health check needs a
 * protocol handshake and a driver this repo has not chosen yet
 * (docs/DATABASE.md). The distinction is stated in the output as well as here,
 * because a check that is quietly weaker than its name is how "validated"
 * becomes meaningless.
 */
export function probePort({ host, port, timeoutMs = 2000 }) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const finish = (outcome) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(outcome);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish({ ok: true }));
    socket.once("timeout", () =>
      finish({ ok: false, reason: `no response within ${timeoutMs}ms` }),
    );
    socket.once("error", (error) => {
      const code = error?.code ?? "unknown";
      const reason =
        code === "ECONNREFUSED"
          ? "nothing is listening on that port"
          : code === "ENOTFOUND" || code === "EAI_AGAIN"
            ? "the hostname does not resolve"
            : `connection failed (${code})`;
      finish({ ok: false, reason });
    });
  });
}

const SERVICES = [
  {
    variable: "DATABASE_URL",
    label: "postgres",
    defaultPort: 5432,
    schemes: ["postgresql:", "postgres:"],
  },
  { variable: "REDIS_URL", label: "redis", defaultPort: 6379, schemes: ["redis:", "rediss:"] },
];

export async function checkServices({ sources, probe = probePort }) {
  const findings = [];
  for (const service of SERVICES) {
    const resolved = resolveVariable(service.variable, sources);
    if (!resolved || !resolved.value.trim()) {
      findings.push(
        warn(`services.${service.label}`, {
          expected: `${service.variable} to be set when probing services`,
          found: "not set, so there is nothing to probe",
          fix: `set ${service.variable} in .env.local, or drop --services`,
        }),
      );
      continue;
    }
    const url = parseUrl(resolved.value);
    if (!url || !service.schemes.includes(url.protocol) || !url.hostname) {
      // Already reported in detail by the format check; not repeated here with
      // a second, vaguer message about the same variable.
      continue;
    }
    const port = Number(url.port || service.defaultPort);
    // Host and port only. The URL's userinfo is a credential and never appears
    // in output, which is why this is reassembled rather than printed.
    const target = `${url.hostname}:${port}`;
    const outcome = await probe({ host: url.hostname, port });
    if (!outcome.ok) {
      findings.push(
        fail(`services.${service.label}`, {
          expected: `a TCP connection to ${target} (from ${service.variable})`,
          found: outcome.reason,
          fix: "docker compose -f infra/docker-compose.yml up -d",
        }),
      );
    }
  }
  return findings;
}

/* ==========================================================================
 * Snapshot gathering (the only part that touches the filesystem)
 * ========================================================================== */

function readText(root, rel) {
  try {
    return fs.readFileSync(path.join(root, rel), "utf8");
  } catch {
    return null;
  }
}

function readJsonFile(root, rel) {
  const text = readText(root, rel);
  if (text === null) return { text: null, json: null, parseError: null };
  try {
    return { text, json: JSON.parse(text), parseError: null };
  } catch (error) {
    return { text, json: null, parseError: error.message };
  }
}

function expandWorkspacePatterns(root, patterns) {
  const dirs = [];
  const emptyPatterns = [];
  for (const pattern of patterns) {
    if (!pattern.endsWith("/*")) {
      if (fs.existsSync(path.join(root, pattern, "package.json"))) dirs.push(pattern);
      else emptyPatterns.push(pattern);
      continue;
    }
    const base = pattern.slice(0, -2);
    let entries = [];
    try {
      entries = fs.readdirSync(path.join(root, base), { withFileTypes: true });
    } catch {
      emptyPatterns.push(pattern);
      continue;
    }
    // npm skips directories without a package.json rather than failing, so this
    // does too: reporting a stray scratch directory as a broken workspace would
    // be a disagreement with the tool that actually performs the install.
    const matched = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${base}/${entry.name}`)
      .filter((dir) => fs.existsSync(path.join(root, dir, "package.json")))
      .sort();
    if (!matched.length) emptyPatterns.push(pattern);
    dirs.push(...matched);
  }
  return { dirs, emptyPatterns };
}

/**
 * `lstat` then `realpath`, not `existsSync`.
 *
 * `existsSync` follows links, so a link whose target has been deleted reports
 * as absent -- indistinguishable from never having been installed, though the
 * remedies differ. lstat sees the link itself; realpath then answers the
 * question that actually matters, which is where it points.
 */
function inspectLink(root, name, dir) {
  const linkPath = path.join(root, "node_modules", ...name.split("/"));
  try {
    fs.lstatSync(linkPath);
  } catch {
    return { state: "missing", target: null };
  }
  let target;
  try {
    target = fs.realpathSync(linkPath);
  } catch {
    return { state: "broken", target: null };
  }
  let expected;
  try {
    expected = fs.realpathSync(path.join(root, dir));
  } catch {
    return { state: "broken", target };
  }
  if (path.resolve(target) === path.resolve(expected)) return { state: "ok", target };
  return { state: "foreign", target: path.relative(root, target) || target };
}

export function gatherRepoState(root) {
  const files = {
    "package.json": readJsonFile(root, "package.json"),
    "package-lock.json": readJsonFile(root, "package-lock.json"),
    "node_modules/.package-lock.json": readJsonFile(root, "node_modules/.package-lock.json"),
    ".nvmrc": { text: readText(root, ".nvmrc") },
    ".env.example": { text: readText(root, ".env.example") },
  };
  for (const file of ENV_FILES) files[file] = { text: readText(root, file) };

  const nodeModulesExists = fs.existsSync(path.join(root, "node_modules"));
  const manifest = files["package.json"].json;
  const patterns = Array.isArray(manifest?.workspaces) ? manifest.workspaces : [];
  const { dirs, emptyPatterns } = expandWorkspacePatterns(root, patterns);

  const workspaces = dirs.map((dir) => {
    const pkg = readJsonFile(root, `${dir}/package.json`);
    const name = pkg.json?.name ?? null;
    return {
      dir,
      name,
      parseError: pkg.parseError,
      link: name && nodeModulesExists ? inspectLink(root, name, dir) : null,
    };
  });

  return { root, files, nodeModulesExists, workspaces, emptyPatterns };
}

/* ==========================================================================
 * Evaluation
 * ========================================================================== */

export function buildSources(snapshot, processEnv) {
  const sources = [{ label: "process.env", values: new Map(Object.entries(processEnv)) }];
  for (const file of ENV_FILES) {
    const text = snapshot.files[file]?.text;
    if (text !== null && text !== undefined) {
      sources.push({ label: file, values: parseEnvFile(text) });
    }
  }
  return sources;
}

/**
 * Pure: snapshot and options in, findings out. Nothing here reads the clock,
 * the filesystem, or the process -- which is what makes every branch above
 * reachable from a test that does not have to build a real environment first.
 */
export function evaluate(snapshot, { actualVersion, processEnv, scope = "app" }) {
  const findings = [];

  findings.push(
    ...checkNodeVersion({
      nvmrcText: snapshot.files[".nvmrc"].text,
      enginesNode: snapshot.files["package.json"].json?.engines?.node ?? null,
      actualVersion,
      scope,
    }),
  );

  findings.push(...checkInstall(snapshot));

  const contract = parseEnvContract(snapshot.files[".env.example"].text);
  for (const defect of contract.defects) {
    findings.push(
      fail("env.contract", {
        expected: ".env.example to be a well-formed environment contract",
        found: defect,
        fix: "correct .env.example; it is parsed, not just copied",
      }),
    );
  }

  const sources = buildSources(snapshot, processEnv);
  findings.push(...checkEnvironmentVariables({ contract, sources, scope }));

  return { findings, contract, sources };
}

/* ==========================================================================
 * Process layer
 * ========================================================================== */

const USAGE = `Usage: node scripts/validate-env.mjs [--quiet] [--scope app|ci] [--services]

  --quiet         suppress success output; failures and warnings still print
  --scope <s>     app (default) or ci; ci additionally requires @scope ci vars
  --services      probe PostgreSQL/Redis reachability (opt-in; TCP connect only)
  --help          show this message`;

export function parseArgs(argv) {
  const options = { quiet: false, scope: "app", services: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--quiet") options.quiet = true;
    else if (arg === "--services") options.services = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--scope") {
      const value = argv[++i];
      if (!KNOWN_SCOPES.has(value)) return { error: `--scope must be app or ci, got "${value ?? ""}"` };
      options.scope = value;
    } else if (arg.startsWith("--scope=")) {
      const value = arg.slice("--scope=".length);
      if (!KNOWN_SCOPES.has(value)) return { error: `--scope must be app or ci, got "${value}"` };
      options.scope = value;
    } else return { error: `unknown option "${arg}"` };
  }
  return { options };
}

export async function main(argv, { root = process.cwd(), processEnv = process.env } = {}) {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    console.error(`${parsed.error}\n\n${USAGE}`);
    return EXIT_USAGE;
  }
  const options = parsed.options;
  if (options.help) {
    console.log(USAGE);
    return EXIT_OK;
  }

  const snapshot = gatherRepoState(root);
  const { findings, contract, sources } = evaluate(snapshot, {
    actualVersion: process.versions.node,
    processEnv,
    scope: options.scope,
  });

  if (options.services) {
    findings.push(...(await checkServices({ sources })));
  }

  const errors = findings.filter((finding) => finding.level === "error");
  const warnings = findings.filter((finding) => finding.level === "warn");

  // Warnings go to stderr in every mode: --quiet suppresses SUCCESS output, and
  // silencing a warning that names a variable doing nothing would defeat the
  // reason it is a warning rather than a failure.
  if (warnings.length) {
    console.error(warnings.map(formatFinding).join("\n\n"));
  }

  if (errors.length) {
    console.error(
      `${warnings.length ? "\n" : ""}Project Liberty environment validation failed ` +
        `(${errors.length} problem${errors.length === 1 ? "" : "s"}):\n\n` +
        errors.map(formatFinding).join("\n\n"),
    );
    return EXIT_INVALID;
  }

  if (!options.quiet) {
    const checked = contract.variables.filter(
      (variable) => variable.scope === "app" || variable.scope === options.scope,
    ).length;
    // The warning count is echoed on the success line because warnings go to
    // stderr: on a machine where the two streams are separated, "passed" would
    // otherwise be the only thing anyone sees.
    const noted = warnings.length
      ? `, with ${warnings.length} warning${warnings.length === 1 ? "" : "s"} above`
      : "";
    console.log(
      `Project Liberty environment validation passed ` +
        `(Node ${process.versions.node}, scope ${options.scope}, ${checked} declared variables` +
        `${options.services ? ", services reachable" : ""})${noted}.`,
    );
  }
  return EXIT_OK;
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
