/* -------------------------------------------------------------------------
 * The packaged sidecar's entry point (PW-0106).
 *
 * WHY THIS FILE EXISTS AT ALL, AND WHY IT IS NOT NEXT'S OWN ENTRY.
 *
 * PW-0101's contract is that the KERNEL chooses the port: the shell sets
 * `PORT=0`, the sidecar binds, and the sidecar reports what it actually got.
 * Next 16.3.1's generated standalone entry cannot honour that. Its line is
 *
 *     const currentPort = parseInt(process.env.PORT, 10) || 3000
 *
 * and `parseInt("0", 10)` is `0`, which is FALSY, so `PORT=0` means "bind
 * 3000". The server is then created with `allowRetry: false`. Observed on the
 * packaged tree with the shell's own environment:
 *
 *     Error: listen EADDRINUSE: address already in use 127.0.0.1:3000
 *
 * exit 1. On a user's PC anything from a dev server to another Electron app
 * holds 3000, so that is a first-run failure with no window and no diagnostic
 * the user can act on.
 *
 * gpt-architect's round-96 ruling rejected the obvious workarounds by name --
 * "Do NOT replace the kernel-selected-port design with shell-selected/
 * free-port probing" -- and required instead that the sidecar "own the
 * listener bootstrap at the point where an actual Node `Server` is
 * available". That is this file.
 *
 * ==========================================================================
 * THE ORDER IS THE DESIGN: LISTEN FIRST, PREPARE SECOND
 * ==========================================================================
 *
 * The socket is created and bound before Next is constructed, and the request
 * listener holds every request until `prepare()` resolves. Three things fall
 * out of that ordering, and none of them is incidental:
 *
 *   1. WE own the bind, so `listen(0)` reaches the kernel and
 *      `server.address().port` is the truth. Nothing probes, nothing retries,
 *      nothing is preselected.
 *   2. Next is constructed with the REAL port, not with a placeholder. This
 *      matters: `NextCustomServer.prepare()` forwards `this.options.port || 3000`,
 *      so a literal `0` would become 3000 inside Next even though our socket
 *      is elsewhere.
 *   3. PW-0105's instrumentation runs during `prepare()`, which is now AFTER
 *      the bind. Its handle-table discovery therefore finds this listener and
 *      emits the handshake with this port, unchanged. PW-0106 needs no edit to
 *      PW-0105, which is what keeps the two tasks separate as the ruling asked.
 *      It also means no request is served before PW-0105's bind-safety check
 *      has run -- which closes the window PW-0105 had to document as open.
 *
 * ==========================================================================
 * THE ONE NON-PUBLIC COUPLING, NAMED RATHER THAN BURIED
 * ==========================================================================
 *
 * `next()` and `getRequestHandler()` are the documented custom-server API and
 * they are all this file needs -- except for the resolved build config.
 *
 * `next({ conf })` IS IN THE TYPES AND IS SILENTLY IGNORED on this path.
 * `createServer()` returns `NextCustomServer` whenever `customServer !== false`,
 * and `NextCustomServer.prepare()` calls `getRequestHandlers({ dir, port,
 * isDev, hostname, minimalMode, quiet })` -- `conf` is not among the forwarded
 * fields. Passing the correct config produced "Could not find a production
 * build in the '.next' directory" while this application builds to
 * `dist/desktop`.
 *
 * The fully public alternative -- writing a `next.config.js` into the packaged
 * directory -- serves, and was rejected on measurement: `loadConfig` re-runs
 * `assignDefaults` over an already-resolved config and DROPS keys. Observed
 * warnings named `htmlLimitedBots` (a serialized RegExp cannot round-trip
 * through JSON), `experimental.trustHostHeader`,
 * `experimental.turbopackMemoryEvictionMode`,
 * `experimental.isExperimentalCompile`, `configFileName`, `repoRoot` and
 * `distDirRoot`. Serving with a runtime config that differs from the built one,
 * silently, is worse than one named coupling.
 *
 * So the config is delivered the way Next's own standalone output delivers it:
 * `__NEXT_PRIVATE_STANDALONE_CONFIG`, on which `config.js` short-circuits with
 * the comment "we don't apply assignDefaults or modifyConfig here as it has
 * already been applied". It is a private double-underscore variable and this
 * is the only one.
 *
 * WHAT THIS FILE DOES NOT DO: it does not read, parse, patch or depend on the
 * generated `server.js`. The config comes from
 * `<distDir>/required-server-files.json`, a build-output MANIFEST, which is
 * where `next start` itself looks for the serialized build config. Nothing is
 * post-processed after a build.
 *
 * IF A FUTURE NEXT REMOVES THE VARIABLE, `prepare()` rejects with the
 * `.next`-directory error above. `explainPrepareFailure` turns that into a
 * diagnostic that names this coupling, so the failure is loud and points at
 * the line that has to change -- rather than a server that quietly comes up on
 * default configuration.
 * ---------------------------------------------------------------------- */
"use strict";

const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");

/**
 * Where the packaging step recorded the build's dist directory.
 *
 * DERIVED, NOT RESTATED. `apps/web/src/app/api/v1/playback/build-target.ts`
 * owns `DESKTOP_DIST_DIR`; `package-sidecar.mjs` reads it from there and
 * writes this file. The round-95 failure was two files naming one location and
 * disagreeing, and this is the same lesson applied to a third reader.
 */
const LAYOUT_FILE = "liberty-sidecar-layout.json";

/** The loopback address a sidecar may bind. Never `0.0.0.0`, never a name. */
const BIND_HOST = "127.0.0.1";

