#!/usr/bin/env node
/* -------------------------------------------------------------------------
 * What the installer actually ships, printed where it can be read (PL-0737)
 *
 * ==========================================================================
 * WHY THIS EXISTS: THE EVIDENCE WAS BEING ARCHIVED, NOT REPORTED
 * ==========================================================================
 *
 * PW-0208 has sat in review for three rounds waiting on evidence about the
 * binaries the installer carries. Windows #16 and #17 both BUILT a real MSI
 * and a real NSIS installer, and in both the upload step was skipped behind
 * an earlier failure -- but a successful upload would not have helped: a
 * GitHub artifact needs a login to download, and the engineering session has
 * none. Annotations are the only channel it can read.
 *
 * So the evidence has to be PRINTED BY THE RUN. That is the whole idea here.
 *
 * ==========================================================================
 * THREE TREES, NEVER CONFLATED
 * ==========================================================================
 *
 * SOURCE INTENT      what the repository says it will ship
 * PACKAGE BUILD OUTPUT  what `tauri build` actually produced
 * INSTALLED TREE     what landed on a machine after the MSI ran
 *
 * Evidence from one is not evidence about another, and the easiest way to
 * mislead a reviewer is to answer a question about the third using the first.
 * This script reports on whichever tree it is pointed at and SAYS WHICH, in
 * its first line of output, every time.
 *
 * ==========================================================================
 * IT REPORTS. IT FAILS ON EXACTLY ONE THING.
 * ==========================================================================
 *
 * A script that went red over an unexpected DLL would be unusable the first
 * time a legitimate one arrived, and what may ship is gpt-architect's and the
 * commander's judgement, not a script's. So everything here is reported.
 *
 * The one exception is a CONTRADICTION between the binaries and the notices,
 * in either direction:
 *
 *   - an libmpv or FFmpeg binary is present while
 *     `THIRD-PARTY-NOTICES.md` still says no shipped component is LGPL. That
 *     is a shipped LGPL binary with no written offer and no attribution --
 *     the trap `docs/DESKTOP_PLAYBACK.md` §9 names, and the one
 *     `RESEARCH_PLAYBACK.md` already found elsewhere: "every prebuilt
 *     ffprobe on npm is a GPL-3.0 binary, and several declare otherwise".
 *   - the notices claim an LGPL component and no binary in the tree
 *     corresponds to it. An attribution for something nobody ships is a
 *     different kind of false statement, and it is still a false statement.
 *
 * Today the honest answer is that neither is present and the notices say so,
 * which agrees. The value of this script is not that answer. It is that it
 * notices the day the answer changes -- which is the day the obligations
 * attach, and the day nobody is thinking about this file.
 *
 * ==========================================================================
 * NOT IN SCOPE, AND NOT INFERRABLE FROM ANYTHING BELOW
 * ==========================================================================
 *
 * H.264 and HEVC PATENT AUTHORISATION. This script reports file names, sizes
 * and hashes. It says nothing about whether a decoder may lawfully be
 * distributed, it must not be cited as bearing on that question, and nothing
 * it prints may be used to enable a patent-encumbered decoder. That is a
 * commander and counsel decision, and no amount of packaging evidence moves
 * it one inch.
 *
 * USAGE
 *   node scripts/windows/distribution-inventory.mjs --tree <dir> --kind <kind>
 *
 *   --kind  one of: package-build-output | installed-tree | source-intent
 * ---------------------------------------------------------------------- */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** The three trees, spelled the way the output has to spell them. */
const KINDS = {
  "package-build-output": "PACKAGE BUILD OUTPUT (what `tauri build` produced)",
  "installed-tree": "INSTALLED TREE (what landed on a machine after the installer ran)",
  "source-intent": "SOURCE INTENT (what the repository says it will ship)"
};

/** Extensions that are a native binary on some platform this product targets. */
const NATIVE = new Set([".dll", ".exe", ".so", ".dylib", ".node"]);

