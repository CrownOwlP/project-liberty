/* -------------------------------------------------------------------------
 * The qualification collector (PL-0741)
 *
 * WHAT IS TESTABLE HERE AND WHAT IS NOT. Every reading this script takes is
 * a Windows fact — the registry, WMI, the installed tree, the per-user log —
 * and none of those commands can be executed on this machine. What CAN be
 * tested, and is the part that can be wrong in a way that costs the
 * commander a session, is the composition: that a failed reading becomes a
 * recorded absence rather than a silent gap, that nothing claims more than
 * it saw, and that no secret is carried back. Those run here, against
 * injected readers, the way `installed-identity.mjs` takes `env`.
 * ---------------------------------------------------------------------- */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyLog,
  collect,
  environment,
  installation,
  processes,
  sidecarLog,
  summarise
} from "./qualify.mjs";

const IDENTITY = Object.freeze({
  productName: "Project Liberty",
  identifier: "app.projectliberty.desktop",
  executable: "liberty-desktop.exe",
  serverEntry: "sidecar/server/liberty-sidecar.js",
  nodeExecutable: "sidecar/node.exe",
  writableSubdirectories: Object.freeze(["data", "cache", "logs"])
});

const ENV = Object.freeze({
  ProgramFiles: "C:\\Program Files",
  LOCALAPPDATA: "C:\\Users\\diego\\AppData\\Local"
});

/** A PowerShell stand-in: answers from a map, throws for anything else. */
function runner(answers = {}, failing = new Set()) {
  return (expression) => {
    for (const [needle, value] of Object.entries(answers)) {
      if (expression.includes(needle)) {
        if (failing.has(needle)) throw new Error(`command failed: ${needle}`);
        return value;
      }
    }
    throw new Error("no stub for that expression");
  };
}

const ANSWERS = {
  CurrentVersion: "Windows 11 Pro 24H2 (build 26100.2314)",
  Win32_VideoController_gpu: "",
  DriverVersion: "NVIDIA RTX 4070 / driver 566.14",
  CurrentHorizontalResolution: "3840x2160 @120Hz",
  Win32_SoundDevice: "Realtek High Definition Audio",
  EdgeUpdate: "131.0.2903.86",
  AppliedDPI: "150",
  "Get-Process -Name 'liberty-desktop'": "pid 8124, started 10/05/2026 02:11:03",
  "Get-Process -Name node": "1"
};

test("the environment block is filled from the machine, not from the commander", () => {
  const env = environment(runner(ANSWERS));
  assert.equal(env.windows.value, "Windows 11 Pro 24H2 (build 26100.2314)");
  assert.equal(env.webview2.value, "131.0.2903.86");
  assert.equal(env.scaling.value, "150");
  assert.match(env.gpu.value, /RTX 4070/);
});

test("A READING THAT FAILS IS RECORDED, NOT DROPPED", () => {
  /*
   * THE CASE THAT MATTERS MOST ON A REAL MACHINE. The WebView2 Evergreen key
   * is absent when the runtime is installed per-user, and that is common.
   * A collector that omitted the field would hand back a report whose reader
   * cannot tell "not installed" from "nobody looked" — and WebView2 is the
   * engine the entire UI runs in, so that is the single worst field to lose.
   */
  const env = environment(runner(ANSWERS, new Set(["EdgeUpdate"])));
  assert.equal(env.webview2.value, undefined);
  assert.match(env.webview2.unavailable, /command failed/);
  // and the readings around it still came back
  assert.equal(env.windows.value, "Windows 11 Pro 24H2 (build 26100.2314)");
});

test("an empty answer is an absence too, not an empty string", () => {
  const env = environment(runner({ ...ANSWERS, EdgeUpdate: "" }));
  assert.match(env.webview2.unavailable, /returned nothing/);
});

