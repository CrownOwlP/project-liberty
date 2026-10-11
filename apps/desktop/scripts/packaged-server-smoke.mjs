#!/usr/bin/env node
/* -------------------------------------------------------------------------
 * Smoke the PACKAGED sidecar: does this tree still work once it has MOVED?
 *
 * THE DEFECT THIS EXISTS FOR, and it shipped. Round 129 got the installed MSI
 * as far as launching its bundled Node and completing the handshake. The
 * application then answered `Internal Server Error`, because a server chunk
 * does `await import("pg-587764f78a6c7a9c")` and the only thing that could
 * resolve that specifier was a symlink pointing at
 * `<build machine>/apps/web/dist/desktop/standalone/node_modules/pg` -- an
 * ABSOLUTE path on the GitHub runner. The package `pg` itself was in the tree
 * the whole time, at `server/node_modules/pg`. Nothing was missing. A pointer
 * was aimed at a machine the user does not have.
 *
 * WHY EVERY EXISTING CHECK PASSED, which is the part worth building a tool
 * around. `sidecar-bootstrap/acceptance.mjs` already starts the packaged
 * sidecar and already asserts `GET / -> 200`. It passes on the build machine,
 * because on the build machine that absolute symlink RESOLVES. A tree that is
 * only broken relative to being moved cannot be found by a check that never
 * moves it. So this script does two things no in-place check can:
 *
 *   1. CONTAINMENT. Every symlink in the tree must resolve INSIDE the tree.
 *      A link out of it is a reference to the build machine, and an installer
 *      copies the link, not the machine.
 *   2. RESOLUTION. Every external specifier the shipped chunks import must
 *      resolve from the chunk that imports it, using Node's own resolver,
 *      against the RELOCATED copy. That is the acceptance criterion "the
 *      packaged runtime has no unresolved external imports", asserted rather
 *      than reasoned about.
 *
 * And then it starts the thing from the relocated copy and asks for a page.
 *
 *     node apps/desktop/scripts/packaged-server-smoke.mjs
 *
 * Exit 0 means the relocated tree served an authenticated homepage. Exit 1
 * names what failed. `package-sidecar.mjs` runs this at the end of packaging,
 * for the reason that file already gives for running `collect-notices.mjs`
 * there: the thing that knows what was packaged is the thing that packaged it.
 * ---------------------------------------------------------------------- */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { request } from "node:http";
import { isBuiltin, createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, "..");
const sidecarDir = join(desktop, "sidecar");

const HANDSHAKE_PREFIX = "liberty-sidecar-ready";
const TOKEN_HEADER = "x-liberty-sidecar-token";
const LAYOUT_FILE = "liberty-sidecar-layout.json";

/*
 * NON-VACUITY FLOORS. The specifier extraction below reads minified chunks, so
 * the thing most likely to go wrong is that it stops matching and reports a
 * clean tree because it looked at nothing. Both floors are facts about a Next
 * 16 Turbopack server build rather than numbers chosen to pass: the framework
 * itself is imported through `.external.js` paths, and there are many of them.
 */
/*
 * WHAT A WORKING HOMEPAGE CONTAINS, and every one of these is emitted by
 * `AppShell` rather than by a page -- so a route that fell back to an error
 * boundary cannot produce them. Kept as literal strings rather than imported,
 * because this script runs against a PACKAGED tree that carries no TypeScript.
 * If `AppShell`'s markup changes, this list is the thing to change with it, and
 * a stale entry fails loudly rather than passing quietly.
 */
const APPLICATION_FRAME_MARKERS = ["skip-link", 'class="shell"', 'id="main"'];

/** The error boundary's own headline. Its presence in a 200 is the symptom. */
const ERROR_PAGE_HEADLINE = "could not start this page";

const MINIMUM_SPECIFIERS = 8;
const MINIMUM_FRAMEWORK_SPECIFIERS = 3;

/*
 * EVERY TEMPORARY TREE IS REGISTERED FOR REMOVAL THE MOMENT IT IS CREATED.
 *
 * A relocated copy of the packaged sidecar is ~200 MB. Removing it on the happy
 * path only is how a CI job that fails this check twice runs out of disk and
 * then fails for a reason that has nothing to do with the tree -- which is how
 * a real signal gets written off as flake. `process.on("exit")` covers the
 * `process.exit` in `finish()` as well as a throw, which a trailing statement
 * does not.
 */
const temporary = [];
process.on("exit", () => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true, maxRetries: 5 });
});
const scratch = (prefix) => {
  const made = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(made);
  return made;
};

