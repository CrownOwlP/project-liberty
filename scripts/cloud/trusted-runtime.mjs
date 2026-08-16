#!/usr/bin/env node
/**
 * The trusted copy of the deterministic runtime, kept outside the workspace.
 *
 * WHY THIS EXISTS, and why restoring from HEAD was not sufficient.
 *
 * The previous design had `protect-state.mjs --restore` re-checkout `scripts/`
 * and `.github/` from HEAD before any privileged step ran, on the reasoning
 * that git is an immutable copy the model cannot commit to. The reasoning was
 * right; the bootstrap was wrong. The workflow invoked that guard as:
 *
 *     node scripts/cloud/protect-state.mjs --restore
 *
 * from the model-writable workspace. A model that replaced protect-state.mjs
 * with `process.exit(0)` would have its version run, the restore would never
 * happen, and every subsequent step -- including the finalizer that
 * authenticates to GitHub -- would execute the model's code. The guard was
 * inside the thing it was guarding. The test suite hid this because the
 * scenario performed `git checkout HEAD -- scripts/cloud/protect-state.mjs`
 * itself before invoking the guard; the real workflow performed no such step.
 *
 * A guard cannot bootstrap trust from the location it is protecting. So the
 * whole deterministic runtime is copied to $RUNNER_TEMP BEFORE the model runs,
 * and every privileged step afterwards is invoked from that copy by absolute
 * path. $RUNNER_TEMP is outside the checkout, so nothing the model can write
 * reaches it, and the copy is taken from a workspace that has not yet been
 * exposed to the model.
 *
 * Copying the entire `scripts/` tree rather than a hand-listed set of files is
 * deliberate: an import graph is exactly the kind of list that goes stale
 * silently, and this repository has already shipped that bug twice in the
 * bootstrap copier. Everything, or a provable subset -- not a guess.
 *
 * STATUS NOTE. The workflow no longer relies on this to separate the model from
 * the credentialed steps: those are now different JOBS on different runners,
 * because an in-job trusted copy could not survive a step writing $GITHUB_ENV
 * to redirect a later step. TRUSTED_RUNTIME_PATHS is still the shared list that
 * protect-state.mjs restores and harden-model-session.mjs checks itself
 * against, and --install/--verify remain for privileged single-runner
 * maintenance runs. Do not read the workflow as depending on them.
 *
 *   node scripts/cloud/trusted-runtime.mjs --install
 *   node "$(...)/scripts/cloud/trusted-runtime.mjs" --verify
 *   node scripts/cloud/trusted-runtime.mjs --path        # prints the store root
 *
 * `--verify` additionally re-checks that HEAD has not moved since `--install`.
 * The trusted copy is only meaningful as a statement about a specific commit;
 * if HEAD changed underneath it, the copy describes a different repository than
 * the one about to be pushed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = process.cwd();
const args = process.argv.slice(2);

/**
 * Paths copied verbatim into the trusted store, and restored into the workspace
 * from HEAD after the model step.
 *
 * `scripts` holds every deterministic step and everything they import.
 * `.github` holds the workflows; they are not executed from the store, but a
 * privileged step that inspects workflow definitions must see the committed
 * ones rather than whatever is in the working tree.
 * `.claude` and `.mcp.json` are EXECUTABLE CONFIGURATION: a PostToolUse hook is
 * a shell command fired by Write/Edit, outside the Bash permission system
 * entirely, and this repository's hook invokes scripts from the workspace. They
 * are stripped before the model runs (harden-model-session.mjs) and restored
 * from HEAD afterwards, so they must be part of this set or the restore would
 * leave the repository permanently missing them.
 */
export const TRUSTED_RUNTIME_PATHS = [
  "scripts",
  ".github",
  ".claude",
  ".mcp.json",
  // Must match EXECUTABLE_PROJECT_CONFIG in harden-model-session.mjs exactly.
  // `.claude-plugin` was stripped before the model ran but was missing here, so
  // the stated invariant -- strip, carry in the trusted copy, restore from HEAD
  // -- did not actually hold for it: once stripped it would never have come
  // back. A path that one list knows about and the other does not is the same
  // drift that produced the gate-executor defect.
  ".claude-plugin"
];

