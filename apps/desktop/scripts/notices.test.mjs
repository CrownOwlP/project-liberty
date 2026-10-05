#!/usr/bin/env node
/* -------------------------------------------------------------------------
 * The notices decisions, tested where no Windows bundle is needed (PW-0208)
 *
 *     node --test apps/desktop/scripts/notices.test.mjs
 *
 * WHAT IS TESTED HERE AND WHAT IS NOT. `notices.mjs` is a pure function from
 * (manifest, filenames) to a verdict, and from verdicts to a document; none
 * of that needs a packaged tree, and all of it is where the reasoning lives.
 * Walking a real `sidecar/server/node_modules` is `collect-notices.mjs`'s
 * job and it happens on the machine that packages, which is Windows.
 *
 * NOTHING IN THIS REPOSITORY RUNS THIS FILE AUTOMATICALLY YET, and that is
 * stated rather than left to be discovered. `apps/desktop` has no
 * `package.json`, so it is not an npm workspace and turbo never reaches it;
 * `npm run test:scripts` lives in the root `package.json`, which is outside
 * PW-0208's write surface. The same gap already applies to
 * `scripts/windows/test-lifecycle.mjs`'s CI step. Both are named in the round
 * handoff as one finding rather than worked around twice.
 * ---------------------------------------------------------------------- */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  declaredLicence,
  isLicenceFileName,
  licenceEvidence,
  needsAttention,
  renderNotices
} from "./notices.mjs";

const here = dirname(fileURLToPath(import.meta.url));

describe("a manifest's licence field has had three shapes and all of them count", () => {
  it("reads a plain string", () => {
    assert.equal(declaredLicence({ license: "MIT" }), "MIT");
    assert.equal(declaredLicence({ license: "  Apache-2.0 " }), "Apache-2.0");
  });

  it("reads the legacy object and array forms rather than ignoring them", () => {
    /* npm carried `{ type, url }` and a `licenses` array for years. A package
     * old enough to use them is exactly the kind whose terms matter, so
     * reading only the modern shape would drop the interesting cases. */
    assert.equal(declaredLicence({ license: { type: "ISC", url: "x" } }), "ISC");
    assert.equal(
      declaredLicence({ licenses: [{ type: "MIT" }, { type: "GPL-2.0" }] }),
      "MIT OR GPL-2.0"
    );
  });

  it("DECLARES NOTHING rather than guessing, for everything else", () => {
    for (const manifest of [null, {}, { license: "" }, { license: 7 }, { licenses: [] }]) {
      assert.equal(declaredLicence(manifest), null);
    }
  });
});

describe("licence files are recognised by name, and documentation is not one", () => {
  it("accepts the spellings that actually ship", () => {
    for (const name of ["LICENSE", "LICENCE", "license", "COPYING", "NOTICE", "LICENSE.md", "LICENSE-MIT"]) {
      assert.equal(isLicenceFileName(name), true, name);
    }
  });

  it("rejects files that are ABOUT licensing without being a licence", () => {
    /* `LICENSING.md` is a discussion; `licenses.json` is a manifest of other
     * people's claims. Counting either as shipped licence text would be the
     * manifest mistake in a different costume. */
    for (const name of ["LICENSING.md", "licenses.json", "README.md", "src/license.js"]) {
      assert.equal(isLicenceFileName(name), false, name);
    }
  });
});

