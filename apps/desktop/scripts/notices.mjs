/* -------------------------------------------------------------------------
 * Third-party notices, decided from what is SHIPPED (PW-0208)
 *
 * ==========================================================================
 * WHY A MANIFEST'S `license` FIELD IS NOT THE ANSWER
 * ==========================================================================
 *
 * `docs/RESEARCH_PLAYBACK.md`'s finding 2 is the warning this module is built
 * around: **every prebuilt `ffprobe` on npm is a GPL-3.0 binary and several
 * declare otherwise in their package metadata.** An SBOM scanner that reads a
 * top-level `license` string reports the wrong answer with complete
 * confidence, and `docs/LICENSING.md` §5 states the rule that follows — the
 * notices have to be built from what was actually linked, not from what a
 * manifest claims.
 *
 * So this module never reduces a package to one string. It records the
 * DECLARATION and the SHIPPED TEXT as separate facts and classifies the
 * relationship between them, because the interesting cases are the ones where
 * they disagree or one is missing:
 *
 *   declared-and-shipped   a licence is named AND its text is in the package
 *   declared-only          a licence is named and NO text ships with it
 *   shipped-only           licence text ships and the manifest names nothing
 *   neither                no declaration and no text — the one to look at
 *
 * `declared-only` is not an error: plenty of correct packages name MIT and
 * omit the file. It is published rather than smoothed over because "we shipped
 * a binary and have no copy of its terms" is exactly the question counsel
 * asks, and a generator that answered it silently would be useless for the
 * only purpose it has.
 *
 * ==========================================================================
 * WHAT THIS IS FOR, IN COMPLIANCE TERMS
 * ==========================================================================
 *
 * `docs/DESKTOP_PLAYBACK.md` §9 and `docs/LICENSING.md` §7: the attribution
 * obligation has to be satisfied by **something the user receives**, not by a
 * file in a repository — "a sentence in a README nobody ships" is the phrase.
 * The rendered document goes into the packaged sidecar tree, which
 * `tauri.conf.json` already carries wholesale as a bundle resource, so it
 * reaches the installed machine without a packaging-configuration change.
 *
 * ==========================================================================
 * WHAT IT DOES NOT COVER YET, AND THE OMISSION IS THE HONEST KIND
 * ==========================================================================
 *
 * **libmpv and FFmpeg are not in this document because they are not in the
 * product.** `docs/LICENSING.md` specifies how they must be built when they
 * arrive; writing their notices now would be attributing binaries nobody
 * ships. What IS shipped today is the Node runtime and the npm packages the
 * sidecar carries, and that is what this renders.
 * ---------------------------------------------------------------------- */

/** Filenames that are licence text, not documentation about licensing. */
/* The separator is `[.-]`, not `.` alone, and the test is what found that:
 * a dual-licensed package ships `LICENSE-MIT` and `LICENSE-APACHE` beside
 * each other, and a pattern that only allowed an extension would have
 * reported both of them as no licence text at all. */
const LICENCE_FILE = /^(LICENCE|LICENSE|COPYING|NOTICE)([.-][A-Za-z0-9.-]+)?$/i;

export function isLicenceFileName(name) {
  return LICENCE_FILE.test(name);
}

/**
 * The `license` field, normalised, without inventing one.
 *
 * npm has carried three shapes over its history: a string, a `{ type, url }`
 * object, and a `licenses` array of those objects. All three are read, and
 * anything else answers `null` — which classifies as "declared nothing"
 * rather than as a guess.
 */
export function declaredLicence(manifest) {
  if (!manifest || typeof manifest !== "object") return null;
  const direct = manifest.license;
  if (typeof direct === "string" && direct.trim() !== "") return direct.trim();
  if (direct && typeof direct === "object" && typeof direct.type === "string") {
    return direct.type.trim() || null;
  }
  if (Array.isArray(manifest.licenses)) {
    const names = manifest.licenses
      .map((entry) => (entry && typeof entry.type === "string" ? entry.type.trim() : ""))
      .filter((name) => name !== "");
    if (names.length > 0) return names.join(" OR ");
  }
  return null;
}

