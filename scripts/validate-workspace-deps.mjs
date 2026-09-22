import fs from "node:fs";
import path from "node:path";
import { builtinModules } from "node:module";

/*
 * ===========================================================================
 * Every workspace must declare the packages its own files import.
 * ===========================================================================
 *
 * THE DEFECT THIS EXISTS FOR, exactly as it shipped.
 *
 * `apps/web/src/lib/server-bootstrap.ts` imported
 * `@liberty/media-inspection/node/pinned-fetch`, and `apps/web/package.json`
 * declared seven `@liberty` packages, not including that one.
 * `server-bootstrap.test.ts` carried the same import. Nothing was broken and
 * nothing went red:
 *
 *   - `tsc` resolved it, because npm hoists every workspace into the ROOT
 *     `node_modules` as a symlink, so `@liberty/media-inspection` is on the
 *     resolution path of every file in the repository whether or not the
 *     importing workspace asked for it;
 *   - `eslint`, `next build` and both vitest suites resolved it for the same
 *     reason;
 *   - `npm ci --dry-run` returned 0, because npm tolerates a link node that
 *     already exists in a populated `node_modules`.
 *
 * It was found by a human reading a diff. That is not a detection mechanism,
 * and the manifest was a false description of the code for as long as nobody
 * happened to read both halves at once.
 *
 * WHY A DRY-RUN INSTALL IS NOT THE CHECK. It was considered and is rejected
 * here in writing so it does not get proposed again. `npm ci --dry-run`
 * against a populated tree returned 0 on the defect. Against an EMPTY tree it
 * would also return 0: the workspace link is created because the package is a
 * workspace, not because anyone depends on it. The install has no opinion about
 * which workspace imports what, so no install-shaped check can have one either.
 *
 * WHY THIS READS SOURCE AND NOT `node_modules`. The question is whether a
 * MANIFEST describes the code beside it. That is answerable from two text files
 * and nothing else, so this script imports only Node builtins and is safe to run
 * before `npm ci` -- which matters twice over. It joins the pre-install block in
 * `.github/workflows/ci.yml` for the reason stated there (a dependency problem
 * must not be able to mask a structural failure), and more pointedly: a check on
 * the correctness of dependency declarations must not itself need a successful
 * dependency install to run.
 *
 * WHY IT FAILS RATHER THAN WARNS. A warning inside a passing pipeline is how the
 * original defect survived every gate this repository runs. `main()` exits 1 and
 * `checkWorkspaceDependencies()` returns error strings that
 * `scripts/validate-repo.mjs` folds into its own failure list.
 *
 * DELIBERATELY OUT OF SCOPE: the reverse direction -- a declared dependency that
 * nothing imports. It is a much weaker signal (a dependency can be loaded by
 * configuration, by a binary, or by a type-only reference this scanner does not
 * model) and a check that reports it would be noisy enough to get switched off,
 * taking the direction that matters with it.
 *
 * ALSO OUT OF SCOPE: whether a runtime file leans on a `devDependency`. Every
 * workspace here is `private: true` and none is published, so the distinction
 * has no consequence yet, and enforcing it would flag `next.config.ts` and the
 * vitest configs on day one. A declaration in ANY of the four dependency fields
 * satisfies this check.
 */

/*
 * Directories the scan never descends into.
 *
 * `node_modules` and `.git` are mandatory: a dependency's own source is not this
 * repository's code and its imports are not this repository's declarations. The
 * rest are build outputs and caches. `.next/types/**` in particular is written
 * by `next build` and imports `next/types.js` -- reading it would make the check
 * depend on whether a build had run, which is the class of defect its sibling
 * `scripts/validate-turbo-graph.mjs` exists to prevent.
 *
 * Kept as its own list rather than imported from `scripts/validate-repo.mjs`.
 * That file imports THIS one, and a cycle between two validators is a worse
 * trade than eight duplicated strings. `scripts/test-validate-workspace-deps.mjs`
 * asserts the two lists still agree on the mandatory entries.
 */
export const PRUNED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".next",
  ".turbo",
  ".vercel",
  "dist",
  "build",
  "coverage"
]);

/** File extensions whose contents are scanned for module specifiers. */
export const SCANNED_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

const BUILTIN_MODULES = new Set(builtinModules);

