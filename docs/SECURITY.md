# Security Architecture

## Threat priorities

1. Account/session theft.
2. Unauthorized content access.
3. Provider credential leakage.
4. SSRF through provider/media URLs.
5. XSS through untrusted metadata.
6. Injection into persistence/search systems.
7. Privacy leakage through logs/telemetry.
8. Abuse of playback/session endpoints.

## Controls

- Validate all public input at transport boundaries.
- Enforce authorization server-side.
- Keep provider secrets server-only.
- Provider adapters use explicit allowlists for hosts and protocols.
- Never proxy arbitrary client-provided URLs.
- Apply output escaping and avoid raw HTML for provider metadata.
- Add rate limits for auth, search, and playback resolution.
- Use structured logs with redaction.
- Use short-lived playback/session tokens where applicable.
- Maintain an audit trail for privileged/admin actions.

## Security review requirement

Changes to auth, authorization, provider resolution, URL fetching, secrets, admin functionality, or payment/subscription logic require a security review before merge.

## Review record — PL-0702, provider and URL security

**The findings register for this task is `docs/SECURITY_REVIEW_PROVIDER_URL.md`.**
It is organised by the five named classes and states, per class, what was examined
and by what method. This section is the summary that lives beside the controls; the
register is the evidence.

### Round two (2026-09-17) — what the second pass found and executed

The first pass, recorded below, states that nothing was executed. The second pass
ran a differential probe over 29 hostile host spellings, a `fetchJson` redirect
probe, a request-reflection measurement, a Zod issue-serialisation probe and a
resolve-scaffold smuggling probe, then kept 11 of those as regressions. It found
three defects that a reading pass had missed twice, all three in code the first
pass had read and passed:

**F7 — a fully qualified hostname bypassed the private-host allowlist AND the
loopback gate. High. Fixed.** `new URL()` strips a trailing dot from an IP literal
and KEEPS it on a domain, so `metadata.google.internal.`, `vault.corp.`,
`nas.local.` and `localhost.` matched no comparison in `classifyHost` and came out
`public`. The loopback case is the worse half: classified `public`, a loopback name
never reaches the branch that demands a source opt-in and a local deployment, so
*both* permissions went unasked. Driven through the real session boundary in the
hosted configuration, all four were published to the client as playable
`session.candidates[].uri`. Fixed by stripping the DNS root label ahead of every
comparison; an empty label is refused rather than repaired.

**F8 — IPv6 translation prefixes carrying a private IPv4 address classified as
public. Medium. Fixed.** `classifyIPv6` detects IPv4-mapped and IPv4-compatible
addresses by testing that the first five groups are zero. `64:ff9b::/96` (NAT64
well-known), `2002::/16` (6to4) and `::ffff:0:0/96` (IPv4-translated) embed an IPv4
address without that zero prefix, so `[64:ff9b::a9fe:a9fe]` — the cloud metadata
address — classified `public`. Fixed by decoding the embedded address and asking
`classifyIPv4` about it, which is strictly correct rather than merely stricter: the
same prefixes wrapping 8.8.8.8 still classify `public`, and a test says so.

**F9 — refused request-field names were reflected verbatim and unbounded into the
reason trail. Low. Fixed.** The session request schema is `.strict()`, and the
`unrecognized_keys` detail was every client-chosen key name at full length. Measured:
a 100 KiB property name produced a 100,060-character `detail`, returned in the 400
body and carried into logs. The same class F5 fixed on the outbound side; the
inbound side had no equivalent. Capped at 64 characters per name and 8 names, with
the withheld count stated. It caps rather than redacts because an unrecognised key
is a rights event and the field name is the diagnosis.

**Still open, and outside this task's `allowedPaths` — see the register for file,
line and owner.** **F10:** the production-reachable session route reads an unbounded
request body while the development-only resolve scaffold beside it caps one; fixing
it needs a reason code that does not exist and therefore a change to
`docs/API_CONTRACTS.md`, so it needs a task owning both paths at once. **F11:** R5
below, now measured — a 1,000,000-character candidate `id` produced a 2,002,555-byte
response; the bound belongs in `packages/contracts`. **F12:** `hostOnAllowlist` in
`packages/media-inspection` does not fold the root label either, which fails *closed*
and so is not a bypass, but is the same inconsistency seen from the other side.

