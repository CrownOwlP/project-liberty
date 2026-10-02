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
import { describe, it } from "node:test";

import {
  declaredLicence,
  isLicenceFileName,
  licenceEvidence,
  needsAttention,
  renderNotices
} from "./notices.mjs";

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

  it("states the written offer, and states that nothing LGPL ships yet", () => {
    const document = renderNotices(entries, runtime);
    assert.match(document, /## Written offer/);
    assert.match(document, /three years/);
    assert.match(document, /No component shipped in this build is LGPL today/);
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
