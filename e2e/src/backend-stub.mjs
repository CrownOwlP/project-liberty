#!/usr/bin/env node
/* -------------------------------------------------------------------------
 * THE AUTHENTICATED PLAYBACK BACKEND, AS A STUB (PL-0501, round 45, correction 4)
 *
 * WRITTEN BY PL-0501 INSIDE PL-0701's DECLARED SURFACE, which is BACKLOG and
 * unowned and blocked behind PL-0501. See `tls.ts` for the provenance note; the
 * same applies here.
 *
 * WHAT IT IS FOR. `docs/DESKTOP_PLAYBACK.md` §8 rules that the desktop build
 * forwards `/api/v1/playback/session` to an authenticated backend rather than
 * resolving providers on the machine the viewer administers. Round 44 asserted
 * that property against the module graph and against an injected `fetch`, and
 * recorded in its own gate evidence that nothing proved a forwarded request
 * ever reaches a backend and returns. This process is the backend that proves
 * it.
 *
 * THREE JOBS, AND IT HAS NO OTHERS.
 *
 *   1. RECORD. Every request it receives is kept, with method, path, headers
 *      and body, and served back on `GET /__requests`. That is what turns
 *      "the desktop target answered" into "the desktop target FORWARDED" -- the
 *      difference the whole ruling is about.
 *   2. PROXY. By default it relays the session request to the WEB-target server
 *      and returns its answer verbatim. That is what makes cross-target
 *      contract equivalence a meaningful comparison: the two targets are then
 *      answering from the same decision, so any difference in status, shape or
 *      reason semantics is a difference in the ENVELOPE, which is the thing §8
 *      says must be identical.
 *   3. ANSWER CANNED DECISIONS for a handful of reserved content ids, so a spec
 *      can make the backend say something a local resolver never would. A
 *      desktop build that returned the backend's answer instead of the one a
 *      local fixture provider would have produced has demonstrated, at runtime,
 *      that it did not resolve locally.
 *
 * IT IS DELIBERATELY NOT A SECOND IMPLEMENTATION OF THE ROUTE. It performs no
 * rights evaluation, no ranking and no URL policy: it either relays the real
 * one or returns a literal. A stub that reimplemented the decision would be a
 * second opinion about it, and the equivalence test would then be comparing two
 * of our own guesses.
 *
 * PLAIN JAVASCRIPT RATHER THAN TYPESCRIPT, and that is a real cost stated
 * rather than hidden: `e2e/tsconfig.json` typechecks `src/**\/*.ts` and this
 * file is outside that. It is spawned directly by `node` from
 * `playwright.config.ts`, and the harness has no build step or loader; a `.ts`
 * file there would need one, or Node's type stripping, which does not apply to
 * a CommonJS-resolved file. Kept small and dependency-free for that reason.
 * ---------------------------------------------------------------------- */

import { createServer } from "node:https";
import { readFileSync } from "node:fs";

const PORT = Number(process.env.LIBERTY_E2E_BACKEND_STUB_PORT ?? "3102");
const UPSTREAM = process.env.LIBERTY_E2E_STUB_UPSTREAM ?? "http://127.0.0.1:3100";
const CERTIFICATE = process.env.LIBERTY_E2E_STUB_CERT;
const PRIVATE_KEY = process.env.LIBERTY_E2E_STUB_KEY;

if (!CERTIFICATE || !PRIVATE_KEY) {
  console.error("backend stub: LIBERTY_E2E_STUB_CERT and LIBERTY_E2E_STUB_KEY are required");
  process.exit(1);
}

const SESSION_PATH = "/api/v1/playback/session";

/**
 * Reserved content ids, and what the backend answers for each.
 *
 * NAMED SO A LOCAL RESOLVER COULD NEVER PRODUCE THE SAME ANSWER. Under a
 * development build the fixture provider grants a session for ANY normalized
 * id, so a `denied` for `stub-denied` cannot have come from anywhere but here.
 */
