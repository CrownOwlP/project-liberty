#!/usr/bin/env node
/* -------------------------------------------------------------------------
 * One command, so the commander's part is small (PL-0741)
 *
 * ==========================================================================
 * WHAT THIS IS FOR
 * ==========================================================================
 *
 * PW-0504 is the half of Windows qualification that only a person with a
 * real machine can produce: the installed application LAUNCHES, the sidecar
 * starts, the handshake completes, WebView2 renders. A runner has no
 * interactive desktop and cannot stand in for any of it.
 *
 * But most of what has to be RECORDED alongside that judgement is not
 * judgement at all — it is facts a machine can read about itself. The run
 * sheet currently asks the commander to type three PowerShell snippets, read
 * two settings pages by eye, and copy each value into a report. Every
 * hand-copied field is a field that can be wrong, missing, or quietly from
 * the wrong machine, and `docs/WINDOWS_CERTIFICATION.md`'s own rule is that
 * "a RIG pass on unrecorded hardware is not evidence".
 *
 * So: install, launch, look at the window, run this, send the file.
 *
 * ==========================================================================
 * IT CLAIMS NOTHING IT CANNOT SEE
 * ==========================================================================
 *
 * This reports that a process exists, that a file exists, that a log line is
 * present. It does NOT and must not report that the window appeared, that
 * WebView2 rendered the application, or that anything played. gpt-architect's
 * round-105 §9 says in terms: do not collapse those claims. Every section
 * that could be misread as covering them says what it does not cover.
 *
 * ABSENCE IS A FINDING, NOT A GAP. A missing `sidecar.log`, an unresolvable
 * WebView2 version, a process that is not running — each is recorded
 * explicitly. The run sheet already tells the commander an absent log is
 * itself a finding; a collector that quietly omitted it would undo that.
 *
 * NO SECRETS. The launch token is never read, no environment is dumped, and
 * nothing is taken from the handshake line beyond host and port. The shell
 * already redacts the token from the log it writes; this does not undo that
 * by capturing anything the shell was careful about.
 *
 * ==========================================================================
 * TESTABLE OFF WINDOWS
 * ==========================================================================
 *
 * Every platform fact arrives through an injected reader, the way
 * `installed-identity.mjs` takes `env` as a parameter. The composition, the
 * absence-handling and the redaction have a suite that runs on Linux. The
 * Windows commands themselves cannot be executed here, and that limit is
 * stated rather than glossed — see this task's gate evidence.
 *
 * USAGE, on the commander's machine, after installing and launching:
 *   node scripts\\windows\\qualify.mjs
 *   node scripts\\windows\\qualify.mjs --out C:\\path\\to\\report.json
 * ---------------------------------------------------------------------- */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { locations, readIdentity } from "./installed-identity.mjs";

/**
 * Bytes of `sidecar.log` to READ. Not to report.
 *
 * PL-0741 ROUND 2, after gpt-architect's CHANGES_REQUESTED against 846a1f4.
 * This constant used to bound a `tail` field that carried those bytes straight
 * into the report, which contradicted this file's own NO SECRETS acceptance --
 * and the test that was supposed to catch it asserted on
 * `JSON.stringify(log.handshake)` rather than on the object `sidecarLog`
 * returns, so it proved the handshake was clean while the tail beside it
 * carried the same bytes. **Nothing from the file's content leaves this module
 * now.** The window is still read, because the classifier below reads it; only
 * the classifier's verdict is reported.
 */
const LOG_TAIL_BYTES = 16 * 1024;

/**
 * THE ONLY THINGS THE LOG'S CONTENT MAY CONTRIBUTE TO THE REPORT.
 *
 * AN ALLOWLIST, NOT A DENYLIST, AND THAT IS THE WHOLE POINT. Redacting things
 * that "look like secrets" cannot work: a secret is whatever happened to be in
 * a URL, an argv, an environment dump or a stack frame, and no pattern
 * enumerates that. So the report cannot contain anything the log said. It can
 * only contain WHICH OF THESE FIXED PATTERNS MATCHED, which is a fact about
 * this table rather than about the file.
 *
 * `means` is written here, in this repository, for a reader six weeks from now
 * who has the report and not the machine. Each entry is a real way the sidecar
 * fails to start on Windows; this is the diagnostic value the raw tail had,
 * minus the bytes.
 */
