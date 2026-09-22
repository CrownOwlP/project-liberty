import fs from "node:fs";
import path from "node:path";

/*
 * ===========================================================================
 * A task that READS what another task WRITES must be ordered after it.
 * ===========================================================================
 *
 * THE DEFECT THIS EXISTS FOR.
 *
 * `npx turbo run typecheck lint build --force` -- this project's recorded gate
 * invocation for several rounds -- failed once with `@liberty/web#typecheck`
 * exit 2 AND NO `error TS` LINE, then passed on two re-runs of the identical
 * tree. Nothing about the code had changed between the three runs, which is the
 * signature of a race rather than of a type error.
 *
 * The race was verifiable from three static facts, without reproducing it:
 *
 *   1. `apps/web/tsconfig.json` includes `.next/types/**\/*.ts`;
 *   2. turbo's `build` task declares `.next/**` as an output;
 *   3. turbo's `typecheck` task declared `dependsOn: ["^typecheck"]` and no
 *      edge to `build`.
 *
 * So `tsc --noEmit` read a directory that `next build` was concurrently
 * emptying and refilling, in whatever order turbo's scheduler happened to pick.
 * A GREEN RUN IS NOT EVIDENCE THE RACE IS GONE -- the two clean re-runs are the
 * proof of that. The only admissible evidence is that the graph can no longer
 * schedule the two together, which is what this file checks and what
 * `scripts/test-validate-turbo-graph.mjs` pins.
 *
 * THE FIX, AND WHY THIS SHAPE.
 *
 * `turbo.json` gained a package-scoped `"@liberty/web#typecheck"` entry with
 * `dependsOn: ["^typecheck", "build"]`. Package-scoped rather than a change to
 * the shared `typecheck` task, because exactly one workspace has this coupling:
 * `apps/web` is the only one whose tsconfig reads a build output. Coupling the
 * other ten packages' typechecks to their builds would buy nothing and cost
 * every one of them a wait.
 *
 * REJECTED: excluding `.next/types/**\/*.ts` from `apps/web/tsconfig.json`.
 * It removes the read, which is the cleaner-sounding fix, and it fails for two
 * reasons. First, Next re-adds it: `writeConfigurationDefaults` in
 * `node_modules/next/dist/lib/typescript/writeConfigurationDefaults.js` walks
 * `userTsConfig.include`, pushes back any of its own type globs that are missing
 * and rewrites the file, on every `next dev` and `next build`, so the fix would
 * be undone by the framework and leave a permanently dirty tsconfig behind it.
 * Second -- for the variant that keeps the glob in `include` and adds it to
 * `exclude`, which does survive -- the cost is real coverage.
 * `.next/types/validator.ts` is the only mechanical check that this app's page,
 * layout and route-handler exports still match the router's contract; it is what
 * catches a `params` that stopped being a Promise. Excluding it removes that
 * from `tsc` AND from `next build`'s own type pass, because both read the same
 * tsconfig.
 *
 * THE COST OF THE EDGE, STATED. `@liberty/web#typecheck` now waits for
 * `@liberty/web#build`, and transitively for every upstream `build`. In CI that
 * is close to free: `.github/workflows/ci.yml` already runs Typecheck and Build
 * as separate steps in one job, so the build work moves earlier and the Build
 * step becomes a cache hit. Locally, a warm cache makes it a restore. The real
 * bill is `--force`, which re-runs the build inside the typecheck invocation and
 * again inside the build invocation. That is the price of the three-invocation
 * gate protocol, and it is the right trade: a gate that is sometimes wrong costs
 * more than a gate that is sometimes slow, and this one was wrong once already.
 *
 * WHAT THIS FILE CHECKS, GENERALLY. Not "the web app has this one edge" -- that
 * would be a restatement of turbo.json in a second file. The invariant is:
 *
 *   for every workspace task whose command compiles against a tsconfig, and
 *   every OTHER task whose declared turbo outputs contain a path that tsconfig
 *   reads, the reading task must depend on the writing task within the package.
 *
 * So it also fires if someone adds a second Next app, points a tsconfig at
 * another package's `dist/`, or removes the edge that exists now.
 *
 * DELIBERATELY NOT CHECKED: `next build`'s own internal type pass. It writes
 * `.next/types` and reads it back inside a single process, so it is ordered by
 * construction; a task is never required to depend on itself. And the reader
 * detection is lexical -- a task counts as a compiler if its command contains a
 * `tsc` token -- so a future task that typechecks by some other means would not
 * be seen. Stated rather than papered over.
 */

