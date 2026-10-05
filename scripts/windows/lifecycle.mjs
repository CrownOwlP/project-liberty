#!/usr/bin/env node
/* -------------------------------------------------------------------------
 * The installer's lifecycle, exercised (PW-0503)
 *
 *     node scripts/windows/lifecycle.mjs --msi <path> [--previous-msi <path>]
 *                                        [--out windows-lifecycle-report.json]
 *     node scripts/windows/lifecycle.mjs --plan      (prints the matrix, runs nothing)
 *
 * ==========================================================================
 * WHAT THIS CAN PROVE, AND THE LINE IT WILL NOT CROSS
 * ==========================================================================
 *
 * `docs/WINDOWS_CERTIFICATION.md` section F owns the five lifecycle scenarios
 * and already assigns each an owner. This script performs the AUTO half of
 * that assignment and reports the rest as outstanding, by name, with the
 * reason. It never marks a RIG row, and it cannot: the owner comes out of the
 * document, `lifecycle-cases.mjs` refuses to run anything the document did not
 * mark automatable, and the report carries the same distinction all the way to
 * its last field.
 *
 * It also refuses to run at all off Windows. Not "skips" -- refuses, with exit
 * 2. A green run on Linux would be a sentence in a log saying the Windows
 * lifecycle was exercised, produced by a process that never saw an installer,
 * and the standing instruction in this project is that fabricated Windows
 * evidence is the one failure with no recovery.
 *
 * ==========================================================================
 * F1'S MISSING HALF, STATED RATHER THAN QUIETLY DROPPED
 * ==========================================================================
 *
 * F1 is "clean install, then launch". This installs and verifies; it does not
 * launch. A `windows-latest` runner has no interactive desktop session, so
 * starting a Tauri window there either hangs or proves something much smaller
 * than the sentence claims -- and `verify-install.mjs` already drew exactly
 * this boundary in round 99: it answers "did the MSI carry the files the shell
 * will reach for" and starts nothing. The launch is the RIG half of F1 and it
 * appears in the report as outstanding work for the commander's machine.
 *
 * ==========================================================================
 * F2 NEEDS A PREVIOUS VERSION, WHICH IS A FACT ABOUT THE PROJECT
 * ==========================================================================
 *
 * The Windows workflow says it in its own comments: "an upgrade needs a
 * PREVIOUS version to upgrade FROM, and this repository has never shipped
 * one." So `--previous-msi` is optional, and when it is absent F2 is reported
 * as NOT RUN with that reason -- never as passed, and never as failed either,
 * because nothing about the product failed. The first release is what creates
 * the thing a second run can upgrade.
 * ---------------------------------------------------------------------- */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadPlan, runnableHere } from "./lifecycle-cases.mjs";
import { locations, readIdentity } from "./installed-identity.mjs";
import { classifyResidue, upgradePreservedUserData } from "./residue.mjs";

const REPORT_DEFAULT = "windows-lifecycle-report.json";

/** A marker a real first launch would never write, so its survival means something. */
const MARKER_NAME = "pw-0503-upgrade-marker.txt";

function parseArguments(argv) {
  const parsed = { plan: false, msi: null, previousMsi: null, out: REPORT_DEFAULT };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    switch (flag) {
      case "--plan":
        parsed.plan = true;
        break;
      case "--msi":
        parsed.msi = requireValue(flag, value);
        index += 1;
        break;
      case "--previous-msi":
        parsed.previousMsi = requireValue(flag, value);
        index += 1;
        break;
      case "--out":
        parsed.out = requireValue(flag, value);
        index += 1;
        break;
      default:
        throw new Error(`unknown argument ${flag}`);
    }
  }
  return parsed;
}

