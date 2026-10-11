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
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  STAGING_SUFFIX,
  classifyLink,
  materialiseLink,
  removeLinkOnly,
  symlinksUnder
} from "./external-links.mjs";
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
  /*
   * ANY LEFTOVER LINK IS REMOVED ON ITS OWN BEFORE THE RECURSIVE WIPE
   * (PL-0758).
   *
   * The wipe below is a recursive delete, and a previous run that died between
   * copying the tree and materialising its links leaves links in it. Node's
   * recursive delete does unlink a symlink rather than descend into it, so this
   * is belt and braces -- but the thing on the other end of one of those links
   * is `<repo>/node_modules/pg`, and "the implementation probably does the
   * right thing with a Windows junction" is the exact species of reasoning that
   * produced PL-0755. `removeLinkOnly` cannot recurse by construction.
   */
  for (const link of symlinksUnder(sidecarDir)) removeLinkOnly(link);
  for (const entry of readdirSync(sidecarDir)) {
    if (PRESERVED.includes(entry)) continue;
    rmSync(join(sidecarDir, entry), { recursive: true, force: true, maxRetries: 5 });
  }
}
mkdirSync(join(sidecarDir, "server"), { recursive: true });

const serverDir = join(sidecarDir, "server");

/*
 * EVERY LINK THE BUILD LEFT IS CLASSIFIED, REPORTED, AND THEN REPLACED BY WHAT
 * IT POINTS AT (PL-0755, corrected by PL-0758).
 *
 * THE DEFECT PL-0755 FIXED, in one paragraph because the rule below is
 * unreadable without it. Turbopack externalises some server packages and emits
 * a BARE import of a hashed alias for each -- the shipped chunks contain
 * `await import("pg-587764f78a6c7a9c")` -- and Next makes that resolvable by
 * creating `<distDir>/node_modules/<alias>` as a LINK to the package it traced.
 * This script copied the tree with `cpSync`, whose documented behaviour for a
 * symlink is to resolve it against its SOURCE directory and write an ABSOLUTE
 * link at the destination. So the MSI shipped a pointer at a directory on a
 * GitHub runner, the import failed with ERR_MODULE_NOT_FOUND, and every page
 * that reaches the persistence layer answered 500. `pg` itself was never
 * missing; it is traced into `standalone/node_modules` and copied below.
 *
 * AND THE RULE PL-0755 USED WAS A LINUX ACCIDENT (PL-0758). It required each
 * link's target to be inside the standalone tree, which is where a RELATIVE
 * link lands. On Windows the same build produces an absolute one -- a directory
 * junction, which is what a process without the symlink privilege creates and
 * which stores an absolute target -- aimed at the workspace's own hoisted copy:
 *
 *     ...\standalone\apps\web\dist\desktop\node_modules\pg-587764f78a6c7a9c
 *       -> D:\a\project-liberty\project-liberty\node_modules\pg
 *
 * That is a dependency-traced package in this repository, and refusing it
 * turned the Windows package job red. The policy now lives in
 * `external-links.mjs`, where it is tested against real links of both shapes,
 * and it is three checks where there was one -- repository containment, a
 * `node_modules` target, and a `package.json` in it. Two of those did not exist
 * before; the only loosened one is the boundary, from a directory inside the
 * build output to the checkout.
 *
 * REPORTED BEFORE ANYTHING IS FOLLOWED, because following a link is silent:
 * every one is named with where it resolves, and every refusal is collected so
 * a build that grew three new links says so once instead of dying on the first.
 */
