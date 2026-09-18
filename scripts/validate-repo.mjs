import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

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

export { INSTRUCTION_BASENAMES, INSTRUCTION_FILE_ALLOWLIST, PRUNED_DIRECTORIES };
