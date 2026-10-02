#!/usr/bin/env node
/* -------------------------------------------------------------------------
 * Write the third-party notices the installer carries (PW-0208)
 *
 *     node apps/desktop/scripts/collect-notices.mjs [<packaged sidecar dir>]
 *
 * WHERE IT WRITES AND WHY THAT NEEDED NO PACKAGING CHANGE. `tauri.conf.json`
 * declares one bundle resource, `"../sidecar/": "sidecar/"` — the whole
 * packaged tree. A file written into that tree therefore reaches the
 * installed machine without touching the bundle configuration at all, which
 * matters because the Windows packaging job is the one green signal this
 * project has and an unproven resource glob is a bad way to spend it.
 *
 * IT DESCRIBES THE TREE, NOT THE LOCKFILE. The entries come from walking the
 * `node_modules` that was actually copied into the sidecar, so a dependency
 * that is in `package-lock.json` and not in the bundle does not appear, and
 * one that is in the bundle and not in the lockfile does. `docs/LICENSING.md`
 * §5 states the rule: built from what was actually linked, not from what a
 * manifest claims.
 *
 * IT DOES NOT FAIL THE BUILD, AND THAT IS DELIBERATE FOR NOW. A package with
 * no licence evidence at all is reported in the document, first-class, under
 * its own heading. Turning that into a non-zero exit is a one-line change and
 * `--strict` already does it — but arming it from here would mean a Linux
 * session deciding that a Windows packaging job should start failing, on a
 * list nobody has seen yet. The first run prints the list; arming the gate is
 * the next decision, with the list in hand.
 * ---------------------------------------------------------------------- */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isLicenceFileName, licenceEvidence, needsAttention, renderNotices } from "./notices.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, "..");

const NOTICES_NAME = "THIRD-PARTY-NOTICES.md";

function fail(message) {
  console.error(`collect-notices: ${message}`);
  process.exit(1);
}

/**
 * Every package directory under a `node_modules`, scopes included.
 *
 * NESTED `node_modules` ARE WALKED TOO. npm hoists most of the time and not
 * always; a transitive copy pinned to a different version is a different
 * artifact with possibly different terms, and skipping it would under-report
 * exactly the case that is hardest to notice.
 */
function* packageDirectories(modulesDir) {
  if (!existsSync(modulesDir)) return;
  for (const entry of readdirSync(modulesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === ".bin" || entry.name === ".package-lock.json") continue;
    const full = join(modulesDir, entry.name);
    if (entry.name.startsWith("@")) {
      for (const scoped of readdirSync(full, { withFileTypes: true })) {
        if (!scoped.isDirectory()) continue;
        yield join(full, scoped.name);
      }
      continue;
    }
    yield full;
    yield* packageDirectories(join(full, "node_modules"));
  }
}

function readManifest(packageDir) {
  const file = join(packageDir, "package.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    /* A package whose manifest will not parse declares nothing, which is a
     * verdict this module already has a name for. */
    return null;
  }
}

function licenceFilesIn(packageDir) {
  try {
    return readdirSync(packageDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && isLicenceFileName(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

export function collect(sidecarDir) {
  const modules = join(sidecarDir, "server", "node_modules");
  const entries = [];
  for (const packageDir of packageDirectories(modules)) {
    const manifest = readManifest(packageDir);
    const name =
      manifest && typeof manifest.name === "string"
        ? manifest.name
        : relative(modules, packageDir).split(/[\\/]/).join("/");
    const version = manifest && typeof manifest.version === "string" ? manifest.version : null;
    entries.push(licenceEvidence(name, version, manifest, licenceFilesIn(packageDir)));
  }

  /* The runtime is a single file beside the server, named by the Rust
   * constant the shell itself uses — see scripts/windows/installed-identity.mjs
   * for the same derivation and the history behind it. */
  const node = join(sidecarDir, "node.exe");
  const runtime = existsSync(node)
    ? {
        path: "node.exe",
        bytes: statSync(node).size,
        licenceText: existsSync(join(sidecarDir, "LICENSE"))
          ? "LICENSE"
          : null
      }
    : null;

  return { entries, runtime };
}

const target = resolve(process.argv.find((a) => !a.startsWith("--") && a !== process.argv[0] && a !== process.argv[1]) ?? join(desktop, "sidecar"));
const strict = process.argv.includes("--strict");

if (!existsSync(target)) {
  fail(
    `no packaged sidecar tree at ${target}. Run apps/desktop/scripts/package-sidecar.mjs first; ` +
      `this describes what was packaged and has nothing to describe before that.`
  );
}

const { entries, runtime } = collect(target);
const document = renderNotices(entries, runtime);
const output = join(target, NOTICES_NAME);
writeFileSync(output, document, "utf8");

const attention = needsAttention(entries);
console.log(
  `collect-notices: ${entries.length} package(s), ${attention.length} with no licence evidence -> ${output}`
);
for (const entry of attention) console.log(`  no licence evidence: ${entry.name} ${entry.version ?? ""}`);

if (strict && attention.length > 0) {
  fail(
    `${attention.length} shipped package(s) neither declare a licence nor carry one, and --strict ` +
      `was given. They are listed above and in ${NOTICES_NAME}.`
  );
}