const CANNED = {
  "stub-denied": {
    status: 403,
    body: {
      outcome: "denied",
      reasons: [
        {
          code: "rights_not_established",
          candidateId: null,
          detail: "the authenticated backend refused this title for the stub suite"
        }
      ]
    }
  },
  "stub-unavailable": {
    status: 503,
    body: {
      outcome: "unavailable",
      reasons: [
        {
          code: "provider_unavailable",
          candidateId: null,
          detail: "the authenticated backend had no provider for the stub suite"
        }
      ]
    }
  },
  /* Not a member of the response union. The forwarder must refuse to relay a
   * body it could not parse as a decision, rather than passing bytes through. */
  "stub-off-contract": { status: 200, body: { outcome: "granted", session: null } },
  /* A redirect the forwarder must NOT follow: following one would re-send the
   * caller's identity headers to whatever origin the redirect named. */
  "stub-redirect": { status: 302, redirect: "https://127.0.0.1:1/elsewhere" }
};

/** Everything this process has been asked, newest last. */
const received = [];

function json(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload)
  });
  response.end(payload);
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const server = createServer(
  { cert: readFileSync(CERTIFICATE), key: readFileSync(PRIVATE_KEY) },
  (request, response) => {
    void handle(request, response).catch((cause) => {
      json(response, 500, { error: "backend_stub_failed", detail: String(cause) });
    });
  }
);

async function handle(request, response) {
  const url = new URL(request.url ?? "/", `https://127.0.0.1:${PORT}`);

  if (url.pathname === "/__health") {
    json(response, 200, { ok: true, upstream: UPSTREAM });
    return;
  }

  if (url.pathname === "/__requests") {
    if (request.method === "DELETE") {
      received.length = 0;
      json(response, 200, { cleared: true });
      return;
    }
    json(response, 200, { requests: received });
    return;
  }

  const body = await readBody(request);

  /*
   * RECORDED BEFORE ANYTHING IS DECIDED, including for a path this stub does
   * not serve. A forwarder that started sending requests somewhere else on this
   * origin should show up in the ledger rather than in a 404 nobody reads.
   */
  received.push({
    method: request.method ?? "",
    path: url.pathname,
    headers: { ...request.headers },
    body
  });

  if (url.pathname !== SESSION_PATH) {
    json(response, 404, { error: "backend_stub_unknown_path", path: url.pathname });
    return;
  }

  let contentId = null;
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === "object" && typeof parsed.contentId === "string") {
      contentId = parsed.contentId;
    }
  } catch {
    /* Not JSON. The upstream route answers malformed bodies with a well-formed
     * denial, so relaying is the right behaviour and there is nothing to do. */
  }

  const canned = contentId === null ? undefined : CANNED[contentId];
  if (canned !== undefined) {
    if (canned.redirect !== undefined) {
      response.writeHead(canned.status, { location: canned.redirect });
      response.end();
      return;
    }
    json(response, canned.status, canned.body);
    return;
  }

  /*
   * THE PROXY PATH. Relayed to the WEB-target server, so the decision both
   * targets are compared on is one decision rather than two implementations of
   * one. Headers are relayed as received, minus the hop-by-hop ones Node will
   * set itself -- this stub is not the place that enforces an allowlist; the
   * FORWARDER is, and what it chose to send is exactly what the ledger above
   * records for the spec to assert.
   */
  const outbound = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (["host", "connection", "content-length", "transfer-encoding"].includes(name)) continue;
    outbound.set(name, Array.isArray(value) ? value.join(", ") : value);
  }

  let upstream;
  try {
    upstream = await fetch(new URL(SESSION_PATH, UPSTREAM), {
      method: request.method ?? "POST",
      headers: outbound,
      body: body.length === 0 ? undefined : body,
      redirect: "error"
    });
  } catch (cause) {
    json(response, 502, {
      outcome: "unavailable",
      reasons: [
        {
          code: "provider_unavailable",
          candidateId: null,
          detail: `the stub backend could not reach its upstream: ${String(cause)}`
        }
      ]
    });
    return;
  }

  const text = await upstream.text();
  response.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") ?? "application/json",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(text)
  });
  response.end(text);
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`backend stub listening on https://127.0.0.1:${PORT} (upstream ${UPSTREAM})`);
});
