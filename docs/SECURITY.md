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
*(F7 and F12 are both closed, and PL-0710 part A removed the condition that produced
them: the fold is now one function in `@liberty/net-policy` that all three gates —
`classifyHost`, `hostOnAllowlist` and the pinned lookup's hostname comparison —
call. The third of those did not fold at all and was safe only because both sides
of its comparison came from the same `URL` object.)*

**A1 below has since been RETIRED, and the reason it had to be is the finding
itself.** F1, F7 and F8 are three defects of one shape — host-*string* comparison
getting a spelling wrong — in one function. That is evidence about the approach
rather than about any one branch: a check that compares a string against literals
is only ever as complete as the list of spellings whoever wrote it thought of.
R1's resolve-and-pin adoption was the remedy, it is now done in both halves
(PL-0710), and it classifies the address a resolver returned — which has one
spelling. A1 and R1 below record what changed and what it does not cover.

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

**A1 — the outbound URL policy validates the host LITERAL, not the resolved address. RETIRED by PL-0710 part B; the original acceptance is kept below because a retired acceptance is a record, not a deletion.**

*As accepted:* a public name with a private A record, and a name that answers differently between check and connect (DNS rebinding), both passed. Accepted only while the Stremio adapter was what it was: operator-fixed endpoints, reviewable at configuration time. `packages/provider-sdk/src/stremio/url-policy.ts` stated the condition under which the acceptance expired — the day this became the general client for arbitrary operator- or user-configured addons, host-string checks stop being a control at all, because the attacker chooses the name. PL-0710 part A moved the classifier into `@liberty/net-policy` and did NOT change this: a classifier of the host literal is still a classifier of the host literal.

*What retires it:* PL-0710 part B. `packages/provider-sdk/src/stremio/http.ts` — the only place the package opens a connection — now runs `checkUrl` AND `@liberty/media-inspection`'s `authoriseResolvedTarget`. The name is resolved before the connection; every returned address is classified; any private, loopback, link-local or reserved answer refuses the target; the surviving addresses travel to the transport inside an unforgeable `PinnedTarget`, so no second resolution can choose the destination; and every redirect hop repeats all of it and gets its own pin. `StremioProviderOptions.fetch` is a `PinnedFetch` with no default, so the unpinned `globalThis.fetch` that used to be the fallback is not expressible.

*What A1's retirement does NOT claim.* `checkUrl` itself is unchanged and is still a host-literal gate — deliberately, because a gate that resolved would be a second resolution and a second SSRF control. It is now the first of two halves rather than the last word. And the adapter still has no operator host ALLOWLIST, which `@liberty/media-inspection` does have; see R6.

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

