#!/usr/bin/env node
/* -------------------------------------------------------------------------
 * Lay out the packaged sidecar (PW-0102).
 *
 * Produces exactly the tree `src-tauri/src/sidecar.rs` expects and
 * `tauri.conf.json` declares under `bundle.resources`:
 *
 *     sidecar/node.exe          the Node runtime that runs the server
 *     sidecar/server/server.js  the Next standalone entry point
 *     sidecar/server/.next/     the chunks the server reads at runtime
 *
 * A SCRIPT RATHER THAN A README INSTRUCTION, because the layout is a contract
 * between three files -- this one, the Rust constants and the Tauri config --
 * and a contract maintained by hand across three languages is one that drifts.
 * The constants are asserted against each other at the bottom.
 *
 * IT DOES NOT DOWNLOAD A NODE RUNTIME. `node.exe` is a platform binary and
 * which one ships is a release decision with a supply-chain answer attached:
 * a pinned version, a checksum, and a place it came from. Inventing that here
 * would be choosing it by accident. The script takes a path to one and refuses
 * without it, and PW-0501 -- which owns the Windows CI job -- is where the
 * runner supplies it.
 * ---------------------------------------------------------------------- */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, "..");
const repoRoot = resolve(desktop, "..", "..");
const sidecarDir = join(desktop, "sidecar");

/** Where the web application lives in this workspace, relative to the root. */
const WEB_WORKSPACE = join("apps", "web");

/** Must equal `NODE_RELATIVE_PATH` / `SERVER_RELATIVE_PATH` in `src/sidecar.rs`. */
const NODE_RELATIVE = "node.exe";
const SERVER_RELATIVE = join("server", "server.js");

function fail(message) {
  console.error(`package-sidecar: ${message}`);
  process.exit(1);
}

/**
 * Read a string constant out of a source file this script must agree with.
 *
 * THE TECHNIQUE THIS FILE ALREADY USES for the Rust constants at the bottom,
 * lifted to the top so the INPUT layout is derived the same way the OUTPUT
 * layout is verified. A regex over source is crude and it is the right crude:
 * this is a `.mjs` module and the two files it must agree with are Rust and
 * TypeScript, neither of which it can import.
 */
function constantFrom(file, label, name) {
  let source;
  try {
    source = readFileSync(file, "utf8");
  } catch (error) {
    fail(`${label} could not be read at ${file}: ${error.code ?? error.message}`);
  }
  const found = new RegExp(`${name}\\s*=\\s*"([^"]+)"`).exec(source)?.[1];
  if (!found) {
    fail(
      `${label} no longer declares ${name} as a string literal, so this script cannot derive ` +
        `the value it must agree with. Do not guess it here: one of the two files has to be ` +
        `the source, and it is that one.`
    );
  }
  return found;
}

/*
 * WHERE THE DESKTOP BUILD PUTS ITS OUTPUT, DERIVED RATHER THAN RESTATED.
 *
 * THE DEFECT THIS REPLACES FAILED THE FIRST WINDOWS RUN THIS PROJECT EVER DID
 * (run 36635212507, head 72e844d). This script read its input from
 * `apps/web/.next/standalone`. The desktop build does not write there:
 * `next.config.ts` applies `distDirFor(target)` and `build-target.ts` sets
 * `DESKTOP_DIST_DIR = "dist/desktop"`, so the tree lands at
 * `apps/web/dist/desktop/standalone`. Two files named one location and they
 * disagreed.
 *
 * The header of this file already says why that is the defect -- "a contract
 * maintained by hand across three languages is one that drifts" -- and the
 * bottom of this file already verifies the OUTPUT layout against `sidecar.rs`
 * for exactly that reason. The guard existed on one side and not the other,
 * and the unguarded side is the one that broke. Now both sides derive.
 */
const DESKTOP_DIST_DIR = constantFrom(
  join(repoRoot, WEB_WORKSPACE, "src", "app", "api", "v1", "playback", "build-target.ts"),
  "build-target.ts",
  "DESKTOP_DIST_DIR"
);

