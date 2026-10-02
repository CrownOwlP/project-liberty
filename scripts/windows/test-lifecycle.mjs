#!/usr/bin/env node
/* -------------------------------------------------------------------------
 * The lifecycle harness's reasoning, tested where no Windows machine is needed
 * (PW-0503)
 *
 *     node --test scripts/windows/test-lifecycle.mjs
 *
 * ==========================================================================
 * WHAT CAN HONESTLY BE TESTED HERE, AND WHAT CANNOT
 * ==========================================================================
 *
 * Nothing in this file observes a Windows machine, and nothing in it pretends
 * to. What it tests is the part of the harness that is a DECISION rather than
 * a measurement: which cases exist and who owns them, what counts as residue,
 * whether an upgrade preserved anything, and -- the one that matters most --
 * that the harness refuses to run where it cannot see what it claims to check.
 *
 * That division is the same one the rest of this repository keeps arriving at.
 * `lib/network-state.ts` decides and `e2e/` measures; `resolveNextEpisode`
 * decides and a browser plays. Here `residue.mjs` decides and `msiexec`
 * measures. The value is that a red build on a runner points at an
 * installation, never at an argument about what "clean" means.
 *
 * THE LAST TEST IN THIS FILE IS THE IMPORTANT ONE. It runs the real script, on
 * this Linux container, and asserts it exits non-zero and says why. A harness
 * that produced a green Windows lifecycle result from a machine with no
 * Windows on it would be the worst possible failure of this task, and that is
 * the assertion standing between here and there.
 * ---------------------------------------------------------------------- */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  CERTIFICATION_PATH,
  CERTIFICATION_SECTION,
  PROCEDURES,
  REPO_ROOT,
  loadPlan,
  ownerNeedsTheCommander,
  ownerRunsAutomatically,
  parseCertificationSection,
  planFor,
  runnableHere
} from "./lifecycle-cases.mjs";
import { cargoBinaryName, locations, readIdentity, rustConstant } from "./installed-identity.mjs";
import {
  classifyResidue,
  isUnder,
  namesTheProduct,
  upgradePreservedUserData
} from "./residue.mjs";
import { parseArguments } from "./lifecycle.mjs";

const IDENTITY = readIdentity();
const HERE = join(REPO_ROOT, "scripts", "windows");

describe("the matrix is READ from the certification document, never retyped", () => {
  it("finds section F in the real file and every owner is one the harness knows", () => {
    const rows = parseCertificationSection(readFileSync(CERTIFICATION_PATH, "utf8"));
    assert.ok(rows.length >= 5, `expected section F to have rows, got ${rows.length}`);
    assert.deepEqual(
      rows.map((row) => row.id),
      rows.map((row) => row.id).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))),
      "rows should come back in the order the document lists them"
    );
    for (const row of rows) {
      assert.ok(row.scenario.length > 0, `${row.id} has no scenario text`);
      assert.ok(row.condition.length > 0, `${row.id} has no pass condition`);
    }
  });

  it("REFUSES a document it cannot read rather than falling back to its own copy", () => {
    /* The whole value of deriving is lost if a parse failure quietly produces
     * a built-in table. Each of these is a way the document could change. */
    assert.throws(() => parseCertificationSection("# Nothing like it"), /no longer contains/);
    assert.throws(
      () => parseCertificationSection(`${CERTIFICATION_SECTION}\n\nprose, no table\n\n## Next`),
      /no F-numbered rows/
    );
    assert.throws(
      () =>
        parseCertificationSection(
          `${CERTIFICATION_SECTION}\n| # | S | Owner | P |\n| --- | --- | --- | --- |\n| F1 | x | SOMEBODY | y |\n`
        ),
      /not one of/
    );
  });

  it("stops at the next heading, so section G's rows cannot leak in", () => {
    const rows = parseCertificationSection(readFileSync(CERTIFICATION_PATH, "utf8"));
    assert.ok(
      rows.every((row) => /^F\d+$/.test(row.id)),
      `section F parsed something that is not an F row: ${rows.map((r) => r.id).join(", ")}`
    );
  });
});

