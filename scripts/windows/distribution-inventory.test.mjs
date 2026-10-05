/* -------------------------------------------------------------------------
 * The distribution inventory, driven as a command (PL-0737)
 *
 * SPAWNED, NOT IMPORTED, for the reason `assert-no-row-runs-nowhere.test.mjs`
 * gives: the contract this script has with CI is an EXIT CODE and lines a
 * human can read in an annotation. Importing its internals would test a
 * function the workflow never calls.
 *
 * THE CASE THAT MATTERS is the contradiction one. Everything else here is
 * reporting, and a report is hard to get wrong in a way a test catches; the
 * refusal is the only thing that can fail a build, so it is the only thing
 * that has to be shown failing, in both directions, over fixture trees built
 * to look like the real one.
 * ---------------------------------------------------------------------- */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(here, "distribution-inventory.mjs");

/** The sentence `apps/desktop/scripts/notices.mjs` writes today. */
const DENIAL = "**No component shipped in this build is LGPL today.** The obligation is stated in advance.";

/**
 * A notices document shaped like the real one.
 *
 * THE TABLE SHAPE IS COPIED FROM `notices.mjs`, not invented: a header row, a
 * `| --- |` separator, then one row per package. The script counts components
 * by counting those rows, so a fixture that got the shape wrong would be
 * testing the fixture.
 */
function noticesDocument({ rows = 2, denyLgpl = true, extra = "" } = {}) {
  const lines = [
    "# Third-party notices",
    "",
    "## Packages in the sidecar",
    "",
    "| Package | Version | Declared licence | Licence text shipped |",
    "| --- | --- | --- | --- |"
  ];
  for (let i = 0; i < rows; i += 1) lines.push(`| pkg-${i} | 1.0.0 | MIT | yes |`);
  lines.push("");
  if (denyLgpl) lines.push(DENIAL);
  if (extra) lines.push(extra);
  return `${lines.join("\n")}\n`;
}

/** Builds a tree from a {relative path: contents} map and returns its root. */
function tree(files) {
  const root = mkdtempSync(join(tmpdir(), "dist-inventory-"));
  for (const [relative, contents] of Object.entries(files)) {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  return root;
}

/** The tree as it is today: Node and the sidecar, no media libraries. */
function todaysTree(overrides = {}) {
  return tree({
    "liberty-desktop.exe": "shell",
    "sidecar/node.exe": "node runtime",
    "sidecar/LICENSE": "MIT",
    "sidecar/server/THIRD-PARTY-NOTICES.md": noticesDocument(),
    "sidecar/server/liberty-sidecar.js": "entry",
    ...overrides
  });
}

function run(root, kind = "package-build-output", env = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, "--tree", root, "--kind", kind], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_ACTIONS: "", ...env }
  });
  return { code: result.status, out: result.stdout ?? "", err: result.stderr ?? "" };
}

test("the tree as it ships today is reported, and agrees with itself", () => {
  const { code, out } = run(todaysTree());
  assert.equal(code, 0, out);
  assert.match(out, /libmpv \/ FFmpeg: ABSENT/);
  assert.match(out, /THIRD-PARTY-NOTICES\.md: present/);
  assert.match(out, /2 component row\(s\)/);
  assert.match(out, /agreement: no libmpv\/FFmpeg binary/);
});

test("it names which of the three trees it read, every time", () => {
  /*
   * THE EASIEST WAY TO MISLEAD A REVIEWER is to answer a question about the
   * installed tree using the build output. The kind is required, has no
   * default, and is printed first.
   */
  assert.match(run(todaysTree(), "package-build-output").out, /PACKAGE BUILD OUTPUT/);
  assert.match(run(todaysTree(), "installed-tree").out, /INSTALLED TREE/);
  assert.match(run(todaysTree(), "source-intent").out, /SOURCE INTENT/);
});

test("it refuses to run without being told which tree this is", () => {
  const result = spawnSync(process.execPath, [SCRIPT, "--tree", todaysTree()], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--kind must be one of/);
});

test("THE REFUSAL: an FFmpeg binary while the notices still deny LGPL", () => {
  /*
   * The trap `docs/DESKTOP_PLAYBACK.md` §9 names and `RESEARCH_PLAYBACK.md`
   * already found elsewhere. A shipped LGPL binary with no written offer and
   * no attribution is the failure this whole script exists for, and it is the
   * only thing it refuses.
   */
  const { code, err } = run(todaysTree({ "sidecar/avcodec-61.dll": "ffmpeg" }));
  assert.equal(code, 1);
  assert.match(err, /contradict each other/);
  assert.match(err, /shipped LGPL binary with no written offer/);
});