function requireValue(flag, value) {
  /* A flag whose value is missing must not be read as absent -- the control
   * plane learned the same lesson about `--reconcile-existing`. */
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} needs a value`);
  }
  return value;
}

/*
 * A DEADLINE ON EVERY msiexec INVOCATION (PL-0745).
 *
 * Found by PL-0736 while bounding the STEP that contains these calls. Windows
 * Installer serialises on the `_MSIExecute` mutex, and a process holding it --
 * an unattended-install service, a previous msiexec that has not exited, a
 * repair triggered by something else on the machine -- makes the next
 * invocation WAIT. Not fail. Wait. There was no deadline anywhere in the chain
 * that decides F1, F3 and F4.
 *
 * HOW 3 MINUTES WAS DERIVED, and the arithmetic is the point. A silent
 * install, uninstall or reinstall of this MSI is seconds of work, so any of
 * these numbers is far above "slow". The ceiling is what fixes it: PL-0736 put
 * a 15-minute `timeout-minutes` on the whole step, and there are FOUR
 * invocations. At 3 minutes each the pathological case -- all four stalling --
 * spends 12 minutes and still leaves time for the observation queries and the
 * report to be written, so the harness reports rather than the step dying with
 * nothing to say. At 5 minutes each it would be 20, the step bound would fire
 * first, and this deadline would have bought nothing.
 */
const MSIEXEC_TIMEOUT_MS = 180_000;

/**
 * The spawn options, hoisted out so the DEADLINE ITSELF IS TESTABLE.
 *
 * `classifyInvocation` can be driven with synthetic results all day and would
 * go on passing if someone deleted `timeout` from this object -- `timedOut`
 * would simply never become true again, on a Windows machine nobody here can
 * run. The one assertion that catches that is on the options, so they are a
 * value rather than an object literal buried in a call.
 */
export const MSIEXEC_SPAWN_OPTIONS = Object.freeze({
  encoding: "utf8",
  windowsHide: true,
  timeout: MSIEXEC_TIMEOUT_MS,
  /* SIGKILL, not the default SIGTERM: the thing being killed is a process
   * that is already not responding. */
  killSignal: "SIGKILL"
});

function msiexec(args, logName) {
  const result = spawnSync("msiexec.exe", args, MSIEXEC_SPAWN_OPTIONS);
  /*
   * THREE OUTCOMES WORE ONE FACE BEFORE THIS. Verified against a real child in
   * this container rather than assumed: on timeout `status` is null and
   * `error.code` is ETIMEDOUT; when the binary is absent `status` is ALSO null
   * and `error.code` is ENOENT; an ordinary failure has a number and no error.
   * The old code tested `status !== 0`, so a stall and a missing msiexec.exe
   * both arrived as a bare `fail` with `status: null` and nothing to read.
   */
  const code = result.error?.code;
  return {
    command: `msiexec.exe ${args.join(" ")}`,
    status: result.status,
    log: logName,
    stderr: (result.stderr ?? "").slice(0, 2000),
    timedOut: code === "ETIMEDOUT",
    timeoutMs: MSIEXEC_TIMEOUT_MS,
    spawnError: code !== undefined && code !== "ETIMEDOUT" ? `${code}: ${result.error.message}`.slice(0, 500) : null
  };
}

/**
 * What an invocation means, as a decision separate from making it.
 *
 * `null` means "nothing to record, carry on and judge the real thing". Pure,
 * exported and tested, because the alternative -- a stall quietly becoming a
 * pass or quietly becoming nothing -- is not something a Windows runner would
 * tell us about.
 *
 * A STALL IS RECORDED AS `fail`, DELIBERATELY, AND THAT IS NOT THE END STATE.
 * It is not a pass, and it is not `not-run`: in this harness `not-run` means
 * "the evidence does not exist" -- F2 has no previous release to upgrade from
 * -- and a stall means "we did not find out", which must never read as a
 * deliberate skip. A distinct `stalled` outcome would say that better, and the
 * detail below already carries `timedOut` and `timeoutMs` so one can be split
 * out mechanically. It is NOT introduced here because the annotation emitter
 * in `.github/workflows/windows.yml` raises a warning for `fail` and a notice
 * for everything else, so a new string would land on the run page looking
 * benign -- and that file is reserved by PL-0736, which is in review. Doing it
 * in two halves, with the quiet half first, is how a gate stops gating.
 */
export function classifyInvocation(result) {
  if (result.timedOut) {
    return {
      outcome: "fail",
      reason:
        `msiexec did not return within ${result.timeoutMs} ms and was killed. THIS IS A STALL, ` +
        `NOT AN INSTALLER DEFECT: Windows Installer serialises on the _MSIExecute mutex, so ` +
        `another install, repair or uninstall holding it makes this invocation wait rather than ` +
        `fail. Look for a concurrent msiexec or an unattended-install service before looking at ` +
        `the MSI. Nothing was learned about this case either way.`
    };
  }
  if (result.spawnError !== null) {
    return {
      outcome: "fail",
      reason: `msiexec.exe could not be started at all (${result.spawnError}). This is the machine, not the package.`
    };
  }
  if (result.status !== 0) {
    return { outcome: "fail", reason: `msiexec exited ${result.status}` };
  }
  return { outcome: null, reason: null };
}

/**
 * Whether the run failed, as a decision rather than an expression buried in a
 * return statement.
 *
 * Exported so the gate itself is testable. A harness whose exit code is
 * computed inline is a harness whose exit code is verified by reading it.
 */
export function jobFailed(results) {
  return results.some((entry) => entry.outcome === "fail");
}

function powershell(script) {
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 }
  );
  if (result.status !== 0) {
    throw new Error(`powershell failed (${result.status}): ${(result.stderr ?? "").slice(0, 500)}`);
  }
  const text = (result.stdout ?? "").trim();
  if (text === "") return [];
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

/**
 * Everything `classifyResidue` needs, observed rather than assumed.
 *
 * EACH QUERY IS SEPARATE AND EACH FAILURE IS LOUD. If the scheduled-task query
 * throws, the observation is absent, and an absent observation is what makes
 * the verdict non-clean -- it does not become an empty list that reads as "no
 * residue".
 */
function observe(where) {
  return {
    installRoot: {
      path: where.installRoot,
      exists: existsSync(where.installRoot),
      entries: existsSync(where.installRoot) ? readdirSync(where.installRoot) : []
    },
    userDataRoot: {
      path: where.userDataRoot,
      exists: existsSync(where.userDataRoot),
      entries: existsSync(where.userDataRoot) ? readdirSync(where.userDataRoot) : []
    },
    services: powershell(
      "Get-CimInstance Win32_Service | Select-Object Name,DisplayName,PathName | ConvertTo-Json -Compress"
    ).map((row) => ({ name: row.Name, displayName: row.DisplayName, binaryPath: row.PathName })),
    scheduledTasks: powershell(
      "Get-ScheduledTask | ForEach-Object { [pscustomobject]@{ Name = $_.TaskName; " +
        "Action = ($_.Actions | ForEach-Object { $_.Execute }) -join ';' } } | ConvertTo-Json -Compress"
    ).map((row) => ({ name: row.Name, action: row.Action })),
    processes: powershell(
      "Get-Process | Where-Object { $_.Path } | Select-Object Id,ProcessName,Path | ConvertTo-Json -Compress"
    ).map((row) => ({ pid: row.Id, name: row.ProcessName, executablePath: row.Path }))
  };
}

function verifyInstalledTree(where) {
  const script = join(import.meta.dirname, "verify-install.mjs");
  const result = spawnSync(process.execPath, [script, where.installRoot], { encoding: "utf8" });
  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().slice(0, 4000)
  };
}

function readUserData(root) {
  if (!existsSync(root)) return {};
  const contents = {};
  const walk = (directory, prefix) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) walk(full, relative);
      else if (entry.isFile()) {
        /* Content, not just names: F2 is about a viewer's profiles surviving,
         * and a file recreated empty passes an existence check. */
        try {
          contents[relative] = readFileSync(full, "utf8").slice(0, 4096);
        } catch {
          contents[relative] = "<unreadable>";
        }
      }
    }
  };
  walk(root, "");
  return contents;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const plan = loadPlan();

  if (options.plan) {
    /* READING THE PLAN IS ALLOWED ANYWHERE. It makes no claim about a machine,
     * it just prints what the certification document says and what this
     * harness can do about each row -- which is exactly the "the split is
     * visible rather than implied" the acceptance asks for, and it is useful
     * in a review on any platform. */
    console.log(JSON.stringify({ platform: process.platform, cases: plan }, null, 2));
    return 0;
  }

  const allowed = runnableHere();
  if (!allowed.ok) {
    console.error(`lifecycle: refusing to run on ${process.platform}. ${allowed.reason}`);
    console.error("lifecycle: use --plan to inspect the matrix without claiming anything.");
    return 2;
  }
  if (!options.msi) {
    console.error("lifecycle: --msi <path to the installer under test> is required");
    return 2;
  }
  if (!existsSync(options.msi)) {
    console.error(`lifecycle: no installer at ${options.msi}`);
    return 2;
  }

  const identity = readIdentity();
  const where = locations(identity, process.env);
  const results = [];
  const record = (id, outcome, detail) => {
    const planned = plan.find((entry) => entry.id === id);
    results.push({
      id,
      scenario: planned?.scenario ?? id,
      owner: planned?.owner ?? "unknown",
      outcome,
      detail,
      outstandingForCommander: planned?.outstandingForCommander ?? null
    });
    console.log(`${id} ${outcome}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  };

  /* ---- F1: clean install, then verify what landed ---------------------- */
  if (existsSync(where.installRoot)) {
    record(
      "F1",
      "not-run",
      `${where.installRoot} already exists, so this machine is not clean and a "clean install" ` +
        `result from it would be a different scenario wearing F1's name`
    );
  } else {
    const install = msiexec(
      ["/i", options.msi, "/qn", "/norestart", "/l*v", "lifecycle-install.log"],
      "lifecycle-install.log"
    );
    const verdict = classifyInvocation(install);
    if (verdict.outcome !== null) record("F1", verdict.outcome, { install, reason: verdict.reason });
    else {
      const verified = verifyInstalledTree(where);
      record("F1", verified.status === 0 ? "pass" : "fail", {
        install,
        verify: verified,
        note: "installed and verified; LAUNCHING is the RIG half and was not attempted"
      });
    }
  }

  /* ---- F2: upgrade over a previous version ----------------------------- */
  if (!options.previousMsi) {
    record(
      "F2",
      "not-run",
      "no --previous-msi was supplied. An upgrade needs a previous version to upgrade FROM and " +
        "this repository has never shipped one; the first release is what creates the thing a " +
        "second run can upgrade. This is a fact about the project, not a failure of the installer."
    );
  } else {
    mkdirSync(where.userDataRoot, { recursive: true });
    const marker = join(where.userDataRoot, MARKER_NAME);
    writeFileSync(marker, `written before the upgrade at ${new Date().toISOString()}`, "utf8");
    const before = readUserData(where.userDataRoot);

    const upgrade = msiexec(
      ["/i", options.msi, "/qn", "/norestart", "/l*v", "lifecycle-upgrade.log"],
      "lifecycle-upgrade.log"
    );
    const verdict = classifyInvocation(upgrade);
    if (verdict.outcome !== null) record("F2", verdict.outcome, { upgrade, reason: verdict.reason });
    else {
      const preservation = upgradePreservedUserData(before, readUserData(where.userDataRoot));
      record("F2", preservation.preserved ? "pass" : "fail", { upgrade, preservation });
    }
  }

  /* ---- F3: uninstall, and account for everything ----------------------- */
  const uninstall = msiexec(
    ["/x", options.msi, "/qn", "/norestart", "/l*v", "lifecycle-uninstall.log"],
    "lifecycle-uninstall.log"
  );
  const uninstallVerdict = classifyInvocation(uninstall);
  if (uninstallVerdict.outcome !== null) {
    record("F3", uninstallVerdict.outcome, { uninstall, reason: uninstallVerdict.reason });
  } else {
    const residue = classifyResidue(observe(where), identity);
    record("F3", residue.clean ? "pass" : "fail", { uninstall, residue });
  }

  /* ---- F4: reinstall after uninstall ----------------------------------- */
  const reinstall = msiexec(
    ["/i", options.msi, "/qn", "/norestart", "/l*v", "lifecycle-reinstall.log"],
    "lifecycle-reinstall.log"
  );
  const reinstallVerdict = classifyInvocation(reinstall);
  if (reinstallVerdict.outcome !== null) {
    record("F4", reinstallVerdict.outcome, { reinstall, reason: reinstallVerdict.reason });
  } else {
    const verified = verifyInstalledTree(where);
    record("F4", verified.status === 0 ? "pass" : "fail", { reinstall, verify: verified });
  }

  const outstanding = plan
    .filter((entry) => entry.outstandingForCommander !== null || entry.blockedReason !== null)
    .map((entry) => ({
      id: entry.id,
      owner: entry.owner,
      scenario: entry.scenario,
      outstanding: entry.outstandingForCommander,
      blockedReason: entry.blockedReason
    }));

  const report = {
    producedBy: "scripts/windows/lifecycle.mjs (PW-0503)",
    producedAt: new Date().toISOString(),
    platform: process.platform,
    identity,
    locations: where,
    results,
    /* NAMED, NOT COUNTED. The acceptance asks for the split to be visible;
     * a number would hide which rows a person still owes. */
    outstandingForTheCommandersMachine: outstanding,
    claim:
      "This report covers the AUTO half of docs/WINDOWS_CERTIFICATION.md section F only. It " +
      "makes no claim about launching the application, about a display, or about anything a " +
      "runner has no device for."
  };
  writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`lifecycle: wrote ${options.out}`);

  return jobFailed(results) ? 1 : 0;
}

/*
 * RUN ONLY WHEN THIS FILE IS THE ENTRY POINT, COMPARED BY RESOLVED PATH.
 *
 * The first version of this check was `process.argv[1].endsWith("lifecycle.mjs")`
 * and it was wrong within the hour: `test-lifecycle.mjs` ends with
 * `lifecycle.mjs` too, so merely importing this module to test
 * `parseArguments` ran the whole harness and exited the test process with
 * code 2. A suffix is not an identity.
 */
const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(`lifecycle: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}

export { MARKER_NAME, MSIEXEC_TIMEOUT_MS, parseArguments, readUserData };