const LOG_SIGNATURES = [
  {
    id: "port-in-use",
    pattern: /\bEADDRINUSE\b/,
    means:
      "the port the sidecar tried to bind was already taken. portpicker should make this " +
      "impossible, so if it appears, something else on the machine grabbed the port between " +
      "the pick and the bind, or a previous sidecar never exited."
  },
  {
    id: "address-unavailable",
    pattern: /\bEADDRNOTAVAIL\b/,
    means: "the sidecar could not bind to 127.0.0.1 at all, which points at the network stack or a policy."
  },
  {
    id: "permission-denied",
    pattern: /\b(EACCES|EPERM)\b/,
    means:
      "the sidecar was refused access to a file, a directory or a port. On a per-machine install " +
      "this usually means the user profile cannot write where the shell expected."
  },
  {
    id: "file-missing",
    pattern: /\bENOENT\b/,
    means: "something the sidecar opened does not exist. Most often an incomplete packaged tree."
  },
  {
    id: "module-missing",
    pattern: /\b(MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND)\b|Cannot find (module|package)/,
    means:
      "the Next standalone tree is incomplete: a module it requires was not packaged. This is a " +
      "packaging defect, not a machine problem."
  },
  {
    id: "module-format",
    pattern: /\b(ERR_REQUIRE_ESM|ERR_UNSUPPORTED_ESM_URL_SCHEME|ERR_UNKNOWN_FILE_EXTENSION)\b/,
    means: "a CommonJS/ESM mismatch in the packaged tree. Also a packaging defect."
  },
  {
    id: "native-module-failed",
    pattern: /\bERR_DLOPEN_FAILED\b|The specified module could not be found/,
    means:
      "a native addon loaded but its own DLL did not. The usual cause is a missing Visual C++ " +
      "runtime or a native dependency that was not packaged beside it."
  },
  {
    id: "node-not-found",
    pattern: /is not recognized as an internal or external command|cannot find the path specified/i,
    means: "node.exe itself was not where the shell looked for it. The sidecar never started."
  },
  {
    id: "unhandled-error",
    pattern: /\bUnhandledPromiseRejection\b|Unhandled '?error'? event|\bunhandledRejection\b/,
    means: "the sidecar threw during startup and nothing caught it."
  },
  {
    id: "fatal",
    pattern: /FATAL ERROR|JavaScript heap out of memory/,
    means: "the Node process died rather than exiting. Memory or a V8 fault."
  }
];

/**
 * Classify the log's tail WITHOUT quoting it.
 *
 * Returns counts, which are facts about shape rather than content, and the
 * signatures from the table above that matched. `lines` and `errorLines` are
 * safe because `[err]` is a prefix THE SHELL writes, not something the log's
 * subject chose.
 */
export function classifyLog(text) {
  const window = text.slice(-LOG_TAIL_BYTES);
  const lines = window.split("\n").filter((line) => line.trim().length > 0);
  const signatures = LOG_SIGNATURES.filter((signature) => signature.pattern.test(window)).map(
    ({ id, means }) => ({ id, means })
  );
  return {
    linesExamined: lines.length,
    errorLines: lines.filter((line) => line.startsWith("[err]")).length,
    bytesExamined: window.length,
    signatures,
    note:
      signatures.length > 0
        ? "The signatures above are the only content this report takes from sidecar.log. Read the " +
          "file on the machine, at the path above, for anything more."
        : "NO RECOGNISED FAILURE SIGNATURE in the examined window. That is not the same as 'no " +
          "error': it means nothing in scripts/windows/qualify.mjs's signature table matched. " +
          "Read sidecar.log on the machine, at the path above, and if its failure is one this " +
          "table should know about, add it there."
  };
}

/** The handshake prefix, which must equal `HANDSHAKE_PREFIX` in the shell. */
const HANDSHAKE_PREFIX = "liberty-sidecar-ready";

/**
 * A reading that may not be obtainable, which is itself worth recording.
 *
 * `{ value }` or `{ unavailable: "<why>" }` — never a bare null, because a
 * null in a report reads as "nothing there" when the truth is often "this
 * machine would not say".
 */
function reading(fn) {
  try {
    const value = fn();
    return value === undefined || value === null || value === ""
      ? { unavailable: "the command returned nothing" }
      : { value };
  } catch (error) {
    return { unavailable: `${error.code ?? "failed"}: ${String(error.message ?? error).slice(0, 200)}` };
  }
}

/** Runs a PowerShell expression and returns its trimmed stdout. */
export function powershell(expression) {
  return execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", expression],
    { encoding: "utf8", timeout: 30_000, windowsHide: true }
  ).trim();
}