/**
 * THE KERNEL CHOOSES. This is a literal, not a variable, and
 * `process.env.PORT` is deliberately never read in this file -- reading it is
 * the entire defect PW-0106 exists to remove. `package-sidecar.mjs` asserts
 * both of those facts against this source at packaging time.
 */
const KERNEL_CHOOSES_THE_PORT = 0;

function fatal(message) {
  /* stderr, never stdout: stdout carries one machine-readable line that the
   * desktop shell parses, and a diagnostic there is a parser's problem. */
  process.stderr.write(`liberty-sidecar: ${message}\n`);
  process.exit(1);
}

function readLayout(dir) {
  const file = path.join(dir, LAYOUT_FILE);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fatal(
      `${LAYOUT_FILE} could not be read at ${file} (${error.code ?? error.message}). ` +
        `It is written by apps/desktop/scripts/package-sidecar.mjs from DESKTOP_DIST_DIR ` +
        `in build-target.ts; a packaged tree without it was not laid out by that script.`
    );
  }
  const distDir = parsed && typeof parsed.distDir === "string" ? parsed.distDir : "";
  if (distDir === "") fatal(`${LAYOUT_FILE} states no distDir`);
  return distDir;
}

function readBuildConfig(dir, distDir) {
  const manifest = path.join(dir, distDir, "required-server-files.json");
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(manifest, "utf8"));
  } catch (error) {
    fatal(
      `no build manifest at ${manifest} (${error.code ?? error.message}). ` +
        `This file is emitted by \`next build\` and carries the RESOLVED config; ` +
        `without it the server would fall back to defaults and look for a build in .next.`
    );
  }
  const config = parsed && parsed.config;
  if (!config || typeof config !== "object") {
    fatal(`${manifest} carries no \`config\` object`);
  }
  if (config.distDir !== distDir) {
    /* The two are written by different tools from different sources. If they
     * disagree, one of them is describing a tree that is not here. */
    fatal(
      `${LAYOUT_FILE} says distDir ${JSON.stringify(distDir)} but the build manifest says ` +
        `${JSON.stringify(config.distDir)}; the packaged tree and the build disagree about ` +
        `where the application lives`
    );
  }
  const buildId = path.join(dir, distDir, "BUILD_ID");
  if (!fs.existsSync(buildId)) {
    fatal(`no BUILD_ID at ${buildId}; ${JSON.stringify(distDir)} is not a finished build`);
  }
  return config;
}

/**
 * Turns Next's own failure into one that names the coupling that broke.
 *
 * The specific failure worth catching: if `__NEXT_PRIVATE_STANDALONE_CONFIG`
 * ever stops being honoured, `loadConfig` falls back to defaults, `distDir`
 * becomes `.next`, and `prepare()` rejects with a message about a missing
 * production build. That is a true statement about a directory nobody asked
 * for, and on its own it sends the next reader looking in the wrong place.
 */
function explainPrepareFailure(error, distDir) {
  const message = String((error && error.message) || error);
  if (!/production build|\.next/.test(message)) return message;
  return (
    `${message}\n` +
    `    -> liberty-sidecar: this application builds to ${JSON.stringify(distDir)}, not ".next". ` +
    `Next was told so through __NEXT_PRIVATE_STANDALONE_CONFIG, which is a PRIVATE variable ` +
    `(see the header of this file). If this version of Next no longer honours it, that is the ` +
    `line to change -- do not "fix" this by moving the build output.`
  );
}

function main() {
  const dir = __dirname;
  process.env.NODE_ENV = "production";
  /* The build's config carries a RELATIVE distDir and the server resolves its
   * chunks from the working directory, exactly as Next's own entry does. */
  process.chdir(dir);

  const distDir = readLayout(dir);
  const config = readBuildConfig(dir, distDir);
  process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(config);

  /* Assigned once `prepare()` has resolved; every request waits for that. */
  let handler = null;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  /* A rejection is reported through the request path AND kills the process
   * below; attaching this keeps Node from calling it unhandled in between. */
  ready.catch(() => {});

  const server = http.createServer((request, response) => {
    ready.then(
      () => handler(request, response),
      () => {
        /* Unreachable in practice -- the process exits on a prepare failure --
         * but a listener that is already accepting connections must answer
         * something, and 503 is the honest one. */
        response.statusCode = 503;
        response.setHeader("cache-control", "no-store");
        response.end();
      }
    );
  });

  server.on("error", (error) => {
    fatal(
      `could not listen on ${BIND_HOST}:${KERNEL_CHOOSES_THE_PORT} (${error.code ?? error.message}). ` +
        `A kernel-selected port should always be available; this is not a port collision.`
    );
  });

  server.listen(KERNEL_CHOOSES_THE_PORT, BIND_HOST, () => {
    const address = server.address();
    if (address === null || typeof address === "string") {
      fatal("the listener bound to a pipe or socket rather than a TCP port");
    }
    if (address.address !== BIND_HOST) {
      /* Invariant 5. The environment can claim loopback; this is what the
       * kernel did. */
      fatal(
        `the listener bound ${JSON.stringify(address.address)}, not ${BIND_HOST}; ` +
          `refusing to serve on an address that is not loopback`
      );
    }

    /*
     * NEXT IS CONSTRUCTED WITH THE REAL PORT. Not with 0: NextCustomServer
     * forwards `this.options.port || 3000`, so a falsy port would hand Next
     * the very number this task exists to stop using.
     */
    const next = require("next");
    const app = next({
      dir,
      dev: false,
      hostname: BIND_HOST,
      port: address.port,
      /* So Next can attach its own `upgrade` handling to the socket we own. */
      httpServer: server
    });
    handler = app.getRequestHandler();

    app.prepare().then(resolveReady, (error) => {
      rejectReady(error);
      fatal(explainPrepareFailure(error, distDir));
    });
  });
}

main();
