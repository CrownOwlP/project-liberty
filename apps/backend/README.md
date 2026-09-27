# `@liberty/backend` — the authenticated playback backend

The counterparty `docs/DESKTOP_PLAYBACK.md` §8 rules must exist.

> Provider resolution and any credential-bearing provider calls must not rely on
> the user-administered local sidecar as the trust boundary. The desktop build
> proxies those specific routes to an authenticated backend service while
> preserving the same application-facing route contract.

The forwarder half of that ruling has existed since PL-0501
(`apps/web/src/app/api/v1/playback/session/playback-session-implementation.desktop.ts`).
Until PW-0401 the thing it forwarded *to* existed only as `e2e/src/backend-stub.mjs`.
This workspace is that thing, as a service.

## What it serves

`POST /api/v1/playback/session`, and nothing else. §8 is a rule about a handful
of routes, not about the application: everything else continues to run in the
sidecar exactly as §2 describes. A backend that also answered the catalog, the
profiles and the watchlist would be a second deployment of the application,
which is the rewrite the preservation constraint forbids.

`GET /__health` answers `{"ok":true}` and reports **nothing** about the
configuration — not the identity store's state, not whether a provider is wired,
not the transport. An unauthenticated endpoint that described this service's
configuration would be a reconnaissance surface whose entire benefit is saving an
operator one look at a log.

## The two things it does, in this order

1. **Authenticate the caller**, from headers alone, using
   `resolveRequestAccount` — the same function `apps/web`'s profile, progress and
   watchlist routes resolve an identity with. Imported, not reimplemented, so
   this service and the application agree about who a caller is because they are
   running the same code against the same database. PW-0403's ruling that Liberty
   uses **database** sessions rather than signed stateless tokens holds here
   unchanged: a session row deleted on the web side stops working against this
   service on the very next request.
2. **Hand the untouched request to `handlePlaybackSessionRequest`** — the
   application's own route envelope. Same body bound, same parse, same decision,
   same response re-validation, same status derivation, same `no-store`.

**The refusal in step 1 cannot leak whether a content id exists**, and not
because it was written carefully: at the moment it is produced the request body
is still an unconsumed stream, so there is no content id in scope for the answer
to differ on. `session-endpoint.test.ts` asserts the refusal is byte-identical
for a real id, an invented id, a malformed id, a body with no id and a body that
is not JSON.

| Refusal | Status | Whose problem |
| --- | --- | --- |
| `not_authenticated` | 401 | The viewer's. "Retry later" is false; no amount of waiting signs anybody in. |
| `authentication_not_configured` | 503 | The operator's. This deployment is missing a dependency. |
| `development_identifier_malformed` | 400 | The developer's own typo, and unreachable on a deployment. |

These are `apps/web/src/lib/db/request-context.ts`'s statuses, not new ones.

## Two decisions that are open for review

### 1. It imports the decision from `@liberty/web`, which is a layering inversion

The acceptance requires "the same route contract, byte for byte", and
`e2e/src/backend-stub.mjs` already argues the general case in its own header: a
counterparty that reimplemented the decision "would be a second opinion about
it". So there must be **one** implementation, and today it lives in
`apps/web/src/app/api/v1/playback/session/`. This service reaches it through a
narrow `exports` subpath on `@liberty/web`.

**The architecturally correct home for that decision is a package of its own**,
and PW-0401 — the second caller — is normally exactly the event that triggers
such an extraction. It was **not** taken here for a specific technical reason:
`apps/web/src/app/api/v1/playback/build-target.test.ts` is what proves §8's
central property (a desktop bundle contains no provider-resolution
implementation), and **its walker follows relative specifiers only** — a
non-relative specifier is recorded as a package name and not walked into.
Extracting the resolver behind `@liberty/playback-resolution` would put
`@liberty/provider-sdk` and `@liberty/media-engine` on the far side of a boundary
that walker does not cross: the desktop assertion would still pass, for the wrong
reason, and the suite's own non-vacuity assertion — that the *web* graph **does**
reach those two packages, which exists precisely so a walker that silently
resolved nothing cannot look like an absence — would fail or have to be weakened.

