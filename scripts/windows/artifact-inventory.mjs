#!/usr/bin/env node
/* -------------------------------------------------------------------------
 * The exact artifact inventory, with hashes (PW-0501).
 *
 * gpt-architect's round-94 scope for this task asks for "exact artifact
 * inventory and hashes" and, in the same breath, for "no signing claims
 * without a real certificate". Those are one requirement read from two ends: a
 * release artifact is only meaningful if you can say precisely what was
 * produced and prove the bytes, and an inventory that implied a signature it
 * does not have would be worse than none.
 *
 * WHAT THIS IS NOT. It is not a signature, it is not a provenance attestation,
 * and it is not evidence that the installer installs anything. A SHA-256 over
 * a file the same job just built proves the bytes are the bytes; it says
 * nothing about who built them or whether they work. Everything this script
 * emits is written to be read that way.
 *
 * WHY A SCRIPT RATHER THAN A SHELL LOOP IN THE WORKFLOW. Because it ASSERTS,
 * and the assertion is the point. `tauri build` exits 0 having produced
 * whatever it produced; a workflow that then uploaded `*.msi` would be green
 * on a run that silently emitted one installer instead of two, or none. This
 * fails when the set is not exactly what was expected, which is the difference
 * between a build step and a gate.
 *
 * USAGE
 *   node scripts/windows/artifact-inventory.mjs --bundle <dir> --out <file>
 *                                               [--expect msi,nsis]
 * ---------------------------------------------------------------------- */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * The bundle kinds this build is required to produce.
 *
 * MSI AND NSIS, BOTH, and the pair is deliberate rather than
 * belt-and-braces -- the same argument `identity.rs` makes about
 * `bundle.targets`. The MSI is what an administrator deploys through group
 * policy and what an enterprise inventory understands; the NSIS executable is
 * what a person downloads and double-clicks, and it is the one that can
 * install per-user without elevation. A run that quietly produced one of the
 * two would have dropped an audience, and nothing but this would say so.
 */
const KINDS = {
  msi: { directory: "msi", extension: ".msi" },
  nsis: { directory: "nsis", extension: ".exe" }
};

function fail(message) {
  console.error(`artifact-inventory: ${message}`);
  process.exit(1);
}

function argument(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || index === process.argv.length - 1) return fallback;
  return process.argv[index + 1];
}

const bundleDir = argument("bundle");
const outFile = argument("out");
const expected = (argument("expect", "msi,nsis") ?? "").split(",").map((k) => k.trim()).filter(Boolean);

if (!bundleDir) fail("--bundle <dir> is required (tauri's bundle output directory)");
if (!outFile) fail("--out <file> is required");
for (const kind of expected) {
  if (!(kind in KINDS)) fail(`--expect names ${kind}, which is not one of ${Object.keys(KINDS).join(", ")}`);
}

/**
 * Every file directly under one kind's directory, with the right extension.
 *
 * NOT A RECURSIVE WALK. Tauri writes the installer beside its own build
 * scaffolding -- WiX object files, NSIS plugin copies, extracted toolchains --
 * and hashing those would produce an inventory whose contents changed with the
 * bundler's internals rather than with the product. One level, one extension.
 */
function installersFor(kind) {
  const directory = join(bundleDir, KINDS[kind].directory);
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    fail(
      `no ${kind} output at ${directory}: ${error.code ?? error.message}. ` +
        `tauri build exited successfully, so this is a bundler that produced nothing ` +
        `rather than a build that failed -- which is exactly the case this script exists to catch.`
    );
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(KINDS[kind].extension))
    .map((entry) => join(directory, entry.name))
    .sort();
}

const artifacts = [];
for (const kind of expected) {
  const found = installersFor(kind);
  if (found.length === 0) fail(`no ${KINDS[kind].extension} installer in the ${kind} output directory`);
  if (found.length > 1) {
    /*
     * MORE THAN ONE IS ALSO A FAILURE, and it is the subtler of the two. A
     * leftover installer from a previous version in the same directory would
     * be uploaded beside the new one, and whoever downloaded the release would
     * have two files and no way to tell which was built from the commit the
     * release names.
     */
    fail(
      `${found.length} ${kind} installers in one directory: ${found.map((p) => relative(bundleDir, p)).join(", ")}. ` +
        `A release must name one file per kind; a stale artifact from an earlier build is the usual cause.`
    );
  }

  const path = found[0];
  const bytes = readFileSync(path);
  artifacts.push({
    kind,
    name: relative(bundleDir, path).split("\\").join("/"),
    bytes: statSync(path).size,
    sha256: createHash("sha256").update(bytes).digest("hex")
  });
}

const inventory = {
  /*
   * NAMED AS AN INVENTORY AND NOT AS AN ATTESTATION, in the document itself,
   * because this file will outlive the context it was produced in and will be
   * read by somebody who did not run the job.
   */
  kind: "liberty-windows-artifact-inventory",
  producedAt: new Date().toISOString(),
  commit: process.env.GITHUB_SHA ?? null,
  runId: process.env.GITHUB_RUN_ID ?? null,
  signed: false,
  signingNote:
    "UNSIGNED. No Authenticode certificate exists for this project; PW-0502 depends on one and " +
    "coordination/LAST_MILE.md item 6 records it as an owner action. These installers will trip " +
    "SmartScreen and Defender. The digests below prove the bytes are the bytes this run produced " +
    "and nothing more -- they are not a signature and they do not establish who built them.",
  artifacts
};

writeFileSync(outFile, `${JSON.stringify(inventory, null, 2)}\n`, "utf8");

console.log(`artifact-inventory: ${artifacts.length} artifact(s), unsigned`);
for (const artifact of artifacts) {
  console.log(`  ${artifact.kind.padEnd(4)} ${artifact.sha256}  ${artifact.bytes} B  ${artifact.name}`);
}
console.log(`artifact-inventory: written to ${resolve(outFile)}`);