/**
 * The environment block `docs/WINDOWS_CERTIFICATION.md` specifies.
 *
 * `run` is injected so the suite can drive every branch — including the ones
 * where a command fails, which on a real machine is how a missing WebView2
 * runtime or an absent HDR toggle presents.
 */
export function environment(run) {
  return {
    windows: reading(() =>
      run(
        "$c = Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion'; " +
          "'{0} {1} (build {2}.{3})' -f $c.ProductName, $c.DisplayVersion, $c.CurrentBuildNumber, $c.UBR"
      )
    ),
    gpu: reading(() =>
      run(
        "(Get-CimInstance Win32_VideoController | ForEach-Object { " +
          "'{0} / driver {1}' -f $_.Name, $_.DriverVersion }) -join '; '"
      )
    ),
    display: reading(() =>
      run(
        "(Get-CimInstance Win32_VideoController | ForEach-Object { " +
          "'{0}x{1} @{2}Hz' -f $_.CurrentHorizontalResolution, $_.CurrentVerticalResolution, " +
          "$_.CurrentRefreshRate }) -join '; '"
      )
    ),
    audio: reading(() => run("(Get-CimInstance Win32_SoundDevice | ForEach-Object { $_.Name }) -join '; '")),
    /*
     * THE ONE THAT MATTERS MOST AND IS LEAST LIKELY TO ANSWER. WebView2 is
     * the browser engine the whole UI runs in and it updates itself without
     * asking. The Evergreen Runtime registers under a fixed GUID; when that
     * key is absent the runtime may still be installed per-user, so an
     * unavailable reading here is a prompt to look in Settings, not proof of
     * absence — which is what the `unavailable` wording is for.
     */
    webview2: reading(() =>
      run(
        "(Get-ItemProperty 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\" +
          "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' -ErrorAction Stop).pv"
      )
    ),
    scaling: reading(() =>
      run(
        "[Math]::Round((Get-ItemProperty 'HKCU:\\Control Panel\\Desktop\\WindowMetrics' " +
          "-ErrorAction Stop).AppliedDPI / 96 * 100)"
      )
    )
  };
}

/** Is the shell running, and did it bring a Node child with it? */
export function processes(run, identity) {
  const exe = identity.executable.replace(/\.exe$/i, "");
  return {
    shell: reading(() =>
      run(
        `(Get-Process -Name '${exe}' -ErrorAction SilentlyContinue | ` +
          "ForEach-Object { 'pid {0}, started {1}' -f $_.Id, $_.StartTime }) -join '; '"
      )
    ),
    /*
     * REPORTED, NOT JUDGED. A `node.exe` on this machine may belong to
     * anything; this says how many exist, because the interesting cases are
     * "none while the shell is running" (the sidecar did not start) and
     * "some after the shell is gone" (PW-0102's job object did not hold).
     * Which of those it is, is the commander's row to mark.
     */
    nodeProcesses: reading(() =>
      run("(Get-Process -Name node -ErrorAction SilentlyContinue | Measure-Object).Count")
    )
  };
}

/** The installed tree: is it there, and does the real verifier accept it? */
export function installation(where, runVerifier) {
  const present = existsSync(where.executablePath);
  const result = {
    installRoot: where.installRoot,
    executable: present
      ? { value: where.executablePath }
      : { unavailable: `not found at ${where.executablePath}; was the MSI installed?` },
    userDataRoot: where.userDataRoot
  };
  if (!present) {
    result.verifier = { unavailable: "not run: there is no installation to verify" };
    return result;
  }
  result.verifier = reading(() => runVerifier(where.installRoot));
  return result;
}

/**
 * `sidecar.log`, and the handshake line if the sidecar got that far.
 *
 * ONLY HOST AND PORT ARE TAKEN FROM THE HANDSHAKE. The line is JSON and
 * could grow fields; this reports that it was present and what origin it
 * named, which is the diagnostic value, and nothing else.
 */