function reportBuildOutputLinks(root, label) {
  const links = symlinksUnder(root);
  const refusals = [];
  for (const link of links) {
    const verdict = classifyLink({ link, repoRoot, standaloneRoot: standalone });
    if (verdict.ok) {
      console.log(
        `package-sidecar: ${label}: will materialise ${relative(root, link)} -> ` +
          `${relative(repoRoot, verdict.target)} (${verdict.reason})`
      );
      continue;
    }
    refusals.push(`[${verdict.reason}] ${verdict.detail}`);
  }
  if (refusals.length > 0) {
    fail(
      `the build output at ${label} carries ${refusals.length} link(s) that must not be ` +
        `packaged:\n  ${refusals.join("\n  ")}\n` +
        `An installer carries the link and not the machine it points at, which is the whole of ` +
        `PL-0755 -- so a link that cannot be safely materialised is not one to ship.`
    );
  }
  return links.length;
}

const linkedInApp = reportBuildOutputLinks(standaloneApp, `standalone/${WEB_WORKSPACE.split("\\").join("/")}`);
const linkedInModules = existsSync(standaloneModules)
  ? reportBuildOutputLinks(standaloneModules, "standalone/node_modules")
  : 0;

/* The app directory, flattened: `standalone/apps/web/*` -> `server/*`. */
cpSync(standaloneApp, serverDir, { recursive: true });

/* And the shared dependencies it resolves upward to, brought down beside it. */
if (existsSync(standaloneModules)) {
  cpSync(standaloneModules, join(serverDir, "node_modules"), { recursive: true });
}

/*
 * THE LINKS IN THE PACKAGED TREE ARE REPLACED BY REAL FILES, TO A FIXED POINT.
 *
 * `cpSync`'s `dereference: true` IS NOT THIS, and the difference cost a cycle
 * of PL-0755. The option selects which stat is used on the COPY ROOT; a symlink
 * NESTED inside the tree is still copied as a symlink, and still absolutised
 * against the source. Measured on node v22.22.2: copying a directory containing
 * `node_modules/alias -> ../../target` with `dereference: true` produces a
 * destination where `lstat().isSymbolicLink()` is still true. Passing the flag
 * and believing the name would have shipped the same broken installer with a
 * more confident comment above it.
 *
 * A FIXED POINT RATHER THAN ONE PASS, because materialising a link can expose
 * more: the directory copied in may contain links of its own, and
 * `external-links.test.mjs` pins exactly that case. The budget is small and the
 * refusal is loud.
 *
 * THE POLICY IS RE-APPLIED HERE rather than trusted from the report above. The
 * report looks at the build output; this looks at the bytes about to be
 * shipped, and they are not the same files. A link that arrived in the packaged
 * tree by some other route -- a future step with different copy options, a
 * directory assembled by hand -- is classified on the same terms.
 */
const MATERIALISE_PASSES = 8;