describe("every case is marked automated or commander-machine, with a reason", () => {
  const plan = loadPlan();

  it("classifies all of them and leaves none ambiguous", () => {
    for (const entry of plan) {
      const automated = ownerRunsAutomatically(entry.owner);
      const manual = ownerNeedsTheCommander(entry.owner);
      assert.ok(
        automated || manual || entry.owner === "BLOCKED",
        `${entry.id} is owned "${entry.owner}", which is neither automatable, nor the ` +
          `commander's, nor blocked -- the split the acceptance asks for would be invisible`
      );
      if (manual) {
        assert.ok(
          typeof entry.outstandingForCommander === "string" &&
            entry.outstandingForCommander.length > 0,
          `${entry.id} needs the commander and says nothing about what for`
        );
      }
      if (entry.owner === "BLOCKED") {
        assert.ok(entry.blockedReason, `${entry.id} is BLOCKED with no reason carried from the document`);
      }
    }
  });

  it("REFUSES an automatable case it has no procedure for", () => {
    /*
     * The failure mode this guards is a document gaining a row -- or an
     * existing row being re-owned from RIG to AUTO -- and a run afterwards
     * reporting success over a case nobody wrote any steps for.
     */
    assert.throws(
      () => planFor([{ id: "F9", scenario: "something new", owner: "AUTO", condition: "x" }]),
      /no procedure for it/
    );
  });

  it("does not offer to run a case the document gave to a person", () => {
    const rig = plan.filter((entry) => entry.owner === "RIG");
    assert.ok(rig.length > 0, "section F should have at least one RIG-only row (F5 today)");
    for (const entry of rig) {
      assert.equal(entry.plannedAutomated, false, `${entry.id} is RIG and must not be planned as automated`);
    }
  });

  it("the procedures cover exactly the automatable rows -- no more, no fewer", () => {
    /* NON-VACUITY FOR THE REFUSAL ABOVE. If the harness simply had a procedure
     * for everything, that throw could never fire in practice. */
    const automatable = plan.filter((entry) => ownerRunsAutomatically(entry.owner)).map((e) => e.id);
    assert.deepEqual([...Object.keys(PROCEDURES)].sort(), [...automatable].sort());
  });

  it("F1's automated half stops short of launching, and says so", () => {
    const f1 = plan.find((entry) => entry.id === "F1");
    assert.ok(f1, "F1 should exist");
    assert.match(f1.procedure.manualPortion, /launch/i);
    assert.doesNotMatch(f1.procedure.automatedPortion, /launch/i);
  });
});

describe("the harness refuses to claim anything off Windows", () => {
  it("names the reason rather than skipping quietly", () => {
    const linux = runnableHere("linux");
    assert.equal(linux.ok, false);
    assert.match(linux.reason, /msiexec|Windows/);
    assert.equal(runnableHere("win32").ok, true);
  });

  it("THE REAL SCRIPT, RUN HERE, EXITS NON-ZERO", () => {
    /*
     * The assertion this whole file exists for. Everything else could be
     * correct and this project would still be in trouble if a Linux run could
     * emit a Windows lifecycle report.
     */
    const run = spawnSync(process.execPath, [join(HERE, "lifecycle.mjs"), "--msi", "nowhere.msi"], {
      encoding: "utf8"
    });
    assert.notEqual(run.status, 0, "a run on this platform must not succeed");
    assert.match(`${run.stderr}`, /refusing to run on/);
  });

  it("but --plan is allowed anywhere, because it claims nothing", () => {
    const run = spawnSync(process.execPath, [join(HERE, "lifecycle.mjs"), "--plan"], {
      encoding: "utf8"
    });
    assert.equal(run.status, 0, run.stderr);
    const printed = JSON.parse(run.stdout);
    assert.equal(printed.platform, process.platform);
    assert.ok(printed.cases.length >= 5);
  });
});

describe("arguments are read strictly", () => {
  it("a flag whose value is missing is refused, not read as absent", () => {
    assert.throws(() => parseArguments(["--msi", "--out", "x"]), /--msi needs a value/);
    assert.throws(() => parseArguments(["--msi"]), /--msi needs a value/);
    assert.throws(() => parseArguments(["--nonsense"]), /unknown argument/);
  });

  it("reads the three it accepts", () => {
    const parsed = parseArguments(["--msi", "a.msi", "--previous-msi", "b.msi", "--out", "r.json"]);
    assert.deepEqual(parsed, { plan: false, msi: "a.msi", previousMsi: "b.msi", out: "r.json" });
  });
});

