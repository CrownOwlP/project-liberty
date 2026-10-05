import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { checkWorkspaceDependencies, listWorkspaceDirectories } from "./validate-workspace-deps.mjs";
import { checkTurboGraph } from "./validate-turbo-graph.mjs";

const required = [
  "README.md",
  "AGENTS.md",
  "CLAUDE.md",
  ".claude/settings.json",
  ".claude/agents/orchestration-lead.md",
  "package.json",
  "turbo.json",
  "docs/PRODUCT_SPEC.md",
  "docs/ARCHITECTURE.md",
  "docs/API_CONTRACTS.md",
  "docs/CONTENT_RIGHTS.md",
  "coordination/AI_OPERATING_MODEL.md",
  "coordination/PROJECT_STATUS.md",
  "coordination/MASTER_PLAN.md",
  "coordination/TASKS.md",
  "coordination/OWNERSHIP.md",
  "coordination/IN_PROGRESS.md",
  "coordination/CLAUDE_TO_GPT.md",
  "coordination/GPT_TO_CLAUDE.md",
  "apps/web/package.json",
  "packages/contracts/package.json",
  "packages/media-engine/package.json",
  "packages/provider-sdk/package.json",
  "control/project.json",
  "control/tasks.json",
  "control/milestones.json",
  "control/agents.json",
  "control/policies.json",
  "control/quality-gates.json",
  "control/adapters.json",
  "scripts/ai-control-plane.mjs",
  "scripts/bootstrap-ai-project.mjs",
  "scripts/test-ai-control-plane.mjs",
  // The environment contract and its validator. Required here because a repo
  // that has lost .env.example has not lost documentation -- it has lost the
  // only declaration of which variables exist, and validate-env.mjs would then
  // report a clean environment over an empty contract.
  ".env.example",
  "scripts/validate-env.mjs",
  "scripts/test-validate-env.mjs",
  "scripts/test-validate-repo.mjs",
  // The two build-configuration validators and their suites. Both are called
  // from `main()` below, so deleting one is already a crash rather than a quiet
  // pass; the suites are not imported from anywhere, which is exactly the state
  // this list exists to make impossible.
  "scripts/validate-workspace-deps.mjs",
  "scripts/test-validate-workspace-deps.mjs",
  "scripts/validate-turbo-graph.mjs",
  "scripts/test-validate-turbo-graph.mjs",
  // The runtime half of the same contract. `apps/web`'s dev and start scripts
  // invoke it by path, so losing it does not degrade anything -- it breaks
  // `npm run dev` and `npm run start` outright, with a module-resolution error
  // that names a file rather than the reason it mattered. Required here so the
  // structural check says the reason. (`build` is deliberately NOT wrapped; the
  // reason is turbo's cache key, and it is recorded in docs/DEVELOPMENT.md.)
  "scripts/with-root-env.mjs",
  "infra/docker-compose.yml",
  "scripts/start-ai-engineering.ps1",
  "scripts/start-ai-engineering.cmd"
];

/*
 * ---------------------------------------------------------------------------
 * Agent instruction files
 * ---------------------------------------------------------------------------
 *
 * An `AGENTS.md` or `CLAUDE.md` in the working tree is read by agents as
 * authoritative instruction. Anything that can write such a file into the tree
 * can therefore steer the control plane, and framework tooling can: `next dev`
 * calls node_modules/next/dist/server/lib/generate-agent-files.js, which
 * creates or upserts `apps/web/AGENTS.md` (and `apps/web/CLAUDE.md`) whenever
 * it detects an AI coding agent. That makes a dependency's tooling a write path
 * onto the instruction surface, so the surface is enumerated here rather than
 * discovered by whoever happens to open the directory.
 *
 * The allowlist lives in this file, in code, on purpose. A sibling data file
 * would be a second thing that decides which instructions are legitimate while
 * being cheaper to edit than the validator that reads it, and it would need its
 * own provenance story. Adding an entry here is a change to a gate-bearing
 * script and is reviewed as one.
 *
 * Each entry names an owner: the party accountable for the file's content. An
 * instruction file with no owner is a validation FAILURE, not a warning -- a
 * warning inside a passing run is not a control.
 *
 * One vocabulary constraint on THIS FILE, which is not discoverable from
 * here: scenario 9af in scripts/test-ai-control-plane.mjs overwrites this
 * script with a one-word tamper canary, runs the trusted-runtime restore,
 * and asserts the restored file no longer contains that word. The word is
 * the past participle of "own". A correct restore therefore fails the
 * assertion if this file legitimately contains that substring anywhere, and
 * the failure reads as a broken restore rather than a wording collision --
 * which is exactly what happened to an earlier draft of the message below.
 * "owner" is safe; the participle is not. scripts/test-validate-repo.mjs
 * pins this so it cannot come back unnoticed.
 *
 * Generated entries additionally carry `pinnedSha256` and a `summary` of what
 * the file actually says, recorded by whoever read it. The pin is what keeps
 * allowlisting from degenerating into permission: if the generator emits
 * different bytes on a later version, the hash stops matching and validation
 * fails until someone reads the new text and re-pins it. The allowlist records
 * a review, not a standing exemption.
 */