test("a missing installation says so, and does not pretend to verify it", () => {
  const where = { installRoot: "C:\\Program Files\\Project Liberty", executablePath: "C:\\nope.exe", userDataRoot: "C:\\u" };
  const result = installation(where, () => {
    throw new Error("the verifier must not be run when there is nothing to verify");
  });
  assert.match(result.executable.unavailable, /not found/);
  assert.match(result.verifier.unavailable, /no installation to verify/);
});

test("a present installation runs the REAL verifier and records what it said", () => {
  const where = { installRoot: "C:\\Program Files\\Project Liberty", executablePath: process.execPath, userDataRoot: "C:\\u" };
  const result = installation(where, () => "verify-install: all five required entries present");
  assert.match(result.verifier.value, /five required entries/);
});

test("a verifier that REFUSES is recorded as a refusal, not as a crash", () => {
  const where = { installRoot: "C:\\Program Files\\Project Liberty", executablePath: process.execPath, userDataRoot: "C:\\u" };
  const result = installation(where, () => {
    const error = new Error("verify-install: THIRD-PARTY-NOTICES.md is empty");
    throw error;
  });
  assert.match(result.verifier.unavailable, /THIRD-PARTY-NOTICES\.md is empty/);
});

test("an absent sidecar.log is a FINDING, with the reason spelled out", () => {
  const log = sidecarLog({ userDataRoot: "C:\\u" }, () => "", () => false, () => ({ size: 0 }));
  assert.equal(log.present, false);
  assert.match(log.note, /ABSENT\. This is itself a finding/);
});

/*
 * THE FIXTURE, AND IT IS DELIBERATELY ADVERSARIAL NOW.
 *
 * PL-0741 round 2, after gpt-architect's CHANGES_REQUESTED against 846a1f4.
 * The old fixture put its secret only in the handshake line, and the old
 * assertion checked only `JSON.stringify(log.handshake)` -- one subtree of the
 * object the collector returns. So it passed while `log.tail` beside it
 * carried the same bytes. Two things changed: the secret is now in THREE
 * places, including lines the handshake logic never looks at, and every
 * assertion is against the WHOLE serialised object.
 */
const SECRET = "must-not-appear";
const LEAKY_LOG =
  "[out] starting\n" +
  `[out] argv: --token=${SECRET}\n` +
  `[out] liberty-sidecar-ready {"host":"127.0.0.1","port":49871,"secretish":"${SECRET}"}\n` +
  `[err] Error: connect ECONNREFUSED https://user:${SECRET}@example.invalid/\n` +
  "[out] ready\n";

test("the handshake is reported as host:port and nothing else", () => {
  const log = sidecarLog(
    { userDataRoot: "C:\\u" },
    () => LEAKY_LOG,
    () => true,
    () => ({ size: LEAKY_LOG.length })
  );
  assert.equal(log.present, true);
  assert.equal(log.handshake.seen, true);
  assert.equal(log.handshake.origin, "127.0.0.1:49871");
});

test("NO SECRETS: nothing from the log appears anywhere in what sidecarLog returns", () => {
  /*
   * THE ASSERTION THAT WAS MISSING. `JSON.stringify(log)` -- the whole object,
   * not a subtree of it. The fixture hides the same string in an argv line, in
   * the handshake JSON and in a URL inside a stack-adjacent error line, so a
   * collector that quoted ANY window of the file fails this.
   */
  const log = sidecarLog(
    { userDataRoot: "C:\\u" },
    () => LEAKY_LOG,
    () => true,
    () => ({ size: LEAKY_LOG.length })
  );
  const serialised = JSON.stringify(log);
  assert.ok(!serialised.includes(SECRET), `the secret survived into: ${serialised}`);
  // And nothing else from the log either: no field may quote the file.
  assert.ok(!serialised.includes("argv:"), "an argv line reached the report");
  assert.ok(!serialised.includes("example.invalid"), "a URL from the log reached the report");
  assert.ok(!serialised.includes("[out]"), "a raw log line reached the report");
});