let materialised = 0;
for (let pass = 0; ; pass += 1) {
  const links = symlinksUnder(sidecarDir);
  if (links.length === 0) break;
  if (pass >= MATERIALISE_PASSES) {
    fail(
      `still ${links.length} symlink(s) under ${sidecarDir} after ${MATERIALISE_PASSES} ` +
        `materialisation passes, starting with ${links[0]}. Either the build output contains a ` +
        `cycle or something is recreating them; do not ship a tree with links in it.`
    );
  }
  for (const link of links) {
    const verdict = classifyLink({ link, repoRoot, standaloneRoot: standalone });
    if (!verdict.ok) {
      fail(
        `the packaged tree carries a link that must not be followed: [${verdict.reason}] ` +
          `${verdict.detail}`
      );
    }
    try {
      const done = materialiseLink(link, { repoRoot, standaloneRoot: standalone });
      /*
       * THE NESTED LINKS ARE NAMED, because they are the ones nobody looked at.
       * Round 130A3's Windows failure was a fixture that assumed how a nested
       * link is copied; the copier now resolves each one itself and says so, so
       * the build log records what was followed rather than leaving it to be
       * inferred from a count.
       */
      for (const nested of done.nested) {
        console.log(
          `package-sidecar:   nested ${relative(repoRoot, nested.at)} -> ` +
            `${relative(repoRoot, nested.target)} (${nested.reason})`
        );
      }
    } catch (error) {
      fail(`could not materialise ${link}: ${error.message}`);
    }
    materialised += 1;
  }
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
 * NODE'S OWN LICENCE, BESIDE THE BINARY IT COVERS (PW-0208).
 *
 * The runtime that ships is MIT-licensed and redistributes further
 * components under their own terms -- V8, OpenSSL, ICU and the rest -- all of
 * which the Node distribution states in one `LICENSE` file beside the
 * executable. Shipping the binary and leaving that file behind is an
 * attribution obligation dropped for no reason other than that nobody copied
 * it, and `docs/LICENSING.md` §7 is explicit that the obligation has to be
 * met by something the user receives.
 *
 * GUARDED, NOT ASSUMED. `LIBERTY_SIDECAR_NODE` can point at a runtime laid
 * out any way a packager likes, so the licence is looked for beside the
 * binary and then one directory up -- the two places every mainstream Node
 * distribution puts it -- and its absence is REPORTED rather than fatal.
 * `collect-notices.mjs` then states in the shipped notices that no licence
 * accompanied the binary, which is the honest outcome: the obligation does
 * not disappear because the file was not found, and a packaging step that
 * died here would trade a missing text file for no installer at all.
 */
const nodeDir = dirname(nodeBinary);
const nodeLicence = [join(nodeDir, "LICENSE"), join(nodeDir, "..", "LICENSE")].find((candidate) =>
  existsSync(candidate)
);
if (nodeLicence === undefined) {
  console.warn(
    `package-sidecar: no LICENSE found beside ${nodeBinary}; the shipped notices will say so`
  );
} else {
  cpSync(nodeLicence, join(sidecarDir, "LICENSE"));
  console.log(`package-sidecar: carried the runtime licence from ${nodeLicence}`);
}

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
 * AND THE PACKAGED TREE CONTAINS NO LINK AT ALL (PL-0755, strengthened by
 * PL-0758).
 *
 * The materialisation above is what removes them. This is the check that they
 * are gone, and it is deliberately a SEPARATE statement rather than trust in
 * the loop -- `cpSync`'s symlink behaviour is the thing that caused the defect,
 * so "the code I just wrote means what I think it means" is the assumption
 * least worth making here. It also catches a link arriving by some other
 * route: a future step that copies with different options, a tree assembled by
 * hand.
 *
 * ANY LINK, not merely one that points outside the tree. PL-0755 refused only
 * escaping links, which left a defensible-looking hole: a link INSIDE the tree
 * survives an installer only if the installer reproduces links, and WiX, MSI
 * and whatever a future Windows does about symlinks are three separate
 * questions this project has no reason to answer. A real file answers all
 * three by not being a question. Nothing in this build produces such a link
 * today, so the stricter rule costs nothing and removes the hole.
 *
 * AND NO STAGING DIRECTORY, which would mean a materialisation did not finish.
 */
const strays = symlinksUnder(sidecarDir).map((link) => relative(sidecarDir, link));
if (strays.length > 0) {
  fail(
    `the packaged tree still contains ${strays.length} symlink(s):\n  ${strays.join("\n  ")}\n` +
      `An installer carries the link and not the machine it points at, which is the whole of ` +
      `PL-0755. Materialise it or work out what put it there.`
  );
}
const unfinished = [];
{
  const stack = [sidecarDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.name.endsWith(STAGING_SUFFIX)) unfinished.push(relative(sidecarDir, full));
      else if (entry.isDirectory()) stack.push(full);
    }
  }
}
if (unfinished.length > 0) {
  fail(
    `the packaged tree carries ${unfinished.length} unfinished materialisation(s): ` +
      `${unfinished.join(", ")}. A half-copied dependency is worse than a link, because nothing ` +
      `downstream can tell it is incomplete.`
  );
}
console.log(
  `package-sidecar: ${linkedInApp + linkedInModules} link(s) in the build output, ` +
    `${materialised} materialisation(s) applied, 0 link(s) left in the packaged tree`
);

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

