#!/usr/bin/env node
/* -------------------------------------------------------------------------
 * The twelve acceptance items for PW-0106, run against the packaged sidecar.
 *
 * WHY THIS IS A SCRIPT AND NOT A UNIT TEST. Every item below is a statement
 * about a process that was started from the installed layout with the
 * environment the Rust shell builds. None of it is reachable from a unit test:
 * the defect being guarded against -- `PORT=0` silently becoming 3000 -- lives
 * in Next's generated entry, is invisible to every test in this repository,
 * and was found by starting the artifact. A test that could not have found it
 * is not the test this task needs.
 *
 * `apps/desktop` is not an npm workspace, so no vitest project reaches this
 * directory. That is stated rather than worked around: the guards that DO run
 * in CI are the Rust tests in `src-tauri/src/sidecar.rs` and the source-shape
 * assertions in `scripts/package-sidecar.mjs`, and this script is what a human
 * or a Windows job runs against a real packaged tree.
 *
 *     node apps/desktop/sidecar-bootstrap/acceptance.mjs
 *
 * Exit 0 means every item passed. Exit 1 names the ones that did not.
 * ---------------------------------------------------------------------- */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, "..");
const sidecarDir = join(desktop, "sidecar");
const serverDir = join(sidecarDir, "server");
const entry = join(serverDir, "liberty-sidecar.js");

const HANDSHAKE_PREFIX = "liberty-sidecar-ready";
/** The port Next's generated entry falls back to. The whole point is to avoid it. */
const THE_WRONG_PORT = 3000;

