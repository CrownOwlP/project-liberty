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

/** Must equal `NODE_RELATIVE_PATH` / `SERVER_RELATIVE_PATH` in `src/sidecar.rs`. */
const NODE_RELATIVE = "node.exe";
const SERVER_RELATIVE = join("server", "server.js");

function fail(message) {
  console.error(`package-sidecar: ${message}`);
  process.exit(1);
}

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
const standalone = join(repoRoot, "apps", "web", ".next", "standalone");
if (!existsSync(standalone)) {
  fail(
    `no standalone build at ${standalone}. Run the desktop build first ` +
      `(npm run build:desktop -w @liberty/web), which is what sets output: "standalone".`
  );
}
const staticDir = join(repoRoot, "apps", "web", ".next", "static");
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

cpSync(standalone, join(sidecarDir, "server"), { recursive: true });
/*
 * `.next/static` is NOT part of the standalone output and has to be copied
 * beside it -- this is the single most common way a standalone Next deployment
 * ships and then serves a page with no CSS and no client bundle. Next's own
 * documentation says so and it is still the classic mistake, which is why it is
 * done here rather than left to whoever runs the build.
 */
cpSync(staticDir, join(sidecarDir, "server", ".next", "static"), { recursive: true });
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

for (const required of [NODE_RELATIVE, SERVER_RELATIVE]) {
  const path = join(sidecarDir, required);
  if (!existsSync(path)) fail(`packaging produced no ${required} at ${path}`);
}

console.log(`package-sidecar: laid out ${sidecarDir}`);