const failures = [];
const notes = [];
const fail = (what, detail) => failures.push(`${what}\n        ${detail}`);
const note = (what, detail) => {
  notes.push(what);
  process.stdout.write(`ok    ${what}\n        ${detail}\n`);
};

function finish() {
  if (failures.length === 0) {
    process.stdout.write(`packaged-server-smoke: ${notes.length} check(s) passed\n`);
    process.exit(0);
  }
  process.stderr.write(`\npackaged-server-smoke: ${failures.length} failure(s)\n`);
  for (const line of failures) process.stderr.write(`FAIL  ${line}\n`);
  process.exit(1);
}

/** Every file and symlink under `root`, as absolute paths. */
function walk(root) {
  const files = [];
  const links = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) links.push(full);
      else if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) files.push(full);
    }
  }
  return { files, links };
}

/** Is `candidate` inside `root`, with `root` itself not counting as inside it? */
function isInside(root, candidate) {
  const rel = relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith(`${sep}..`);
}

/*
 * THE EXTERNAL SPECIFIERS A CHUNK IMPORTS.
 *
 * Turbopack's runtime puts `externalImport` on `.y` and `externalRequire` on
 * `.x` of its module context (see `[turbopack]_runtime.js`), so a call site in
 * a minified chunk reads `X.y("spec")` or `X.x("spec", () => require("spec"))`.
 * Reading the call sites rather than a manifest is deliberate: no manifest in
 * the build output lists these, and the chunk is the thing that will run.
 *
 * A regex over minified JavaScript is crude, and the crudeness is bounded in
 * the safe direction -- a false positive makes this check STRICTER (an extra
 * specifier that must resolve), and the two floors above catch it going quiet.
 */
const SPECIFIER_CALL = /\.(?:y|x)\("([^"\\\s()]+)"/g;

function specifiersIn(source) {
  const found = new Set();
  for (const match of source.matchAll(SPECIFIER_CALL)) found.add(match[1]);
  return found;
}

/* ------------------------------------------------------------ the subject */

const entry = join(sidecarDir, "server", "liberty-sidecar.js");
if (!existsSync(entry)) {
  process.stderr.write(
    `packaged-server-smoke: no packaged sidecar at ${entry}.\n` +
      `  Build and package first:\n` +
      `    npm run build:desktop -w @liberty/web\n` +
      `    LIBERTY_SIDECAR_NODE=$(command -v node) node apps/desktop/scripts/package-sidecar.mjs\n`
  );
  process.exit(1);
}

/*
 * WHERE THE CHUNKS ARE, READ FROM THE TREE RATHER THAN RESTATED. Packaging
 * writes `liberty-sidecar-layout.json` beside the entry for exactly this
 * reason: the packaged tree carries no TypeScript, so `DESKTOP_DIST_DIR` is
 * not readable from it. One source, and this is the third reader.
 */
let distDir;
try {
  distDir = JSON.parse(readFileSync(join(sidecarDir, "server", LAYOUT_FILE), "utf8")).distDir;
} catch (error) {
  process.stderr.write(
    `packaged-server-smoke: could not read ${LAYOUT_FILE}: ${error.message}\n` +
      `  Packaging writes it; a tree without it was not laid out by package-sidecar.mjs.\n`
  );
  process.exit(1);
}

/* --------------------------------------------------- 1. the relocated copy */

/*
 * OUTSIDE THE REPOSITORY, which is the whole point. `tmpdir()` is not under the
 * checkout, so a reference that only works because the build tree is next door
 * stops working here -- and an installed application is exactly a copy of this
 * directory sitting somewhere the build tree is not.
 */
const relocated = scratch("liberty-packaged-smoke-");
const movedSidecar = join(relocated, "sidecar");
let copied = false;
try {
  cpSync(sidecarDir, movedSidecar, { recursive: true, verbatimSymlinks: true });
  copied = true;
} catch (error) {
  fail("the packaged tree can be copied", `cpSync refused: ${error.message}`);
}