test("NO HANDSHAKE is the diagnosis, and the classifier says why", () => {
  /*
   * The diagnostic value the raw tail had is kept -- "the port was taken" is
   * still in the report -- but as a verdict from the signature table in
   * qualify.mjs rather than as bytes from the file.
   */
  const text = "[err] Error: EADDRINUSE 127.0.0.1:49871\n[err]     at Server.setupListenHandle\n";
  const log = sidecarLog({ userDataRoot: "C:\\u" }, () => text, () => true, () => ({ size: text.length }));
  assert.equal(log.handshake.seen, false);
  assert.match(log.handshake.note, /did not report a bound port/);
  assert.deepEqual(
    log.diagnosis.signatures.map((s) => s.id),
    ["port-in-use"]
  );
  assert.match(log.diagnosis.signatures[0].means, /already taken/);
  // The port number is content. It must not be in the report.
  assert.ok(!JSON.stringify(log).includes("49871"), "the log's own port number reached the report");
});

test("an UNRECOGNISED failure says so rather than looking clean", () => {
  /*
   * The dangerous failure mode of an allowlist: a real error nobody wrote a
   * signature for comes back as an empty list, which reads like "no problem".
   * The note has to distinguish them, so it is asserted.
   */
  const text = "[err] Error: something nobody has a pattern for yet\n";
  const log = sidecarLog({ userDataRoot: "C:\\u" }, () => text, () => true, () => ({ size: text.length }));
  assert.deepEqual(log.diagnosis.signatures, []);
  assert.match(log.diagnosis.note, /NO RECOGNISED FAILURE SIGNATURE/);
  assert.match(log.diagnosis.note, /not the same as 'no\s+error'/);
  assert.equal(log.diagnosis.errorLines, 1, "the shape of the log is still counted");
});

test("every signature in the table is reachable, and each means something", () => {
  /*
   * A table nobody checks grows a dead entry. This drives one line through
   * each pattern rather than trusting that they were written correctly.
   */
  const samples = {
    "port-in-use": "Error: listen EADDRINUSE",
    "address-unavailable": "Error: listen EADDRNOTAVAIL",
    "permission-denied": "Error: EACCES permission denied",
    "file-missing": "Error: ENOENT no such file",
    "module-missing": "Error: Cannot find module 'next'",
    "module-format": "Error [ERR_REQUIRE_ESM]: require() of ES Module",
    "native-module-failed": "Error: The specified module could not be found.",
    "node-not-found": "'node' is not recognized as an internal or external command",
    "unhandled-error": "UnhandledPromiseRejection: ...",
    fatal: "FATAL ERROR: Reached heap limit"
  };
  for (const [id, line] of Object.entries(samples)) {
    const found = classifyLog(`[err] ${line}\n`).signatures;
    assert.ok(
      found.some((s) => s.id === id),
      `no signature matched the sample for ${id}: ${JSON.stringify(found.map((s) => s.id))}`
    );
    for (const s of found) {
      assert.ok(s.means.length > 20, `${s.id} has no usable explanation`);
    }
  }
});

test("a huge log does not become the report, and the true size is still reported", () => {
  const text = `${"z".repeat(200_000)}\n`;
  const log = sidecarLog({ userDataRoot: "C:\\u" }, () => text, () => true, () => ({ size: text.length }));
  // The examined WINDOW is bounded, and the report carries the window's size
  // rather than the window.
  assert.ok(log.diagnosis.bytesExamined <= 16 * 1024, `examined ${log.diagnosis.bytesExamined} bytes`);
  assert.equal(log.bytes, text.length, "the true size is still reported");
  // The report itself stays small whatever the log does, because its size no
  // longer depends on the file's content at all.
  assert.ok(
    JSON.stringify(log).length < 4 * 1024,
    `the log's report grew to ${JSON.stringify(log).length} bytes`
  );
  assert.ok(!JSON.stringify(log).includes("zzzz"), "the log's content reached the report");
});