const results = [];
const record = (item, ok, detail) => {
  results.push({ item, ok, detail });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${item}\n        ${detail}\n`);
};

if (!existsSync(entry)) {
  process.stderr.write(
    `acceptance: no packaged sidecar at ${entry}.\n` +
      `  Build and package first:\n` +
      `    npm run build:desktop -w @liberty/web\n` +
      `    LIBERTY_SIDECAR_NODE=$(command -v node) node apps/desktop/scripts/package-sidecar.mjs\n`
  );
  process.exit(1);
}

/* ---------------------------------------------------------------- helpers */

function freePort() {
  return new Promise((r) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => r(p));
    });
  });
}

/** Every file under a directory, with size and mtime, for a before/after diff. */
function snapshot(root) {
  const out = new Map();
  const walk = (dir) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, name.name);
      if (name.isDirectory()) {
        walk(full);
        continue;
      }
      const stat = statSync(full);
      out.set(relative(root, full), `${stat.size}:${stat.mtimeMs}`);
    }
  };
  walk(root);
  return out;
}

function launch(overrides = {}) {
  const writable = mkdtempSync(join(tmpdir(), "liberty-acceptance-"));
  const token = randomBytes(32).toString("hex");
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    NODE_ENV: "production",
    LIBERTY_SIDECAR_TOKEN: token,
    LIBERTY_SIDECAR_HOST: "127.0.0.1",
    HOSTNAME: "127.0.0.1",
    /* The launch contract, exactly as `sidecar.rs` sends it. */
    PORT: "0",
    LIBERTY_SIDECAR_DATA_DIR: join(writable, "data"),
    LIBERTY_SIDECAR_CACHE_DIR: join(writable, "cache"),
    LIBERTY_SIDECAR_LOG_DIR: join(writable, "logs"),
    NEXT_CACHE_DIR: join(writable, "cache"),
    ...overrides
  };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];

  const child = spawn(process.execPath, [entry], {
    cwd: serverDir,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const stdout = [];
  const stderr = [];
  createInterface({ input: child.stdout }).on("line", (l) => stdout.push(l));
  createInterface({ input: child.stderr }).on("line", (l) => stderr.push(l));
  return { child, stdout, stderr, token };
}

function awaitHandshake(run, ms = 40000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = setInterval(() => {
      const line = run.stdout.find((l) => l.startsWith(HANDSHAKE_PREFIX));
      if (line) {
        clearInterval(tick);
        resolve({ line });
      } else if (Date.now() - started > ms) {
        clearInterval(tick);
        resolve({ line: null, reason: "timed out" });
      }
    }, 100);
    run.child.on("exit", (code) => {
      const line = run.stdout.find((l) => l.startsWith(HANDSHAKE_PREFIX));
      clearInterval(tick);
      resolve(line ? { line } : { line: null, reason: `exited ${code}`, code });
    });
  });
}

/**
 * The grammar both handshake parsers implement.
 *
 * The authoritative ones are `src-tauri/src/handshake.rs` (the shell, which is
 * what actually consumes this line) and `apps/web/src/lib/sidecar/handshake.ts`.
 * Neither is on this task's write surface, so this is a restatement of their
 * shared contract rather than a call into either: prefix, JSON object, a
 * loopback host, an integer port in range. `bootstrap.test.ts` in PW-0105
 * already asserts a round trip through the TypeScript parser.
 */
function parseHandshake(line) {
  if (!line || !line.startsWith(HANDSHAKE_PREFIX)) return null;
  let body;
  try {
    body = JSON.parse(line.slice(HANDSHAKE_PREFIX.length).trim());
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  if (body.host !== "127.0.0.1" && body.host !== "::1") return null;
  if (!Number.isInteger(body.port) || body.port < 1 || body.port > 65535) return null;
  return body;
}

function probe(port, path, { token, host } = {}) {
  return new Promise((resolve) => {
    const headers = {};
    if (token) headers["x-liberty-sidecar-token"] = token;
    const req = request(
      { host: "127.0.0.1", port, path, method: "GET", headers, setHost: false },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode, body: Buffer.concat(chunks) })
        );
      }
    );
    /* `setHost: false` plus an explicit header, because `fetch` DROPS a Host
     * header -- it is a forbidden header name -- which makes every rebinding
     * probe silently test the wrong thing. */
    if (host) req.setHeader("host", host);
    req.on("error", (error) => resolve({ status: null, error: error.message }));
    req.end();
  });
}

/* ------------------------------------------------------------------- run */

const blockers = [];
let occupiedBy = null;
try {
  const blocker = createServer();
  await new Promise((res, rej) => {
    blocker.once("error", rej);
    blocker.listen(THE_WRONG_PORT, "127.0.0.1", res);
  });
  blockers.push(blocker);
  occupiedBy = "this harness";
} catch (error) {
  occupiedBy = error.code === "EADDRINUSE" ? "another process" : null;
}
record(
  "1. port 3000 is occupied for this test",
  occupiedBy !== null,
  occupiedBy ? `held by ${occupiedBy}` : "could not occupy 3000; the test below proves less"
);

const first = launch();
const firstShake = await awaitHandshake(first);
record(
  "2. the packaged sidecar starts with 3000 occupied",
  firstShake.line !== null,
  firstShake.line
    ? "a handshake was emitted"
    : `no handshake (${firstShake.reason}); stderr: ${first.stderr.slice(-4).join(" | ")}`
);

const firstParsed = parseHandshake(firstShake.line);
record(
  "5. the handshake satisfies the shell parser's grammar",
  firstParsed !== null,
  firstParsed ? JSON.stringify(firstParsed) : `unparseable: ${JSON.stringify(firstShake.line)}`
);

const port = firstParsed ? firstParsed.port : null;
record(
  "3. the actual listener port is not 3000",
  port !== null && port !== THE_WRONG_PORT,
  port === null ? "no port to check" : `bound ${port}`
);

/* Item 4 is not "the line contains A port" but "the line contains THE port":
 * the number is only true if the server actually answers on it. */
const health = port ? await probe(port, "/api/health", { token: first.token, host: `127.0.0.1:${port}` }) : null;
record(
  "4. the handshake carries the REAL bound port",
  health !== null && health.status === 200,
  health === null ? "no port to probe" : `GET /api/health on ${port} -> ${health.status}`
);

const before = port ? snapshot(sidecarDir) : null;

const routes = [];
for (const path of ["/", "/search", "/profiles", "/api/health", "/signin"]) {
  if (!port) break;
  const res = await probe(port, path, { token: first.token, host: `127.0.0.1:${port}` });
  routes.push(`${path} ${res.status}`);
}
record(
  "6. all required routes serve",
  routes.length === 5 && routes.every((r) => r.endsWith(" 200")),
  routes.join(", ") || "not run"
);

let assets = "not run";
let assetsOk = false;
if (port) {
  const home = await probe(port, "/", { token: first.token, host: `127.0.0.1:${port}` });
  const html = home.body ? home.body.toString("utf8") : "";
  const css = /\/_next\/static\/[^"']+\.css/.exec(html);
  const js = /\/_next\/static\/[^"']+\.js/.exec(html);
  /* No token deliberately: `proxy.ts`'s matcher excludes `_next/static`, so the
   * browser can fetch the page's own assets before it holds anything. */
  const cssRes = css ? await probe(port, css[0], { host: `127.0.0.1:${port}` }) : null;
  const jsRes = js ? await probe(port, js[0], { host: `127.0.0.1:${port}` }) : null;
  assetsOk =
    cssRes !== null && jsRes !== null &&
    cssRes.status === 200 && jsRes.status === 200 &&
    cssRes.body.length > 0 && jsRes.body.length > 0;
  assets = `stylesheet ${cssRes?.status} (${cssRes?.body.length ?? 0} B), chunk ${jsRes?.status} (${jsRes?.body.length ?? 0} B)`;
}
record("7. static / CSS / client assets load", assetsOk, assets);

const attacks = [];
if (port) {
  const cases = [
    ["no token", { host: `127.0.0.1:${port}` }],
    ["wrong token", { token: "b".repeat(64), host: `127.0.0.1:${port}` }],
    ["Host evil.test", { token: first.token, host: "evil.test" }],
    ["Host 127.0.0.1.evil.test", { token: first.token, host: `127.0.0.1.evil.test:${port}` }],
    ["userinfo Host", { token: first.token, host: `evil.test@127.0.0.1:${port}` }],
    ["Host localhost", { token: first.token, host: `localhost:${port}` }],
    ["Host 0.0.0.0", { token: first.token, host: `0.0.0.0:${port}` }],
    ["wrong port in Host", { token: first.token, host: `127.0.0.1:${port === 65535 ? 1 : port + 1}` }]
  ];
  for (const [label, options] of cases) {
    const res = await probe(port, "/", options);
    attacks.push(`${label} ${res.status}`);
  }
}
record(
  "8. token and Host attack cases still fail",
  attacks.length === 8 && attacks.every((a) => a.endsWith(" 403")),
  attacks.join(", ") || "not run"
);

let wrote = "not run";
let wroteOk = false;
if (before) {
  const after = snapshot(sidecarDir);
  const added = [...after.keys()].filter((k) => !before.has(k));
  const changed = [...after.keys()].filter((k) => before.has(k) && before.get(k) !== after.get(k));
  wroteOk = added.length === 0 && changed.length === 0;
  wrote = wroteOk
    ? `${after.size} files unchanged under ${relative(desktop, sidecarDir)}`
    : `added ${JSON.stringify(added.slice(0, 5))}, changed ${JSON.stringify(changed.slice(0, 5))}`;
}
record("10. nothing writes beside the executable", wroteOk, wrote);

first.child.kill("SIGKILL");

/* ---- item 11: a second launch gets a different kernel-selected port ---- */
const second = launch();
const secondShake = await awaitHandshake(second);
const secondParsed = parseHandshake(secondShake.line);
record(
  "11. repeated launches use different kernel-selected ports",
  secondParsed !== null && port !== null && secondParsed.port !== port &&
    secondParsed.port !== THE_WRONG_PORT,
  secondParsed ? `first ${port}, second ${secondParsed.port}` : "the second launch emitted no handshake"
);
second.child.kill("SIGKILL");

/* ---- item 9: a non-loopback declaration is a hard startup refusal ------ */
const refusals = [];
for (const [label, overrides] of [
  ["HOSTNAME=0.0.0.0", { HOSTNAME: "0.0.0.0" }],
  ["LIBERTY_SIDECAR_HOST=0.0.0.0", { LIBERTY_SIDECAR_HOST: "0.0.0.0" }],
  ["HOSTNAME unset", { HOSTNAME: undefined }]
]) {
  const run = launch(overrides);
  const shake = await awaitHandshake(run, 25000);
  const code = await new Promise((r) => {
    if (run.child.exitCode !== null) return r(run.child.exitCode);
    const t = setTimeout(() => {
      run.child.kill("SIGKILL");
      r(null);
    }, 15000);
    run.child.on("exit", (c) => {
      clearTimeout(t);
      r(c);
    });
  });
  refusals.push(`${label}: exit ${code}${shake.line ? " BUT EMITTED A HANDSHAKE" : ", no handshake"}`);
}
record(
  "9. a non-loopback startup fails",
  refusals.every((r) => /exit 1, no handshake/.test(r)),
  refusals.join(" | ")
);

/* ---- item 12: nothing on the shell side probes for a port -------------- */
const rust = readFileSync(join(desktop, "src-tauri", "src", "sidecar.rs"), "utf8");
const rustCode = rust.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const probing = ["TcpListener", "bind(", "portpicker", "port_check", "SocketAddr"].filter((n) =>
  rustCode.includes(n)
);
record(
  "12. no shell-side free-port probing exists",
  probing.length === 0 && /BIND_PORT: &str = "0"/.test(rustCode),
  probing.length ? `sidecar.rs mentions ${probing.join(", ")}` : 'BIND_PORT is "0" and nothing binds in the shell'
);

/* ---- the regression the whole task exists for -------------------------- */
const bootstrap = readFileSync(entry, "utf8");
const bootstrapCode = bootstrap
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
record(
  "R. PORT=0 cannot silently become 3000 again",
  !/process\.env\.PORT/.test(bootstrapCode) &&
    /const KERNEL_CHOOSES_THE_PORT = 0;/.test(bootstrapCode) &&
    /server\.listen\(KERNEL_CHOOSES_THE_PORT, BIND_HOST/.test(bootstrapCode),
  "the shipped entry binds a literal 0 and never reads process.env.PORT"
);

for (const blocker of blockers) blocker.close();

const failed = results.filter((r) => !r.ok);
process.stdout.write(
  `\n${results.length - failed.length}/${results.length} acceptance items passed\n`
);
if (failed.length) {
  process.stdout.write(`FAILED: ${failed.map((f) => f.item).join("; ")}\n`);
  process.exit(1);
}