const INSTRUCTION_BASENAMES = new Set(["agents.md", "claude.md"]);

/*
 * Directories the instruction scan never descends into.
 *
 * `node_modules` and `.git` are mandatory exclusions, for two different
 * reasons. Cost is the lesser one. The real one is that a dependency shipping
 * its own AGENTS.md is not a finding and must not be reported as one -- the
 * whole point of the control is that nothing under node_modules is ever
 * authoritative, and a scanner that treated those files as candidates for
 * allowlisting would be asserting the opposite. The build outputs below are
 * excluded because they are regenerated artifacts that no agent reads as
 * instruction; they are gitignored and carry no provenance to review.
 */
const PRUNED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".next",
  ".turbo",
  ".vercel",
  "dist",
  "build",
  "coverage"
]);

const INSTRUCTION_FILE_ALLOWLIST = [
  {
    path: "AGENTS.md",
    owner: "human-commander",
    origin: "authored",
    note: "Repository operating contract for OpenAI/Codex agents. Maintained by hand; no content pin, because it is edited deliberately and every edit is a reviewed diff."
  },
  {
    path: "CLAUDE.md",
    owner: "human-commander",
    origin: "authored",
    note: "Repository operating contract for Claude Code. Maintained by hand; no content pin, for the same reason as AGENTS.md."
  },
  {
    path: "apps/web/AGENTS.md",
    owner: "claude-lead",
    origin: "generated",
    generator: "next dev, via node_modules/next/dist/server/lib/generate-agent-files.js (next@16.3.1)",
    summary:
      "A single managed block delimited by <!-- BEGIN:nextjs-agent-rules --> / <!-- END:nextjs-agent-rules -->. It says this Next.js version has breaking changes relative to a model's training data, instructs the reader to read the relevant guide in node_modules/next/dist/docs/ before writing code and to heed deprecation notices, and states that the block is re-added by `next dev` so removing it from a diff only recreates an uncommitted change. It contains no repository-specific instruction and nothing that touches the control plane.",
    disposition:
      "Read and allowlisted rather than gitignored-and-removed. Removing it does not remove the instruction surface: writeAgentFiles() falls through to apps/web/CLAUDE.md when AGENTS.md is absent, so deleting this file relocates the injected block into the other file instead of eliminating it, and `next dev` recreates it on the next run either way. Tracking it with a pinned hash makes any change to the generated text a validation failure, which is strictly more visible than an ignored file nobody diffs. Its instruction to read node_modules/next/dist/docs/ is bounded by the instruction hierarchy in coordination/AI_OPERATING_MODEL.md: those docs are framework reference, never authoritative over repository contracts.",
    pinnedSha256: "63f2c50380ed6303237cce215ce27af1d620d094c215e28d1b1538a3c070e3bb"
  },
  {
    path: "apps/web/CLAUDE.md",
    owner: "claude-lead",
    origin: "generated",
    generator: "next dev / create-next-app, via the same generate-agent-files module",
    summary: "One line: `@AGENTS.md`. A Claude Code import directive pointing at the sibling AGENTS.md above. It carries no instruction of its own.",
    disposition:
      "Read and allowlisted. It must keep existing and keep exactly these bytes: if it were deleted, `next dev` would write the managed block into whichever of the two files it finds, and if it were edited it would become an unreviewed instruction file in an app directory. The pin makes both cases fail validation.",
    pinnedSha256: "336cc4fbf19beaada7ccf9986414fa91851a8d7a07dfb3ccbe800a69eed0ab49"
  }
];