/*
 * Keywords after which a `/` opens a regular expression rather than dividing.
 *
 * The scanner below has to know this because THE REGEXES IN THIS REPOSITORY
 * CONTAIN IMPORT STATEMENTS. `packages/contracts/src/module-boundary.test.ts`
 * holds `/\bfrom\s*"([^"]+)"/g`, and a scanner that did not recognise a regex
 * literal read `[^` as a package name. That was one of six false positives a
 * first draft produced against a tree with no real defect in it, and a checker
 * that cries wolf six times on a clean tree gets turned off before it ever sees
 * a real one.
 */
const REGEX_PRECEDING_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw",
  "case", "do", "else", "yield", "await"
]);

/**
 * Tokenise JavaScript/TypeScript far enough to tell code from text.
 *
 * Returns `{ type: "word" | "punct" | "string", value }`. Comments are dropped,
 * string bodies are captured as single tokens, and template literals containing
 * `${` are tokenised as `{ type: "string", value: null }` -- a specifier built at
 * runtime cannot be checked against a manifest, and pretending otherwise
 * produced `${forbidden}` as a package name in the same first draft.
 *
 * THE OTHER FALSE POSITIVES THIS SHAPE FIXES. A regex over raw text matched
 * prose: `it("tells 'nothing usable' apart from 'nothing there'", ...)` looks
 * exactly like a `from` clause once you stop distinguishing a string's contents
 * from the code around it. Stripping comments is not enough, because the text
 * that lies is inside string literals, and those must be kept -- they are where
 * the specifiers live. So the scanner has to know which quotes it is inside,
 * which is a tokeniser, not a regex.
 *
 * It is deliberately NOT a parser. It never needs to know what an expression
 * means, only where the strings and comments start and stop, and it is
 * intentionally small enough to read in one sitting. The one place it guesses is
 * regex-versus-division after `}`, where it assumes division; a regex literal
 * opening immediately after a block would be mis-scanned. No file here does
 * that, and the failure mode is a spurious error naming a nonsense package,
 * which is loud rather than silent.
 */