/** Turbo's own JSON accepts comments; tsconfig files here use them. */
export function parseJsonc(text, sourceLabel = "<jsonc>") {
  let output = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];
    if (char === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index += 1;
      index += 2;
      continue;
    }
    if (char === '"') {
      output += char;
      index += 1;
      while (index < text.length) {
        if (text[index] === "\\") {
          output += text[index] + (text[index + 1] ?? "");
          index += 2;
          continue;
        }
        output += text[index];
        if (text[index] === '"') {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    output += char;
    index += 1;
  }
  // Trailing commas are legal in tsconfig and in turbo.json; JSON.parse rejects
  // them, so they go too.
  output = output.replace(/,(\s*[}\]])/g, "$1");
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(`${sourceLabel}: ${error.message}`);
  }
}

function readJsonc(full) {
  return parseJsonc(fs.readFileSync(full, "utf8"), path.basename(full));
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

/**
 * The literal directory a glob reads, with everything from the first wildcard
 * onwards removed. `.next/types/**\/*.ts` -> `.next/types`; `**\/*.ts` -> ``.
 *
 * The truncation is what makes the comparison below sound in the direction that
 * matters. A bare `**\/*.ts` truncates to the workspace root, which is NOT
 * inside `.next`, so it raises nothing -- and that is correct rather than
 * lucky: TypeScript's include globs skip directories whose name begins with a
 * dot, which is exactly why Next has to name `.next/types/**\/*.ts` explicitly
 * instead of relying on the recursive pattern already there.
 */
export function globPrefix(pattern) {
  const wildcard = pattern.search(/[*?]/);
  const literal = wildcard === -1 ? pattern : pattern.slice(0, wildcard);
  const cut = literal.lastIndexOf("/");
  return wildcard === -1 ? literal : cut === -1 ? "" : literal.slice(0, cut);
}

function isInside(candidate, directory) {
  if (directory === "") return false;
  return candidate === directory || candidate.startsWith(`${directory}/`);
}

/**
 * The `include` and `files` entries of a tsconfig, as repo-relative POSIX paths,
 * following a relative `extends` chain. Entries matched by `exclude` are
 * dropped, because `exclude` filters `include`.
 */
export function tsconfigReadPaths(root, configPath) {
  const seen = new Set();
  const layers = [];
  let current = configPath;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (!fs.existsSync(current)) break;
    const config = readJsonc(current);
    layers.push({ dir: path.dirname(current), config });
    const extend = config.extends;
    // A package-name `extends` would need module resolution, which this script
    // does not do; no workspace here uses one, and the test suite pins that.
    current = typeof extend === "string" && extend.startsWith(".") ? path.resolve(path.dirname(current), extend) : null;
  }

  for (const layer of layers) {
    const patterns = [...(layer.config.include ?? []), ...(layer.config.files ?? [])];
    if (patterns.length === 0) continue;
    const excludes = (layer.config.exclude ?? []).map((entry) => globPrefix(entry));
    const resolved = [];
    for (const pattern of patterns) {
      const absolute = path.resolve(layer.dir, globPrefix(pattern));
      const relative = toPosix(path.relative(root, absolute));
      if (excludes.some((entry) => isInside(relative, toPosix(path.relative(root, path.resolve(layer.dir, entry)))))) {
        continue;
      }
      resolved.push({ pattern, directory: relative });
    }
    return resolved; // nearest layer that declares inputs wins, as tsc does
  }
  return [];
}

function effectiveTaskConfig(turbo, packageName, taskName) {
  return turbo.tasks?.[`${packageName}#${taskName}`] ?? turbo.tasks?.[taskName] ?? null;
}

/**
 * Every task in the SAME package that `taskName` transitively waits for.
 *
 * `^task` entries are upstream packages and are irrelevant here: the race is
 * between two tasks of one package over one directory. A `pkg#task` entry counts
 * only when `pkg` is this package.
 */
export function samePackageDependencies(turbo, packageName, taskName) {
  const reached = new Set();
  const queue = [taskName];
  while (queue.length) {
    const current = queue.shift();
    const config = effectiveTaskConfig(turbo, packageName, current);
    for (const entry of config?.dependsOn ?? []) {
      if (entry.startsWith("^")) continue;
      const target = entry.includes("#")
        ? entry.startsWith(`${packageName}#`)
          ? entry.slice(packageName.length + 1)
          : null
        : entry;
      if (!target || reached.has(target)) continue;
      reached.add(target);
      queue.push(target);
    }
  }
  return reached;
}