test("it matches the filenames FFmpeg and libmpv ACTUALLY ship", () => {
  /*
   * THE CARE THAT MAKES THE CHECK REAL. FFmpeg does not ship a file called
   * "ffmpeg" in a library build -- it ships `avcodec-61.dll`,
   * `avformat-61.dll`, `avutil-59.dll`. libmpv ships `libmpv-2.dll` or
   * `mpv-2.dll`. A check that grepped for "ffmpeg" would report ABSENT over a
   * tree full of FFmpeg, pass forever, and prove nothing.
   */
  for (const name of [
    "avcodec-61.dll",
    "avformat-61.dll",
    "avutil-59.dll",
    "swresample-5.dll",
    "swscale-8.dll",
    "libmpv-2.dll",
    "mpv-2.dll",
    "ffprobe.exe"
  ]) {
    const { code, err } = run(todaysTree({ [`sidecar/${name}`]: "binary" }));
    assert.equal(code, 1, `${name} was not recognised as libmpv/FFmpeg`);
    assert.match(err, /contradict each other/, name);
  }
});

test("and it does NOT fire on a name that merely contains one of those words", () => {
  /*
   * The other half of the same care. A package legitimately named
   * `my-avcodec-helper` is not FFmpeg, and a check that went red over it
   * would be turned off within a week.
   */
  const { code, out } = run(todaysTree({ "sidecar/server/node_modules/x/build/helper.node": "addon" }));
  assert.equal(code, 0, out);
  assert.match(out, /libmpv \/ FFmpeg: ABSENT/);
});

test("THE OTHER DIRECTION: notices claiming a live LGPL component nobody ships", () => {
  /*
   * An attribution for a component that is not in the tree is a false
   * statement too. Caught because the denial sentence is gone AND the
   * document still talks about LGPL, with no binary to match.
   */
  const { code, err } = run(
    todaysTree({
      "sidecar/server/THIRD-PARTY-NOTICES.md": noticesDocument({
        denyLgpl: false,
        extra: "libmpv is shipped under the LGPL and the written offer above applies to it."
      })
    })
  );
  assert.equal(code, 1);
  assert.match(err, /false statement in the other direction/);
});

test("the two together agree, and that is the state after libmpv lands", () => {
  /*
   * NON-VACUITY FOR THE REFUSAL. Without this the suite would prove only that
   * the script dislikes FFmpeg. The correct future state -- the binary
   * present AND the notices updated to stop denying it -- must pass, or the
   * check would block the very change it exists to accompany.
   */
  const { code, out } = run(
    todaysTree({
      "sidecar/libmpv-2.dll": "mpv",
      "sidecar/server/THIRD-PARTY-NOTICES.md": noticesDocument({
        denyLgpl: false,
        extra: "| libmpv | 0.38.0 | LGPL-2.1-or-later | yes |"
      })
    })
  );
  assert.equal(code, 0, out);
  assert.match(out, /libmpv \/ FFmpeg: PRESENT/);
  assert.match(out, /agreement: libmpv\/FFmpeg present/);
});

test("an absent notices file is reported, not guessed at", () => {
  const root = tree({ "liberty-desktop.exe": "shell", "sidecar/node.exe": "node" });
  const { code, out } = run(root);
  assert.equal(code, 0, out);
  assert.match(out, /THIRD-PARTY-NOTICES\.md: ABSENT from this tree/);
});

test("a present-but-empty notices file is called out", () => {
  /*
   * PW-0208 already closed one hole here -- the generator reporting success
   * over a tree it found nothing in. This is the same failure observed from
   * the other end, at the installer rather than at the generator.
   */
  const { code, out } = run(todaysTree({ "sidecar/server/THIRD-PARTY-NOTICES.md": "   \n" }));
  assert.equal(code, 0, out);
  assert.match(out, /PRESENT BUT EMPTY/);
});

test("every native binary is listed with a size and a sha256", () => {
  const { out } = run(todaysTree());
  assert.match(out, /liberty-desktop\.exe {2}5 bytes {2}sha256=[0-9a-f]{64}/);
  assert.match(out, /sidecar\/node\.exe {2}12 bytes {2}sha256=[0-9a-f]{64}/);
});

