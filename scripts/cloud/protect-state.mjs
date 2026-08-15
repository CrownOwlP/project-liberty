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

const root = process.cwd();
const args = process.argv.slice(2);

/** State that only deterministic steps may change. */
export const PROTECTED_PATHS = [
  "control",
  "coordination/agent-bus",
  "coordination/PROJECT_STATUS.md",
  "coordination/TASKS.md",
];

const store = path.join(
  process.env.RUNNER_TEMP || os.tmpdir(),
  "liberty-protected-state",
);

function copyInto(from, to) {
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
}

if (args.includes("--snapshot")) {
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
}

if (args.includes("--restore")) {
  if (!fs.existsSync(path.join(store, ".manifest.json"))) {
    console.error(
      `No protected-state snapshot at ${store}. Refusing to continue: without it, ` +
      "model edits to control/bus state cannot be distinguished from deterministic ones.",
    );
    process.exit(1);
  }

  let reverted = 0;
  for (const rel of PROTECTED_PATHS) {
    const saved = path.join(store, rel);
    const live = path.join(root, rel);
    if (!fs.existsSync(saved)) continue;

    const before = fs.existsSync(live) ? JSON.stringify(fs.statSync(live).mtimeMs) : null;
    fs.rmSync(live, { recursive: true, force: true });
    copyInto(saved, live);
    if (before !== null) reverted++;
  }
  console.log(`Protected state restored from ${store} (${reverted} path(s)).`);
  console.log("Any model edits to control/bus state have been discarded, as intended.");
  process.exit(0);
}

console.error("Usage: protect-state.mjs --snapshot | --restore");
process.exit(1);