/** A task counts as a compiler when its command contains a bare `tsc` token. */
export function compilesWithTsc(command) {
  return /(^|[\s"'/\\])tsc([\s"']|$)/.test(command);
}

/** The tsconfig a `tsc` command reads: `-p`/`--project` if given, else the default. */
export function tsconfigFor(workspaceDir, command) {
  const project = command.match(/(?:-p|--project)\s+("[^"]+"|'[^']+'|\S+)/);
  if (!project) return path.join(workspaceDir, "tsconfig.json");
  const raw = project[1].replace(/^["']|["']$/g, "");
  const resolved = path.resolve(workspaceDir, raw);
  return fs.statSync(resolved, { throwIfNoEntry: false })?.isDirectory() ? path.join(resolved, "tsconfig.json") : resolved;
}

/**
 * Check every workspace's reading tasks against every workspace's writing tasks.
 *
 * Returns error strings; an empty array means no task in this graph reads a
 * directory another task in its own package writes without waiting for it.
 */
export function checkTurboGraph(root, listWorkspaceDirectories) {
  const turbo = readJsonc(path.join(root, "turbo.json"));
  const errors = [];
  const workspaces = listWorkspaceDirectories(root).map((directory) => ({
    directory,
    manifest: JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"))
  }));

  // Every declared output directory in the repository, repo-relative, with the
  // package and task that writes it. Negated globs (`!.next/cache/**`) are
  // exclusions from an output set, not directories anyone writes.
  const writers = [];
  for (const { directory, manifest } of workspaces) {
    for (const taskName of Object.keys(manifest.scripts ?? {})) {
      const config = effectiveTaskConfig(turbo, manifest.name, taskName);
      for (const output of config?.outputs ?? []) {
        if (output.startsWith("!")) continue;
        const prefix = globPrefix(output);
        if (prefix === "") continue;
        writers.push({
          packageName: manifest.name,
          taskName,
          directory: toPosix(path.relative(root, path.resolve(directory, prefix))),
          output
        });
      }
    }
  }

  for (const { directory, manifest } of workspaces) {
    for (const [taskName, command] of Object.entries(manifest.scripts ?? {})) {
      if (typeof command !== "string" || !compilesWithTsc(command)) continue;
      if (!effectiveTaskConfig(turbo, manifest.name, taskName)) continue; // not a turbo task
      const configPath = tsconfigFor(directory, command);
      const reads = tsconfigReadPaths(root, configPath);
      if (reads.length === 0) continue;
      const waitsFor = samePackageDependencies(turbo, manifest.name, taskName);

      for (const read of reads) {
        for (const writer of writers) {
          if (!isInside(read.directory, writer.directory)) continue;
          if (writer.packageName === manifest.name && writer.taskName === taskName) continue; // writes then reads its own output, in one process
          if (writer.packageName !== manifest.name) {
            // A cross-package read needs `^task` or an explicit `pkg#task`; both
            // are outside the same-package closure computed above, so resolve it
            // directly rather than guessing.
            const config = effectiveTaskConfig(turbo, manifest.name, taskName);
            const declared = (config?.dependsOn ?? []).some(
              (entry) => entry === `^${writer.taskName}` || entry === `${writer.packageName}#${writer.taskName}`
            );
            if (declared) continue;
          } else if (waitsFor.has(writer.taskName)) {
            continue;
          }

          errors.push(
            `racing tasks: ${manifest.name}#${taskName} runs \`${command}\`, whose tsconfig ` +
              `(${toPosix(path.relative(root, configPath))}) reads "${read.pattern}" -> ${read.directory}/, and ` +
              `${writer.packageName}#${writer.taskName} declares "${writer.output}" as an output of that same ` +
              `directory. Nothing in turbo.json orders them, so turbo may schedule both at once and the reader ` +
              `will compile a directory the writer is still emptying. That failure is intermittent and carries no ` +
              `\`error TS\` line, so it reads as a flake and gets re-run. Add "${writer.taskName}" to ` +
              `${manifest.name}#${taskName}'s dependsOn in turbo.json (a package-scoped "${manifest.name}#${taskName}" ` +
              `entry keeps the wait off every other workspace), or stop the tsconfig reading that directory.`
          );
        }
      }
    }
  }

  return errors;
}

async function main() {
  const root = process.cwd();
  const { listWorkspaceDirectories } = await import("./validate-workspace-deps.mjs");
  let errors;
  try {
    errors = checkTurboGraph(root, listWorkspaceDirectories);
  } catch (error) {
    console.error(`Project Liberty turbo graph validation could not run:\n- ${error.message}`);
    process.exit(1);
  }
  if (errors.length) {
    console.error("Project Liberty turbo graph validation failed:\n" + errors.map((item) => `- ${item}`).join("\n"));
    process.exit(1);
  }
  console.log("Project Liberty turbo graph validation passed (no task reads another task's outputs unordered).");
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) await main();