/**
 * Filename stems that mean libmpv or FFmpeg is in the tree.
 *
 * A LIST, NOT A STRING, and the list is the care. FFmpeg does not ship a file
 * called "ffmpeg" in a library build -- it ships `avcodec-61.dll`,
 * `avformat-61.dll`, `avutil-59.dll` and friends, and libmpv ships
 * `libmpv-2.dll` or `mpv-2.dll` depending on how it was built. A check that
 * grepped for "ffmpeg" would report ABSENT over a tree full of FFmpeg.
 *
 * Matched as a word-ish prefix so `avcodec-61.dll` hits and a package
 * innocently named `my-avcodec-helper.node` does not.
 */
const LGPL_FAMILY = [
  "libmpv",
  "mpv",
  "avcodec",
  "avformat",
  "avutil",
  "avfilter",
  "avdevice",
  "swresample",
  "swscale",
  "postproc",
  "ffmpeg",
  "ffprobe"
];

/** The sentence `notices.mjs` writes while nothing LGPL is shipped. */
const NOTICES_DENIES_LGPL = "No component shipped in this build is LGPL today";
const NOTICES_FILE = "THIRD-PARTY-NOTICES.md";

function fail(message) {
  console.error(`distribution-inventory: ${message}`);
  process.exit(1);
}

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || index === process.argv.length - 1) return null;
  return process.argv[index + 1];
}

/**
 * Every file under `root`, relative to it.
 *
 * Symlinks are NOT followed. A tree that links to somewhere else is not
 * shipping what is on the other end, and following one would let an inventory
 * of an installed tree wander into the machine it is installed on.
 */
function walk(root) {
  const found = [];
  const visit = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      fail(`${dir} could not be read: ${error.code ?? error.message}`);
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) found.push(path);
    }
  };
  visit(root);
  return found.sort();
}

/** `avcodec-61.dll` -> `avcodec`; `libmpv-2.dll` -> `libmpv`. */
function stemOf(name) {
  return name.toLowerCase().replace(/\.[^.]+$/, "").replace(/[-_.]?\d[\d.]*$/, "");
}

function isLgplFamily(name) {
  const stem = stemOf(name);
  return LGPL_FAMILY.some((known) => stem === known || stem.endsWith(`-${known}`));
}

/** A GitHub annotation when there is a runner to read it; plain text otherwise. */
const onRunner = process.env.GITHUB_ACTIONS === "true";
function report(line) {
  console.log(onRunner ? `::notice title=distribution-inventory::${line}` : line);
}

const tree = argument("tree");
const kind = argument("kind");
if (!tree) fail("--tree <dir> is required; there is no default, because which tree this is matters");
if (!kind || !(kind in KINDS)) {
  fail(
    `--kind must be one of ${Object.keys(KINDS).join(", ")}; got ${kind ?? "nothing"}. ` +
      `It is required and has no default: evidence from one tree is not evidence about another, ` +
      `and a report that does not say which tree it read is the way that mistake gets made.`
  );
}
try {
  if (!statSync(tree).isDirectory()) fail(`${tree} is not a directory`);
} catch (error) {
  fail(`${tree} could not be read: ${error.code ?? error.message}`);
}

const files = walk(tree);
report(`${KINDS[kind]} at ${tree}: ${files.length} file(s).`);

/* ---------------------------------------------------------------------------
 * 1. Native binaries, with hashes. A licence argument about binaries starts
 *    with knowing which binaries there are.
 * ------------------------------------------------------------------------ */
const natives = files.filter((path) => NATIVE.has(path.slice(path.lastIndexOf(".")).toLowerCase()));
report(`native binaries: ${natives.length}`);
for (const path of natives) {
  const bytes = readFileSync(path);
  const sha = createHash("sha256").update(bytes).digest("hex");
  report(`  ${relative(tree, path).split(sep).join("/")}  ${bytes.length} bytes  sha256=${sha}`);
}

/* ---------------------------------------------------------------------------
 * 2. libmpv and FFmpeg, by name, present or ABSENT.
 *
 *    Reported either way on purpose. A check that could only report presence
 *    would be silent today and silent on the day it mattered; the useful
 *    statement is "this tree contains none of them", made every run, so the
 *    first run where it stops being true is loud.
 * ------------------------------------------------------------------------ */