/**
 * What we can actually say about one shipped package.
 *
 * TOTAL AND PURE: given a manifest and the names of the licence files found
 * beside it, every input lands in exactly one verdict and nothing is read
 * from disk here.
 */
export function licenceEvidence(name, version, manifest, licenceFiles) {
  const declared = declaredLicence(manifest);
  const files = [...licenceFiles].filter(isLicenceFileName).sort();
  const hasText = files.length > 0;

  let verdict;
  if (declared !== null && hasText) verdict = "declared-and-shipped";
  else if (declared !== null) verdict = "declared-only";
  else if (hasText) verdict = "shipped-only";
  else verdict = "neither";

  return Object.freeze({ name, version: version ?? null, declared, files, verdict });
}

/** The verdicts that mean a reader has to go and look. */
export function needsAttention(entries) {
  return entries.filter((entry) => entry.verdict === "neither");
}

function escapePipes(value) {
  return String(value).replace(/\|/g, "\\|");
}

/**
 * The document the installer carries.
 *
 * ORDERED AND DETERMINISTIC, because this file is regenerated on every
 * package and a diff that reshuffles rows is a diff nobody reads. No
 * timestamp for the same reason: a notices file whose only change is the hour
 * it was built teaches people to ignore its changes.
 */
/**
 * The entries whose DECLARED licence is a copyleft one carrying obligations.
 *
 * ==========================================================================
 * THIS EXISTS BECAUSE THE DOCUMENT CONTRADICTED ITSELF IN PRODUCTION
 * ==========================================================================
 *
 * The written offer below used to end with a fixed sentence: "No component
 * shipped in this build is LGPL today", written when the only copyleft
 * component anyone anticipated was libmpv. It was a STRING, not a reading of
 * the table above it, so the table could fill with LGPL rows underneath a
 * sentence swearing there were none.
 *
 * It did. Run against a real packaged sidecar, this generator produced a
 * document whose table said
 *
 *   | `@img/sharp-libvips-linux-x64` | 1.3.2 | LGPL-3.0-or-later | **none found** |
 *
 * three times over, and then denied it forty lines later. `sharp` arrives as
 * Next's image-optimisation dependency and carries prebuilt libvips. Nobody
 * added it deliberately and nobody noticed.
 *
 * So the offer is DERIVED now, and the contradiction is not fixed, it is
 * unreachable: the same list that renders the table decides what the offer
 * says. A sentence and a table cannot disagree when one is computed from the
 * other.
 *
 * ==========================================================================
 * WHAT THIS DOES NOT DO
 * ==========================================================================
 *
 * It reads the DECLARED licence string and nothing else. It does not decide
 * whether a licence is satisfied, whether a component may ship, or what any
 * obligation requires — those are questions for whoever reviews distribution,
 * and `docs/LICENSING.md` is where the answers go. Matching on the declared
 * string is deliberately crude and deliberately WIDE: `Apache-2.0 AND
 * LGPL-3.0-or-later AND MIT` counts, because a conjunction containing a
 * copyleft term carries that term's obligations.
 */