/**
 * Walk the working tree and return every agent instruction file, as paths
 * relative to `root` with forward slashes. Pruned directories are never
 * descended into and symbolic links are never followed, so the scan cannot
 * escape the checkout or be redirected into node_modules by a link.
 */
export function findInstructionFiles(root) {
  const found = [];
  const stack = [""];
  while (stack.length) {
    const relative = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, relative), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!PRUNED_DIRECTORIES.has(entry.name)) stack.push(child);
        continue;
      }
      if (entry.isFile() && INSTRUCTION_BASENAMES.has(entry.name.toLowerCase())) found.push(child);
    }
  }
  return found.sort();
}

function hashInstructionFile(full) {
  // Normalised to LF before hashing: the generator writes CRLF on a Windows
  // checkout (detectEol in generate-agent-files.js), and a pin that flipped
  // between platforms would be a pin nobody could keep green.
  const content = fs.readFileSync(full, "utf8").replace(/\r\n/g, "\n");
  return crypto.createHash("sha256").update(content).digest("hex");
}

/**
 * Compare the instruction files present under `root` against `allowlist`.
 * Returns error strings; an empty array means the instruction surface is
 * exactly what has been reviewed.
 */
export function checkInstructionFiles(root, allowlist = INSTRUCTION_FILE_ALLOWLIST) {
  const errors = [];
  const byPath = new Map(allowlist.map((entry) => [entry.path, entry]));

  for (const relative of findInstructionFiles(root)) {
    const entry = byPath.get(relative);
    if (!entry) {
      errors.push(
        `agent instruction file with no recorded owner: ${relative}. Agents read AGENTS.md and CLAUDE.md as authoritative, so every one of them must name an owner in INSTRUCTION_FILE_ALLOWLIST in scripts/validate-repo.mjs. If a tool generated this file, read it, record what it says, and either add a reviewed entry with a pinned hash or remove the file and stop the tool from writing it.`
      );
      continue;
    }
    if (!entry.pinnedSha256) continue;
    const actual = hashInstructionFile(path.join(root, relative));
    if (actual !== entry.pinnedSha256) {
      errors.push(
        `agent instruction file changed since it was reviewed: ${relative} (expected sha256 ${entry.pinnedSha256}, found ${actual}). This file is generated by ${entry.generator ?? "tooling"} and is allowlisted only at the bytes someone read. Read the new content, update the entry's summary, and re-pin it.`
      );
    }
  }

  for (const entry of allowlist) {
    if (!fs.existsSync(path.join(root, entry.path))) {
      errors.push(
        `allowlisted agent instruction file is missing: ${entry.path} (owner ${entry.owner}). Either restore it or drop its allowlist entry; a stale entry describes a review of something that is not there.`
      );
    }
  }

  return errors;
}

/* ---------------------------------------------------------------------------
 * ONE VERSION, AND IT MUST BE ONE (PW-0502)
 *
 * ==========================================================================
 * THERE ARE TWO VERSION SOURCES AND NOTHING RECONCILED THEM
 * ==========================================================================
 *
 * `apps/desktop/src-tauri/Cargo.toml` carries the version Tauri names the
 * installer from -- Windows #16 and #17 both produced
 * `Project Liberty_0.1.0_x64_en-US.msi`, and that `0.1.0` is the Cargo
 * package version, because `tauri.conf.json` declares no `version` of its own
 * and Tauri falls back to Cargo's.
 *
 * `apps/web/package.json` carries the version the APPLICATION SHOWS A USER.
 * PW-0308's About section renders `packageJson.version` from that file, and
 * `settings.test.tsx` asserts it is read rather than pasted.
 *
 * Both say `0.1.0` today, by coincidence of nobody having bumped either. The
 * day one moves and the other does not, the About screen states a version
 * that is not the version of the thing installed -- and every defect report
 * from that build names the wrong one. PW-0603's run sheet asks the commander
 * for "Liberty version: from the About screen — never 'latest'", and
 * PW-0501's artifact inventory identifies a build by the installer's name.
 * Those two answers have to be the same answer.
 *
 * ==========================================================================
 * WHY A VALIDATOR CHECK AND NOT A BUILD STEP
 * ==========================================================================
 *
 * This file already runs in CI's `validate` job BEFORE `npm ci`, already
 * performs cross-file consistency checks of exactly this kind, and already
 * has a mirrored suite with its own CI step. A check for "two files must
 * agree" belongs with `checkWorkspaceDependencies` rather than in a packaging
 * script that only a Windows runner reaches -- the disagreement is authored
 * on any machine and should be caught on the machine that authored it.
 *
 * NOT DEDUPLICATED INTO ONE FILE, and that is deliberate rather than lazy.
 * Cargo must have a version in its own manifest and npm must have one in
 * its own; neither tool reads the other's. What can be removed is not the
 * second copy, it is the SILENCE between them.
 * ------------------------------------------------------------------------ */