if (copied) {
  note("the packaged tree was relocated outside the repository", movedSidecar);

  /* ------------------------------------------------- 2. symlink containment */

  const { files, links } = walk(movedSidecar);
  const escaping = [];
  for (const link of links) {
    let target = null;
    try {
      target = realpathSync(link);
    } catch {
      escaping.push(`${relative(movedSidecar, link)} -> (dangling)`);
      continue;
    }
    if (!isInside(movedSidecar, target)) {
      escaping.push(`${relative(movedSidecar, link)} -> ${target}`);
    }
  }
  if (escaping.length > 0) {
    fail(
      "every symlink in the packaged tree resolves inside it",
      `${escaping.length} do(es) not, and an installer ships the link rather than its target:\n        ` +
        escaping.join("\n        ")
    );
  } else {
    note(
      "every symlink in the packaged tree resolves inside it",
      links.length === 0 ? "the tree contains no symlinks at all" : `${links.length} link(s), all contained`
    );
  }

  /* ---------------------------------------- 3. external specifiers resolve */

  const chunkRoot = join(movedSidecar, "server", distDir, "server", "chunks");
  if (!existsSync(chunkRoot)) {
    fail("the packaged tree carries the server chunks", `no directory at ${chunkRoot}`);
  } else {
    const chunks = files.filter(
      (file) => isInside(chunkRoot, file) && file.endsWith(".js")
    );
    const unresolved = [];
    const seen = new Set();
    let frameworkSeen = 0;
    for (const chunk of chunks) {
      const specifiers = specifiersIn(readFileSync(chunk, "utf8"));
      if (specifiers.size === 0) continue;
      const resolver = createRequire(chunk);
      for (const specifier of specifiers) {
        if (isBuiltin(specifier)) continue;
        if (specifier.startsWith("next/dist/")) frameworkSeen += seen.has(specifier) ? 0 : 1;
        if (seen.has(specifier)) continue;
        seen.add(specifier);
        try {
          resolver.resolve(specifier);
        } catch (error) {
          unresolved.push(`${specifier}  (imported from ${relative(movedSidecar, chunk)}: ${error.code ?? error.message})`);
        }
      }
    }

    if (seen.size < MINIMUM_SPECIFIERS || frameworkSeen < MINIMUM_FRAMEWORK_SPECIFIERS) {
      fail(
        "the specifier extraction is not vacuous",
        `found ${seen.size} external specifier(s) across ${chunks.length} chunk(s), ` +
          `${frameworkSeen} of them framework paths; a Next ${""}Turbopack server build has more. ` +
          `The call-site pattern has probably stopped matching, which would make a clean ` +
          `result mean nothing.`
      );
    } else if (unresolved.length > 0) {
      fail(
        "every external import in the packaged chunks resolves",
        `${unresolved.length} do(es) not, from ${relative(relocated, movedSidecar)}:\n        ` +
          unresolved.join("\n        ")
      );
    } else {
      note(
        "every external import in the packaged chunks resolves",
        `${seen.size} distinct non-builtin specifier(s) across ${chunks.length} chunk(s), all resolvable`
      );
    }
  }
}

/* --------------------------------------------- 4. and it actually serves */

function probe(port, path, token) {
  return new Promise((done) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "GET",
        setHost: false,
        headers: { [TOKEN_HEADER]: token }
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => done({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      }
    );
    /* `setHost: false` plus an explicit header, because the guard checks Host
     * and `fetch` cannot set it -- the same reason `acceptance.mjs` says. */
    req.setHeader("host", `127.0.0.1:${port}`);
    req.on("error", (error) => done({ status: null, error: error.message }));
    req.end();
  });
}