export function tokenize(source) {
  const tokens = [];
  const length = source.length;
  // Each entry is the substitution depth of an enclosing template literal.
  const templateStack = [];
  let index = 0;
  let previous = null;

  const push = (token) => {
    tokens.push(token);
    previous = token;
  };

  while (index < length) {
    const char = source[index];
    const next = source[index + 1];

    if (char === "/" && next === "/") {
      while (index < length && source[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
      index += 2;
      continue;
    }
    if (char === " " || char === "\t" || char === "\r" || char === "\n") {
      index += 1;
      continue;
    }

    if (char === '"' || char === "'") {
      const quote = char;
      let value = "";
      index += 1;
      while (index < length && source[index] !== quote) {
        if (source[index] === "\\") {
          value += source[index + 1] ?? "";
          index += 2;
          continue;
        }
        if (source[index] === "\n") break; // unterminated; bail rather than run on
        value += source[index];
        index += 1;
      }
      index += 1;
      push({ type: "string", value });
      continue;
    }

    if (char === "`") {
      index += 1;
      let value = "";
      let dynamic = false;
      while (index < length) {
        if (source[index] === "\\") {
          value += source[index + 1] ?? "";
          index += 2;
          continue;
        }
        if (source[index] === "$" && source[index + 1] === "{") {
          dynamic = true;
          templateStack.push(0);
          index += 2;
          break;
        }
        if (source[index] === "`") {
          index += 1;
          break;
        }
        value += source[index];
        index += 1;
      }
      push({ type: "string", value: dynamic ? null : value });
      continue;
    }

    if (char === "/" && isRegexPosition(previous)) {
      index += 1;
      let inClass = false;
      while (index < length) {
        const c = source[index];
        if (c === "\\") {
          index += 2;
          continue;
        }
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) break;
        else if (c === "\n") break;
        index += 1;
      }
      index += 1;
      while (index < length && /[a-z]/.test(source[index])) index += 1;
      push({ type: "punct", value: "/regex/" });
      continue;
    }

    if (/[A-Za-z_$@#]/.test(char)) {
      let value = "";
      while (index < length && /[A-Za-z0-9_$]/.test(source[index])) {
        value += source[index];
        index += 1;
      }
      if (value === "") {
        // A lone `@`, `#` or similar: emit it as punctuation so it cannot be
        // mistaken for the start of an identifier on the next pass.
        push({ type: "punct", value: char });
        index += 1;
        continue;
      }
      push({ type: "word", value });
      continue;
    }

    if (/[0-9]/.test(char)) {
      while (index < length && /[0-9a-zA-Z_.]/.test(source[index])) index += 1;
      push({ type: "punct", value: "0" });
      continue;
    }

    // Template-literal substitutions: `}` at depth zero resumes the template.
    if (char === "{" && templateStack.length) templateStack[templateStack.length - 1] += 1;
    if (char === "}" && templateStack.length) {
      if (templateStack[templateStack.length - 1] === 0) {
        templateStack.pop();
        index += 1;
        // Consume the rest of the template; its value is already `null`.
        while (index < length) {
          if (source[index] === "\\") {
            index += 2;
            continue;
          }
          if (source[index] === "$" && source[index + 1] === "{") {
            templateStack.push(0);
            index += 2;
            break;
          }
          if (source[index] === "`") {
            index += 1;
            break;
          }
          index += 1;
        }
        previous = { type: "string", value: null };
        continue;
      }
      templateStack[templateStack.length - 1] -= 1;
    }

    push({ type: "punct", value: char });
    index += 1;
  }

  return tokens;
}

function isRegexPosition(previous) {
  if (!previous) return true;
  if (previous.type === "string") return false;
  if (previous.type === "word") return REGEX_PRECEDING_KEYWORDS.has(previous.value);
  return !([")", "]", "}", "0"].includes(previous.value) || previous.value === "/regex/");
}

/**
 * Every statically-known module specifier a source file references.
 *
 * Covers the four forms that resolve a package plus `vi.mock`, because a mock
 * whose first argument is a bare specifier resolves the real module to build the
 * mock's shape and is therefore a dependency like any other:
 *
 *   import x from "spec"   import "spec"   export { x } from "spec"
 *   import("spec")         require("spec")  vi.mock("spec", ...)
 *
 * `import type` needs no special case: the `from` clause is the same token.
 */
export function moduleSpecifiers(source) {
  const tokens = tokenize(source);
  const found = new Set();
  const add = (token) => {
    if (token && token.type === "string" && typeof token.value === "string" && token.value !== "") {
      found.add(token.value);
    }
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.type !== "word") continue;

    if (token.value === "from" || token.value === "import") {
      const after = tokens[i + 1];
      if (after && after.type === "string") {
        add(after);
        continue;
      }
    }
    if (token.value === "import" || token.value === "require") {
      if (tokens[i + 1]?.value === "(") add(tokens[i + 2]);
      continue;
    }
    if ((token.value === "mock" || token.value === "doMock") && tokens[i - 1]?.value === ".") {
      if (tokens[i + 1]?.value === "(") add(tokens[i + 2]);
    }
  }

  return [...found];
}

/**
 * The package a specifier resolves to, or `null` when nothing is being resolved
 * from a manifest.
 *
 * SUBPATH IMPORTS ARE THE POINT. `@liberty/media-inspection/node/pinned-fetch`
 * declares `@liberty/media-inspection`; the defect this file exists for was
 * exactly that shape, and a check that only compared whole specifiers would have
 * missed it.
 */
export function packageNameOf(specifier) {
  if (specifier.startsWith(".") || specifier.startsWith("/")) return null; // relative or absolute
  if (specifier.startsWith("#")) return null; // manifest `imports` subpath; see the gap note in the tests
  if (specifier.startsWith("node:")) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(specifier)) return null; // data:, http:, file: ...
  const segments = specifier.split("/");
  // A bare `@scope` with no package after it resolves to nothing.
  if (specifier.startsWith("@") && segments.length < 2) return null;
  const name = specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
  if (!name) return null;
  if (BUILTIN_MODULES.has(name)) return null;
  return name;
}

/**
 * Expand the root manifest's `workspaces` globs to absolute directories.
 *
 * Only a literal path and a single trailing `/*` are supported, which is every
 * pattern this repository uses. ANYTHING ELSE THROWS rather than being skipped:
 * a workspace the enumerator quietly fails to see is a workspace this check goes
 * blind on, and an unnoticed blind spot in a detector is worse than no detector,
 * because the green tick now covers it.
 */