**A1 below is now a weaker acceptance than when it was written.** F1, F7 and F8 are
three defects of one shape — host-*string* comparison getting a spelling wrong — in
one function. That is evidence about the approach. R1's resolve-and-pin adoption is
the remedy and still has no owner; it is the most important open item on this
surface.

### Round one — scope examined

- `packages/provider-sdk/**` — `url-policy.ts`, `http.ts`, `client.ts`, `mapping.ts`, `source.ts`, `protocol.ts`.
- `apps/web/src/app/api/**` — `health`, `v1/catalog/home`, `v1/playback/resolve`, `v1/playback/session`.
- Read but not editable under this task: `packages/media-inspection/src/egress.ts`, `packages/contracts`, `e2e/**`.

Reviewed against SSRF, secret exposure, redirect handling, allowlist enforcement, and rights bypass. Nothing was executed: no test, typecheck or build was run for this review, so every claim below is from reading.

### Findings

**F1 — `classifyHost` returned `public` for an unbracketed IPv6 literal. High (latent). Fixed.**
`classifyHost` dispatches on a leading `[`, which only `new URL()` adds. `fd00::1`, `fe80::1` and `::1` passed in directly matched no IPv4 branch, no numeric branch, no loopback name and no private suffix, and fell through as `public` — the one answer that opens a socket. Not reachable from inside provider-sdk, where every caller passes a `URL.hostname`; reachable the moment a caller passes a resolver answer, which is bare, and `packages/media-inspection`'s `authoriseFetchTarget` is exactly that caller. Fixed by enforcing the precondition — a colon outside brackets is now `unparseable`. Deliberately not auto-bracketed: that would silently widen what the function accepts on behalf of a consumer whose `HostClassifier` port is typed against the four-value vocabulary and which does its own bracketing.

**F2 — `POST /api/v1/playback/resolve` was an unguarded, unauthenticated rights-verdict endpoint. Medium. Fixed (gated, not removed).**
The caller supplies each candidate's `rights` and receives a full playability verdict. `docs/API_CONTRACTS.md` describes it as a testability scaffold; nothing in the code did, so it was reachable from a hosted deployment. It is **not** an SSRF or media hole — `StreamCandidate` carries no URI, so nothing becomes fetchable or playable and no rights are conferred on anything real. Now returns 404 `route_not_available` unless the deployment is non-production, using the same `NODE_ENV` process-boundary switch as `authorized-candidates.ts`, injectable for tests and never a request field. Gated rather than deleted because deletion also touches `docs/API_CONTRACTS.md`, `docs/E2E.md` and three `e2e/` specs, none of which are in this task's `allowedPaths`; see "Follow-ups".

**F3 — no upper bound on the resolve candidate array. Medium. Fixed.**
`playbackResolveRequestSchema` bounds `candidates` below (`.min(1)`) and not above, so an unbounded array reached Zod's per-element validation and then `rankStreamCandidates`, which scores every candidate against every capability and sorts — a remote compute amplifier bought with a short body of repeated objects. Capped at 100, checked before `safeParse`. A `content-length` cap of 1 MiB was added as a cheap early exit; it is a claim rather than a measurement, and the metered read that would be the real control is deliberately absent from a route that cannot be reached in production.

**F4 — `await request.json()` outside any try on the resolve route. Low. Fixed.**
A non-JSON body threw out of the route and became a 500 with no reason trail — the failure the sibling session route was written to avoid, in the route beside it, and already named in `docs/E2E.md`. Now a 400 `invalid_request`.

**F5 — reason-trail details reproduced an unbounded hostname. Low. Fixed.**
Five `checkUrl` rejection details named `url.hostname` untruncated. `detail` is copied verbatim into a candidate's reason trail by `mapping.ts`, and on a stream URL the host is the addon's choice; the WHATWG parser enforces no length limit on a hostname (253 bytes is a resolver rule, not a parsing one). A host cannot carry a signed query string, so this is log flooding rather than credential leakage. Capped at 64 characters, matching what `packages/media-inspection/src/egress.ts` already does with the same five messages.

**F6 — `/api/health` served without `cache-control: no-store`. Informational. Fixed.**
A cached 200 reports the liveness of a process that may have died minutes ago.

### Accepted risks

