#!/usr/bin/env node
/* -------------------------------------------------------------------------
 * Lay out the packaged sidecar (PW-0102).
 *
 * Produces exactly the tree `src-tauri/src/sidecar.rs` expects and
 * `tauri.conf.json` declares under `bundle.resources`:
 *
 *     sidecar/node.exe                   the Node runtime that runs the server
 *     sidecar/server/liberty-sidecar.js  OUR entry point (PW-0106)
 *     sidecar/server/server.js           Next's own entry, shipped, not spawned
 *     sidecar/server/<distDir>/          the chunks the server reads at runtime
 *
 * THE ENTRY POINT IS OURS AND NEXT'S IS NOT SPAWNED (PW-0106). Next's
 * generated `server.js` resolves its port as `parseInt(process.env.PORT, 10)
 * || 3000`, so `PORT=0` binds 3000 with `allowRetry: false` -- a first-run
 * failure on any machine already using that port. `liberty-sidecar.js` owns
 * the listener instead and lets the kernel choose. Next's entry is still
 * copied because it is part of the build output and removing build output is
 * its own risk; nothing spawns it, and the assertions at the bottom fail if
 * `sidecar.rs` ever points back at it.
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
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
const SERVER_RELATIVE = join("server", "liberty-sidecar.js");

/** The checked-in bootstrap this script lays down, and the file it derives. */
const BOOTSTRAP_SOURCE = join("sidecar-bootstrap", "liberty-sidecar.js");
const LAYOUT_RELATIVE = join("server", "liberty-sidecar-layout.json");

/** Next's own entry, which is shipped as build output and never spawned. */
const NEXT_ENTRY = "server.js";

function fail(message) {
  console.error(`package-sidecar: ${message}`);
  process.exit(1);
}

/**
 * THE ONE PRIVATE NEXT API THIS PRODUCT DEPENDS ON, CHECKED AGAINST THE COPY
 * THAT WILL ACTUALLY SHIP.
 *
 * `liberty-sidecar.js` delivers the resolved build config through
 * `__NEXT_PRIVATE_STANDALONE_CONFIG`, because that is the ONLY channel Next
 * has for it -- `next({ conf })` is ignored on the custom-server path, and
 * `startServer`'s own `config` option is destructured away and never reaches
 * `getRequestHandlers` either. Next's build writes the same assignment into
 * the standalone entry it generates (`dist/build/utils.js`), so a standalone
 * deployment that did not set it would not work at all.
 *
 * WHAT THIS GUARD BUYS. If a future Next removes or renames the variable, the
 * runtime failure is `loadConfig` silently falling back to defaults --
 * `distDir` becomes `.next`, and the server looks for a build that is not
 * there. That is a failure on a user's machine, discovered after shipping.
 * Checking the SHIPPED copy of `next/dist/server/config.js` moves it to
 * packaging time, where it costs a red build instead of a broken install.
 *
 * It is a substring check over a minified-ish dist file, which is crude. It is
 * also exact about the thing that matters -- whether the consumer still names
 * the variable -- and it runs against the bytes being packaged rather than
 * against whatever is installed at the repository root.
 */
function assertStandaloneConfigChannelStillExists(serverRoot) {
  const consumer = join(serverRoot, "node_modules", "next", "dist", "server", "config.js");
  if (!existsSync(consumer)) {
    fail(
      `no ${consumer}. The packaged tree must carry Next's own server config loader; ` +
        `without it the sidecar cannot resolve the build it ships with.`
    );
  }
  if (!readFileSync(consumer, "utf8").includes("__NEXT_PRIVATE_STANDALONE_CONFIG")) {
    const version = (() => {
      try {
        return JSON.parse(
          readFileSync(join(serverRoot, "node_modules", "next", "package.json"), "utf8")
        ).version;
      } catch {
        return "unknown";
      }
    })();
    fail(
      `next@${version} no longer reads __NEXT_PRIVATE_STANDALONE_CONFIG in ` +
        `dist/server/config.js. That variable is how the packaged sidecar hands Next its ` +
        `RESOLVED build config, and it is the only channel that exists: next({ conf }) is ` +
        `ignored on the custom-server path and startServer's config option never reaches ` +
        `getRequestHandlers. Without it the server falls back to defaults, looks for a build ` +
        `in .next, and fails on a user's machine rather than here. Re-do the dependency-risk ` +
        `analysis recorded for PW-0106 against this version before shipping.`
    );
  }
}

/**
 * THE REGRESSION GUARD FOR THE DEFECT PW-0106 EXISTS TO REMOVE.
 *
 * `PORT=0` silently becoming 3000 is not a behaviour anyone would write on
 * purpose; it is what you get by deferring to `process.env.PORT` in a
 * codebase where `parseInt("0", 10) || 3000` is one expression away. So the
 * property asserted here is the SHAPE of the entry point, checked at
 * packaging time against the file that will actually ship:
 *
 *   - it binds a literal 0, through the named constant, so the kernel chooses;
 *   - it never reads `process.env.PORT` at all.
 *
 * Checked over source with comments stripped, the same technique and the same
 * reasoning as `policy.test.ts`'s build-target guard: the prose above the
 * subject has to be able to DISCUSS the variable it refuses to read, or the
 * guard teaches the next reader to delete the explanation.
 *
 * A source-shape assertion is coarse. It is also the only check that runs on
 * the artifact being shipped rather than on a copy of it, and the failure it
 * prevents -- an installed application that will not start on a machine using
 * port 3000 -- is one nobody sees until it is on somebody's PC.
 */
