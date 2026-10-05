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

import { collect, environment, installation, processes, sidecarLog, summarise } from "./qualify.mjs";

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

test("the handshake is reported as host:port and nothing else", () => {
  /*
   * NO SECRETS. The line is JSON and could grow fields. Only the origin is
   * taken, because that is the diagnostic value — and a collector that
   * echoed the whole line would undo the care the shell takes redacting its
   * own log.
   */
  const text =
    "[out] starting\n" +
    '[out] liberty-sidecar-ready {"host":"127.0.0.1","port":49871,"secretish":"must-not-appear"}\n' +
    "[out] ready\n";
  const log = sidecarLog({ userDataRoot: "C:\\u" }, () => text, () => true, () => ({ size: text.length }));
  assert.equal(log.present, true);
  assert.equal(log.handshake.seen, true);
  assert.equal(log.handshake.origin, "127.0.0.1:49871");
  assert.ok(!JSON.stringify(log.handshake).includes("must-not-appear"));
});

test("NO HANDSHAKE is the diagnosis, and it says why the tail matters", () => {
  const text = "[err] Error: EADDRINUSE\n[err]     at Server.setupListenHandle\n";
  const log = sidecarLog({ userDataRoot: "C:\\u" }, () => text, () => true, () => ({ size: text.length }));
  assert.equal(log.handshake.seen, false);
  assert.match(log.handshake.note, /did not report a bound port/);
  assert.match(log.tail, /EADDRINUSE/);
});

test("the tail is bounded, so a huge log does not become the report", () => {
  const text = `${"z".repeat(200_000)}\n`;
  const log = sidecarLog({ userDataRoot: "C:\\u" }, () => text, () => true, () => ({ size: text.length }));
  assert.ok(log.tail.length <= 16 * 1024, `tail was ${log.tail.length} bytes`);
  assert.equal(log.bytes, text.length, "the true size is still reported");
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

test("nothing in a full report mentions a token or an environment dump", () => {
  /*
   * A blunt check, and worth having bluntly: this file is going to be pasted
   * into a chat.
   */
  const report = collect({
    run: runner(ANSWERS),
    identity: IDENTITY,
    env: { ...ENV, LIBERTY_SIDECAR_TOKEN: "0123456789abcdef".repeat(4) },
    runVerifier: () => "ok",
    io: {
      readFile: () => "[out] liberty-sidecar-ready {\"host\":\"127.0.0.1\",\"port\":1}\n",
      exists: () => true,
      stat: () => ({ size: 64 })
    }
  });
  const serialised = JSON.stringify(report);
  assert.ok(!serialised.includes("0123456789abcdef"), "a token-shaped value reached the report");
  assert.ok(!serialised.includes("LIBERTY_SIDECAR_TOKEN"), "an environment variable name reached the report");
});

test("processes are reported, and the node count is not judged", () => {
  const result = processes(runner(ANSWERS), IDENTITY);
  assert.match(result.shell.value, /pid 8124/);
  assert.equal(result.nodeProcesses.value, "1");
});