/*
 * AND THE FILE IS IN THE TREE THIS STEP JUST BUILT (PW-0208).
 *
 * `collect-notices.mjs` checks its own output, and this checks the same
 * thing from the other side -- deliberately, because the two answer
 * different questions. That one asks "did I write it"; this asks "is it in
 * the tree that is about to be handed to the bundler", which is the claim
 * `tauri.conf.json`'s `"../sidecar/": "sidecar/"` resource turns into a file
 * on the installed machine.
 *
 * THE DUPLICATION IS THE POINT, and the cost is three lines. A later edit
 * that moved where the generator writes, or a step inserted between the two
 * that cleaned the directory, would leave the first check passing and this
 * one failing -- which is the correct outcome, because the obligation is
 * discharged by what ships, not by what was generated.
 */
const noticesFile = join(sidecarDir, "THIRD-PARTY-NOTICES.md");
if (!existsSync(noticesFile) || statSync(noticesFile).size === 0) {
  fail(
    `collect-notices reported success and ${noticesFile} is missing or empty. The packaged tree ` +
      `is what carries the attribution obligation to the installed machine, so a tree without ` +
      `this file is not one to hand to the bundler.`
  );
}

console.log(`package-sidecar: laid out ${sidecarDir}`);

/*
 * AND THE TREE IS SMOKED FROM SOMEWHERE ELSE (PL-0755).
 *
 * HERE, for the reason the notices step above gives: the thing that knows what
 * was packaged is the thing that packaged it. It is also the only placement
 * that MAKES THE CHECK RUN. `.github/workflows/windows.yml` already runs this
 * script as its `sidecar` step, so a guard invoked from here executes on the
 * Windows job that produces the installer, with no workflow change -- and
 * `.github/workflows/{ci,windows}.yml` are reserved by PL-0736 this round, so a
 * workflow step is not available to write.
 *
 * NOT OPTIONAL, and that is a decision with a cost. It adds a server start to
 * the job that produces the installer, so a flake here means no installer. The
 * trade is deliberate: for three rounds this project has produced installers
 * that could not start, and every one of them was produced by a job that went
 * green. An installer nobody can run is worth less than a red build.
 *
 * WHAT IT ASSERTS is in that file's header: that the tree still works once it
 * has been copied out of this repository, that every external specifier in the
 * shipped chunks resolves, and that an authenticated homepage answers 200.
 */
/*
 * THE LINK POLICY'S OWN TESTS, RUN HERE FOR THE REASON THE SMOKE TEST IS
 * (PL-0758).
 *
 * `external-links.test.mjs` builds real links of both platform shapes -- the
 * relative one Linux produces and the absolute junction Windows produces -- and
 * asserts which may be packaged. The Windows shape is the one that cannot be
 * reasoned about from a Linux session, and this is the only placement that
 * executes it on windows-latest: `apps/desktop` is not an npm workspace so no
 * vitest project reaches it, and `.github/workflows/{ci,windows}.yml` are
 * reserved by PL-0736. Under a second of runtime.
 */
const policy = spawnSync(process.execPath, ["--test", join(here, "external-links.test.mjs")], {
  encoding: "utf8"
});
process.stdout.write(policy.stdout ?? "");
if (policy.status !== 0) {
  process.stderr.write(policy.stderr ?? "");
  fail(
    `the external-link policy's own tests failed (exit ${String(policy.status)}). The layout rule ` +
      `this script enforces is wrong on this platform; do not package a tree against a rule that ` +
      `cannot pass its own fixtures.`
  );
}

const smoke = spawnSync(process.execPath, [join(here, "packaged-server-smoke.mjs")], {
  encoding: "utf8"
});
process.stdout.write(smoke.stdout ?? "");
process.stderr.write(smoke.stderr ?? "");
if (smoke.status !== 0) {
  fail(
    `the packaged tree did not survive being moved (packaged-server-smoke exited ` +
      `${String(smoke.status)}). The layout above is complete and the tree still does not ` +
      `work anywhere but here; its output names which check failed.`
  );
}