**A1 — the outbound URL policy validates the host LITERAL, not the resolved address.** A public name with a private A record, and a name that answers differently between check and connect (DNS rebinding), both pass. Accepted only while the Stremio adapter is what it is today: operator-fixed endpoints, reviewable at configuration time. `packages/provider-sdk/src/stremio/url-policy.ts` states the condition under which acceptance expires — the day this becomes the general client for arbitrary operator- or user-configured addons, host-string checks stop being a control at all, because the attacker chooses the name. See "Residual risks" for why this is now weaker than a plain acceptance.

**A2 — the Stremio `/stream` array has no element-count bound.** Bounded transitively by `DEFAULT_MAX_RESPONSE_BYTES` (1 MiB), which is enforced by a metered streaming read rather than a `Content-Length` claim. Accepted: the byte cap is the binding constraint and duplicating it as a count would be a second number to keep in agreement.

**A3 — `manifestServes` reads an absent `types`/`resources` list as "no restriction".** Permissive by design and explicitly not a security control — the addon authors its own manifest, so a lying manifest only widens what it gets asked. Accepted because nothing downstream trusts the manifest; this acceptance is void for any future caller that uses it to decide rights or reachability.

**A4 — provider health counters are per-process, unshared and unauthenticated to read.** Not an entitlement input: `mapStremioStream` refuses a non-playable source identically at health 1 and health 0. Accepted as an availability signal.

### Verified with no finding

- Redirects are followed manually, every hop re-validated through the same gate, relative `Location` resolved against the URL that issued it, chain length capped.
- Protocol allowlist is consulted rather than decorative: `https:` only, `http:` only for a literal loopback host, every other scheme refused at both the policy and the mapping layer.
- Private, link-local, CGNAT, multicast, reserved and metadata ranges are rejected before the socket opens, including when loopback is permitted, and including IPv4-mapped IPv6 spellings.
- Loopback requires two independently owned permissions (source opt-in AND deployment mode); a source config attempting to declare `localDeployment` is refused rather than ignored.
- Outbound requests carry `credentials: "omit"` and no ambient credentials.
- Errors are named by type plus a runtime error code, never by message; `JSON.parse`'s document slice and any fetch implementation's URL-bearing message are dropped.
- Unparseable URLs are described by scheme and length, never echoed.
- Rights are operator-declared per source, re-checked at the source gate, at the provider constructor and at the mapper, and are never read or inferred from anything an addon returns. `proxyHeaders` is refused loudly as an access control this adapter will not work around.
- The session route accepts no field that becomes a URL, validates its own response against the published contract, and is served `no-store`.
- **F2's `NODE_ENV` guard survives this repository's own env plumbing**, which is the question worth asking rather than assuming, because a guard keyed on `NODE_ENV` is only as good as how `NODE_ENV` reaches the running server. `apps/web`'s `start` script runs through `scripts/with-root-env.mjs`, which loads the repository root's dotenv files into `process.env` — and its `NEVER_APPLIED` set holds exactly one name, `NODE_ENV`, naming the resolve handler among the branches it protects. That is load-bearing and not caution: `.env.example` ships `NODE_ENV=development`, `README.md` instructs `cp .env.example .env.local`, `.env.local` is in the production file list as well as the development one, and `next/dist/bin/next` assigns `process.env.NODE_ENV || defaultEnv` — it *respects* a pre-set value and only warns. Without that one exclusion, a copied `.env.local` would turn `npm run start` into a development server carrying the scaffold. `.github/workflows/ci.yml` likewise refuses to pin `NODE_ENV` in the job `env:`, on the stated grounds that a workflow file must not decide which branch of the resolve handler a built artifact takes.

  Two limits on that verification, stated because a clean-looking check is the thing most worth qualifying. Nothing was executed — whether Next's build-time define also inlines `process.env.NODE_ENV` in the compiled server bundle, which would make the guard build-time and immune to the runtime environment entirely, was not confirmed by running a build; if it does, the guard is stronger than described here, and if it does not, the runtime read above is the whole of it. And an operator who *exports* `NODE_ENV=development` into a hosted process still gets the scaffold. That is outside what code can prevent, and it is the reason R3 records removal as the correct end state rather than treating the gate as the finish line.

### Residual risks, open