const family = natives.filter((path) => isLgplFamily(path.slice(path.lastIndexOf(sep) + 1)));
if (family.length === 0) {
  report(`libmpv / FFmpeg: ABSENT. No file in this tree matches ${LGPL_FAMILY.join(", ")}.`);
} else {
  report(`libmpv / FFmpeg: PRESENT, ${family.length} file(s):`);
  for (const path of family) report(`  ${relative(tree, path).split(sep).join("/")}`);
}

/* ---------------------------------------------------------------------------
 * 3. The notices document: present, how big, how many components.
 * ------------------------------------------------------------------------ */
const noticesPath = files.find((path) => path.endsWith(`${sep}${NOTICES_FILE}`) || path.endsWith(NOTICES_FILE));
let notices = null;
if (!noticesPath) {
  report(`${NOTICES_FILE}: ABSENT from this tree.`);
} else {
  notices = readFileSync(noticesPath, "utf8");
  /* Rows of the package table, which is how `notices.mjs` lists components:
   * `| name | version | licence | licence text |`, minus the header and the
   * `| --- |` separator. */
  const rows = notices
    .split("\n")
    .filter((line) => line.startsWith("| ") && !line.startsWith("| ---") && !line.startsWith("| Package "));
  report(
    `${NOTICES_FILE}: present at ${relative(tree, noticesPath).split(sep).join("/")}, ` +
      `${Buffer.byteLength(notices)} bytes, ${rows.length} component row(s).`
  );
  if (notices.trim().length === 0) report(`${NOTICES_FILE}: PRESENT BUT EMPTY.`);
}

/* ---------------------------------------------------------------------------
 * 4. The Node runtime's own licence. node.exe is shipped, and its licence
 *    travels with it.
 * ------------------------------------------------------------------------ */
const nodeBinary = natives.find((path) => stemOf(path.slice(path.lastIndexOf(sep) + 1)) === "node");
const nodeLicence = files.find((path) => /(^|[\\/])LICENSE(\.[A-Za-z0-9.-]+)?$/i.test(path));
report(
  `Node runtime: ${nodeBinary ? `present (${relative(tree, nodeBinary).split(sep).join("/")})` : "absent"}; ` +
    `a LICENSE file alongside the tree: ${nodeLicence ? `present (${relative(tree, nodeLicence).split(sep).join("/")})` : "absent"}.`
);

/* ---------------------------------------------------------------------------
 * 5. THE CONTRADICTION CHECK -- the only thing here that can fail a build.
 * ------------------------------------------------------------------------ */
const noticesDenyLgpl = notices !== null && notices.includes(NOTICES_DENIES_LGPL);
const problems = [];

if (family.length > 0 && noticesDenyLgpl) {
  problems.push(
    `${family.length} libmpv/FFmpeg binary(ies) are in this tree while ${NOTICES_FILE} still states ` +
      `"${NOTICES_DENIES_LGPL}". That is a shipped LGPL binary with no written offer and no ` +
      `attribution. Regenerate the notices from the packaged tree, and satisfy the LGPL written-offer ` +
      `obligation in the installer rather than in a README nobody ships (PW-0208, docs/LICENSING.md §2).`
  );
}
/*
 * AN ATTRIBUTION FOR A COMPONENT NOTHING BACKS, read from the TABLE.
 *
 * THIS BRANCH WAS WRONG WHEN FIRST WRITTEN, and the repaired notices
 * document is what proved it. It used to ask "does the document treat the
 * LGPL obligation as live while no libmpv or FFmpeg BINARY is present", on
 * the assumption that libmpv was the only copyleft component this product
 * could ever have. `@img/sharp-libvips-*` is LGPL-3.0-or-later, is not
 * libmpv or FFmpeg, and ships as a `.node` addon rather than a DLL with a
 * recognisable name -- so the first correct document this project has ever
 * generated was refused by this check for telling the truth.
 *
 * The question is not which binaries are present. It is whether the
 * document's own table names a component the obligation can attach to.
 */
const copyleftRows =
  notices === null
    ? []
    : notices
        .split("\n")
        .filter((line) => line.startsWith("| ") && !line.startsWith("| ---") && !line.startsWith("| Package "))
        .filter((line) => /\bL?GPL\b/i.test(line));