function checkVersionAuthority(root) {
  const errors = [];

  const cargoPath = path.join(root, "apps/desktop/src-tauri/Cargo.toml");
  const webPath = path.join(root, "apps/web/package.json");
  const confPath = path.join(root, "apps/desktop/src-tauri/tauri.conf.json");
  if (!fs.existsSync(cargoPath) || !fs.existsSync(webPath)) return errors;

  const cargo = fs.readFileSync(cargoPath, "utf8");
  /* The `[package]` table's own version, not a dependency's. Anchored to the
   * section so a `[dependencies] serde = { version = "..." }` cannot match. */
  const packageSection = /^\[package\]([\s\S]*?)(?=^\[|\Z)/m.exec(cargo)?.[1] ?? "";
  const cargoVersion = /^\s*version\s*=\s*"([^"]+)"/m.exec(packageSection)?.[1] ?? null;
  if (!cargoVersion) {
    errors.push(
      "apps/desktop/src-tauri/Cargo.toml has no [package] version, so the installer Tauri builds " +
        "would be named from nothing and no build could be identified afterwards"
    );
    return errors;
  }

  let webVersion = null;
  try {
    webVersion = JSON.parse(fs.readFileSync(webPath, "utf8")).version ?? null;
  } catch {
    /* A malformed apps/web/package.json is already reported by the JSON scan
     * in main(); saying it twice helps nobody. */
    return errors;
  }
  if (!webVersion) {
    errors.push("apps/web/package.json has no version, and the About screen renders it to a user");
    return errors;
  }

  if (cargoVersion !== webVersion) {
    errors.push(
      `version disagreement: apps/desktop/src-tauri/Cargo.toml says ${cargoVersion} and ` +
        `apps/web/package.json says ${webVersion}. The first names the installer Tauri builds; the ` +
        `second is what the About screen shows a user. A build whose screen and whose filename ` +
        `disagree cannot be identified from a defect report. Bump both, or neither.`
    );
  }

  /*
   * A THIRD SOURCE IS WORSE THAN TWO. If `tauri.conf.json` grows a `version`,
   * it WINS over Cargo's -- quietly, with no error anywhere -- so the field is
   * either absent or in agreement. Absent is what the repository has and what
   * the comment above describes.
   */
  if (fs.existsSync(confPath)) {
    try {
      const conf = JSON.parse(fs.readFileSync(confPath, "utf8"));
      if (conf.version !== undefined && conf.version !== cargoVersion) {
        errors.push(
          `apps/desktop/src-tauri/tauri.conf.json declares version ${String(conf.version)}, which ` +
            `OVERRIDES the Cargo version ${cargoVersion} that everything else is derived from. ` +
            `Remove it, or make all three agree.`
        );
      }

      /*
       * AND NO UPDATER WHILE THERE IS NO SIGNING KEY.
       *
       * PW-0502's acceptance: "an updater that fetches and executes an
       * unverified binary is a remote code execution feature", and "IF
       * SIGNING IS UNAVAILABLE the update path must be disabled by default
       * and say so". No Authenticode certificate exists -- LAST_MILE item 6,
       * an owner decision this session cannot make -- so the honest state is
       * no updater at all.
       *
       * Today that is true by ABSENCE, which is not the same as being
       * decided: nothing would notice the day somebody enabled one. This
       * makes the absence an assertion, so enabling an updater before the
       * signing story exists turns the build red rather than shipping a
       * remote-code-execution path by default.
       */
      const updater = conf.plugins?.updater;
      if (updater && updater.active !== false) {
        errors.push(
          "apps/desktop/src-tauri/tauri.conf.json configures an updater while no Authenticode " +
            "signing key exists (LAST_MILE 6). An updater that fetches and executes an unverified " +
            "binary is a remote-code-execution feature. Disable it, or land signature verification " +
            "and the pinned, allowlisted update endpoint PW-0502 requires first. docs/RELEASE.md " +
            "states the boundary."
        );
      }
    } catch {
      /* Reported by the JSON scan in main(). */
    }
  }

  return errors;
}