const nodeBinary = process.env.LIBERTY_SIDECAR_NODE;
if (!nodeBinary) {
  fail(
    "set LIBERTY_SIDECAR_NODE to the node.exe that should ship with the application. " +
      "It is deliberately not downloaded here: which runtime ships is a release decision " +
      "that needs a pinned version and a checksum, and picking one in a build script " +
      "chooses it by accident."
  );
}
if (!existsSync(nodeBinary)) fail(`LIBERTY_SIDECAR_NODE does not exist: ${nodeBinary}`);

/*
 * The standalone tree is produced by `next build` with `output: "standalone"`,
 * which `apps/web/next.config.ts` sets when LIBERTY_BUILD_TARGET is desktop.
 * This script consumes that output; it does not run the build, because a
 * packaging step that silently rebuilds is one that can ship something other
 * than what was tested.
 */
const buildOutput = join(repoRoot, WEB_WORKSPACE, DESKTOP_DIST_DIR);
const standalone = join(buildOutput, "standalone");
if (!existsSync(standalone)) {
  fail(
    `no standalone build at ${standalone}. Run the desktop build first ` +
      `(npm run build:desktop -w @liberty/web), which is what sets output: "standalone" ` +
      `and sends it to ${DESKTOP_DIST_DIR}.`
  );
}

/*
 * A DIRECTORY THAT EXISTS AND IS EMPTY IS NOT A BUILD, and this check is here
 * because its absence cost a round. A stale empty `standalone/` in a working
 * tree satisfies `existsSync`, so a local rehearsal passed against a directory
 * containing nothing while a clean CI checkout failed -- the rehearsal
 * measured its own leftovers. Emptiness is cheap to rule out and the only
 * thing that made the earlier check a lie.
 */
if (readdirSync(standalone).length === 0) {
  fail(
    `the standalone build at ${standalone} is EMPTY. A leftover directory is not a build; ` +
      `run npm run build:desktop -w @liberty/web.`
  );
}

/*
 * THE MONOREPO SHAPE, WHICH IS NOT THE SHAPE THE DOCUMENTATION PICTURES.
 *
 * Next emits a standalone tree that preserves the workspace layout, so the
 * entry point is at `standalone/apps/web/server.js` with `standalone/
 * node_modules` ONE LEVEL UP -- Node resolves upward from `__dirname`, which
 * is what makes that work. The server also `chdir`s to its own directory and
 * carries `distDir: "./dist/desktop"` in its inlined config, so it reads its
 * chunks from `<its own dir>/dist/desktop`.
 *
 * `sidecar.rs` wants the entry at `sidecar/server/server.js`. So the app
 * directory is FLATTENED into `server/` and the shared `node_modules` is
 * placed beside it, which reproduces the resolution the server was built for.
 */
const standaloneApp = join(standalone, WEB_WORKSPACE);
if (!existsSync(join(standaloneApp, "server.js"))) {
  fail(
    `no server.js at ${join(standaloneApp, "server.js")}. Next emits the standalone entry ` +
      `under the workspace path it was built from; if that has changed, this script's ` +
      `WEB_WORKSPACE has to change with it.`
  );
}
const standaloneModules = join(standalone, "node_modules");

/*
 * `static` IS NOT PART OF THE STANDALONE OUTPUT and has to be copied beside
 * it. This is the single most common way a standalone Next deployment ships
 * and then serves a page with no CSS and no client bundle -- Next's own
 * documentation says so and it is still the classic mistake.
 */
const staticDir = join(buildOutput, "static");
if (!existsSync(staticDir)) fail(`no static assets at ${staticDir}`);

/*
 * THE TWO TRACKED FILES SURVIVE THE WIPE (PW-0501 corrective).
 *
 * THE DEFECT THIS REPLACES, and it was live: the directory was removed whole
 * and the two files were then restored from `../sidecar-template/`, a
 * directory that does not exist -- guarded by `existsSync`, so the restore
 * silently did nothing. Running the packaging script therefore DELETED two
 * TRACKED files, `sidecar/.gitignore` and `sidecar/README.md`, and left the
 * working tree dirty with two deletions nobody asked for. The same class of
 * defect PW-0104 exists for, arriving through a different door.
 *
 * WHY THOSE TWO ARE TRACKED AT ALL, which is what makes deleting them
 * expensive rather than untidy: `tauri-build` validates `bundle.resources` at
 * build time and FAILS when a declared path is absent, and git does not carry
 * empty directories. The two files are what keep `sidecar/` present in a fresh
 * clone, so `cargo check` does not depend on whether somebody has run this
 * script first. `sidecar/README.md` says so in its own words.
 *
 * SO THE WIPE IS NOW SELECTIVE rather than the directory being recreated from
 * a template that never existed. One source for those files -- the tracked
 * ones -- instead of two copies to keep in step.
 */