describe("the four verdicts, because a single licence string cannot carry them", () => {
  const cases = [
    [{ license: "MIT" }, ["LICENSE"], "declared-and-shipped"],
    [{ license: "MIT" }, [], "declared-only"],
    [{}, ["LICENSE"], "shipped-only"],
    [{}, [], "neither"]
  ];

  it("classifies each combination exactly once", () => {
    for (const [manifest, files, expected] of cases) {
      assert.equal(licenceEvidence("p", "1.0.0", manifest, files).verdict, expected);
    }
  });

  it("keeps the declaration and the shipped text as SEPARATE facts", () => {
    /*
     * The whole point. `docs/RESEARCH_PLAYBACK.md` finding 2: every prebuilt
     * ffprobe on npm is a GPL-3.0 binary and several declare otherwise. A
     * record that collapsed to one string could not express the disagreement
     * that finding is about.
     */
    const entry = licenceEvidence("ffprobe-static", "5.2.0", { license: "MIT" }, ["LICENSE"]);
    assert.equal(entry.declared, "MIT");
    assert.deepEqual(entry.files, ["LICENSE"]);
  });

  it("sorts the file list so a regenerated document does not reshuffle", () => {
    const entry = licenceEvidence("p", "1", {}, ["NOTICE", "LICENSE", "COPYING"]);
    assert.deepEqual(entry.files, ["COPYING", "LICENSE", "NOTICE"]);
  });

  it("`needsAttention` is only the total absence, not a missing file", () => {
    const entries = [
      licenceEvidence("a", "1", { license: "MIT" }, []),
      licenceEvidence("b", "1", {}, ["LICENSE"]),
      licenceEvidence("c", "1", {}, [])
    ];
    assert.deepEqual(needsAttention(entries).map((e) => e.name), ["c"]);
  });
});

