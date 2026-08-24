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

### Scope examined

- `packages/provider-sdk/**` — `url-policy.ts`, `http.ts`, `client.ts`, `mapping.ts`, `source.ts`, `protocol.ts`.
- `apps/web/src/app/api/**` — `health`, `v1/catalog/home`, `v1/playback/resolve`, `v1/playback/session`.
- Read but not editable under this task: `packages/media-inspection/src/egress.ts`, `packages/contracts`, `e2e/**`.

Reviewed against SSRF, secret exposure, redirect handling, allowlist enforcement, and rights bypass. Nothing was executed: no test, typecheck or build was run for this review, so every claim below is from reading.

### Findings

**F1 — `classifyHost` returned `public` for an unbracketed IPv6 literal. High (latent). Fixed.**
`classifyHost` dispatches on a leading `[`, which only `new URL()` adds. `fd00::1`, `fe80::1` and `::1` passed in directly matched no IPv4 branch, no numeric branch, no loopback name and no private suffix, and fell through as `public` — the one answer that opens a socket. Not reachable from inside provider-sdk, where every caller passes a `URL.hostname`; reachable the moment a caller passes a resolver answer, which is bare, and `packages/media-inspection`'s `authoriseFetchTarget` is exactly that caller. Fixed by enforcing the precondition — a colon outside brackets is now `unparseable`. Deliberately not auto-bracketed: that would silently widen what the function accepts on behalf of a consumer whose `HostClassifier` port is typed against the four-value vocabulary and which does its own bracketing.

**F2 — `POST /api/v1/playback/resolve` was an unguarded, unauthenticated rights-verdict endpoint. Medium. Fixed (gated, not removed).**
The caller supplies each candidate's `rights` and receives a full playability verdict. `docs/API_CONTRACTS.md` describes it as a testability scaffold; nothing in the code did, so it was reachable from a hosted deployment. It is **not** an SSRF or media hole — `StreamCandidate` carries no URI, so nothing becomes fetchable or playable and no rights are conferred on anything real. Now returns 404 `route_not_available` unless the deployment is non-production, using the same `NODE_ENV` process-boundary switch as `authorized-candidates.ts`, injectable for tests and never a request field. Gated rather than deleted because deletion also touches `docs/API_CONTRACTS.md`, `docs/E2E.md` and three `e2e/` specs, none of which are in this task's `allowedPaths`; see "Follow-ups outside this task's scope".

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

### Residual risks, open

- **R1 — resolve-and-pin has no owner.** A1's remedy now exists in this repository: `@liberty/media-inspection`'s `authoriseFetchTarget` resolves the name, classifies every answer, and refuses on any private result. The Stremio adapter does not use it. That changes the deferral from "nobody has built this" to "this adapter has not adopted it", which is a weaker acceptance. `url-policy.ts` previously tracked the work as PL-0701; PL-0701 is the end-to-end harness and never covered it, so the work is currently tracked nowhere. **Needs a control-plane task.**
- **R2 — no rate limits exist on any route.** "Add rate limits for auth, search, and playback resolution" is a control listed above and is unimplemented. The natural home is request middleware, outside this task's `allowedPaths`. F3's cap bounds per-request work, not request rate.
- **R3 — the resolve scaffold still exists.** Gating closes the hosted exposure; the route remains reachable in development and remains the only endpoint that accepts client-supplied rights. Removal is the correct end state.
- **R4 — no authentication or authorization exists on any API route yet.** Every finding above is scoped to a system with no identity layer. When one lands, each route needs revisiting; nothing in the current code should be read as a decision that these routes are safe to leave anonymous.

### Follow-ups outside this task's scope

- `e2e/tests/rights-boundary.api.spec.ts` — two tests POST to `/api/v1/playback/resolve` and expect 400 and 200. The harness defaults to a production build, where the route now answers 404. They need either `LIBERTY_E2E_WEB_MODE=development` or a skip guarded on `WEB_MODE`, in the pattern `tests/playback-session.spec.ts` already uses. **This will fail the e2e gate until it is done.**
- `docs/API_CONTRACTS.md` — the resolve section must record that the route is absent from a hosted deployment, and the two 413 refusals.
- `docs/E2E.md` — its note that this route 500s on a non-JSON body is now stale.
- `packages/contracts` — `.max()` on `playbackResolveRequestSchema.candidates` is the better home for F3's bound than a route-level pre-check.
- `control/tasks.json` — a task for R1.