if (notices !== null && !noticesDenyLgpl && /\bL?GPL\b/i.test(notices) && copyleftRows.length === 0 && family.length === 0) {
  problems.push(
    `${NOTICES_FILE} treats a copyleft obligation as live, but neither its own component table nor ` +
      `this tree contains anything it could attach to. An attribution for a component nobody ships ` +
      `is a false statement in the other direction.`
  );
}

/* ---------------------------------------------------------------------------
 * AND THE CONTRADICTION INSIDE THE DOCUMENT, which is the one that was
 * actually true the first time this script was pointed at a real tree.
 *
 * THIS IS NOT HYPOTHETICAL AND IT IS NOT ABOUT libmpv. Run against a real
 * packaged sidecar, `apps/desktop/scripts/collect-notices.mjs` produced a
 * document whose own table says
 *
 *     | `@img/sharp-libvips-linux-x64` | 1.3.2 | LGPL-3.0-or-later | **none found** |
 *
 * and whose written-offer section, forty lines later, says "No component
 * shipped in this build is LGPL today." Both sentences are in one generated
 * file. `sharp` arrives as Next's image-optimisation dependency and carries
 * prebuilt libvips, which is LGPL-3.0-or-later; nobody put it there on
 * purpose and nobody noticed it was there.
 *
 * The denial is a STATIC STRING in the generator, written when the only LGPL
 * component anyone expected was libmpv. It is not derived from the table it
 * sits beneath, so the table can fill up with LGPL rows underneath a sentence
 * swearing there are none.
 *
 * Checked by reading the DOCUMENT rather than the filenames, because that is
 * where this class of mistake lives: a component can be LGPL without being
 * named like libmpv, and the notices already know its licence.
 * ------------------------------------------------------------------------ */
if (notices !== null && noticesDenyLgpl) {
  /* Table rows only -- `| name | version | licence | text |` -- so the prose
   * ABOUT the LGPL obligation, which legitimately says "LGPL" several times,
   * cannot make this fire. */
  const lgplRows = copyleftRows;
  if (lgplRows.length > 0) {
    problems.push(
      `${NOTICES_FILE} CONTRADICTS ITSELF: its own component table declares ${lgplRows.length} ` +
        `(L)GPL-licensed component(s) while its written-offer section states ` +
        `"${NOTICES_DENIES_LGPL}". The rows:\n` +
        lgplRows.map((row) => `      ${row.trim()}`).join("\n") +
        `\n    The denial is a static sentence in apps/desktop/scripts/notices.mjs and is not derived ` +
        `from the table above it. Either the component must not ship, or the offer must be real.`
    );
  }
}

if (problems.length > 0) {
  console.error("");
  console.error("distribution-inventory: the binaries and the notices contradict each other:");
  for (const problem of problems) console.error(`  ${problem}`);
  console.error("");
  console.error("This is the one thing this script refuses. Everything else above is reported, because");
  console.error("what may ship is a licensing judgement and not a script's to make.");
  process.exit(1);
}

/*
 * THE COPYLEFT INVENTORY IS REPORTED EVEN WHEN NOTHING IS WRONG, because it
 * is the evidence PW-0208 is waiting on. A check that only speaks up on
 * failure leaves a reviewer asking "and what DOES it ship?" every time.
 */
if (copyleftRows.length === 0) {
  report(`copyleft components declared in ${NOTICES_FILE}: NONE.`);
} else {
  report(`copyleft components declared in ${NOTICES_FILE}: ${copyleftRows.length}`);
  for (const row of copyleftRows) report(`  ${row.trim()}`);
}

report(
  `agreement: libmpv/FFmpeg ${family.length === 0 ? "ABSENT" : "PRESENT"}; ` +
    `${NOTICES_FILE} ${
      notices === null
        ? "is absent, so it claims nothing"
        : noticesDenyLgpl
          ? "denies shipping any copyleft component"
          : copyleftRows.length === 0
            ? "makes no copyleft claim"
            : `declares ${copyleftRows.length} copyleft component(s) and a live offer`
    }. No contradiction between them.`
);
report("H.264/HEVC patent authorisation is NOT addressed by any line above and cannot be inferred from it.");
