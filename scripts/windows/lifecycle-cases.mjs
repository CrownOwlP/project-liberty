/* -------------------------------------------------------------------------
 * The installer's lifecycle, as data, derived from the document that already
 * owns it (PW-0503)
 *
 * ==========================================================================
 * WHY THE MATRIX IS READ AND NOT RETYPED
 * ==========================================================================
 *
 * `docs/WINDOWS_CERTIFICATION.md` section F already states these cases and
 * already assigns each one an owner -- AUTO for a `windows-latest` runner, RIG
 * for the commander's machine, BLOCKED for something nobody can reach yet.
 * This task's acceptance asks that "each case is marked automated or
 * commander-machine, with the reason, so the split is visible rather than
 * implied", and the shortest route to that is a second table in this file.
 *
 * A second table would be the fourth time this repository has been bitten by
 * one fact living in two places. `verify-install.mjs` carries the history:
 * `.next/standalone` versus `dist/desktop/standalone` in round 95, a
 * hard-coded `"server.js"` in a Rust test in round 98, and the Windows
 * workflow's own third copy of the sidecar entry path in round 99 -- that last
 * one silently reduced to checking that the installer shipped a file nothing
 * ever starts.
 *
 * So the owners come OUT of the certification document, by parsing it, and
 * this file states only what a document cannot: the executable steps. If
 * somebody re-owns F2 from AUTO to RIG, the harness stops offering to run it
 * automatically, because the harness never knew the owner in the first place.
 * If the document's shape changes so this cannot read it, every function here
 * throws rather than falling back to a built-in answer -- a parser that
 * silently substitutes its own data is worse than no parser.
 *
 * ==========================================================================
 * WHAT A CASE IS, AND WHAT IT IS NOT
 * ==========================================================================
 *
 * A case here is a LIFECYCLE case: something you do to an installation. It is
 * not a test of the application's behaviour once installed -- `e2e/` owns
 * that, in a browser, and it owns it on Linux. The boundary matters because
 * the one thing this harness must never do is let a Linux run look like
 * evidence about Windows. `runnableHere()` answers `false` on every platform
 * but `win32`, with a reason, and `lifecycle.mjs` refuses rather than skipping
 * quietly.
 * ---------------------------------------------------------------------- */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "..", "..");

/** The document that owns the owner column. */
export const CERTIFICATION_PATH = join(REPO_ROOT, "docs", "WINDOWS_CERTIFICATION.md");

/** The heading whose table this reads. Changing it here changes nothing else. */
export const CERTIFICATION_SECTION = "### F. Install and update";

/**
 * Who can prove a case, in the certification document's own vocabulary.
 *
 * `AUTO+RIG` IS NOT A THIRD OWNER, it is two claims about one scenario -- a
 * runner can prove part of it and only a person can prove the rest. The
 * harness runs the AUTO half and reports the RIG half as outstanding, which is
 * the whole point of the split being visible.
 */
export const OWNERS = Object.freeze(["AUTO", "RIG", "AUTO+RIG", "BLOCKED"]);

export function ownerRunsAutomatically(owner) {
  return owner === "AUTO" || owner === "AUTO+RIG";
}

export function ownerNeedsTheCommander(owner) {
  return owner === "RIG" || owner === "AUTO+RIG";
}

/**
 * Pull section F's rows out of the certification document.
 *
 * STRICT ON PURPOSE. Every failure here throws with the reason, because the
 * alternative -- returning what it managed to find -- produces a harness that
 * runs three cases and reports success for five.
 */
