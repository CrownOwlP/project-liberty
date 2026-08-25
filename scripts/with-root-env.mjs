#!/usr/bin/env node
/**
 * Load the REPOSITORY ROOT's dotenv files into `process.env`, then run the real
 * command.
 *
 * WHY THIS EXISTS AT ALL.
 *
 * `apps/web`'s package scripts run with cwd `apps/web` -- that is where npm puts
 * them, and turbo, `npm run --workspace`, and the e2e harness all inherit that.
 * Next resolves its dotenv files from the project directory, so `next dev` and
 * `next build` read `apps/web/.env*` and nothing else. Meanwhile
 * `docs/DEVELOPMENT.md` tells developers to write real values into `.env.local`
 * at the repository ROOT, `README.md` says `cp .env.example .env.local` from
 * there, `turbo.json` lists the root `.env*` files in `globalDependencies` and so
 * intends to hash them into every task's cache key (whether it really does when
 * `.gitignore` ignores them is the open question below),
 * and `scripts/validate-env.mjs` validates the root files. Every one of those
 * pointed at a directory the application never opened. Nothing bridged the two.
 *
 * The consequence was not a loud failure, which is why it survived three
 * debugging rounds: a value written at the root was simply invisible, and the
 * variable fell back to its documented default. `LIBERTY_FIXTURE_MEDIA_ORIGIN`
 * stayed `https://fixtures.invalid` -- a TLD reserved by RFC 2606 that can never
 * resolve -- so every playback attempt failed DNS and the player retried a
 * hostname that cannot exist until its retry budget was gone.
 *
 * The irony is worth recording rather than quietly fixing. `validate-env.mjs`'s
 * own header says that "a confident pass over the wrong bytes is worse than no
 * check at all", and that is exactly what it was doing: reading files the
 * application never read, and passing. The validator was right about the wrong
 * directory. That is the defect this file closes, and requirement (2) below is
 * what stops it reopening.
 *
 * WHAT WAS REJECTED, AND WHY IT CANNOT WORK.
 *
 * The obvious fix is to call `loadEnvConfig(repoRoot, ...)` from
 * `apps/web/next.config.ts`. It was tried. It is a GUARANTEED no-op, and this is
 * verifiable in `node_modules` rather than a matter of opinion:
 *
 *   - `next/dist/server/config.js` calls `loadEnvConfig(dir, ...)` with the
 *     PROJECT directory (`apps/web`) and only then does `findUp(CONFIG_FILES,
 *     { cwd: dir })` to locate, transpile and evaluate `next.config.ts`. The
 *     framework's load happens first, always;
 *   - `@next/env`'s `loadEnvConfig` caches at module scope. Minified, the guard
 *     reads `if(l&&!s){return{combinedEnv:l,parsedEnv:p,loadedEnvFiles:u}}` --
 *     `l` is the cached result and `s` is `forceReload`. A second call with a
 *     different directory returns the first call's answer and never touches the
 *     filesystem.
 *
 * So the config file is structurally too late. Worse, `forceReload` would not
 * save it either: that path begins `replaceProcessEnv(initialEnv)`, which
 * restores the environment captured at the FIRST call and would discard anything
 * set since.
 *
 * WHAT THIS DOES INSTEAD.
 *
 * `process.env` outranks every dotenv file in Next's own precedence order -- see
 * the merge in `@next/env`'s `processEnv`, which only adopts a parsed value when
 * `typeof initialEnv[name] === "undefined"`. So a loader that runs BEFORE Next
 * starts and writes into `process.env` cannot be defeated by a directory
 * question. That is the whole mechanism, and it is why this is a package-script
 * wrapper rather than anything inside the app.
 *
 * Four requirements shape the implementation.
 *
 * 1. THE ROOT IS FOUND, NOT ASSUMED. `path.resolve(__dirname, "..")` would be
 *    correct today and is still not what this does, because being silently wrong
 *    about which directory holds the environment IS the bug being fixed. The
 *    search walks up for a `package.json` declaring `workspaces` -- npm's own
 *    definition of the monorepo root -- and throws with the directories it tried
 *    when there is none. A loud stop beats a confident wrong root.
 *
 * 2. ONE IMPLEMENTATION, SHARED WITH THE VALIDATOR. The file list and the parser
 *    are imported from `scripts/validate-env.mjs` (`envFilesForMode`,
 *    `parseEnvFile`) rather than reimplemented. This is the most important line
 *    in the file. Two parsers, or two file lists, is precisely how this class of
 *    defect comes back: the validator and the runtime would each be internally
 *    consistent and would disagree about which bytes win, and the disagreement
 *    would show up as a variable that validates clean and behaves wrong.
 *    `scripts/test-validate-env.mjs` scenario 36 pins the agreement.
 *
 * 3. ONLY WHAT IS NOT ALREADY SET. A name already present in `process.env` is
 *    left alone, matching Next's documented precedence exactly -- including its
 *    treatment of an empty string, which is PRESENT and therefore wins (that is
 *    `typeof`, not truthiness, in the merge cited above). This is load-bearing
 *    for real callers: `.github/workflows/ci.yml` pins CONTENT_RIGHTS_ENFORCEMENT,
 *    LIBERTY_FC_SEED and LIBERTY_FIXTURE_MEDIA_ORIGIN in the job `env:`, and
 *    `e2e/playwright.config.ts` pins CONTENT_RIGHTS_ENFORCEMENT and
 *    LIBERTY_FIXTURE_MEDIA_ORIGIN on the server it starts. Both expect an
 *    exported value to win. Both still do -- and the harness now pins the media
 *    origin UNCONDITIONALLY because of this rule rather than in spite of it: it
 *    used to omit the variable to get the app's default, and once this wrapper
 *    existed, omission started meaning "inherit the developer's `.env.local`"
 *    instead. Precedence that a caller can rely on is only useful to a caller
 *    that states a value.
 *
 * 4. THE CHILD'S EXIT IS THE EXIT. A wrapper that swallowed a non-zero status
 *    would turn a failed command green, which is the same family of lie as the
 *    one above. Exit codes pass through, death by signal is re-raised rather
 *    than translated into a number, and Ctrl-C reaches the child.
 *
 * WHICH SCRIPTS ARE WRAPPED, AND WHY `build` IS NOT.
 *
 * `apps/web`'s `dev` and `start` go through here. `build` does NOT, and that is
 * a deliberate retreat rather than an oversight.
 *
 * `turbo.json` lists LIBERTY_FIXTURE_MEDIA_ORIGIN, CONTENT_RIGHTS_ENFORCEMENT,
 * LIBERTY_FC_SEED and NODE_ENV in `globalEnv`, which is the mechanism that stops
 * one `.next/**` cache entry serving builds that meant different values. Turbo
 * hashes those from the environment it sees BEFORE it launches the task. This
 * wrapper sets them INSIDE the task. So for `build`, `globalEnv` would be
 * hashing the absence of exactly the variables the build then used -- and both
 * `authorized-candidates.ts` and `watch/watch-session.ts` read
 * LIBERTY_FIXTURE_MEDIA_ORIGIN at module scope, so it is a build INPUT, not only
 * a runtime one.
 *
 * The remaining guard would be `globalDependencies`, which does list all eight
 * root `.env*` files. Whether that guard holds could not be settled without
 * running turbo: `.gitignore` ignores `.env*`, and turbo is documented to skip
 * gitignored files when hashing `inputs`. If it does the same for
 * `globalDependencies` the cache key ignores the file AND the variable, and the
 * failure mode is a silent one -- a cache hit that serves a build made for a
 * different media origin, with no error and nothing in the log. `docs/
 * DEVELOPMENT.md` records the open question and the exact experiment that
 * settles it.
 *
 * So the three scripts were separated on what each one actually needs:
 *
 *   - `dev` is the case this whole file exists for, and turbo declares it
 *     `"cache": false`, so nothing it reads outlives the process;
 *   - `start` reads the environment at REQUEST time and produces no cached
 *     artifact, so a value loaded here changes this server and nothing else;
 *   - `build` is the only one whose OUTPUT depends on these values, and it is
 *     also the one that already has a correct answer elsewhere:
 *     `.github/workflows/ci.yml` pins all three in the job `env:`, where turbo
 *     hashes them properly, and that is the build that ships.
 *
 * The cost is that a local `npm run build` does not see the root `.env.local`.
 * That is the behaviour every build had before this file existed -- not a
 * regression, and a developer who wants it can export the value, which is also
 * the spelling turbo hashes correctly. Traded against an unsettled
 * cache-correctness risk with no visible symptom, that is the cheaper side.
 * Settle the experiment in DEVELOPMENT.md and `build` can be wrapped again.
 *
 * `packages/persistence`'s `db:generate`, `db:migrate` and `db:check` go through
 * here too, with an explicit `--mode development`. Same defect, second location:
 * those scripts also run with cwd set to their own package directory, and
 * drizzle-kit's bundled dotenv only ever opens `<cwd>/.env` -- not `.env.local`,
 * not the repository root -- so `drizzle.config.ts` read an empty
 * `DATABASE_URL` while the value sat in the root file the setup instructions
 * name. It failed loudly rather than silently, which made it cheaper than the
 * `apps/web` case and no less wrong. None of the three is a turbo task or
 * appears in `globalEnv`, so the cache-hashing argument that keeps `build`
 * unwrapped has nothing to bite on; the mode choice is argued where it is made,
 * in `packages/persistence/drizzle.config.ts`.
 *
 * NODE_ENV IS DELIBERATELY NEVER APPLIED. See `NEVER_APPLIED` below; the reason
 * is specific and it is not squeamishness -- a copied `.env.local` plus a naive
 * loader turns a production `next start` into a development one.
 *
 * Usage:
 *   node scripts/with-root-env.mjs [--mode development|test|production] [--]
 *                                  <command> [args...]
 *
 *   --mode <m>  which dotenv file set to load. Required only when the command is
 *               not `next`, because for `next` the mode is DERIVED from the
 *               subcommand, which is what actually decides it (see `nextEnvMode`).
 *   --quiet     suppress the one-line summary on stderr. Failures still print.
 *
 * Exit codes: the child's, or 2 for a usage/resolution error in this wrapper
 * itself. The overlap with a child that happens to exit 2 is unavoidable and
 * accepted; this wrapper's own failures always print a line beginning
 * `with-root-env:` first.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { envFilesForMode, parseEnvFile } from "./validate-env.mjs";

export const EXIT_USAGE = 2;

const KNOWN_MODES = new Set(["development", "test", "production"]);

const USAGE = `Usage: node scripts/with-root-env.mjs [--mode <m>] [--quiet] [--] <command> [args...]

  --mode <m>  development, test or production. Optional for \`next\`, whose mode
              is derived from the subcommand exactly as @next/env derives it.
  --quiet     suppress the one-line summary printed to stderr
  --help      show this message

Loads the repository ROOT's dotenv files for that mode into process.env --
without overwriting anything already set there -- and then runs the command.`;

/* ==========================================================================
 * Locating the repository root
 * ========================================================================== */