export function sidecarLog(where, readFile = readFileSync, exists = existsSync, stat = statSync) {
  const path = join(where.userDataRoot, "logs", "sidecar.log");
  if (!exists(path)) {
    return {
      path,
      present: false,
      note:
        "ABSENT. This is itself a finding, not a gap: the shell writes this file on every launch, " +
        "and says on its own stdout when it cannot. Record that it was missing."
    };
  }
  const bytes = stat(path).size;
  const text = String(readFile(path, "utf8"));
  const handshake = text.split("\n").find((line) => line.includes(HANDSHAKE_PREFIX));
  let origin = null;
  if (handshake) {
    const json = /\{.*\}/.exec(handshake)?.[0];
    try {
      const parsed = JSON.parse(json ?? "{}");
      if (parsed.host && parsed.port) origin = `${parsed.host}:${parsed.port}`;
    } catch {
      origin = null;
    }
  }
  return {
    path,
    present: true,
    bytes,
    handshake: handshake
      ? { seen: true, origin: origin ?? "present but unparseable" }
      : {
          seen: false,
          note:
            "No handshake line in the log. The sidecar did not report a bound port, so the shell had " +
            "nothing to point the webview at. `diagnosis.signatures` below is the classifier's best " +
            "account of why; the log itself is on the machine at the path above."
        },
    /*
     * NOT A TAIL. PL-0741 round 2: this field used to be
     * `text.slice(-LOG_TAIL_BYTES)`, which put the log's own bytes -- any
     * token, URL or argv in them -- into a report that gets pasted into a
     * thread. `classifyLog` reads the same window and reports only which
     * entries of a fixed table matched, so no content crosses out of here.
     */
    diagnosis: classifyLog(text)
  };
}

/** The whole report. Pure over its injected readers. */
export function collect({ run, identity, env, runVerifier, io = {} }) {
  const where = locations(identity, env);
  return {
    kind: "liberty-windows-qualification",
    collectedAt: new Date().toISOString(),
    product: { productName: identity.productName, identifier: identity.identifier },
    environment: environment(run),
    installation: installation(where, runVerifier),
    processes: processes(run, identity),
    sidecarLog: sidecarLog(where, io.readFile, io.exists, io.stat),
    /*
     * CARRIED IN THE FILE ITSELF so it cannot be separated from the data by
     * being pasted into a message.
     */
    notCovered: [
      "Whether a window appeared, and what it showed. No machine reading here establishes that.",
      "Whether WebView2 RENDERED the application. A WebView2 runtime version is not a render.",
      "Whether anything played, and whether audio or subtitles behaved.",
      "The SmartScreen or Defender wording on first run (matrix row F5) -- it is seen once, by a person.",
      "Experiment 1a (row G1), display scaling (G2) and keyboard-only operation (G3): all judgement."
    ]
  };
}

/** A short human summary, so the commander can see it worked before sending. */
export function summarise(report) {
  const say = (label, r) =>
    `  ${label.padEnd(18)} ${r?.value ?? r?.unavailable ?? "(not recorded)"}`;
  const lines = [
    "Liberty Windows qualification",
    "",
    say("Windows", report.environment.windows),
    say("GPU", report.environment.gpu),
    say("WebView2", report.environment.webview2),
    say("Display", report.environment.display),
    say("Scaling %", report.environment.scaling),
    "",
    say("Installed exe", report.installation.executable),
    say("Verifier", report.installation.verifier),
    say("Shell process", report.processes.shell),
    say("node.exe count", report.processes.nodeProcesses),
    ""
  ];
  const log = report.sidecarLog;
  lines.push(
    log.present
      ? `  sidecar.log        ${log.bytes} bytes; handshake ${log.handshake.seen ? `seen (${log.handshake.origin})` : "NOT SEEN"}`
      : `  sidecar.log        ABSENT -- record this, it is a finding`
  );
  lines.push(
    "",
    "This file records what a machine can read about itself. It does NOT establish",
    "that a window appeared, that WebView2 rendered Liberty, or that anything played.",
    "Those rows are yours."
  );
  return lines.join("\n");
}

/* ---- the command ------------------------------------------------------- */
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop() ?? "");
if (isMain) {
  const outIndex = process.argv.indexOf("--out");
  const out =
    outIndex !== -1 && process.argv[outIndex + 1]
      ? process.argv[outIndex + 1]
      : join(process.cwd(), "liberty-qualification.json");

  if (process.platform !== "win32") {
    console.error(
      `qualify: refusing to run on ${process.platform}. Every reading here is a Windows fact -- the ` +
        `registry, WMI, the installed tree, the per-user log. A report produced elsewhere would not be ` +
        `a weaker result, it would be a different one wearing the same name.`
    );
    process.exit(2);
  }

  const identity = readIdentity();
  const report = collect({
    run: powershell,
    identity,
    env: process.env,
    runVerifier: (root) =>
      execFileSync(process.execPath, [join(import.meta.dirname, "verify-install.mjs"), root], {
        encoding: "utf8",
        timeout: 60_000
      }).trim()
  });

  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(summarise(report));
  console.log(`\nWritten to ${out}\nSend that one file back.`);
}