export function parseCertificationSection(markdown) {
  const start = markdown.indexOf(CERTIFICATION_SECTION);
  if (start === -1) {
    throw new Error(
      `docs/WINDOWS_CERTIFICATION.md no longer contains the heading "${CERTIFICATION_SECTION}". ` +
        `This harness derives the owner of every lifecycle case from that section rather than ` +
        `keeping its own copy; fix the heading or the reference, do not re-type the table here.`
    );
  }

  const rest = markdown.slice(start + CERTIFICATION_SECTION.length);
  const end = rest.search(/\n#{2,3} /);
  const body = end === -1 ? rest : rest.slice(0, end);

  const rows = [];
  for (const line of body.split("\n")) {
    const cells = line.split("|").map((cell) => cell.trim());
    /* A markdown row is `| a | b | c | d |`, so splitting gives two empty
     * edges. Anything else is prose, the header, or the `---` separator. */
    if (cells.length !== 6 || cells[0] !== "" || cells[5] !== "") continue;
    const [, id, scenario, owner, condition] = cells;
    if (!/^F\d+$/.test(id)) continue;
    if (!OWNERS.includes(owner)) {
      throw new Error(
        `${id} in docs/WINDOWS_CERTIFICATION.md has owner "${owner}", which is not one of ` +
          `${OWNERS.join(", ")}. An owner this harness cannot read is an owner it cannot honour.`
      );
    }
    rows.push({ id, scenario, owner, condition });
  }

  if (rows.length === 0) {
    throw new Error(
      `the "${CERTIFICATION_SECTION}" section exists but no F-numbered rows could be read from ` +
        `it. Refusing to continue: a matrix that parsed to nothing would make every case pass ` +
        `vacuously.`
    );
  }
  return rows;
}

/**
 * The steps this harness knows how to perform, by case id.
 *
 * SEPARATE FROM THE OWNER, which is the document's. A case can be listed here
 * and owned by RIG -- that combination means "we could automate this and the
 * document says a person must do it", and `planFor` reports it rather than
 * running it. The reverse -- owned AUTO with no procedure here -- is the one
 * that must never be silent, and `planFor` refuses it by name.
 */
export const PROCEDURES = Object.freeze({
  F1: Object.freeze({
    key: "clean-install",
    summary: "Install the MSI on a machine that has never had it, then verify the installed tree.",
    /*
     * LAUNCH IS DELIBERATELY NOT HERE even though F1 says "then launch".
     * `verify-install.mjs` states the boundary in its own header: it answers
     * "did the MSI carry the files the shell will reach for" and does not
     * start anything. Starting a Tauri window needs a desktop session; a
     * `windows-latest` runner has no interactive one, so an automated
     * "launch" would either hang or prove something smaller than it claimed.
     * That half of F1 is the RIG half, and it is reported as outstanding.
     */
    automatedPortion: "install and verify the installed tree",
    manualPortion: "launching the application and seeing a window"
  }),
  F2: Object.freeze({
    key: "upgrade",
    summary: "Install a previous version, write user data, install the new one over it.",
    automatedPortion: "upgrade in place and prove the user-data root survived it",
    manualPortion: null
  }),
  F3: Object.freeze({
    key: "uninstall",
    summary: "Uninstall, then account for everything it did or did not leave behind.",
    automatedPortion: "uninstall and assert no service, scheduled task, orphaned process or stale install root",
    manualPortion: "confirming on a machine that has carried real user data for a while"
  }),
  F4: Object.freeze({
    key: "reinstall",
    summary: "Install again after an uninstall and verify the tree a second time.",
    automatedPortion: "reinstall and verify",
    manualPortion: null
  })
});

/**
 * One case, owner and procedure together.
 *
 * `plannedAutomated` is the honest conjunction: the document says a runner can
 * prove it AND this harness knows how. Either half missing is reported with
 * its reason rather than dropped.
 */
export function planFor(rows, procedures = PROCEDURES) {
  const unprocedured = [];
  const cases = rows.map((row) => {
    const procedure = procedures[row.id] ?? null;
    if (ownerRunsAutomatically(row.owner) && procedure === null) unprocedured.push(row.id);
    return Object.freeze({
      ...row,
      procedure,
      plannedAutomated: ownerRunsAutomatically(row.owner) && procedure !== null,
      outstandingForCommander: ownerNeedsTheCommander(row.owner)
        ? (procedure?.manualPortion ?? row.condition)
        : null,
      /*
       * BLOCKED carries its reason from the document rather than from here.
       * F6 is blocked on signing, and a harness that invented its own excuse
       * for that would drift from LAST_MILE the first time the real one
       * changed.
       */
      blockedReason: row.owner === "BLOCKED" ? row.condition : null
    });
  });

  if (unprocedured.length > 0) {
    throw new Error(
      `docs/WINDOWS_CERTIFICATION.md owns ${unprocedured.join(", ")} as automatable and this ` +
        `harness has no procedure for ${unprocedured.length === 1 ? "it" : "them"}. That is a gap ` +
        `in the harness, not in the document, and it is thrown rather than skipped so a run ` +
        `cannot report success over a case it never attempted.`
    );
  }
  return cases;
}

/** Read the document from disk and plan. The one impure function here. */
export function loadPlan(path = CERTIFICATION_PATH) {
  return planFor(parseCertificationSection(readFileSync(path, "utf8")));
}

/**
 * Whether this process may execute the automated half at all.
 *
 * THE RULE THIS WHOLE TASK TURNS ON. Everything the harness measures is a
 * Windows installer acting on a Windows machine. Run anywhere else it would
 * either fail for the wrong reason or -- worse -- find nothing and call that a
 * clean uninstall. `docs/WINDOWS_CERTIFICATION.md` says it in terms: "No row
 * of it may be marked passed from the cloud engineering session, which can
 * observe no Windows machine."
 */
export function runnableHere(platform = process.platform) {
  if (platform === "win32") return { ok: true, reason: null };
  return {
    ok: false,
    reason:
      `this harness drives msiexec and inspects Windows services, scheduled tasks and ` +
      `processes; on ${platform} there is nothing for it to observe. A run here would not be a ` +
      `weaker result, it would be a different one wearing the same name.`
  };
}
