#!/usr/bin/env node
/**
 * Filesystem enforcement of the model's mutation boundary.
 *
 * Removing mutating CLI subcommands is not sufficient: the model still holds
 * Edit and Write, so it could rewrite control/tasks.json directly and the
 * finalizer would later stage that rewrite as a legitimate "control-plane
 * output". A prompt asking it not to is documentation, not a boundary.
 *
 * So the protected control/bus state is snapshotted OUTSIDE the workspace
 * before the model runs and restored byte-for-byte afterwards. Anything the
 * model wrote there is discarded before any deterministic step reads it.
 *
 *   node scripts/cloud/protect-state.mjs --snapshot
 *   node scripts/cloud/protect-state.mjs --restore
 *
 * Snapshot location: $RUNNER_TEMP (or the OS temp dir), never the repository.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = process.cwd();
const args = process.argv.slice(2);

/**
 * Runtime state carried in $RUNNER_TEMP.
 *
 * These paths hold state produced by DETERMINISTIC steps before the model ran
 * (claim/start, queues, journal), so they cannot be recovered from HEAD -- the
 * committed version predates those mutations. They must be snapshotted.
 *
 * MUST stay a superset of everything `stage-task-changes.mjs` will commit in
 * control mode. A path that control mode may commit but this does not protect
 * is a path where a model edit survives and is later committed as deterministic
 * state -- so the two lists are derived from one shared source.
 */
// Local binding AND re-export. `export { X as Y } from "..."` would forward the
// name to importers without defining it in this module's scope.
import { CONTROL_OUTPUT_PATHS } from "./control-paths.mjs";
export const PROTECTED_PATHS = CONTROL_OUTPUT_PATHS;

/**
 * Executable code the model must never be able to substitute.
 *
 * Restored from HEAD rather than a snapshot: git is already an immutable
 * trusted copy the model cannot alter, because it can edit the working tree but
 * cannot commit. `select-task.mjs` refuses any task owning these paths, so a
 * legitimate model edit here never exists.
 */
export const TRUSTED_RUNTIME_PATHS = ["scripts", ".github"];

const store = path.join(
  process.env.RUNNER_TEMP || os.tmpdir(),
  "liberty-protected-state",
);

function copyInto(from, to) {
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
}

/**
 * This module both exports PROTECTED_PATHS and provides a CLI. Without this
 * guard, importing it to read that constant would execute the CLI, fall through
 * to the usage branch and process.exit(1) the importing process.
 */
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
} else if (args.includes("--snapshot")) {
  fs.rmSync(store, { recursive: true, force: true });
  fs.mkdirSync(store, { recursive: true });
  for (const rel of PROTECTED_PATHS) {
    copyInto(path.join(root, rel), path.join(store, rel));
  }
  fs.writeFileSync(
    path.join(store, ".manifest.json"),
    JSON.stringify({ takenAt: new Date().toISOString(), paths: PROTECTED_PATHS }, null, 2) + "\n",
  );
  console.log(`Protected state snapshotted to ${store}`);
  console.log(PROTECTED_PATHS.map((p) => `  ${p}`).join("\n"));
  process.exit(0);
} else if (args.includes("--restore")) {
  if (!fs.existsSync(path.join(store, ".manifest.json"))) {
    console.error(
      `No protected-state snapshot at ${store}. Refusing to continue: without it, ` +
      "model edits to control/bus state cannot be distinguished from deterministic ones.",
    );
    process.exit(1);
  }

  /*
   * FIRST: restore the executable runtime from HEAD.
   *
   * This must happen before anything else, because every step that follows --
   * including this guard's own siblings and the finalizer that holds GH_TOKEN --
   * is executed FROM the workspace. A model that rewrote finalize-task.mjs or
   * stage-task-changes.mjs would otherwise have its version run with push
   * credentials in scope.
   *
   * git is the immutable copy: the model can write the working tree but cannot
   * commit, so HEAD is authoritative and needs no separate snapshot.
   */
  const restoredRuntime = [];
  for (const rel of TRUSTED_RUNTIME_PATHS) {
    if (!fs.existsSync(path.join(root, rel))) continue;
    try {
      const changed = execFileSync("git", ["status", "--porcelain", "--", rel], {
        cwd: root, encoding: "utf8",
      }).trim();
      if (changed) restoredRuntime.push(...changed.split("\n").map((l) => l.trim()));
      // Tracked files back to HEAD; untracked additions removed outright.
      execFileSync("git", ["checkout", "HEAD", "--", rel], { cwd: root, stdio: "ignore" });
      execFileSync("git", ["clean", "-fd", "--", rel], { cwd: root, stdio: "ignore" });
    } catch (error) {
      console.error(`Could not restore trusted runtime path ${rel}: ${error.message}`);
      console.error("Refusing to continue: privileged steps would run model-writable code.");
      process.exit(1);
    }
  }
  if (restoredRuntime.length) {
    console.error(`REVERTED ${restoredRuntime.length} unauthorized edit(s) to trusted runtime code:`);
    for (const line of restoredRuntime) console.error(`  ! ${line}`);
    console.error("Privileged steps will run the committed versions, not these.");
  } else {
    console.log("Trusted runtime clean; no unauthorized edits to scripts/ or .github/.");
  }

  // SECOND: restore deterministic control/bus state from the snapshot.
  let reverted = 0;
  for (const rel of PROTECTED_PATHS) {
    const saved = path.join(store, rel);
    const live = path.join(root, rel);
    if (!fs.existsSync(saved)) continue;

    const existed = fs.existsSync(live);
    fs.rmSync(live, { recursive: true, force: true });
    copyInto(saved, live);
    if (existed) reverted++;
  }
  console.log(`Protected control state restored from ${store} (${reverted} path(s)).`);
  console.log("Any model edits to control/bus state have been discarded, as intended.");
  process.exit(0);
} else {
  console.error("Usage: protect-state.mjs --snapshot | --restore");
  process.exit(1);
}