The honest prerequisite for the extraction is teaching that walker to follow
workspace packages, which would make the guard **stronger** than it is today.
That belongs to whoever owns the guard. If it happens, this service changes by
three import specifiers and nothing else.

### 2. A signed-out desktop viewer cannot be told they are signed out

`playbackSessionReasonCodeSchema` is a **closed** vocabulary with no
authentication member, and the response status in that contract is derived from
the **outcome** alone — `granted`, `denied`, `unavailable` — so there is no shape
in it that means 401. The forwarder validates every backend body against that
schema and turns anything else into an honest `unavailable`.

So this service's refusal bodies are **not part of the published contract** and
must not look like they are. They reach an operator with `curl` and a log, never
a client that parses them. The cost is real: a signed-out desktop viewer sees
"unavailable" rather than "sign in".

Fixing it is a published-contract change under invariant 5 — `contract.ts`, the
status derivation and `docs/API_CONTRACTS.md` together — which is a wider surface
than this task owns, and it is the same change PW-0403 made deliberately for the
request-context vocabulary, where the ruling was "do not collapse these states".
It is raised as a follow-up rather than taken unilaterally here.

## Running it

```bash
npm run build --workspace @liberty/backend   # esbuild bundle -> dist/main.mjs
npm run start --workspace @liberty/backend
```

| Variable | Meaning |
| --- | --- |
| `LIBERTY_BACKEND_TLS_CERT` / `LIBERTY_BACKEND_TLS_KEY` | Terminate TLS in this process. Set together or not at all. |
| `LIBERTY_BACKEND_TLS_TERMINATED_UPSTREAM` | Exactly `true` to serve cleartext because something in front already terminated TLS. |
| `LIBERTY_BACKEND_HOST` | Default `127.0.0.1`. |
| `LIBERTY_BACKEND_PORT` | Default `3102`, the port the e2e harness already dials for this role. |
| `DATABASE_URL`, `LIBERTY_AUTH_SECRET`, … | The identity store, read by the same code `apps/web` reads it with. See `apps/web/src/lib/session/auth-instance.ts`. |

**It refuses to start with no transport stated.** Not because configuration
hygiene is a virtue: the desktop forwarder refuses any backend origin that is not
`https:`, so cleartext is only ever correct behind a terminator — and if an
absent certificate quietly meant cleartext, the failure mode would be a service
that works on a developer's machine and carries a viewer's session cookie across
a network in the clear in production.

**It does start without an identity store and without a provider**, and that is
required by the acceptance rather than tolerated. With no identity store it
answers `authentication_not_configured` at 503; with no provider it answers the
contract's own `provider_not_configured`, which is exactly what the web target
already does. Both are honest states an operator can deploy into and then fix.
**PL-0302 remains the separate task that wires a real provider in; this service
does not wait for credentials and does not contain any.**

## Why it is bundled

Every `@liberty/*` workspace publishes **raw TypeScript** through its `exports`
field. `next` handles that with `transpilePackages` and vitest handles it with
`server.deps.inline`; a plain `node dist/main.js` has neither, and Node's type
stripping does not apply inside `node_modules`. `esbuild.mjs` is the third
mechanism doing the same job for a plain Node process. Only `pg` is external —
it has native bindings and bundling it buys nothing while risking a failure that
only appears against a real database.

The build script defines no constants, reads no environment variable and performs
no substitution, so **no credential can be baked into the artifact**. Credentials
reach this service the way they reach any service: at runtime, from the
environment of the process an operator starts.

## What this task did not do

- **It did not rewire the e2e harness onto this service.** The desktop specs
  assert *that the forwarder forwarded*, which they do by reading
  `backend-stub.mjs`'s `/__requests` ledger of every request it received,
  headers included. A production backend must not have that ledger, so pointing
  the harness here is not a configuration change — it needs a different way to
  witness forwarding, and that question is not this task's to answer alone. The
  stub stays; this service is proven on its own.
- **It did not add a provider.** There is none to add.