export function copyleftEntries(entries) {
  return [...entries]
    .filter((entry) => typeof entry.declared === "string" && /\bL?GPL\b/i.test(entry.declared))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function renderNotices(entries, runtime) {
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  const attention = needsAttention(sorted);

  const lines = [];
  lines.push("# Third-party notices");
  lines.push("");
  lines.push(
    "Project Liberty ships the components listed here. This file is **generated from the",
    "packaged tree** rather than written by hand, so it describes what the installer actually",
    "carries and not what a dependency list intended to carry. See `docs/LICENSING.md`."
  );
  lines.push("");
  lines.push("## The runtime");
  lines.push("");
  if (runtime === null) {
    lines.push("No runtime binary was found in the packaged tree.");
  } else {
    lines.push(`- **Node.js** — shipped as \`${runtime.path}\`, ${runtime.bytes} bytes.`);
    lines.push(
      "  Node is MIT-licensed and redistributes further components under their own terms,",
      "  all of which are stated in the `LICENSE` file of the Node distribution this binary",
      "  came from. That file is reproduced below when the packaging step can find it."
    );
    if (runtime.licenceText === null) {
      lines.push("");
      lines.push(
        "  **No `LICENSE` accompanied this binary in the packaged tree.** It is named here",
        "  rather than omitted: the obligation does not disappear because the file was not",
        "  copied, and the remedy is to copy it, not to delete this sentence."
      );
    }
  }
  lines.push("");
  lines.push("## Packages in the sidecar");
  lines.push("");
  lines.push(`${sorted.length} package(s) are present in the packaged sidecar tree.`);
  lines.push("");
  lines.push("| Package | Version | Declared licence | Licence text shipped |");
  lines.push("| --- | --- | --- | --- |");
  for (const entry of sorted) {
    lines.push(
      `| \`${escapePipes(entry.name)}\` | ${escapePipes(entry.version ?? "—")} | ` +
        `${entry.declared === null ? "**none declared**" : escapePipes(entry.declared)} | ` +
        `${entry.files.length === 0 ? "**none found**" : entry.files.map((f) => `\`${f}\``).join(", ")} |`
    );
  }
  lines.push("");
  lines.push("## Packages with no licence evidence at all");
  lines.push("");
  if (attention.length === 0) {
    lines.push(
      "None. Every package above either declares a licence, ships its text, or both."
    );
  } else {
    lines.push(
      "These ship in the product and neither declare a licence nor carry one. **This is a",
      "question for whoever reviews distribution, not a formatting problem**, and it is",
      "listed first-class rather than folded into the table above so it cannot be skimmed",
      "past."
    );
    lines.push("");
    for (const entry of attention) lines.push(`- \`${entry.name}\` ${entry.version ?? ""}`.trim());
  }
  lines.push("");
  lines.push("## Written offer");
  lines.push("");
  lines.push(
    "Where a component above is licensed under the LGPL, you are entitled to the complete",
    "corresponding source for that component, at the exact revision shipped, together with",
    "the scripts used to build it. Project Liberty will supply it for three years from the",
    "date this build was distributed. The build configuration those scripts must reproduce",
    "is specified in `docs/LICENSING.md` §2."
  );
  lines.push("");

  /*
   * DERIVED FROM THE TABLE, NOT ASSERTED BESIDE IT. See `copyleftEntries`.
   * Both branches read the same list the table above was rendered from, so
   * this paragraph cannot describe a different build than the rows do.
   */
  const copyleft = copyleftEntries(sorted);
  if (copyleft.length === 0) {
    lines.push(
      "**No component in the table above declares a copyleft licence**, so the offer has",
      "nothing to attach to in this build. It is stated in advance rather than added later",
      "because an offer written at the same moment as the binary is an offer nobody checked."
    );
  } else {
    lines.push(
      `**The offer above is live: ${copyleft.length} component(s) in the table declare a copyleft licence.**`
    );
    lines.push("");
    for (const entry of copyleft) {
      lines.push(
        `- \`${escapePipes(entry.name)}\` ${entry.version ?? ""} — ${escapePipes(entry.declared)}` +
          `${entry.files.length === 0 ? " — **no licence text ships with it**" : ""}`.trimEnd()
      );
    }
    lines.push("");
    lines.push(
      "A component listed here with **no licence text** has an unmet obligation that is",
      "separate from this offer: the licence text itself must travel with the binary. Both",
      "are distribution questions for `docs/LICENSING.md` and for whoever reviews it, not",
      "something this generator decides."
    );
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}