if (copied) {
  const movedServer = join(movedSidecar, "server");
  const movedEntry = join(movedServer, "liberty-sidecar.js");
  /*
   * THE PACKAGED RUNTIME WHEN IT CAN RUN HERE, this one otherwise. On a Windows
   * job `sidecar/node.exe` is the runtime that will ship, and smoking the
   * artifact with the binary that will execute it is strictly better evidence.
   * On a Linux job that same file is a Windows binary, so the check would be
   * measuring the platform rather than the tree.
   */
  const packagedNode = join(movedSidecar, "node.exe");
  const runtime = process.platform === "win32" && existsSync(packagedNode) ? packagedNode : process.execPath;

  const token = randomBytes(32).toString("hex");
  const writable = scratch("liberty-packaged-smoke-data-");
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    NODE_ENV: "production",
    LIBERTY_SIDECAR_TOKEN: token,
    LIBERTY_SIDECAR_HOST: "127.0.0.1",
    HOSTNAME: "127.0.0.1",
    PORT: "0",
    LIBERTY_SIDECAR_DATA_DIR: join(writable, "data"),
    LIBERTY_SIDECAR_CACHE_DIR: join(writable, "cache"),
    LIBERTY_SIDECAR_LOG_DIR: join(writable, "logs"),
    NEXT_CACHE_DIR: join(writable, "cache")
  };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];

  const child = spawn(runtime, [movedEntry], { cwd: movedServer, env, stdio: ["ignore", "pipe", "pipe"] });
  const out = [];
  const err = [];
  createInterface({ input: child.stdout }).on("line", (line) => out.push(line));
  createInterface({ input: child.stderr }).on("line", (line) => err.push(line));

  const handshake = await new Promise((done) => {
    const started = Date.now();
    const tick = setInterval(() => {
      const line = out.find((l) => l.startsWith(HANDSHAKE_PREFIX));
      if (line) {
        clearInterval(tick);
        done({ line });
      } else if (Date.now() - started > 60000) {
        clearInterval(tick);
        done({ line: null, why: "timed out after 60s" });
      }
    }, 100);
    child.on("exit", (code) => {
      clearInterval(tick);
      const line = out.find((l) => l.startsWith(HANDSHAKE_PREFIX));
      done(line ? { line } : { line: null, why: `exited ${code}` });
    });
  });

  let port = null;
  if (handshake.line) {
    try {
      port = JSON.parse(handshake.line.slice(HANDSHAKE_PREFIX.length).trim()).port;
    } catch {
      port = null;
    }
  }

  if (port === null) {
    fail(
      "the relocated sidecar starts and announces a port",
      `${handshake.why ?? "unparseable handshake"}; stderr tail: ${err.slice(-6).join(" | ") || "(empty)"}`
    );
  } else {
    note("the relocated sidecar starts and announces a port", `bound ${port} with ${runtime}`);

    for (const path of ["/api/health", "/"]) {
      const res = await probe(port, path, token);
      if (res.status !== 200) {
        fail(
          `the relocated sidecar answers ${path} with 200`,
          `got ${res.status ?? `no response (${res.error})`}; stderr tail: ${err.slice(-8).join(" | ") || "(empty)"}`
        );
        continue;
      }
      if (path === "/" && !res.body.includes("<html")) {
        fail("the homepage is a document", `200 but the body carries no <html (${res.body.length} bytes)`);
        continue;
      }
      /*
       * AND THE HOMEPAGE IS THE APPLICATION, NOT ITS ERROR PAGE (round 131A).
       *
       * THE DEFECT THIS CLOSES IS THIS CHECK'S OWN. `200` plus `<html` was the
       * whole assertion, and `app/global-error.tsx` answers both: it is a
       * complete HTML document, served with a 200 on a client-side escalation.
       * The installed Windows application displayed "Project Liberty could not
       * start this page" while this test reported six green checks, because the
       * only question it asked was whether bytes arrived.
       *
       * That is the third time in this series that an assertion has been
       * satisfied without the thing working -- after a symlink that resolved
       * only on the build machine, and a "no links" invariant a dropped
       * directory would have satisfied. The pattern is an absence or a shape
       * standing in for a presence, so this names what must BE there:
       * `AppShell`'s skip link and its main frame, which no error boundary
       * renders -- `global-error.tsx` must not import the shell, and
       * `shell-usage.test.ts` exempts it from the rule that every other route
       * does -- and it refuses the error page's own headline by name.
       */
      if (path === "/") {
        const absent = APPLICATION_FRAME_MARKERS.filter((marker) => !res.body.includes(marker));
        if (absent.length > 0) {
          fail(
            "the homepage is the application and not an error page",
            `200, ${res.body.length} bytes, but the body is missing ${JSON.stringify(absent)}. ` +
              `Those come from AppShell, which no error boundary renders.` +
              (res.body.includes(ERROR_PAGE_HEADLINE)
                ? ` The body IS the global error page: it contains "${ERROR_PAGE_HEADLINE}".`
                : "")
          );
          continue;
        }
        if (res.body.includes(ERROR_PAGE_HEADLINE)) {
          fail(
            "the homepage is the application and not an error page",
            `200 and the application frame is present, but the body also contains ` +
              `"${ERROR_PAGE_HEADLINE}" -- the error boundary's headline must not be in a working page.`
          );
          continue;
        }
        /* STATED, not merely not-failed: a check that only speaks when it is
         * unhappy is one nobody knows they have. */
        note(
          "the homepage is the application and not an error page",
          `carries ${APPLICATION_FRAME_MARKERS.join(", ")} and not "${ERROR_PAGE_HEADLINE}"`
        );
      }
      note(`the relocated sidecar answers ${path} with 200`, `${res.body.length} bytes`);
    }
  }

  child.kill("SIGKILL");
}

finish();