export function storeRoot() {
  return path.join(process.env.RUNNER_TEMP || os.tmpdir(), "liberty-trusted-runtime");
}

const MANIFEST = ".manifest.json";

function headSha() {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}

/**
 * Paths inside `scripts/` that are NOT part of the deterministic runtime and
 * must not be trusted just because they live there. Nothing currently matches;
 * the hook exists so that adding, say, a scratch directory under scripts/ does
 * not silently widen the trusted set.
 */
const EXCLUDED = new Set([]);

function copyTrusted(from, to) {
  fs.cpSync(from, to, {
    recursive: true,
    filter: (src) => !EXCLUDED.has(path.relative(root, src))
  });
}

function isEntryPoint() {
  if (!process.argv[1]) return false;
  const canonical = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const self = canonical(fileURLToPath(import.meta.url));
  const entry = canonical(path.resolve(process.argv[1]));
  return process.platform === "win32"
    ? self.toLowerCase() === entry.toLowerCase()
    : self === entry;
}

if (!isEntryPoint()) {
  // Imported for its exports; the CLI below is deliberately inert.
} else if (args.includes("--install")) {
  /*
   * Install runs BEFORE the model. The working tree at this point came
   * straight from actions/checkout, so it equals HEAD -- but "should equal"
   * is not "does equal", and copying a dirty tree would trust whatever made it
   * dirty. Verify, then copy.
   */
  const dirty = execFileSync(
    "git",
    ["status", "--porcelain", "--", ...TRUSTED_RUNTIME_PATHS],
    { cwd: root, encoding: "utf8" }
  ).trim();

  if (dirty) {
    console.error(
      "Refusing to install a trusted runtime from a modified working tree. " +
      "The copy would inherit whatever produced these changes:"
    );
    for (const line of dirty.split("\n")) console.error(`  ! ${line.trim()}`);
    process.exit(1);
  }

  const store = storeRoot();
  fs.rmSync(store, { recursive: true, force: true });
  fs.mkdirSync(store, { recursive: true });

  for (const rel of TRUSTED_RUNTIME_PATHS) {
    const from = path.join(root, rel);
    if (!fs.existsSync(from)) continue;
    copyTrusted(from, path.join(store, rel));
  }

  const sha = headSha();
  fs.writeFileSync(
    path.join(store, MANIFEST),
    JSON.stringify({ installedAt: new Date().toISOString(), headSha: sha, paths: TRUSTED_RUNTIME_PATHS }, null, 2) + "\n"
  );

  console.log(`Trusted runtime installed at ${store} from ${sha.slice(0, 12)}.`);
  console.log("Privileged steps must be invoked from that path, not from the workspace.");
  process.exit(0);
} else if (args.includes("--verify")) {
  const store = storeRoot();
  const manifestPath = path.join(store, MANIFEST);

  if (!fs.existsSync(manifestPath)) {
    console.error(
      `No trusted runtime at ${store}. Refusing to continue: without it there is no copy of the ` +
      "deterministic steps that the model provably could not reach."
    );
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const current = headSha();
  if (manifest.headSha !== current) {
    console.error(
      `HEAD moved since the trusted runtime was installed ` +
      `(${String(manifest.headSha).slice(0, 12)} -> ${current.slice(0, 12)}). ` +
      "The trusted copy describes a different commit than the one about to be operated on."
    );
    process.exit(1);
  }

  /*
   * Self-check: this file is running FROM the store when invoked correctly. If
   * it is running from the workspace, the workflow is calling the untrusted
   * copy and the whole boundary is nominal.
   */
  const self = fs.realpathSync(fileURLToPath(import.meta.url));
  const inStore = self.startsWith(fs.realpathSync(store));
  if (!inStore) {
    console.error(
      `--verify was invoked from ${self}, which is inside the model-writable workspace. ` +
      "Invoke the copy under the trusted store instead; a guard that runs from the location it " +
      "guards proves nothing."
    );
    process.exit(1);
  }

  console.log(`Trusted runtime verified at ${store} for ${current.slice(0, 12)}.`);
  process.exit(0);
} else if (args.includes("--path")) {
  console.log(storeRoot());
  process.exit(0);
} else {
  console.error("Usage: trusted-runtime.mjs --install | --verify | --path");
  process.exit(1);
}
