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
import {
  MSIEXEC_SPAWN_OPTIONS,
  MSIEXEC_TIMEOUT_MS,
  classifyInvocation,
  jobFailed,
  parseArguments
} from "./lifecycle.mjs";

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

  /* =======================================================================
   * THE TWO PLACES THE DERIVED IDENTITY IS WRITTEN DOWN A SECOND TIME
   *
   * WHAT STOOD HERE AND WHY IT WAS WRONG (PL-0727). One case, "agrees with
   * the install path the Windows workflow asserts", required that
   * `.github/workflows/windows.yml` CONTAIN the literal
   * `<productName>\<executable>`, on the premise its comment stated: "That
   * workflow hard-codes Program Files\Project Liberty". CI #180's validate
   * job went red on it, and nothing had been renamed.
   *
   * PW-0307 (commit 9c6abd4) deleted that literal deliberately. It replaced
   * an inline `Test-Path` against a written-down executable path with `node
   * scripts/windows/verify-install.mjs`, which DERIVES the paths it checks
   * from `apps/desktop/src-tauri/src/sidecar.rs`. The block it removed
   * explains why in its own words: the path had already drifted once because
   * it was "written down in a third place".
   *
   * So the workflow moved to derivation -- which is better, and is what this
   * check's own comment said it wanted -- and the check went on demanding
   * the literal the move had removed. The sixth time a check in this
   * repository has reported a fault that was not there, and the standing
   * rule applies again: fix the check, do not restore what it misses.
   * Restoring the literal would re-create the third copy PW-0307 removed.
   *
   * WHAT THE CHECK IS NOW. The correspondence is real; it moved. Two
   * literals still exist and both are worth guarding:
   *
   *   - `windows.yml` still writes the PRODUCT NAME, in the install root it
   *     prints before the harness runs;
   *   - `verify-install.mjs` still writes the EXECUTABLE, in the first entry
   *     of its required list, because no Rust constant carries it -- it
   *     comes from Cargo.toml's binary name.
   *
   * Each is compared against the value derived from the files the shell
   * compiles, so a rename fails here rather than on a runner.
   * ==================================================================== */

  /**
   * Require a literal, or refuse saying which two things disagree.
   *
   * A FUNCTION RATHER THAN AN INLINE `assert.ok`, so the third case can hand
   * it text that DISAGREES and prove it refuses. An `includes` against a
   * string absent from both sides passes forever, which is exactly the shape
   * of the check this replaces.
   */
  const mustMention = (text, literal, where) => {
    if (!text.includes(literal)) {
      throw new Error(
        `${where} does not mention ${literal}, which is derived from the files the shell ` +
          `compiles; one of the two has been renamed without the other`
      );
    }
  };

  it("the workflow's install root agrees with the derived product name", () => {
    const workflow = readFileSync(join(REPO_ROOT, ".github", "workflows", "windows.yml"), "utf8");
    mustMention(workflow, `"${IDENTITY.productName}"`, ".github/workflows/windows.yml");
  });

  it("verify-install's executable agrees with the derived executable", () => {
    /*
     * THIS IS WHERE THE EXECUTABLE LITERAL LIVES NOW, and it is the one copy
     * PW-0307 did not eliminate: `verify-install.mjs` derives the SIDECAR
     * paths from `sidecar.rs` and then writes the shell's own filename out by
     * hand. So this case is what keeps that copy honest, and it is the reason
     * the executable's disappearance from the workflow is not an untested
     * gap -- the correspondence is asserted here, against the file that still
     * carries it.
     */
    const verify = readFileSync(join(REPO_ROOT, "scripts", "windows", "verify-install.mjs"), "utf8");
    mustMention(verify, `"${IDENTITY.executable}"`, "scripts/windows/verify-install.mjs");
  });

  it("A CROSS-CHECK THAT CANNOT FAIL IS NOT A CROSS-CHECK", () => {
    /*
     * NON-VACUITY, ON THE REAL COMPARISON. Both cases above pass today; so
     * would a check whose literal appeared in neither file, which is how the
     * replaced case survived a deliberate removal for a whole round. This
     * drives the same function with text that disagrees and requires the
     * refusal.
     */
    assert.throws(
      () => mustMention('Join-Path ${env:ProgramFiles} "Liberty Player"', `"${IDENTITY.productName}"`, "a renamed workflow"),
      /has been renamed without the other/
    );
    assert.throws(
      () => mustMention('path: join(root, "liberty-player.exe"),', `"${IDENTITY.executable}"`, "a renamed verifier"),
      /has been renamed without the other/
    );
    /* AND IT ACCEPTS THE AGREEING CASE, so the rule is not simply "throw". */
    assert.doesNotThrow(() =>
      mustMention(`x = "${IDENTITY.productName}"`, `"${IDENTITY.productName}"`, "an agreeing file")
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

describe("an msiexec that never returns (PL-0745)", () => {
  /*
   * WHY THIS BLOCK EXISTS. `lifecycle.mjs` called `spawnSync("msiexec.exe")`
   * four times with no `timeout`, and Windows Installer serialises on the
   * `_MSIExecute` mutex -- a process holding it makes the next invocation
   * WAIT rather than fail. The step that decides F1, F3 and F4 had no
   * deadline anywhere in its chain.
   *
   * None of these cases runs msiexec; no Windows machine is needed for any of
   * them, which is the same division the rest of this file keeps. What IS
   * exercised for real is Node's timeout behaviour, because the whole repair
   * rests on it and asserting a belief about `spawnSync` back to myself would
   * prove nothing.
   */

  it("NODE REALLY BEHAVES THIS WAY -- a timed-out child, not a stubbed one", () => {
    const timedOut = spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], {
      encoding: "utf8",
      timeout: 250,
      killSignal: "SIGKILL"
    });
    assert.equal(timedOut.status, null, "a killed child has no exit status");
    assert.equal(timedOut.error?.code, "ETIMEDOUT");
  });

  it("AND SO DOES A MISSING BINARY, WHICH IS THE TRAP", () => {
    /*
     * The reason the old code could not tell these apart: a timeout and an
     * absent executable BOTH produce `status: null`. `status !== 0` reported
     * each as a bare fail with nothing to read, so "the installer is broken"
     * and "msiexec is not on this machine" looked identical in the report.
     */
    const missing = spawnSync("definitely-not-a-real-binary-pl0745", [], {
      encoding: "utf8",
      timeout: 250
    });
    assert.equal(missing.status, null, "the trap: this is null too");
    assert.equal(missing.error?.code, "ENOENT");
  });

  it("a stall is a FAIL whose reason says it is a stall, not an installer defect", () => {
    const verdict = classifyInvocation({
      status: null,
      timedOut: true,
      timeoutMs: 180_000,
      spawnError: null
    });
    assert.equal(verdict.outcome, "fail");
    assert.match(verdict.reason, /THIS IS A STALL, NOT AN INSTALLER DEFECT/);
    assert.match(verdict.reason, /_MSIExecute/);
    // "we did not find out" is the claim, and it must be in the text a person
    // reads rather than inferable from the absence of one.
    assert.match(verdict.reason, /Nothing was learned about this case/);
  });

  it("A STALL IS NEVER A PASS AND NEVER A not-run", () => {
    /*
     * The two outcomes that would let a release through or read as a
     * deliberate skip. `not-run` in this harness means the evidence does not
     * exist -- F2 has no previous release -- and a stall means nobody found
     * out, which is a different sentence entirely.
     */
    const verdict = classifyInvocation({ status: null, timedOut: true, timeoutMs: 1, spawnError: null });
    assert.notEqual(verdict.outcome, "pass");
    assert.notEqual(verdict.outcome, "not-run");
    assert.equal(jobFailed([{ outcome: verdict.outcome }]), true, "a stall must fail the job");
  });

  it("a missing msiexec blames the machine, not the package", () => {
    const verdict = classifyInvocation({
      status: null,
      timedOut: false,
      timeoutMs: 180_000,
      spawnError: "ENOENT: spawnSync msiexec.exe ENOENT"
    });
    assert.equal(verdict.outcome, "fail");
    assert.match(verdict.reason, /could not be started at all/);
    assert.match(verdict.reason, /the machine, not the package/);
    assert.doesNotMatch(verdict.reason, /stall/i, "a spawn failure must not be dressed as a timeout");
  });

  it("an ordinary non-zero exit still reports its code", () => {
    const verdict = classifyInvocation({ status: 1603, timedOut: false, timeoutMs: 180_000, spawnError: null });
    assert.equal(verdict.outcome, "fail");
    assert.match(verdict.reason, /exited 1603/);
  });

  it("a success records nothing, so the real check still decides the case", () => {
    const verdict = classifyInvocation({ status: 0, timedOut: false, timeoutMs: 180_000, spawnError: null });
    assert.equal(verdict.outcome, null);
    assert.equal(verdict.reason, null);
  });

  it("the gate is the gate: any fail fails, and nothing else does", () => {
    assert.equal(jobFailed([{ outcome: "pass" }, { outcome: "not-run" }]), false);
    assert.equal(jobFailed([{ outcome: "pass" }, { outcome: "fail" }]), true);
    assert.equal(jobFailed([]), false);
  });

  it("THE DEADLINE IS ACTUALLY WIRED INTO THE SPAWN", () => {
    /*
     * The case that catches the repair being undone. Every other test here
     * drives `classifyInvocation` with a synthetic result, and all of them
     * would keep passing if `timeout` were deleted from the spawn options --
     * `timedOut` would just never become true again, on a machine nobody in
     * this container can run.
     */
    assert.equal(MSIEXEC_SPAWN_OPTIONS.timeout, MSIEXEC_TIMEOUT_MS);
    assert.ok(MSIEXEC_SPAWN_OPTIONS.timeout > 0, "a zero or absent timeout is no timeout");
    assert.equal(MSIEXEC_SPAWN_OPTIONS.killSignal, "SIGKILL");
    assert.ok(Object.isFrozen(MSIEXEC_SPAWN_OPTIONS), "nothing may relax the deadline at runtime");
  });

  it("THE DEADLINE FITS INSIDE THE STEP BOUND, which is the whole derivation", () => {
    /*
     * PL-0736 put `timeout-minutes: 15` on the step. There are four msiexec
     * invocations. If four stalls could outlast the step, the step would die
     * with no report and this deadline would have bought nothing -- so the
     * arithmetic is asserted rather than left in a comment where it can drift
     * away from the number above it.
     */
    const INVOCATIONS = 4;
    const STEP_BOUND_MS = 15 * 60 * 1000;
    const worstCase = MSIEXEC_TIMEOUT_MS * INVOCATIONS;
    assert.ok(
      worstCase < STEP_BOUND_MS,
      `four stalls would take ${worstCase} ms against a ${STEP_BOUND_MS} ms step bound`
    );
    // And with room left for the observation queries and writing the report,
    // because reporting is the point of surviving at all.
    assert.ok(STEP_BOUND_MS - worstCase >= 120_000, "too little slack left to write the report");
  });
});