const PRESERVED = [".gitignore", "README.md"];

if (existsSync(sidecarDir)) {
  for (const entry of readdirSync(sidecarDir)) {
    if (PRESERVED.includes(entry)) continue;
    rmSync(join(sidecarDir, entry), { recursive: true, force: true, maxRetries: 5 });
  }
}
mkdirSync(join(sidecarDir, "server"), { recursive: true });

const serverDir = join(sidecarDir, "server");

/* The app directory, flattened: `standalone/apps/web/*` -> `server/*`. */
cpSync(standaloneApp, serverDir, { recursive: true });

/* And the shared dependencies it resolves upward to, brought down beside it. */
if (existsSync(standaloneModules)) {
  cpSync(standaloneModules, join(serverDir, "node_modules"), { recursive: true });
}

/*
 * INTO `<distDir>/static`, WHICH IS WHERE THE SERVER LOOKS. The inlined config
 * in `server.js` names the distDir and the server chdirs to its own directory,
 * so this path is a consequence of the build rather than a convention -- and
 * it is derived from the same constant the input path is.
 */
cpSync(staticDir, join(serverDir, DESKTOP_DIST_DIR, "static"), { recursive: true });
cpSync(nodeBinary, join(sidecarDir, NODE_RELATIVE));

/*
 * ASSERTED RATHER THAN RESTORED. They were never removed above, so this is a
 * check that the selective wipe stayed selective -- the failure mode it
 * replaces was silent, and a guard that only runs when something has already
 * gone wrong is the one worth having.
 */
for (const kept of PRESERVED) {
  if (!existsSync(join(sidecarDir, kept))) {
    fail(
      `packaging removed the tracked file sidecar/${kept}. It is tracked so that git carries ` +
        `the directory into a fresh clone, which is what lets tauri-build validate ` +
        `bundle.resources without this script having been run first.`
    );
  }
}

/*
 * THE LAYOUT IS VERIFIED AGAINST THE RUST CONSTANTS, not merely produced. If
 * `sidecar.rs` is edited and this script is not, the build fails here rather
 * than at first launch on a user's machine with a window that never loads.
 */
const rust = readFileSync(join(desktop, "src-tauri", "src", "sidecar.rs"), "utf8");
const expect = (constant, value) => {
  const pattern = new RegExp(`${constant}: &str = "([^"]+)"`);
  const found = pattern.exec(rust)?.[1];
  if (found !== value) {
    fail(
      `${constant} in src/sidecar.rs is ${JSON.stringify(found)} but this script produces ` +
        `${JSON.stringify(value)}; the shell would look for the sidecar where it is not`
    );
  }
};
expect("NODE_RELATIVE_PATH", `sidecar/${NODE_RELATIVE}`);
expect("SERVER_RELATIVE_PATH", `sidecar/${SERVER_RELATIVE.split("\\").join("/")}`);

for (const required of [
  NODE_RELATIVE,
  SERVER_RELATIVE,
  /*
   * THE CHUNKS AND THE CLIENT BUNDLE, checked because their absence is SILENT.
   * A missing `server.js` is a sidecar that will not start, which the shell
   * reports. A missing static tree is a server that starts, answers, and
   * renders every page with no CSS and no client JavaScript -- and the first
   * person to see that is whoever installed the application.
   */
  join("server", DESKTOP_DIST_DIR, "static"),
  join("server", "node_modules")
]) {
  const path = join(sidecarDir, required);
  if (!existsSync(path)) fail(`packaging produced no ${required} at ${path}`);
}

console.log(`package-sidecar: laid out ${sidecarDir}`);