export function listWorkspaceDirectories(root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const patterns = Array.isArray(manifest.workspaces) ? manifest.workspaces : (manifest.workspaces?.packages ?? []);
  const directories = [];

  for (const pattern of patterns) {
    if (!pattern.includes("*")) {
      directories.push(path.join(root, pattern));
      continue;
    }
    if (!pattern.endsWith("/*") || pattern.slice(0, -2).includes("*")) {
      throw new Error(
        `scripts/validate-workspace-deps.mjs cannot expand the workspace pattern ${JSON.stringify(pattern)}. ` +
          `It understands a literal path and a single trailing "/*". Teach it the new shape rather than leaving ` +
          `that workspace unchecked -- an unenumerated workspace is one this gate cannot see.`
      );
    }
    const parent = path.join(root, pattern.slice(0, -2));
    let entries = [];
    try {
      entries = fs.readdirSync(parent, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(parent, entry.name);
      // npm itself ignores a directory with no manifest, so this is npm's rule
      // rather than a shortcut of ours.
      if (fs.existsSync(path.join(full, "package.json"))) directories.push(full);
    }
  }

  return directories.sort();
}

/**
 * Every scannable file inside a workspace, INCLUDING TEST FILES.
 *
 * Test files are in scope because `server-bootstrap.test.ts` carried the same
 * undeclared import as the module it tests. A test imports through the same
 * resolver as production code and is just as capable of being the only reason a
 * package is needed; excluding tests would have halved the evidence for the one
 * defect this check was written against.
 */
export function listSourceFiles(directory) {
  const found = [];
  const stack = [directory];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!PRUNED_DIRECTORIES.has(entry.name)) stack.push(full);
        continue;
      }
      if (entry.isFile() && SCANNED_EXTENSIONS.has(path.extname(entry.name))) found.push(full);
    }
  }
  return found.sort();
}

function relativePosix(root, full) {
  return path.relative(root, full).split(path.sep).join("/");
}

/**
 * Compare every workspace's imports against its own manifest.
 *
 * Returns error strings; an empty array means every workspace declares what it
 * imports. The root manifest is deliberately never consulted as a fallback --
 * resolution through the root is precisely the mechanism that hid the defect, so
 * treating a root declaration as satisfying a workspace's import would encode the
 * bug as the rule.
 */
export function checkWorkspaceDependencies(root) {
  const errors = [];

  for (const directory of listWorkspaceDirectories(root)) {
    const manifestPath = path.join(directory, "package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const declared = new Set();
    for (const field of DEPENDENCY_FIELDS) {
      for (const name of Object.keys(manifest[field] ?? {})) declared.add(name);
    }

    const undeclared = new Map();
    for (const file of listSourceFiles(directory)) {
      let source;
      try {
        source = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      for (const specifier of moduleSpecifiers(source)) {
        const name = packageNameOf(specifier);
        if (name === null) continue;
        if (name === manifest.name) continue; // a package referring to itself
        if (declared.has(name)) continue;
        if (!undeclared.has(name)) undeclared.set(name, []);
        undeclared.get(name).push(`${relativePosix(root, file)} imports "${specifier}"`);
      }
    }

    for (const [name, sites] of [...undeclared].sort((a, b) => a[0].localeCompare(b[0]))) {
      const shown = sites.slice(0, 5);
      const more = sites.length - shown.length;
      errors.push(
        `undeclared dependency: ${manifest.name ?? relativePosix(root, directory)} imports "${name}" but ` +
          `${relativePosix(root, manifestPath)} does not list it in dependencies, devDependencies, ` +
          `peerDependencies or optionalDependencies.\n` +
          shown.map((site) => `      ${site}`).join("\n") +
          (more > 0 ? `\n      ...and ${more} more` : "") +
          `\n      This resolves at runtime anyway, through the workspace link in the ROOT node_modules, which is ` +
          `why typecheck, lint, build, the test suites and npm ci are all green on it. Add "${name}" to ` +
          `${relativePosix(root, manifestPath)} and regenerate package-lock.json with ` +
          `\`npm install --package-lock-only\`; the manifest line and the lockfile edge are the same fact and ` +
          `either one alone is the disagreement.`
      );
    }
  }

  return errors;
}

function main() {
  const root = process.cwd();
  let errors;
  try {
    errors = checkWorkspaceDependencies(root);
  } catch (error) {
    console.error(`Project Liberty workspace dependency validation could not run:\n- ${error.message}`);
    process.exit(1);
  }

  if (errors.length) {
    console.error(
      "Project Liberty workspace dependency validation failed:\n" + errors.map((item) => `- ${item}`).join("\n")
    );
    process.exit(1);
  }

  const count = listWorkspaceDirectories(root).length;
  console.log(`Project Liberty workspace dependency validation passed (${count} workspaces).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) main();