function assertBootstrapStillOwnsThePort(file) {
  const raw = readFileSync(file, "utf8");
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  if (!/const KERNEL_CHOOSES_THE_PORT = 0;/.test(code)) {
    fail(
      `${file} no longer declares KERNEL_CHOOSES_THE_PORT = 0. The sidecar must bind a ` +
        `literal 0 so the kernel selects the port; see PW-0106.`
    );
  }
  if (!/server\.listen\(KERNEL_CHOOSES_THE_PORT, BIND_HOST/.test(code)) {
    fail(
      `${file} no longer calls server.listen(KERNEL_CHOOSES_THE_PORT, BIND_HOST, ...). ` +
        `The bind is the whole of PW-0106 and it must not be parameterised.`
    );
  }
  if (/process\.env\.PORT|process\.env\[["']PORT["']\]/.test(code)) {
    fail(
      `${file} reads process.env.PORT. IT MUST NOT: Next's generated entry resolves the port ` +
        `as parseInt(process.env.PORT, 10) || 3000, which turns the PORT=0 launch contract ` +
        `into "bind 3000 and fail if it is taken". That is the defect PW-0106 removed, and ` +
        `reading the variable again is how it comes back.`
    );
  }
  /* Non-vacuity: the comment stripper must not be eating the whole file. */
  if (!/function main\(\)/.test(code)) {
    fail(`${file} could not be checked: the stripped source contains no main()`);
  }
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
/* Checked as a SHAPE assertion, not because this file is the entry any more:
 * its presence is how we know Next emitted the tree under the workspace path
 * this script flattens. PW-0106 spawns `liberty-sidecar.js` instead. */
if (!existsSync(join(standaloneApp, NEXT_ENTRY))) {
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
 * OUR ENTRY POINT, AND THE ONE FACT IT CANNOT WORK OUT FOR ITSELF (PW-0106).
 *
 * `liberty-sidecar.js` is CHECKED IN -- it is not generated here, and nothing
 * in it is templated. What it cannot know on a user's PC is which directory
 * the build wrote to, because that is `DESKTOP_DIST_DIR` in `build-target.ts`
 * and the packaged tree carries no TypeScript. So this script, which has
 * already derived that constant from its one source, writes it down beside
 * the entry. One source, three readers, no restatement -- the round-95 lesson
 * applied to a third file rather than relearned by it.
 */
const bootstrapSource = join(desktop, BOOTSTRAP_SOURCE);
if (!existsSync(bootstrapSource)) {
  fail(
    `no bootstrap at ${bootstrapSource}. It is a tracked source file, not build output; ` +
      `a checkout missing it cannot produce a runnable sidecar.`
  );
}
assertBootstrapStillOwnsThePort(bootstrapSource);
assertStandaloneConfigChannelStillExists(serverDir);
cpSync(bootstrapSource, join(sidecarDir, SERVER_RELATIVE));
writeFileSync(
  join(sidecarDir, LAYOUT_RELATIVE),
  `${JSON.stringify({ distDir: DESKTOP_DIST_DIR }, null, 2)}\n`
);

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
  LAYOUT_RELATIVE,
  /*
   * Next's own entry, checked for PRESENCE and nothing else. It is build
   * output and it is not spawned; the assertion above that SERVER_RELATIVE_PATH
   * names `liberty-sidecar.js` is what keeps it that way.
   */
  join("server", NEXT_ENTRY),
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

/*
 * THE THIRD-PARTY NOTICES, GENERATED FROM THE TREE THAT WAS JUST LAID OUT
 * (PW-0208).
 *
 * HERE RATHER THAN IN THE WORKFLOW, for the reason this file exists at all:
 * the thing that knows what was packaged is the thing that packaged it. A
 * step in `.github/workflows/windows.yml` would be a second place that has
 * to agree about the layout, and this repository has been bitten three times
 * in four rounds by exactly that -- `verify-install.mjs`'s header lists them.
 *
 * AFTER the assertions above, so the notices describe a tree that passed
 * them, and it writes INTO `sidecarDir`, which `tauri.conf.json` already
 * carries wholesale as a bundle resource -- so the obligation reaches the
 * installed machine with no packaging-configuration change. `docs/LICENSING.md`
 * §7: it has to be satisfied by something the user receives, not by a file in
 * a repository.
 *
 * NOT FATAL. `collect-notices.mjs --strict` exits non-zero when a shipped
 * package neither declares a licence nor carries one; it is not passed here,
 * deliberately, because arming that gate from a Linux session would be
 * deciding that a Windows packaging job should start failing on a list
 * nobody has read yet. The list is printed and written into the document;
 * arming it is the next decision, with the list in hand.
 */
const notices = spawnSync(process.execPath, [join(here, "collect-notices.mjs"), sidecarDir], {
  encoding: "utf8"
});
process.stdout.write(notices.stdout ?? "");
if (notices.status !== 0) {
  fail(`collect-notices failed with ${String(notices.status)}: ${(notices.stderr ?? "").slice(0, 500)}`);
}

console.log(`package-sidecar: laid out ${sidecarDir}`);