function main() {
  const root = process.cwd();
  const quick = process.argv.includes("--quick");
  const errors = [];

  for (const file of required) {
    if (!fs.existsSync(path.join(root, file))) errors.push(`missing required file: ${file}`);
  }

  for (const file of ["package.json", "turbo.json", ".claude/settings.json", "apps/web/package.json", "packages/contracts/package.json", "packages/media-engine/package.json", "packages/provider-sdk/package.json", "packages/observability/package.json", "control/project.json", "control/tasks.json", "control/milestones.json", "control/agents.json", "control/policies.json", "control/quality-gates.json", "control/adapters.json"]) {
    const full = path.join(root, file);
    if (!fs.existsSync(full)) continue;
    try {
      JSON.parse(fs.readFileSync(full, "utf8"));
    } catch (error) {
      errors.push(`invalid JSON: ${file}: ${error.message}`);
    }
  }

  // Runs in --quick too. The instruction surface is the one thing here that an
  // agent can change mid-session, and .claude/settings.json wires the quick
  // run into a hook; a control that only fires in the slow path would not see
  // the file until after the session that wrote it had finished using it.
  errors.push(...checkInstructionFiles(root));

  /*
   * The build configuration must describe the code it builds. Both of these run
   * in --quick as well, for the same reason the instruction scan does: they
   * catch something an agent introduces MID-SESSION -- an import added without
   * the matching manifest line, a tsconfig pointed at a directory another task
   * writes -- and a control that only fires in the slow path would not see it
   * until after the session that wrote it had finished.
   *
   * Both cost together about a quarter of a second, and neither touches
   * node_modules, so this stays ahead of `npm ci` in CI like everything above.
   *
   * They throw rather than return errors when the repository is shaped in a way
   * they cannot read -- an unexpandable workspace glob, an unparseable tsconfig.
   * That is deliberate on their side and must not be swallowed here: a validator
   * that cannot see part of the tree has to say so, not report a pass over the
   * part it could see.
   */
  /* Runs in --quick too, for the reason the two below do: a version bumped in
   * one file and not the other is introduced mid-session by whoever is doing
   * the bumping, and a control that only fires in the slow path would not see
   * it until after that session had finished. It reads two small files. */
  errors.push(...checkVersionAuthority(root));

  try {
    errors.push(...checkWorkspaceDependencies(root));
    errors.push(...checkTurboGraph(root, listWorkspaceDirectories));
  } catch (error) {
    errors.push(`build configuration could not be validated: ${error.message}`);
  }

  if (!quick) {
    const taskDoc = JSON.parse(fs.readFileSync(path.join(root, "control/tasks.json"), "utf8"));
    const ids = (taskDoc.tasks ?? []).map((task) => task.id);
    const unique = new Set(ids);
    if (unique.size < 20) errors.push("control plane has fewer than 20 unique executable task IDs");
    if (unique.size !== ids.length) errors.push("control plane contains duplicate task IDs");

    const rights = fs.readFileSync(path.join(root, "docs/CONTENT_RIGHTS.md"), "utf8");
    for (const phrase of ["DRM circumvention", "paywalls", "geographic restrictions"]) {
      if (!rights.includes(phrase)) errors.push(`content-rights invariant missing phrase: ${phrase}`);
    }
  }

  if (errors.length) {
    console.error("Project Liberty repository validation failed:\n" + errors.map((item) => `- ${item}`).join("\n"));
    process.exit(1);
  }

  console.log(`Project Liberty repository validation passed${quick ? " (quick)" : ""}.`);
}

// Importable for scripts/test-validate-repo.mjs without running the checks on
// import; still a plain script when invoked directly.
if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) main();

export { INSTRUCTION_BASENAMES, INSTRUCTION_FILE_ALLOWLIST, PRUNED_DIRECTORIES, checkVersionAuthority };