function readTextOrNull(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * Walk up for the directory npm itself would call the monorepo root.
 *
 * The marker is a parseable `package.json` with a `workspaces` ARRAY, which is
 * the one thing that distinguishes `<root>` from `apps/web` -- both have a
 * package.json, and only one of them owns the environment. `.git` is not used:
 * it is absent from a tarball export and present in a worktree's parent, so it
 * answers a different question than the one being asked.
 *
 * The walk starts from this FILE's directory rather than from cwd. cwd is
 * `apps/web` under every real caller and walking up from there happens to reach
 * the same place, but the script's own location is a fact about the checkout
 * rather than about who invoked it, and this function must not have an opinion
 * that depends on the caller.
 *
 * Failure throws with every directory that was tried. There is no fallback,
 * deliberately: a wrong root here would reproduce the original defect with the
 * blast radius of a fix, and "the environment came from somewhere unexpected" is
 * the single hardest thing to notice from the outside.
 */
export function findRepoRoot(startDir, { readFile = readTextOrNull } = {}) {
  const tried = [];
  let dir = path.resolve(startDir);
  for (;;) {
    tried.push(dir);
    const text = readFile(path.join(dir, "package.json"));
    if (text !== null && text !== undefined) {
      let manifest = null;
      try {
        manifest = JSON.parse(text);
      } catch {
        // A package.json that does not parse is not evidence of anything; keep
        // walking rather than stopping on a file that could belong to anyone.
        manifest = null;
      }
      if (manifest && Array.isArray(manifest.workspaces)) return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `could not find the repository root above ${path.resolve(startDir)}.\n` +
      `Looked for a package.json declaring a "workspaces" array in:\n` +
      tried.map((entry) => `  ${entry}`).join("\n") +
      `\nThis wrapper refuses to guess: loading the environment from the wrong ` +
      `directory is the defect it exists to prevent.`,
  );
}

/* ==========================================================================
 * Which mode, and therefore which files
 * ========================================================================== */

/**
 * Strip whatever the platform put on the front of a command name.
 *
 * `next`, `next.cmd`, `./node_modules/.bin/next` and an absolute Windows path
 * all name the same program, and the mode derivation below must not depend on
 * which spelling the package script used.
 */
function commandName(command) {
  const base = path.basename(String(command));
  const dot = base.lastIndexOf(".");
  return (dot > 0 ? base.slice(0, dot) : base).toLowerCase();
}

/**
 * The mode @next/env will pick, derived from the same inputs it uses.
 *
 * This is NOT "read NODE_ENV". @next/env computes
 * `isTest ? "test" : dev ? "development" : "production"`, where `isTest` is
 * `process.env.NODE_ENV === "test"` and `dev` comes from the PHASE -- that is,
 * from the subcommand. `validate-env.mjs`'s `defaultModes` documents this gap
 * and cannot close it, because a validator has no command to inspect. A wrapper
 * does: the command is sitting in its argv. So this is exact rather than a
 * guess, and the two places where it matters are real ones:
 *
 *   - `NODE_ENV=production npm run dev` still loads the DEVELOPMENT file set,
 *     because `next dev` is a development phase whatever the shell says;
 *   - `next start` with NODE_ENV unset loads the PRODUCTION file set, before
 *     anything has set NODE_ENV at all -- `next/dist/bin/next` assigns
 *     `process.env.NODE_ENV = process.env.NODE_ENV || defaultEnv` later, and
 *     this wrapper runs earlier than that.
 *
 * `build` is answered too, and correctly, even though `apps/web` no longer routes
 * it through here: the derivation is a fact about @next/env, not about which
 * scripts happen to be wrapped this week, and `test-validate-env.mjs` scenario 36
 * pins all three subcommands so that re-wrapping `build` is a one-line change
 * rather than a rediscovery.
 *
 * Returns null when the command is not `next`, because then there is no phase to
 * read and the honest answer is to make the caller say `--mode` rather than to
 * assume one.
 */
export function nextEnvMode(commandArgv, processEnv) {
  // The command is checked FIRST, before NODE_ENV. Otherwise `NODE_ENV=test`
  // would hand back a confident "test" for a command whose phase this function
  // cannot see at all, which is the guess it exists to refuse.
  if (!commandArgv.length || commandName(commandArgv[0]) !== "next") return null;
  if (processEnv.NODE_ENV === "test") return "test";
  const subcommand = commandArgv.slice(1).find((arg) => !arg.startsWith("-")) ?? "";
  return subcommand === "dev" ? "development" : "production";
}

/* ==========================================================================
 * Resolving the root files
 * ========================================================================== */

/**
 * The variable this wrapper will not set, whatever a root file says.
 *
 * NODE_ENV decides which dotenv files are read, so injecting it from a dotenv
 * file would let a file choose which files are read -- the wrong-bytes failure
 * again, one level up. And the damage is not hypothetical: `.env.example` ships
 * `NODE_ENV=development`, `README.md` says `cp .env.example .env.local`, and
 * `next/dist/bin/next` does `process.env.NODE_ENV = process.env.NODE_ENV ||
 * defaultEnv` -- it RESPECTS a pre-set value and only warns. `.env.local` is in
 * the PRODUCTION file list as well as the development one, so a copied
 * `.env.local` plus a naive loader would silently turn `npm run start` into a
 * development server, flipping the production branches in
 * `authorized-candidates.ts`, `issue-session.ts` and the resolve handler -- a
 * deployment that resolves fixtures and exposes the resolve scaffold, which a
 * security review made a production build refuse. `build` no longer runs through
 * here at all (see the header), so it is `start` that this guard now protects;
 * the guard is not weaker for that, because `start` is what serves requests.
 *
 * Note that Next itself does not have this problem with its own files: it
 * computes the phase and the file list BEFORE merging parsed values into
 * `process.env`, so a NODE_ENV sitting in `apps/web/.env.local` cannot change
 * which files were read or which build was made. Skipping it here is therefore
 * not a deviation from Next -- it is what keeps this loader faithful to it.
 */
const NEVER_APPLIED = new Set(["NODE_ENV"]);

/**
 * Which root variables this wrapper would set, and from which file.
 *
 * Pure over `readEnvFile` and `processEnv` so the agreement with the validator
 * can be asserted against the SAME bytes the validator sees, with no filesystem
 * involved -- see `scripts/test-validate-env.mjs` scenario 36.
 *
 * The two skip rules together reproduce Next's precedence exactly:
 * `processEnv` wins over every file (checked with `Object.hasOwn`, not
 * truthiness, because an empty string is a value someone exported on purpose and
 * @next/env treats it as present too), and among files the first one to declare
 * a name wins, which is why `envFilesForMode` returns them highest-precedence
 * first.
 */
export function resolveRootEnv({ mode, processEnv, readEnvFile }) {
  const applied = new Map();
  const bySource = new Map();
  const filesRead = [];
  /*
   * The FILE, never the value. The comparison against `mode` happens in here so
   * the skipped value has no way out of this function -- `validate-env.mjs`
   * makes the same move with `dedupeFound`, on the grounds that a field which
   * outlives its purpose is one a later formatter prints by accident, and this
   * one would be printed straight into a build log.
   */
  let nodeEnvConflict = null;

  for (const file of envFilesForMode(mode)) {
    const text = readEnvFile(file);
    if (text === null || text === undefined) continue;
    filesRead.push(file);
    for (const [name, value] of parseEnvFile(text)) {
      if (NEVER_APPLIED.has(name)) {
        if (name === "NODE_ENV" && nodeEnvConflict === null && value !== mode) {
          nodeEnvConflict = file;
        }
        continue;
      }
      if (Object.hasOwn(processEnv, name)) continue;
      if (applied.has(name)) continue;
      applied.set(name, value);
      if (!bySource.has(file)) bySource.set(file, []);
      bySource.get(file).push(name);
    }
  }

  return { applied, bySource, filesRead, nodeEnvConflict };
}

/**
 * Apply the resolution to a real environment object and describe what happened.
 *
 * The summary names VARIABLES and FILES and never a value, matching rule 3 of
 * `validate-env.mjs`: whether a given value is a credential is a property of the
 * machine, not of anyone's annotations, and a build log is exactly where that
 * assumption gets tested. Names are safe -- the validator prints them freely --
 * and printing them is the point: "which variables did the root files actually
 * supply" is the question three debugging rounds could not answer.
 */
export function applyRootEnv({ root, mode, processEnv, readEnvFile }) {
  const resolution = resolveRootEnv({ mode, processEnv, readEnvFile });
  for (const [name, value] of resolution.applied) processEnv[name] = value;

  const lines = [];
  if (resolution.applied.size === 0) {
    const searched = resolution.filesRead.length
      ? `${resolution.filesRead.join(", ")} supplied nothing new`
      : "no root .env file for this mode exists";
    lines.push(`with-root-env: ${mode}, root ${root} -- ${searched}`);
  } else {
    lines.push(`with-root-env: ${mode}, root ${root}`);
    for (const [file, names] of resolution.bySource) {
      lines.push(`  ${file} -> ${names.join(", ")}`);
    }
  }

  /*
   * Loud, but only when it could matter. NODE_ENV is skipped unconditionally
   * (see NEVER_APPLIED), and saying so on every `next dev` when the file agrees
   * with the mode anyway would be a line people learn to scroll past. When the
   * file DISAGREES with the mode the command is running in, that is the case the
   * skip exists for and the reader needs to know it happened. The file's value is
   * not echoed; the variable, the file, and the mode in force are enough to look.
   */
  if (resolution.nodeEnvConflict !== null) {
    lines.push(
      `  note: NODE_ENV is declared in ${resolution.nodeEnvConflict} with a different value and ` +
        `is NOT applied. This command runs in ${mode} mode. Loading NODE_ENV from a file would ` +
        `let that file choose which files are read, and would turn a production build into a ` +
        `development one. Export NODE_ENV in the environment if you really mean to change it.`,
    );
  }

  return { ...resolution, summary: lines.join("\n") };
}

/* ==========================================================================
 * Locating and running the command
 * ========================================================================== */

/**
 * Where the search for a package's bin ended: `{ bin }` on success, otherwise
 * `{ bin: null, problem, manifest }`.
 *
 * Windows is the reason this exists rather than `spawn(command, args, { shell:
 * true })`. `node_modules/.bin/next` is an extensionless shell script there and
 * Node's non-shell `spawn` does no PATHEXT resolution, so the shell would be
 * mandatory -- and a `.cmd` in the middle brings back cmd.exe's "Terminate batch
 * job (Y/N)?" on Ctrl-C, which is the exact ergonomic this repo's `.cmd`-driven
 * workflow trips over. Resolving the package's own `bin` entry and handing the
 * path to `process.execPath` skips the shell entirely: no quoting rules, no
 * intermediate process to lose a signal in, and the child provably runs the same
 * Node major the parent does -- which `validate-env.mjs` spends a whole check
 * insisting on.
 *
 * The walk mirrors npm resolution (nearest `node_modules` first, so a workspace
 * copy wins over the hoisted one) and stops at the first directory that HAS the
 * package, rather than walking past one that has no `bin`.
 *
 * THE THREE FAILURES ARE REPORTED SEPARATELY, and that is the whole reason this
 * returns a shape rather than `string | null`. It used to collapse them into one
 * `null` and one message ending "run `npm install`" -- advice that fixes exactly
 * one of the three, and quietly misdirects the reader on the other two. A
 * package that is installed but declares no `bin` for this name is an upstream
 * or naming problem that reinstalling reproduces; a `package.json` that does not
 * parse is a damaged tree, where the honest instruction names the file. A
 * diagnostic that is confidently wrong costs more than one that says less --
 * which is the same principle `validate-env.mjs` opens with, applied to an error
 * path instead of a check.
 */
const BIN_PROBLEMS = {
  "not-installed": (command) =>
    `no node_modules/${command}/package.json exists in any directory above it. ` +
    `Run \`npm install\` (or \`npm ci\`) to install the tree.`,
  "no-bin": (command, manifest) =>
    `${manifest} exists but declares no "bin" entry named "${command}", so there is nothing ` +
    `to execute. Reinstalling will not change that -- this is a question about the installed ` +
    `package, not about whether it is installed.`,
  unparseable: (command, manifest) =>
    `${manifest} is not parseable JSON. The tree is damaged rather than missing; delete ` +
    `node_modules and reinstall, and if it comes back, the file named here is the one to look at.`
};

export function findPackageBin(command, startDir, { readFile = readTextOrNull } = {}) {
  let dir = path.resolve(startDir);
  for (;;) {
    const manifestPath = path.join(dir, "node_modules", command, "package.json");
    const text = readFile(manifestPath);
    if (text !== null && text !== undefined) {
      let manifest = null;
      try {
        manifest = JSON.parse(text);
      } catch {
        return { bin: null, problem: "unparseable", manifest: manifestPath };
      }
      const bin = manifest?.bin;
      const relative =
        typeof bin === "string" ? bin : bin && typeof bin === "object" ? bin[command] : null;
      // "installed but not executable" and "not installed" are different
      // problems with different fixes, so the walk stops here rather than
      // continuing on to a hoisted copy: npm would have resolved to this one.
      if (typeof relative !== "string") {
        return { bin: null, problem: "no-bin", manifest: manifestPath };
      }
      return { bin: path.resolve(path.dirname(manifestPath), relative), problem: null };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return { bin: null, problem: "not-installed", manifest: null };
    dir = parent;
  }
}

/**
 * Signals worth forwarding, filtered to the ones this platform actually has.
 *
 * The filter is not cosmetic: `process.on("SIGBREAK", ...)` throws on Linux,
 * which would make the wrapper crash on a platform it works fine on.
 */
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"].filter(
  (signal) => signal in os.constants.signals,
);

/**
 * Run the child and become its exit status.
 *
 * `stdio: "inherit"` so `next dev`'s output, colours and interactive prompts are
 * untouched -- a wrapper the developer can see is a wrapper nobody has to think
 * about.
 *
 * Signals are handled in two halves because the platforms genuinely differ. On
 * POSIX the signal is delivered to this process and has to be relayed. On
 * Windows a console Ctrl-C is already delivered to every process attached to the
 * console, so the child has it; what matters there is that the parent does NOT
 * exit first, and merely REGISTERING a listener achieves that, because Node then
 * stops applying the default terminate-on-SIGINT behaviour. Calling `child.kill`
 * on Windows would be worse than useless: it maps to TerminateProcess, so it
 * would forcibly kill a server that was already shutting down cleanly.
 */
function runChild(file, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd, stdio: "inherit" });

    const listeners = [];
    for (const signal of FORWARDED_SIGNALS) {
      const listener = () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        if (process.platform === "win32") return;
        try {
          child.kill(signal);
        } catch {
          // The child is already gone; the exit handler below is what reports.
        }
      };
      listeners.push([signal, listener]);
      process.on(signal, listener);
    }
    const release = () => {
      for (const [signal, listener] of listeners) process.off(signal, listener);
    };

    child.on("error", (error) => {
      release();
      console.error(`with-root-env: could not run ${file}: ${error.message}`);
      resolve(EXIT_USAGE);
    });

    child.on("exit", (code, signal) => {
      release();
      if (signal) {
        /*
         * Re-raised rather than translated. A supervisor that distinguishes "was
         * killed" from "exited 130" should still be able to, and now that the
         * listeners are gone the default action applies. The numeric fallback is
         * for Windows, where re-raising a signal is not a thing.
         */
        try {
          process.kill(process.pid, signal);
        } catch {
          // fall through to the conventional code
        }
        resolve(128 + (os.constants.signals[signal] ?? 0));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

/* ==========================================================================
 * Process layer
 * ========================================================================== */

export function parseArgs(argv) {
  const options = { mode: null, quiet: false, help: false, command: [] };
  let i = 0;
  for (; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      i++;
      break;
    }
    if (arg === "--quiet") options.quiet = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--mode" || arg.startsWith("--mode=")) {
      const value = arg === "--mode" ? argv[++i] : arg.slice("--mode=".length);
      if (!KNOWN_MODES.has(value)) {
        return { error: `--mode must be development, test, or production, got "${value ?? ""}"` };
      }
      options.mode = value;
    } else if (arg.startsWith("-")) {
      return { error: `unknown option "${arg}"` };
    } else break;
  }
  options.command = argv.slice(i);
  return { options };
}

export async function main(
  argv,
  { cwd = process.cwd(), processEnv = process.env, scriptDir = null } = {},
) {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    console.error(`with-root-env: ${parsed.error}\n\n${USAGE}`);
    return EXIT_USAGE;
  }
  const options = parsed.options;
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  if (!options.command.length) {
    console.error(`with-root-env: no command given\n\n${USAGE}`);
    return EXIT_USAGE;
  }

  const mode = options.mode ?? nextEnvMode(options.command, processEnv);
  if (mode === null) {
    console.error(
      `with-root-env: cannot tell which .env file set "${options.command[0]}" should get.\n` +
        `The mode is derived automatically only for \`next\`, whose subcommand is what decides ` +
        `it. Pass --mode development|test|production explicitly.`,
    );
    return EXIT_USAGE;
  }

  let root;
  try {
    root = findRepoRoot(scriptDir ?? path.dirname(fileURLToPath(import.meta.url)));
  } catch (error) {
    console.error(`with-root-env: ${error.message}`);
    return EXIT_USAGE;
  }

  const { summary } = applyRootEnv({
    root,
    mode,
    processEnv,
    readEnvFile: (file) => readTextOrNull(path.join(root, file)),
  });
  // stderr, not stdout: a wrapper must not inject a line into output somebody
  // is piping. `--quiet` suppresses the summary only; every error above and
  // below still prints.
  if (!options.quiet) console.error(summary);

  const [command, ...rest] = options.command;
  if (commandName(command) === "node") {
    return runChild(process.execPath, rest, cwd);
  }
  const found = findPackageBin(command, cwd);
  if (found.bin === null) {
    console.error(
      `with-root-env: could not resolve a "${command}" executable from ${cwd}.\n` +
        `${BIN_PROBLEMS[found.problem](command, found.manifest)}\n` +
        `This wrapper deliberately does not fall back to a shell lookup: on Windows that means ` +
        `a .cmd shim, and a .cmd shim in the middle turns Ctrl-C into "Terminate batch job ` +
        `(Y/N)?".`,
    );
    return EXIT_USAGE;
  }
  return runChild(process.execPath, [found.bin, ...rest], cwd);
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    /*
     * Not decoration. `main` documents EXIT_USAGE for its own failures, and
     * without this a throw it did not anticipate -- a readFile that fails for a
     * reason `readTextOrNull` does not swallow, say -- becomes an unhandled
     * rejection: Node prints a stack and exits 1, which is a code this wrapper
     * never promised and is indistinguishable from a child that failed normally.
     * The stack is still printed, because a bug in here should look like one;
     * what is added is the documented status and the `with-root-env:` prefix
     * that every other failure in this file carries, so the reader can tell at a
     * glance whether the wrapper or the command was what broke.
     */
    .catch((error) => {
      console.error(`with-root-env: unexpected failure`);
      console.error(error);
      process.exitCode = EXIT_USAGE;
    });
}