- **R1 — resolve-and-pin has no owner.** A1's remedy now exists in this repository: `@liberty/media-inspection`'s `authoriseFetchTarget` resolves the name, classifies every answer, and refuses on any private result. The Stremio adapter does not use it. That changes the deferral from "nobody has built this" to "this adapter has not adopted it", which is a weaker acceptance. `url-policy.ts` previously tracked the work as PL-0701; PL-0701 is the end-to-end harness and never covered it, so the work is currently tracked nowhere. **Needs a control-plane task.**
- **R2 — no rate limits exist on any route.** "Add rate limits for auth, search, and playback resolution" is a control listed above and is unimplemented. The natural home is request middleware, outside this task's `allowedPaths`. F3's cap bounds per-request work, not request rate.
- **R3 — the resolve scaffold still exists.** Gating closes the hosted exposure; the route remains reachable in development and remains the only endpoint that accepts client-supplied rights. Removal is the correct end state.
- **R4 — no authentication or authorization exists on any API route yet.** Every finding above is scoped to a system with no identity layer. When one lands, each route needs revisiting; nothing in the current code should be read as a decision that these routes are safe to leave anonymous.
- **R5 — the resolve scaffold reflects caller-supplied candidate strings back verbatim.** Found on re-reading F2's fix rather than during the original pass, and recorded rather than fixed because the fix does not belong in this task's paths. `streamCandidateSchema.id` and `.providerId` are `z.string().min(1)` with no upper bound and no charset restriction, and `rankStreamCandidates` copies the whole candidate into `ranked[].candidate` and the id into `rejected[].candidateId`, so whatever a caller puts in those two fields comes back out. Same class as F5 — an unbounded attacker-chosen string landing in a reason trail, and from there in logs and dashboards — and weaker than F5 only because this route is unreachable in production and confers no rights. Note that it also under-cuts a claim made elsewhere: `e2e/tests/rights-boundary.api.spec.ts`'s "never accepts, acts on or returns a candidate URL" smuggles its URL into an extra key, which Zod strips, so the test passes without exercising the field that would actually echo one. `playbackResolveRequestSchema` is a plain `z.object`, not `.strict()` like the session contract, so an unknown key is dropped silently rather than refused. The bound belongs on the schema in `packages/contracts`, next to F3's `.max()`.

### Follow-ups

Recorded here as pending at the time of the review because they were outside this
task's `allowedPaths`. Re-checked against the working tree; three have since
landed, and the status is restated rather than deleted so that a reader can tell
a closed follow-up from one nobody ever picked up.

- **Done** — `e2e/tests/rights-boundary.api.spec.ts`. The review recorded this as a red e2e gate: two tests POSTed to `/api/v1/playback/resolve` expecting 400 and 200, against a harness that defaults to a production build where the route now answers 404. The spec now splits on `WEB_MODE` rather than skipping wholesale — a dedicated test asserts the 404 gate with no `selected` and no `ranked` under the default `production` mode, and `requiresResolveScaffold()` guards the three ranking tests with a stated reason. The gate having been made a rights control is why it is asserted rather than skipped around.
- **Done** — `docs/API_CONTRACTS.md`. The resolve section now leads with "Not part of a hosted deployment", states the 404 and why it is 404 and not 403, names `handler.ts` as the thing that enforces the scaffold status, and documents both 413 refusals and the 400 on a non-JSON body.
- **Done** — `docs/E2E.md`. The stale "500 on a non-JSON body" note is gone; the coverage table now carries a "Resolve gate" row, and the not-covered section explains why the body limits are unit-tested rather than asserted through the harness.
- **Open** — `packages/contracts`. `.max()` on `playbackResolveRequestSchema.candidates` is still the better home for F3's bound than a route-level pre-check, and R5 wants an upper bound on `streamCandidateSchema.id` and `.providerId` in the same place. The route-level check stays either way: it runs before `safeParse`, which is the property F3 was about.
- **Open** — `control/tasks.json`. A task for R1, and one that owns every file naming this route at once if R3's removal is ever taken (`apps/web/src/app/api/v1/playback/resolve/**`, `docs/API_CONTRACTS.md`, `docs/E2E.md`, `e2e/**`). No application code calls the route — grepping `api/v1/playback` across the repo finds only the session route's own callers — so removal is a docs-and-tests change, not a client migration.