test("THE REPORT CARRIES WHAT IT DOES NOT COVER, inside the file", () => {
  /*
   * gpt-architect's round-105 §9: do not collapse these claims. The list
   * travels IN the JSON rather than only in a covering message, because the
   * file is what gets pasted into a thread six weeks later.
   */
  const report = collect({
    run: runner(ANSWERS),
    identity: IDENTITY,
    env: ENV,
    runVerifier: () => "ok",
    io: { readFile: () => "", exists: () => false, stat: () => ({ size: 0 }) }
  });
  const text = report.notCovered.join(" ");
  assert.match(text, /Whether a window appeared/);
  assert.match(text, /WebView2 RENDERED/);
  assert.match(text, /not a render/);
  assert.match(text, /SmartScreen/);
});

test("the paths come from the identity and the env, not from a guess", () => {
  const report = collect({
    run: runner(ANSWERS),
    identity: IDENTITY,
    env: ENV,
    runVerifier: () => "ok",
    io: { readFile: () => "", exists: () => false, stat: () => ({ size: 0 }) }
  });
  assert.equal(report.installation.installRoot, "C:\\Program Files\\Project Liberty");
  assert.match(report.sidecarLog.path, /app\.projectliberty\.desktop/);
  assert.match(report.sidecarLog.path, /logs/);
});

test("the summary shows an unavailable reading rather than hiding it", () => {
  const report = collect({
    run: runner(ANSWERS, new Set(["EdgeUpdate"])),
    identity: IDENTITY,
    env: ENV,
    runVerifier: () => "ok",
    io: { readFile: () => "", exists: () => false, stat: () => ({ size: 0 }) }
  });
  const text = summarise(report);
  /* "failed:" is reading()'s prefix when the error carries no code; the point
   * of the case is that the line is PRESENT and says why, not its exact shape. */
  assert.match(text, /WebView2\s+failed: command failed/);
  assert.match(text, /sidecar\.log\s+ABSENT/);
  assert.match(text, /does NOT establish/);
});

test("nothing in a full report mentions a token, an environment dump, or the log's own bytes", () => {
  /*
   * A blunt check, and worth having bluntly: this file is going to be pasted
   * into a chat.
   *
   * PL-0741 ROUND 2 STRENGTHENED THIS TEST, AND THIS IS WHERE THE HOLE WAS.
   * It already asserted on the WHOLE serialised report -- but it fed
   * `sidecarLog` a CLEAN fixture, so it could never have caught the raw
   * `tail`. The secret was in a different test's fixture and that test
   * asserted only on `log.handshake`. Between them, two tests that each looked
   * right left the leak uncovered. The log fixture here is now the adversarial
   * one, which is what gpt-architect asked for: the fixture secret must not
   * appear anywhere in the full serialized report.
   */
  const report = collect({
    run: runner(ANSWERS),
    identity: IDENTITY,
    env: { ...ENV, LIBERTY_SIDECAR_TOKEN: "0123456789abcdef".repeat(4) },
    runVerifier: () => "ok",
    io: {
      readFile: () => LEAKY_LOG,
      exists: () => true,
      stat: () => ({ size: LEAKY_LOG.length })
    }
  });
  const serialised = JSON.stringify(report);
  assert.ok(!serialised.includes("0123456789abcdef"), "a token-shaped value reached the report");
  assert.ok(!serialised.includes("LIBERTY_SIDECAR_TOKEN"), "an environment variable name reached the report");
  assert.ok(!serialised.includes(SECRET), "the log fixture's secret reached the report");
  assert.ok(!serialised.includes("example.invalid"), "a URL from the log reached the report");
  assert.ok(!serialised.includes("[out]"), "a raw log line reached the report");
  // The human-readable summary is derived from the report and is what actually
  // gets pasted, so it is checked rather than assumed clean.
  const text = summarise(report);
  assert.ok(!text.includes(SECRET), "the log fixture's secret reached the human summary");
  assert.ok(!text.includes("0123456789abcdef"), "a token-shaped value reached the human summary");
});

test("processes are reported, and the node count is not judged", () => {
  const result = processes(runner(ANSWERS), IDENTITY);
  assert.match(result.shell.value, /pid 8124/);
  assert.equal(result.nodeProcesses.value, "1");
});