describe("identity is derived from the files the shell itself compiles", () => {
  it("reads the product, the identifier, the executable and the sidecar paths", () => {
    assert.equal(IDENTITY.productName, "Project Liberty");
    assert.equal(IDENTITY.identifier, "app.projectliberty.desktop");
    assert.match(IDENTITY.executable, /\.exe$/);
    assert.match(IDENTITY.serverEntry, /^sidecar\//);
    assert.match(IDENTITY.nodeExecutable, /^sidecar\//);
    assert.equal(IDENTITY.writableSubdirectories.length, 3);
  });

  it("THROWS when a constant it derives from stops being derivable", () => {
    /* Rather than quietly hard-coding what it last saw -- which is the exact
     * drift `verify-install.mjs` was written to stop. */
    assert.throws(() => rustConstant("pub const SERVER_RELATIVE_PATH: &str = compute();", "SERVER_RELATIVE_PATH"), /no longer provides/);
    assert.throws(() => cargoBinaryName("[package]\nname = \"x\"\n"), /no longer provides/);
  });

  it("locates the install root and the user-data root from the environment", () => {
    const where = locations(IDENTITY, {
      ProgramFiles: "C:\\Program Files",
      LOCALAPPDATA: "C:\\Users\\viewer\\AppData\\Local"
    });
    assert.equal(where.installRoot, "C:\\Program Files\\Project Liberty");
    assert.equal(where.executablePath, `C:\\Program Files\\Project Liberty\\${IDENTITY.executable}`);
    assert.equal(
      where.userDataRoot,
      "C:\\Users\\viewer\\AppData\\Local\\app.projectliberty.desktop"
    );
  });

  it("refuses to guess when the environment does not say", () => {
    assert.throws(() => locations(IDENTITY, { ProgramFiles: "C:\\Program Files" }), /LOCALAPPDATA/);
    assert.throws(() => locations(IDENTITY, {}), /ProgramFiles/);
  });

  it("agrees with the install path the Windows workflow asserts", () => {
    /*
     * CROSS-CHECKED AGAINST THE OTHER COPY, which is the point of declaring
     * `.github/workflows/windows.yml` as a review dependency. That workflow
     * hard-codes `Program Files\Project Liberty`; if the product is ever
     * renamed, the derived value here moves and the workflow's literal does
     * not, and this is where that is noticed -- rather than on a runner, or
     * on the commander's machine.
     */
    const workflow = readFileSync(join(REPO_ROOT, ".github", "workflows", "windows.yml"), "utf8");
    assert.ok(
      workflow.includes(`"${IDENTITY.productName}\\${IDENTITY.executable}"`) ||
        workflow.includes(`${IDENTITY.productName}\\${IDENTITY.executable}`),
      `the Windows workflow does not mention ${IDENTITY.productName}\\${IDENTITY.executable}; one ` +
        `of the two has been renamed without the other`
    );
  });
});

describe("what an uninstall is allowed to leave behind", () => {
  const where = {
    installRoot: "C:\\Program Files\\Project Liberty",
    userDataRoot: "C:\\Users\\viewer\\AppData\\Local\\app.projectliberty.desktop"
  };
  const nothingLeft = {
    installRoot: { path: where.installRoot, exists: false, entries: [] },
    userDataRoot: { path: where.userDataRoot, exists: true, entries: ["data"] },
    services: [],
    scheduledTasks: [],
    processes: []
  };

  it("a machine with nothing left is clean, and the user's data is reported as KEPT", () => {
    const verdict = classifyResidue(nothingLeft, IDENTITY);
    assert.equal(verdict.clean, true);
    assert.equal(verdict.violations.length, 0);
    assert.ok(
      verdict.kept.some((entry) => entry.path === where.userDataRoot),
      "the kept user data must be named, not implied -- the acceptance asks for it in terms"
    );
  });

  it("A CHECK THAT WAS NEVER RUN CANNOT PASS", () => {
    /*
     * The difference between an absent observation and an empty one. Collapse
     * them and a harness whose PowerShell failed reports a spotless machine.
     */
    const { services, ...withoutServices } = nothingLeft;
    void services;
    const verdict = classifyResidue(withoutServices, IDENTITY);
    assert.equal(verdict.clean, false);
    assert.deepEqual(verdict.notObserved, ["services were not inspected"]);
  });

  it("catches a service by its binary path and by its registered name", () => {
    const byPath = classifyResidue(
      {
        ...nothingLeft,
        services: [{ name: "Whatever", displayName: "W", binaryPath: `${where.installRoot}\\svc.exe` }]
      },
      IDENTITY
    );
    assert.equal(byPath.clean, false);
    assert.equal(byPath.violations[0].rule, "service-left-behind");

    const byName = classifyResidue(
      { ...nothingLeft, services: [{ name: "Project Liberty", binaryPath: "C:\\elsewhere\\x.exe" }] },
      IDENTITY
    );
    assert.equal(byName.clean, false);
  });

  it("does NOT accuse something that merely has a similar name", () => {
    /* A machine may perfectly well run "Liberty Insurance Helper", and a
     * harness that declared it to be our residue would send somebody deleting
     * a stranger's software. */
    const verdict = classifyResidue(
      {
        ...nothingLeft,
        services: [{ name: "Liberty Insurance Helper", binaryPath: "C:\\Vendor\\lih.exe" }]
      },
      IDENTITY
    );
    assert.equal(verdict.clean, true);
    assert.equal(namesTheProduct("Liberty Insurance Helper", IDENTITY), false);
    assert.equal(namesTheProduct("project liberty", IDENTITY), true);
  });

  it("catches a scheduled task and an orphaned process under the install root", () => {
    const task = classifyResidue(
      { ...nothingLeft, scheduledTasks: [{ name: "t", action: `${where.installRoot}\\x.exe` }] },
      IDENTITY
    );
    assert.equal(task.violations[0].rule, "scheduled-task-left-behind");

    const orphan = classifyResidue(
      {
        ...nothingLeft,
        processes: [
          { pid: 4, name: "node", executablePath: `${where.installRoot}\\sidecar\\node.exe` }
        ]
      },
      IDENTITY
    );
    assert.equal(orphan.violations[0].rule, "process-still-running-from-the-install-root");
  });

  it("ignores every OTHER node.exe on the machine, which is most of them", () => {
    /* Matching by name would kill the build's own Node. PW-0102's Job Object
     * is what should make an orphan impossible; this check says whether it
     * did, and it has to be able to tell the two apart. */
    const verdict = classifyResidue(
      {
        ...nothingLeft,
        processes: [
          { pid: 1, name: "node", executablePath: "C:\\Program Files\\nodejs\\node.exe" },
          { pid: 2, name: "node", executablePath: "D:\\a\\runner\\node.exe" }
        ]
      },
      IDENTITY
    );
    assert.equal(verdict.clean, true);
  });

  it("an emptied product folder is kept; one with files in it is a violation", () => {
    const empty = classifyResidue(
      { ...nothingLeft, installRoot: { path: where.installRoot, exists: true, entries: [] } },
      IDENTITY
    );
    assert.equal(empty.clean, true);

    const stale = classifyResidue(
      {
        ...nothingLeft,
        installRoot: { path: where.installRoot, exists: true, entries: ["liberty-desktop.exe"] }
      },
      IDENTITY
    );
    assert.equal(stale.violations[0].rule, "install-root-not-emptied");
  });

  it("reports honestly when there was no user data to keep", () => {
    const verdict = classifyResidue(
      { ...nothingLeft, userDataRoot: { path: where.userDataRoot, exists: false, entries: [] } },
      IDENTITY
    );
    assert.equal(verdict.clean, true, "a runner that never launched the app has none, and that is normal");
    assert.match(verdict.kept[0].what, /nothing/);
  });

  it("path containment is case- and separator-insensitive, because Windows is", () => {
    assert.equal(isUnder("c:/program files/project liberty/x.exe", where.installRoot), true);
    assert.equal(isUnder("C:\\Program Files\\Project Liberty", where.installRoot), true);
    assert.equal(isUnder("C:\\Program Files\\Project Liberty Extra\\x", where.installRoot), false);
    assert.equal(isUnder("", where.installRoot), false);
  });
});

describe("an upgrade is judged on CONTENT, not on a directory still existing", () => {
  it("passes when everything written before is still there unchanged", () => {
    const verdict = upgradePreservedUserData({ "data/db": "rows" }, { "data/db": "rows", "logs/a": "x" });
    assert.equal(verdict.preserved, true);
    assert.deepEqual(verdict.added, ["logs/a"]);
  });

  it("FAILS a file that came back empty, which an existence check would pass", () => {
    const verdict = upgradePreservedUserData({ "data/db": "rows" }, { "data/db": "" });
    assert.equal(verdict.preserved, false);
    assert.deepEqual(verdict.altered, ["data/db"]);
  });

  it("fails a file that is simply gone", () => {
    const verdict = upgradePreservedUserData({ "data/db": "rows" }, {});
    assert.equal(verdict.preserved, false);
    assert.deepEqual(verdict.missing, ["data/db"]);
  });
});
