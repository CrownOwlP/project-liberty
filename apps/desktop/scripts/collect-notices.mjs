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

/* -------------------------------------------------------------------------
 * A TREE THIS FINDS NOTHING IN IS UNKNOWN, NOT CLEAN (PW-0208)
 * -------------------------------------------------------------------------
 *
 * THE SHAPE THIS CLOSES. Before this check, a `sidecarDir` whose
 * `node_modules` was missing, empty, or laid out somewhere this script does
 * not walk produced a notices document listing nothing, printed
 * "0 package(s), 0 with no licence evidence", and EXITED 0. Worse,
 * `--strict` could not catch it either: it fires on
 * `attention.length > 0`, and a tree with no packages has nothing to pay
 * attention to. The strictest setting available was green on the one input
 * where the evidence was entirely absent.
 *
 * That is the third time this repository has met the same defect in a
 * month. `drizzle-kit migrate` applied nothing and exited 0 (PL-0714, and
 * PL-0726 when the hand-written replacement grew its own version of it);
 * three e2e titles were skipped in every configuration and no gate asked
 * (PL-0717). Each time the mechanism reported success over an empty set.
 *
 * WHY IT IS FATAL RATHER THAN A WARNING. This document is how an LGPL
 * attribution obligation reaches the person who receives the binary.
 * `docs/LICENSING.md` §7 says the obligation must be met by something the
 * user receives; a notices file that lists nothing because the walk found
 * nothing LOOKS like a clean bill and is the absence of one. An installer
 * built on top of it would ship a confident, empty claim.
 *
 * IT IS NOT A JUDGEMENT ABOUT ANY PACKAGE'S LICENCE, which is the line this
 * task must not cross on its own. It says only that a packaged tree with no
 * packages in it is not a tree anybody has described.
 * ---------------------------------------------------------------------- */
if (entries.length === 0) {
  fail(
    `found no packages under ${target}, so there is nothing to describe and no evidence that ` +
      `there is nothing to describe. A packaged sidecar carries its own node_modules; an empty ` +
      `walk means the tree was not packaged, was packaged somewhere else, or is laid out in a ` +
      `way this script does not read. Writing a notices document that lists nothing would be a ` +
      `confident claim about a tree nobody looked at.`
  );
}

const document = renderNotices(entries, runtime);
const output = join(target, NOTICES_NAME);
writeFileSync(output, document, "utf8");

/*
 * AND THE FILE IS READ BACK (PW-0208). `writeFileSync` throwing is not the
 * only way to end up without a notices file -- a full disk, a path that
 * resolved somewhere unexpected, or a later step overwriting it all end the
 * same way, and every one of them is silent. The obligation is the FILE, so
 * the file is what gets checked.
 */
const written = existsSync(output) ? statSync(output).size : 0;
if (written === 0) {
  fail(
    `wrote ${NOTICES_NAME} to ${output} and it is missing or empty afterwards. The attribution ` +
      `obligation is the file, not the attempt.`
  );
}

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

/*
 * WHY `--strict` IS STILL NOT PASSED BY `package-sidecar.mjs`, restated
 * because this file now fails in two new ways and the difference matters.
 *
 * The checks above refuse a tree nobody described and a file that is not
 * there -- both are statements about whether EVIDENCE WAS GATHERED, and
 * neither requires an opinion about any package's terms. `--strict` refuses
 * a tree where a named package carries no licence evidence, which is a
 * statement about a LIST THAT HAS NEVER BEEN READ: no packaging run has
 * completed and printed one. Arming it from here would be a Linux session
 * deciding that a Windows job should fail on contents it has not seen.
 *
 * The list is what unblocks that decision, and it arrives with the first
 * packaging run that gets this far.
 */