test("it says the patent question is not answered here", () => {
  /*
   * NOT DECORATION. This script is going to be cited in a licensing review,
   * and the one inference that must never be drawn from it is that a file
   * list bears on whether a patent-encumbered decoder may be distributed.
   * The disclaimer travels with the evidence.
   */
  assert.match(run(todaysTree()).out, /H\.264\/HEVC patent authorisation is NOT addressed/);
});

test("on a runner it speaks in annotations, because that is the only readable channel", () => {
  const { out } = run(todaysTree(), "package-build-output", { GITHUB_ACTIONS: "true" });
  assert.match(out, /^::notice title=distribution-inventory::/m);
  assert.match(out, /::notice title=distribution-inventory::.*libmpv \/ FFmpeg: ABSENT/);
});

test("it refuses a tree that is not there, rather than reporting an empty one", () => {
  const result = spawnSync(
    process.execPath,
    [SCRIPT, "--tree", join(tmpdir(), "definitely-not-here-pl0737"), "--kind", "installed-tree"],
    { encoding: "utf8" }
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /could not be read: ENOENT/);
});

test("THE ONE THAT WAS ALREADY TRUE: the notices table contradicts its own written offer", () => {
  /*
   * NOT A HYPOTHETICAL. The first time this script was pointed at a real
   * packaged sidecar, `collect-notices.mjs` had produced a document whose
   * table said
   *
   *   | `@img/sharp-libvips-linux-x64` | 1.3.2 | LGPL-3.0-or-later | **none found** |
   *
   * and whose written-offer section said "No component shipped in this build
   * is LGPL today." Both in one generated file. `sharp` arrives as Next's
   * image-optimisation dependency and carries prebuilt libvips, which is
   * LGPL-3.0-or-later. Nobody put it there deliberately and nobody noticed.
   *
   * The denial is a static string in the generator, written when the only
   * LGPL component anyone expected was libmpv, and it is not derived from the
   * table beneath it. So the table can fill with LGPL rows under a sentence
   * swearing there are none — which is what happened.
   */
  const { code, err } = run(
    todaysTree({
      "sidecar/server/THIRD-PARTY-NOTICES.md": noticesDocument({
        rows: 0,
        denyLgpl: true,
        extra: "| `@img/sharp-libvips-win32-x64` | 1.3.2 | LGPL-3.0-or-later | **none found** |"
      })
    })
  );
  assert.equal(code, 1);
  assert.match(err, /CONTRADICTS ITSELF/);
  assert.match(err, /sharp-libvips-win32-x64/);
  assert.match(err, /static sentence in apps\/desktop\/scripts\/notices\.mjs/);
});

test("it reads the TABLE, so the prose explaining the LGPL offer cannot fire it", () => {
  /*
   * NON-VACUITY FOR THAT CHECK, AND THE REASON IT READS ROWS. The written-offer
   * section says the word "LGPL" three times by design — "Where a component
   * above is licensed under the LGPL, you are entitled to..." — so a check
   * that grepped the document would fire on every build forever and be
   * switched off by the end of the week. Today's real document, minus the
   * sharp rows, must pass.
   */
  const { code, out } = run(
    todaysTree({
      "sidecar/server/THIRD-PARTY-NOTICES.md": noticesDocument({
        rows: 3,
        denyLgpl: true,
        extra:
          "Where a component above is licensed under the LGPL, you are entitled to the complete\n" +
          "corresponding source for that component, together with the scripts used to build it."
      })
    })
  );
  assert.equal(code, 0, out);
});

test("a GPL row is caught as well as an LGPL one", () => {
  /*
   * `RESEARCH_PLAYBACK.md` already found the live version of this elsewhere:
   * "every prebuilt ffprobe on npm is a GPL-3.0 binary, and several declare
   * otherwise". A GPL component in a product that ships no source is a larger
   * problem than an LGPL one, so the row pattern must not be LGPL-only.
   */
  const { code, err } = run(
    todaysTree({
      "sidecar/server/THIRD-PARTY-NOTICES.md": noticesDocument({
        rows: 0,
        denyLgpl: true,
        extra: "| `some-prebuilt-binary` | 1.0.0 | GPL-3.0 | **none found** |"
      })
    })
  );
  assert.equal(code, 1);
  assert.match(err, /CONTRADICTS ITSELF/);
  assert.match(err, /GPL-3\.0/);
});