- **R1 — resolve-and-pin is owned, and BOTH halves have landed. Closed.** A1's remedy is now applied where A1 lived. The work is **PL-0710**.

  **Part A** extracted the canonical host vocabulary into `@liberty/net-policy`, a dependency leaf that imports neither `@liberty/provider-sdk` nor `@liberty/media-inspection`; both packages consume it, and the three separate canonicalisers described under F7 and F12 are one.

  **Part B** is the half that retires A1, and each clause is a separate way host-literal checking fails:

  | clause | where it is enforced | where it is proved |
  | --- | --- | --- |
  | DNS resolution before the connection | `authoriseResolvedTarget` in `packages/media-inspection/src/egress.ts`, called from `packages/provider-sdk/src/stremio/http.ts` | `resolve-and-pin.test.ts` clause 1 |
  | every resolved address classified | the loop over `addresses`, not `addresses[0]` | `resolve-and-pin.test.ts` clause 2/3, driven from `HOSTILE_ADDRESS_SPELLINGS` |
  | any disallowed answer refuses, mixed sets included | `dns_resolved_private_address` | same, both orderings of a mixed set |
  | the transport connects only to an authorised address | the `PinnedTarget` and `createPinnedLookup` in `packages/media-inspection/src/pin.ts` | `pinned-transport.test.ts`: a server on 127.0.0.1, a pin on 127.0.0.2, and no request arrives |
  | per redirect hop | the loop in `http.ts` re-authorises and therefore re-pins | `resolve-and-pin.test.ts` clause 5 |
  | loopback only via the two-key path | `checkUrl` (source opt-in AND local deployment) | `resolve-and-pin.test.ts` clause 6, including a public name that resolves to 127.0.0.1 being refused with both keys set |
  | Host, SNI and certificate identity stay the ORIGINAL hostname | the resolver is substituted, not the host: `packages/media-inspection/src/node/pinned-fetch.ts` keeps `hostname` and `servername` as `url.hostname` | `pinned-transport.test.ts`: Host header over plaintext, SNI read off the ClientHello, and a completed handshake against a certificate whose only SAN is `DNS:localhost` — with the rejected connect-by-address design failing `ERR_TLS_CERT_ALTNAME_INVALID` beside it as the counterfactual |

  **The mechanism is shared, not duplicated.** `authoriseResolvedTarget` is the second half of `@liberty/media-inspection`'s own `authoriseFetchTarget`: the same resolution, the same per-address classification, the same `pinFor`, the same brand and the same registry, now exported so a package with its own static gate can reach it. A second resolve-and-pin written beside the first would be the two-classifiers defect one layer up. `net-policy-boundary.test.ts` in `@liberty/provider-sdk` asserts the edge exists, that it uses the narrow `./egress` and `./pin` subpaths rather than the barrel, and that `@liberty/media-inspection` does not depend back — so the arrangement is acyclic by assertion rather than by reading.

  Why the design changed, because the reason is the control-plane record rather than a preference: PL-0709 had to import `classifyHost` from `@liberty/provider-sdk` by DEEP RELATIVE PATH to write its agreement test, since that package published a bare `./src/index.ts` exports field with no subpaths. The reviewer accepted that import for that one test at that one tree and ruled it was not an acceptable permanent boundary. Making `@liberty/media-inspection` depend on `@liberty/provider-sdk` creates a cycle, because part B points the arrow the other way. A lower shared layer that neither package can import back is the shape that works for the vocabulary; the resolve-and-pin control itself is reached by an ordinary acyclic edge onto the package that owns it.

  **What part A bought, stated as a control and not as tidying.** F1, F7 and F8 were three defects of one shape in one function, and F12 was a fourth spelling in a SECOND function written specifically to avoid duplicating the first. The duplication arrived anyway — not as a copied classifier but as a copied assumption about what a hostname string is. There is now one root-label fold, one address classifier and one bracket convention, in one package, and both consumers are held to importing them by reference-identity assertions rather than by convention (`net-policy-boundary.test.ts` in each). The deep cross-package import is gone and a scan refuses its return.