describe("the document the installer carries", () => {
  const entries = [
    licenceEvidence("zod", "3.23.8", { license: "MIT" }, ["LICENSE"]),
    licenceEvidence("acme", "0.1.0", {}, [])
  ];
  const runtime = { path: "node.exe", bytes: 123, licenceText: null };

  it("is ordered, so a regeneration diff is about licences and not about order", () => {
    const first = renderNotices(entries, runtime);
    const second = renderNotices([...entries].reverse(), runtime);
    assert.equal(first, second);
  });

  it("carries no timestamp, for the same reason", () => {
    /* A file whose only change is the hour it was built teaches people to
     * ignore its changes. */
    assert.doesNotMatch(renderNotices(entries, runtime), /\d{4}-\d{2}-\d{2}T/);
  });

  it("gives the no-evidence packages their own heading rather than a table row", () => {
    const document = renderNotices(entries, runtime);
    assert.match(document, /## Packages with no licence evidence at all/);
    const section = document.slice(document.indexOf("## Packages with no licence evidence"));
    assert.match(section, /`acme` 0\.1\.0/);
    assert.doesNotMatch(section, /`zod`/);
  });

  it("says so plainly when every package has evidence", () => {
    const clean = renderNotices([entries[0]], runtime);
    assert.match(clean, /None\. Every package above either declares a licence/);
  });

  it("NAMES A MISSING RUNTIME LICENCE INSTEAD OF OMITTING IT", () => {
    /* The obligation does not disappear because the file was not copied. */
    assert.match(renderNotices(entries, runtime), /No `LICENSE` accompanied this binary/);
    const withText = renderNotices(entries, { ...runtime, licenceText: "LICENSE" });
    assert.doesNotMatch(withText, /No `LICENSE` accompanied this binary/);
  });

  it("THE OFFER IS DERIVED FROM THE TABLE, so the document cannot contradict itself", () => {
    /*
     * ==================================================================
     * THIS CASE USED TO ASSERT THE DEFECT (PL-0739)
     * ==================================================================
     *
     * It read:
     *
     *   assert.match(document, /No component shipped in this build is LGPL today/);
     *
     * and it passed for every round this generator has existed, because the
     * sentence it pinned was a STRING in `renderNotices` rather than a
     * reading of the table above it. Run against a real packaged sidecar,
     * the generator produced a document whose own table said
     *
     *   | `@img/sharp-libvips-linux-x64` | 1.3.2 | LGPL-3.0-or-later | **none found** |
     *
     * three times over, and then denied it forty lines later. `sharp`
     * arrives as Next's image-optimisation dependency and carries prebuilt
     * libvips. Nobody added it deliberately and nobody noticed -- and this
     * assertion is part of why nobody noticed.
     *
     * THE REPOSITORY'S OWN WARNING APPLIES TO THIS EDIT, which is why it is
     * this loud: "updating an expected value to match reality is
     * byte-for-byte indistinguishable from updating it to match a
     * regression". So the replacement does NOT pin a new sentence. It
     * asserts the PROPERTY that makes the old sentence impossible to get
     * wrong again -- the offer is computed from the same list the table is
     * rendered from, and both branches of that computation are driven here.
     */
    const document = renderNotices(entries, runtime);
    assert.match(document, /## Written offer/);
    assert.match(document, /three years/);

    /* No copyleft row in `entries`, so the offer must say it has nothing to
     * attach to -- and must NOT be phrased as a standing promise about the
     * product's future, which is what made the old sentence outlive its
     * truth. */
    assert.match(document, /No component in the table above declares a copyleft licence/);
    assert.doesNotMatch(document, /No component shipped in this build is LGPL today/);
  });

  it("and when the table HAS a copyleft row, the same document says the offer is live", () => {
    /*
     * THE OTHER BRANCH, AND THE ONE THAT WAS FALSE IN PRODUCTION. Driven
     * with the real shape: a declared LGPL licence and no licence text
     * shipped, which is exactly what the three sharp rows look like.
     */
    const libvips = licenceEvidence(
      "@img/sharp-libvips-win32-x64",
      "1.3.2",
      { license: "LGPL-3.0-or-later" },
      []
    );
    const document = renderNotices([...entries, libvips], runtime);

    assert.match(document, /The offer above is live: 1 component\(s\)/);
    assert.match(document, /@img\/sharp-libvips-win32-x64/);
    assert.doesNotMatch(document, /No component in the table above declares a copyleft licence/);
    /* The second, separate obligation: the licence TEXT must travel with the
     * binary, and the three real rows all say **none found**. */
    assert.match(document, /no licence text ships with it/);
  });

  it("a conjunction containing a copyleft term counts, because the obligation does", () => {
    /*
     * `@img/sharp-wasm32` declares `Apache-2.0 AND LGPL-3.0-or-later AND
     * MIT`. A matcher that only recognised a bare `LGPL-3.0-or-later` would
     * have missed one of the three components actually shipping, and the
     * document would have been accurate about two of them -- which is a
     * harder error to spot than being wrong about all three.
     */
    const dual = licenceEvidence(
      "@img/sharp-wasm32",
      "0.35.3",
      { license: "Apache-2.0 AND LGPL-3.0-or-later AND MIT" },
      []
    );
    assert.match(renderNotices([dual], runtime), /The offer above is live: 1 component\(s\)/);
  });

  it("a permissive licence that merely CONTAINS the letters is not copyleft", () => {
    /*
     * NON-VACUITY FOR THE MATCHER. The word-boundary test is what keeps this
     * from firing on an invented `GPL-ish` or on prose; without it the check
     * would declare an offer live over a table of MIT packages and be
     * switched off the first time somebody read the document.
     */
    const mit = licenceEvidence("ordinary", "1.0.0", { license: "MIT" }, ["LICENSE"]);
    const apache = licenceEvidence("other", "2.0.0", { license: "Apache-2.0" }, ["LICENSE"]);
    const document = renderNotices([mit, apache], runtime);
    assert.match(document, /No component in the table above declares a copyleft licence/);
  });

  it("survives a package name containing a table separator", () => {
    const odd = licenceEvidence("we|ird", "1", { license: "M|T" }, []);
    const document = renderNotices([odd], runtime);
    assert.match(document, /we\\\|ird/);
    assert.match(document, /M\\\|T/);
  });

  it("reports an absent runtime rather than pretending one shipped", () => {
    assert.match(renderNotices(entries, null), /No runtime binary was found/);
  });
});

/* -------------------------------------------------------------------------
 * THE GENERATOR REFUSES AN UNDESCRIBED TREE (PW-0208)
 *
 * gpt-architect's round-111 verdict asks, among the distribution evidence,
 * that "strict notice generation fails on missing evidence rather than
 * silently producing a green result". It did not. A packaged tree whose
 * `server/node_modules` was missing or empty produced a notices document
 * listing nothing, printed "0 package(s), 0 with no licence evidence" and
 * exited 0 -- and `--strict` could not catch it either, because it fires on
 * `attention.length > 0` and an empty tree has nothing to pay attention to.
 * The strictest setting available was GREEN on the one input where the
 * evidence was entirely absent.
 *
 * These drive the real script as a child process rather than importing a
 * function, because the thing being tested is an exit code and a file on
 * disk, which is what the packaging step depends on.
 * ---------------------------------------------------------------------- */
describe("a tree this finds nothing in is unknown, not clean", () => {
  const script = join(here, "collect-notices.mjs");

  /** Run the real generator against a throwaway tree. */
  const run = (dir, ...args) =>
    spawnSync(process.execPath, [script, dir, ...args], { encoding: "utf8" });

  /** A packaged-sidecar-shaped tree, with whatever packages are asked for. */
  function tree(name, packages) {
    const root = mkdtempSync(join(tmpdir(), `notices-${name}-`));
    for (const [pkg, manifest, licence] of packages) {
      const dir = join(root, "server", "node_modules", ...pkg.split("/"));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify(manifest), "utf8");
      if (licence !== null) writeFileSync(join(dir, "LICENSE"), licence, "utf8");
    }
    return root;
  }

  it("describes a tree that HAS packages, so the refusals below mean something", () => {
    /*
     * THE CONTROL CASE. Every assertion after this one is about a refusal,
     * and a script that refused everything would satisfy all of them. This
     * is the one that says the generator still works.
     */
    const root = tree("ok", [
      ["alpha", { name: "alpha", version: "1.0.0", license: "MIT" }, "MIT License\n"],
      ["@scope/beta", { name: "@scope/beta", version: "2.0.0" }, null]
    ]);
    const result = run(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /2 package\(s\), 1 with no licence evidence/);
    assert.ok(statSync(join(root, "THIRD-PARTY-NOTICES.md")).size > 0);
    rmSync(root, { recursive: true, force: true });
  });

  it("REFUSES a tree with no node_modules at all", () => {
    const root = mkdtempSync(join(tmpdir(), "notices-bare-"));
    mkdirSync(join(root, "server"), { recursive: true });
    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /found no packages/);
    /* AND IT WROTE NOTHING. A document listing nothing is worse than no
     * document: it is a confident claim about a tree nobody looked at. */
    assert.equal(existsSync(join(root, "THIRD-PARTY-NOTICES.md")), false);
    rmSync(root, { recursive: true, force: true });
  });

  it("REFUSES an empty node_modules, which is the same thing one level down", () => {
    const root = mkdtempSync(join(tmpdir(), "notices-empty-"));
    mkdirSync(join(root, "server", "node_modules"), { recursive: true });
    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /found no packages/);
    rmSync(root, { recursive: true, force: true });
  });

  it("REFUSES IT UNDER --strict TOO, which is the regression that mattered", () => {
    /*
     * The specific hole: `--strict` is the setting a packaging job would
     * reach for to be careful, and on an empty tree it was the setting that
     * passed. Asserted separately from the case above because the two were
     * reached by different code paths and only one of them was ever wrong.
     */
    const root = mkdtempSync(join(tmpdir(), "notices-strict-"));
    mkdirSync(join(root, "server", "node_modules"), { recursive: true });
    assert.equal(run(root, "--strict").status, 1);
    rmSync(root, { recursive: true, force: true });
  });

  it("still refuses a described tree under --strict when evidence is missing", () => {
    /*
     * The ORIGINAL `--strict` behaviour, asserted here so the new refusals
     * cannot be mistaken for having replaced it. A tree with packages, one
     * of which neither declares a licence nor carries one, still fails.
     */
    const root = tree("strictreal", [
      ["alpha", { name: "alpha", version: "1.0.0", license: "MIT" }, "MIT License\n"],
      ["@scope/beta", { name: "@scope/beta", version: "2.0.0" }, null]
    ]);
    const result = run(root, "--strict");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /neither declare a licence nor carry one/);
    rmSync(root, { recursive: true, force: true });
  });
});
