#!/usr/bin/env node
/* -------------------------------------------------------------------------
 * What the installer actually put on the machine (PW-0107).
 *
 * WHY THIS IS A SCRIPT AND NOT FOUR MORE LINES OF POWERSHELL.
 *
 * The workflow used to assert, inline, that `sidecar\server\server.js` existed
 * under Program Files. That was true and it stopped meaning anything the day
 * PW-0106 landed: `server.js` is Next's generated entry, it is still SHIPPED as
 * build output, and it is NEVER SPAWNED. The shell starts
 * `sidecar\server\liberty-sidecar.js`. So the one check that connects "packaging
 * produced a runnable tree" to "the installer delivered one" was proving the
 * installer carried a file nothing runs, and would have passed with the real
 * entry point missing.
 *
 * It drifted because the path was WRITTEN DOWN IN A THIRD PLACE. The same fact
 * already lives in `apps/desktop/src-tauri/src/sidecar.rs`, which is what the
 * shell reads, and in `apps/desktop/scripts/package-sidecar.mjs`, which asserts
 * its own output against those Rust constants by regex and fails when they
 * disagree. The workflow had a copy and no guard. This repository has now been
 * bitten by that shape three times in four rounds -- `.next/standalone` versus
 * `dist/desktop/standalone` in round 95, a hard-coded `"server.js"` in a Rust
 * test in round 98, and this.
 *
 * So this script DERIVES the paths it checks from `sidecar.rs`. If someone
 * renames the entry again, the Rust constant moves and this moves with it; if
 * the constant stops being a string literal, this fails loudly rather than
 * checking nothing. gpt-architect's round-99 ruling asks for exactly that:
 * verification that "derives from or is mechanically checked against the
 * authoritative runtime path contract rather than manually duplicating it".
 *
 * WHAT IT DOES NOT DO, and the boundary is the ruling's: it does not launch
 * anything. Installed runtime qualification -- the shell starting the child,
 * the handshake, a window rendering -- is PW-0503 and the commander's machine.
 * This answers one question only: did the MSI carry the files the shell will
 * reach for.
 *
 *     node scripts/windows/verify-install.mjs "<install root>"
 *
 * Exit 0 if every required path is present, 1 with a named list if not.
 * ---------------------------------------------------------------------- */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const SIDECAR_RS = join(repoRoot, "apps", "desktop", "src-tauri", "src", "sidecar.rs");

function fail(message) {
  console.error(`verify-install: ${message}`);
  process.exit(1);
}

/**
 * A `pub const NAME: &str = "value";` out of the Rust that the shell compiles.
 *
 * The same technique `package-sidecar.mjs` uses, and for the same reason: this
 * is a `.mjs` module and the file it must agree with is Rust, which it cannot
 * import. A regex over source is crude and it is the right crude -- the
 * alternative is a fourth copy of the path.
 */
function rustConstant(source, name) {
  const found = new RegExp(`${name}\\s*:\\s*&str\\s*=\\s*"([^"]+)"`).exec(source)?.[1];
  if (!found) {
    fail(
      `apps/desktop/src-tauri/src/sidecar.rs no longer declares ${name} as a string literal, so ` +
        `this check cannot derive the path the shell will actually use. Do not hard-code it here: ` +
        `the Rust constant is the contract, and a copy of it is how this check drifted before.`
    );
  }
  return found;
}

const root = process.argv[2];
if (!root) fail('usage: node scripts/windows/verify-install.mjs "<install root>"');
if (!existsSync(root)) fail(`the install root does not exist: ${root}`);

let rust;
try {
  rust = readFileSync(SIDECAR_RS, "utf8");
} catch (error) {
  fail(`could not read ${SIDECAR_RS}: ${error.code ?? error.message}`);
}

/* The two the shell resolves against its resource directory, verbatim. */
const serverRelative = rustConstant(rust, "SERVER_RELATIVE_PATH");
const nodeRelative = rustConstant(rust, "NODE_RELATIVE_PATH");