- **R2 — no rate limits exist on any route.** "Add rate limits for auth, search, and playback resolution" is a control listed above and is unimplemented. The natural home is request middleware, outside this task's `allowedPaths`. F3's cap bounds per-request work, not request rate.
- **R3 — the resolve scaffold still exists.** Gating closes the hosted exposure; the route remains reachable in development and remains the only endpoint that accepts client-supplied rights. Removal is the correct end state.
- **R4 — CORRECTED ON RE-AUDIT (PW-0402). It said "no authentication or authorization exists on any API route yet"; half of that is out of date and the half that is still true is the more serious one.**

  **AUTHORIZATION IS ENFORCED, and was already.** Every profile-scoped handler resolves a request context and then calls `resolveActiveProfileScope`, which calls `authorizeProfileAccess` in `@liberty/auth` against a real ownership record and a minted `ProfileScope`. **No handler reads a profile id from the caller** — there is no `?profileId=` and no body field, which is the route-level form of the cross-profile bypass PL-0405 found one layer down. The existence leak is closed too: `externalProfileAccessReason` narrows `profile_not_found` and `profile_not_owned_by_account` to one external `profile_unavailable`, through a total `switch` with no `default`, so extending the union fails to compile rather than leaking a new reason. `apps/web/src/lib/authorization/handler-authorization.test.ts` now guards all of that mechanically, so it cannot quietly stop being true.

  **AUTHENTICATION IS NOW ENFORCED IN A DEPLOYMENT (PW-0403), and the sentence this replaces is kept below because the state it described is what the desktop still has to be protected from.** `apps/web/src/lib/session/auth-instance.ts` constructs the reviewed `@liberty/auth/server` instance from validated configuration, `/api/auth/*` serves its endpoints, and `resolveRequestAccount` resolves a deployment identity **only** from a verified, database-backed session. Absent, malformed, expired and revoked sessions are one indistinguishable `not_authenticated` (401); the store failing to answer is `authentication_not_configured` (503), because "retry later" is true of one and false of the other. The instance declines Better Auth's `cookieCache`, so a revoked session stops working immediately rather than at the end of a cache window.

  *What it replaced:* `resolveRequestAccount` established an account from a **plaintext development header** in a non-deployment runtime and refused outright in a deployment, so the routes were **unauthenticated in development and closed in production** — the identity every authorization decision was built on was whatever the caller typed in a header, on any machine where the runtime classified as non-deployment.

  **WHAT THE DESKTOP CHANGES.** A hosted deployment is closed, so nobody can reach it unauthenticated. A sidecar is not: it runs on the user's own machine, where the runtime may well classify as non-deployment, and **every process on that machine can reach the loopback port**. PW-0101's per-launch bearer token stops an unrelated process talking to the listener at all — but a launch token is not a login, and `route-authorization.ts` exists to make that separation structural: it is never given a `Request`, so it cannot consult the token even by accident, and it names no address, so "it came from 127.0.0.1" can never become a credential.

  **WHAT THE DESKTOP CHANGES, RESTATED FOR THE NEW STATE.** The development-header branch has not been removed and must not be: it is what lets `next dev` and the unit suites exercise cross-household behaviour without a sign-in flow. It is reachable only with a minted `NonDeploymentEnvironment`, so a hosted deployment cannot take it — but **a desktop build that classified as a non-deployment would take it**, on a machine where every local process can reach the loopback port. PW-0101's per-launch bearer token stops an unrelated process talking to the listener at all, and `route-authorization.ts` keeps that token from becoming a login by never being given a `Request`. The same separation now holds from the other side: `deploymentSessionAccount` reads the session cookie and nothing else, and it is asserted not to authenticate on a launch token, a loopback origin, or a development header. **The desktop build must still classify as a deployment.** That is a packaging requirement (PW-0102/PW-0601), not something this module can enforce.

  **STILL OPEN AFTER PW-0403, and stated so that neither is mistaken for delivered:**

  - **No mail transport is configured.** `createLibertyAuth` requires one and the composition root supplies a placeholder that **rejects** rather than one that logs the link (a one-click account-takeover token in the log aggregator) or silently drops it. The consequence is real: with `requireEmailVerification: true`, sign-up cannot complete, and password reset cannot start. Wiring SMTP is an operator concern with its own credentials.
  - **No SQL has been executed against PostgreSQL.** There is no database in this environment, so the instance has been constructed only against validated configuration and the refusal paths; the sign-in round trip itself is owed to a real-device or CI observation. The `integration` gate remains unsatisfiable from this lane.
  - **No sign-in UI.** `/api/auth/*` is served; nothing in the application links to it. A viewer in a deployment currently receives 401 with no screen to act on, which PW-0309 (offline/degraded states) or a dedicated task should close.
- **R5 — the resolve scaffold reflects caller-supplied candidate strings back verbatim.** Found on re-reading F2's fix rather than during the original pass, and recorded rather than fixed because the fix does not belong in this task's paths. `streamCandidateSchema.id` and `.providerId` are `z.string().min(1)` with no upper bound and no charset restriction, and `rankStreamCandidates` copies the whole candidate into `ranked[].candidate` and the id into `rejected[].candidateId`, so whatever a caller puts in those two fields comes back out. Same class as F5 — an unbounded attacker-chosen string landing in a reason trail, and from there in logs and dashboards — and weaker than F5 only because this route is unreachable in production and confers no rights. Note that it also under-cuts a claim made elsewhere: `e2e/tests/rights-boundary.api.spec.ts`'s "never accepts, acts on or returns a candidate URL" smuggles its URL into an extra key, which Zod strips, so the test passes without exercising the field that would actually echo one. `playbackResolveRequestSchema` is a plain `z.object`, not `.strict()` like the session contract, so an unknown key is dropped silently rather than refused. The bound belongs on the schema in `packages/contracts`, next to F3's `.max()`.
- **R6 — the Stremio adapter has no operator host allowlist, and its transport and resolver are injected.** Two residuals that R1's closure does not cover, recorded together because both are about what is outside the gate rather than inside it.

  `@liberty/media-inspection`'s `EgressPolicy` confines egress to hosts an operator named, and refuses everything when the list is empty. `@liberty/provider-sdk` has no equivalent: a Stremio source's endpoint is the operator's configuration, and a redirect may legitimately leave it, so the adapter admits any host that survives scheme, class, plaintext and the resolve-and-pin gate. Adding an allowlist is a product decision about how sources are configured, not an implementation detail, and PL-0710 deliberately did not invent one.

  `StremioProviderOptions.fetch` and `.resolveHost` are required with no defaults, which is what stops an unpinned `globalThis.fetch` being the path of least resistance — but they are still ports. A composition root that supplied a `PinnedFetch` which read `target.url` and ignored `target.addresses` would defeat the pin. Two things narrow that: the transport cannot obtain a socket from the pin except through `createPinnedLookup`, which refuses any target `authoriseFetchTarget` did not issue, and the only transport in the repository is `nodePinnedFetch`. Nothing prevents a future second one from being written badly. No composition root wires the Stremio adapter yet; PL-0302 is the task that will.

### Follow-ups

Recorded here as pending at the time of the review because they were outside this
task's `allowedPaths`. Re-checked against the working tree; three have since
landed, and the status is restated rather than deleted so that a reader can tell
a closed follow-up from one nobody ever picked up.

- **Done** — `e2e/tests/rights-boundary.api.spec.ts`. The review recorded this as a red e2e gate: two tests POSTed to `/api/v1/playback/resolve` expecting 400 and 200, against a harness that defaults to a production build where the route now answers 404. The spec now splits on `WEB_MODE` rather than skipping wholesale — a dedicated test asserts the 404 gate with no `selected` and no `ranked` under the default `production` mode, and `requiresResolveScaffold()` guards the three ranking tests with a stated reason. The gate having been made a rights control is why it is asserted rather than skipped around.
- **Done** — `docs/API_CONTRACTS.md`. The resolve section now leads with "Not part of a hosted deployment", states the 404 and why it is 404 and not 403, names `handler.ts` as the thing that enforces the scaffold status, and documents both 413 refusals and the 400 on a non-JSON body.
- **Done** — `docs/E2E.md`. The stale "500 on a non-JSON body" note is gone; the coverage table now carries a "Resolve gate" row, and the not-covered section explains why the body limits are unit-tested rather than asserted through the harness.
- **Open** — `packages/contracts`. `.max()` on `playbackResolveRequestSchema.candidates` is still the better home for F3's bound than a route-level pre-check, and R5 wants an upper bound on `streamCandidateSchema.id` and `.providerId` in the same place. The route-level check stays either way: it runs before `safeParse`, which is the property F3 was about.
- **Done** — `control/tasks.json`. PL-0710 owns R1, with `packages/net-policy/**`, both consumer packages and the packaging metadata reserved before the claim. Both halves have landed and A1 is retired; R6 records what they did not cover. **Still open** — a task that owns every file naming this route at once if R3's removal is ever taken (`apps/web/src/app/api/v1/playback/resolve/**`, `docs/API_CONTRACTS.md`, `docs/E2E.md`, `e2e/**`). No application code calls the route — grepping `api/v1/playback` across the repo finds only the session route's own callers — so removal is a docs-and-tests change, not a client migration.