if (!serverRelative.endsWith(".js")) {
  fail(`SERVER_RELATIVE_PATH is ${JSON.stringify(serverRelative)}, which is not a script path`);
}

/** Rust writes these with forward slashes; Windows takes either, `join` normalises. */
const fromRelative = (relative) => join(root, ...relative.split("/"));

const required = [
  {
    path: join(root, "liberty-desktop.exe"),
    why: "the shell itself; without it the installer ran and installed nothing"
  },
  {
    path: fromRelative(nodeRelative),
    why: `the Node runtime the shell spawns, from NODE_RELATIVE_PATH (${nodeRelative})`
  },
  {
    path: fromRelative(serverRelative),
    why:
      `THE ENTRY POINT THE SHELL ACTUALLY SPAWNS, from SERVER_RELATIVE_PATH ` +
      `(${serverRelative}). This is the check the workflow used to be missing.`
  },
  {
    path: join(dirname(fromRelative(serverRelative)), "liberty-sidecar-layout.json"),
    why:
      "the layout file the bootstrap reads to find the build; without it the sidecar exits " +
      "before it binds, with a diagnostic no user can act on"
  }
];

const missing = [];
for (const entry of required) {
  if (existsSync(entry.path)) {
    console.log(`present: ${entry.path}`);
  } else {
    missing.push(entry);
  }
}

/*
 * THE STATIC TREE, CHECKED BY SHAPE RATHER THAN BY PATH. Its location is
 * `<server>/<distDir>/static`, and `distDir` is a build fact this script has no
 * authoritative source for on an installed machine -- `build-target.ts` is
 * TypeScript and is not shipped. Its absence is the silent failure Next
 * deployments are famous for: the server starts, answers, and renders every
 * page with no CSS and no client bundle. So it is looked for rather than
 * located, and a miss is reported as a miss.
 */
const serverDir = dirname(fromRelative(serverRelative));
let staticTree = null;
const findStatic = (dir, depth) => {
  if (staticTree || depth > 3) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (staticTree) return;
    if (!entry.isDirectory()) continue;
    if (entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.name === "static" && depth > 0) {
      staticTree = full;
      return;
    }
    findStatic(full, depth + 1);
  }
};
findStatic(serverDir, 0);
if (staticTree && statSync(staticTree).isDirectory() && readdirSync(staticTree).length > 0) {
  console.log(`present: ${staticTree} (client assets)`);
} else {
  missing.push({
    path: join(serverDir, "<distDir>", "static"),
    why:
      "the client asset tree. Its absence does not stop the server starting -- it makes every " +
      "page render with no CSS and no client JavaScript, and the first person to see that is " +
      "whoever installed the application"
  });
}

/*
 * NEXT'S OWN ENTRY IS REPORTED, NOT REQUIRED, and the distinction is the whole
 * point of this task. It is shipped as build output; it is not what runs.
 * gpt-architect: the workflow "may also assert `server.js` exists as packaged
 * Next build output, but that must not be mistaken for the spawned runtime
 * entry."
 */
const generatedEntry = join(serverDir, "server.js");
console.log(
  existsSync(generatedEntry)
    ? `present (build output, NOT the spawned entry): ${generatedEntry}`
    : `absent (build output only, not required): ${generatedEntry}`
);

if (missing.length > 0) {
  console.error(`\nverify-install: the installed tree is missing ${missing.length} required path(s):`);
  for (const entry of missing) console.error(`  - ${entry.path}\n      ${entry.why}`);
  console.error(
    `\nThese paths are DERIVED from apps/desktop/src-tauri/src/sidecar.rs, which is what the ` +
      `shell reads at runtime. A miss here means the MSI did not carry what the shell will look for.`
  );
  process.exit(1);
}

console.log("\nverify-install: the installed tree carries everything the shell resolves.");
