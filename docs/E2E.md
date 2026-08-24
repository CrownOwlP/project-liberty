# End-to-End Harness

The critical browser-level gate for PL-0701. It drives a real build of
`apps/web` in a real engine and asserts the things a unit test structurally
cannot: that the rights boundary is still a boundary when a client is on the
other side of HTTP, that a playback decision arrives with a reason trail
attached, and that the catalog-to-title-to-player journey is reproducible.

Everything it owns lives in `e2e/`. Nothing in `apps/**` or `packages/**` was
changed to make it work, and no `data-testid` was added anywhere: every locator
addresses a role, a heading or an accessible name, so a test failing here means
the thing a reader interacts with changed, not that a private hook moved.

## Running it

```bash
cd e2e
npm install                 # once; installs into e2e/node_modules
npm run browsers            # once; downloads the browser builds
npm test
```

`npm test` builds the repository, starts `apps/web` on port 3100, waits for
`/api/health`, runs every project, and shuts the server down. The first run is
slow because it is a cold `turbo run build`; subsequent runs hit the turbo
cache.

Useful narrower invocations:

```bash
npm test -- --project=api          # no browser needed at all
npm test -- --project=chromium     # the critical journey, one engine
npm test -- --project=mobile-safari
npm test -- --headed --project=chromium
npm run report                     # open the last HTML report
```

### Why `e2e/` is not an npm workspace

The root `package.json` declares `apps/*` and `packages/*`. `e2e/` is
deliberately outside both, which costs one extra `npm install` and buys two
things:

- **`apps/web`'s vitest suite cannot pick it up.** That suite runs in the `node`
  environment against `**/*.test.ts` under the app. A Playwright spec swept into
  it fails on the first `page` fixture, and the repair people reach for is to
  give the unit suite a browser environment.
- **`npm ci` at the root never grows a browser download.** Playwright pins a
  browser build to an exact package version. Keeping it out of the root lockfile
  means a lane that only wants to typecheck does not pay for Chromium.

`@playwright/test` is pinned to **1.62.1** exactly, not `^1.62.1`. Verified
against the registry on 2026-08-21:
<https://registry.npmjs.org/@playwright/test/latest> — version `1.62.1`, licence
**Apache-2.0**, `engines.node >= 20`, published by Microsoft with SLSA
provenance. The pin is not caution about semver: Playwright downloads a browser
build keyed to the package version, so a caret range means the browser a
recorded gate result refers to can change under a lockfile refresh, and
"e2e passed" becomes evidence about a browser nobody chose.

### The root script this would like, and does not have

PL-0701 did not edit the root `package.json` — another task's reviewed surface
is in that file. If you want `npm run e2e` from the repository root, this is the
exact line, placed after `"test": "turbo run test",`:

```json
    "e2e": "npm --prefix e2e run test",
```

Do **not** fold it into `"check"`. `check` is expected to pass on a fresh clone,
and this harness needs `npm install` and `playwright install` to have been run
inside `e2e/` first. In CI it belongs in a job of its own, after `Build`, with
`npm --prefix e2e ci` and `npm --prefix e2e run browsers` as its own steps.

## Configuration

All harness variables are prefixed `LIBERTY_E2E_`. None of them is declared in
`.env.example` or `turbo.json`, and that is deliberate: those describe variables
the **application** reads, and these configure the test runner. The one
application variable involved — `LIBERTY_FIXTURE_MEDIA_ORIGIN` — is already
declared there and is set on the server process by the harness rather than read
by it.

| Variable                 | Default          | Effect |
| ------------------------ | ---------------- | ------ |
| `LIBERTY_E2E_BASE_URL`   | unset            | Test an already-running deployment. When set, the harness starts no server. It POSTs to the playback session endpoint, so never aim it at production. |
| `LIBERTY_E2E_PORT`       | `3100`           | Port for the harness-managed server. Not 3000, because that is where a developer's `next dev` already is and `reuseExistingServer` would silently adopt it. |
| `LIBERTY_E2E_WEB_MODE`   | `production`     | `production` runs `npm run build` + `next start`. `development` runs `next dev`. See the note below — the two answer the session API differently and disagree about whether `/api/v1/playback/resolve` exists, both on purpose. |
| `LIBERTY_E2E_MEDIA_ORIGIN` | unset          | A DASH/HLS origin you hold rights to serve from. Passed to the server as `LIBERTY_FIXTURE_MEDIA_ORIGIN`. Unset means the media-rig suite skips. |

### The two web modes are not the same deployment

`resolveAuthorizedCandidates` returns `not-configured` when `NODE_ENV` is
`production`, because no provider registry is wired into this app yet and
serving fixtures from a hosted deployment would publish fabricated `owned`
rights for files that do not exist. So under the default `production` mode the
session API answers `unavailable` / `provider_not_configured` / 503, and the
harness asserts exactly that. The `granted` branch is reachable only under
`LIBERTY_E2E_WEB_MODE=development`.

Both are asserted rather than one being treated as the real one. If a production
build ever starts answering `granted`, a fixture has escaped into a shipped
artifact, and that is a rights incident rather than a test failure.

The same switch decides whether `POST /api/v1/playback/resolve` exists at all.
That route is a ranking scaffold: the **client** supplies the candidate list
including each candidate's `rights`, and it did so unauthenticated, so a
security review made it answer `404` / `route_not_available` when `NODE_ENV` is
`production`. Under the default mode the harness therefore asserts the **gate** —
that a well-formed, rightsed request gets a 404 carrying no `selected` and no
`ranked` — and skips the two rights-refusal tests with a reason naming
`LIBERTY_E2E_WEB_MODE=development`. Under `development` the split reverses.

Asserting the gate rather than only skipping is deliberate. The gate is now a
rights control, and a scaffold reachable from a hosted deployment is the finding;
a suite that went quiet under the mode CI actually builds would say nothing about
the only build that ships.

The watch page does not share that switch — `watch/watch-session.ts` is PL-0501's
stand-in and serves fixtures in either mode — so the browser journey runs in
both.

## What it covers

| Area | Assertion |
| --- | --- |
| Catalog API | 200, `no-store`, non-empty rails; every surfaced item's `rights` is on the playable allowlist; **no key anywhere in the response is a media address, and no value is an absolute URL** |
| Session API shape | Exactly one of `granted` / `denied` / `unavailable`; a **non-empty reason trail on every branch**; reasons are `snake_case` codes with a non-empty human `detail` and a required, nullable `candidateId`; `no-store` |
| Session API status | The HTTP status is re-derived from the outcome by the harness and compared. A 200 carrying a denial is a client that plays nothing and reports nothing |
| Session API grants | Candidate ids are distinct; `startAtSeconds` is `null` (engine default), not `0`; `expiresAt` parses; a failover policy is published; **every candidate URI is on the configured media origin and no other** |
| Session API determinism | The same request twice produces a byte-identical response once the session id and expiry are removed |
| Rights boundary | A request carrying `uri` is **refused**, not stripped, with `request_field_not_permitted` as the **primary** reason and no session attached; the same for a URL smuggled into the nested `capabilities` object; a non-normalized `contentId` is refused before any resolver runs; no response echoes the submitted address anywhere in its body |
| Resolve gate | Under the default `production` mode, `/api/v1/playback/resolve` answers **404 `route_not_available` with no verdict attached** to the request that would otherwise have succeeded |
| Rights boundary | Under `development`, an unrightsed candidate posted to `/api/v1/playback/resolve` never yields `selected` or `ranked` — with a rightsed control candidate beside it, so the refusal is about rights and not about an outage |
| Robustness | `"not json"`, `7`, `null`, `[]` all produce a well-formed `denied` and never a 500 |
| Journey | Catalog rail → title route → Play link → watch route → back; unknown ids are real 404s |
| Player | `<liberty-video>` mounts and **never carries a `src`**; the reason trail renders |
| Search | Idle, results and empty stay three distinct states; the query is escaped rather than interpreted; typing becomes an addressable URL |

## What it deliberately does not cover

- **Playback of actual media, unless you configure a rig.** See below.
- **Progress and resume.** PL-0403 has not landed in `apps/web`; `startAtSeconds`
  is always `null` today, and the harness asserts that it is `null` rather than
  pretending to test a resume point. When PL-0403 lands, that assertion is the
  thing that must be changed deliberately.
- **The click from a catalog card to a title.** There isn't one. Cards and search
  results are `<article>` elements with no play affordance, which
  `search-results.tsx` states is intentional — search is discovery, and a stream
  is resolved at playback time rather than implied by a result being visible. The
  journey crosses that step by address and asserts that the id the catalog
  published is the id the title route serves. Faking the click would have made
  the test pass and the gap invisible.
- **`/api/v1/playback/resolve` under a production build, beyond the 404.** Its
  body limits — `413 request_too_large` from `content-length`, `413
  too_many_candidates` above 100, and the `400 invalid_request` that a non-JSON
  body now produces instead of the 500 it used to — are unit-tested in
  `apps/web/src/app/api/v1/playback/resolve/handler.test.ts`, where the guard can
  be injected. Asserting them from here would mean running the whole harness in
  `development` to exercise a route that is not part of a deployment.
- **Authentication.** There is none to exercise yet.
- **Visual regression, axe/a11y scans, CMCD telemetry assertions.** All worth
  having; none of them is the critical gate PL-0701 asks for, and each brings a
  flake surface of its own.

## Determinism, and when a retry is allowed

`retries` is **0**, in CI as well as locally. That is the opposite of the
Playwright default and it is the deliberate position: this repository has found
six order-dependence defects, and a retry is exactly the mechanism that converts
one into a pass. A suite that goes green on the second attempt teaches people to
re-run until green, which is how a real regression gets ignored.

The rules the specs follow:

- **Nothing sleeps.** There is no `waitForTimeout` in `e2e/`. Every wait is an
  `expect` that retries on a condition, so a slow machine costs time and never a
  false failure.
- **No test encodes a timing constant.** The search debounce is 250 ms; no spec
  mentions it. The test asserts that the URL eventually carries the query.
- **`fullyParallel` is on.** The server is stateless and fixture-backed, so
  parallelism is safe — and it is also the condition under which a shared-state
  dependence would actually surface. Serialising would hide it.
- **Timeouts are ceilings for a hang, not substitutes for a wait.**
- **A skip must say why.** `MEDIA_RIG_SKIP_REASON` is a sentence, not a boolean,
  because a suite that quietly does not run is indistinguishable in a report from
  one that passed.

A retry is legitimate here in exactly one case: **an infrastructure failure that
is provably not the application's** — the browser process died, the runner lost
its network, the harness could not bind its port. Those are re-run at the *job*
level with a note on the run, never by raising `retries` in the config. If a
spec fails twice out of ten and nobody can say why, that is a defect in the spec
and it gets fixed or deleted.

## Pointing it at a real media rig

**Legal test content is a task, not a footnote.** The product invariants admit
only licensed, user-owned or public-domain content into playback resolution, and
there is no torrent, magnet or debrid path anywhere in this system. That
constraint applies to test fixtures exactly as it applies to the product: a
media URL of unknown provenance pasted into a fixture is a rights claim that no
rights review ever saw, and it would sit in the repository looking exactly like
a reviewed one.

So **no media URL appears anywhere in `e2e/`**. The addresses the harness does
send — `smuggled.test`, `fixtures.invalid` — are on domains reserved by RFC 2606
and exist to be refused.

`LIBERTY_FIXTURE_MEDIA_ORIGIN` defaults to `https://fixtures.invalid`, which
resolves nowhere. That is the honest default: with no rig configured there is
nothing to play, the fixtures fail, failover walks all three candidates, and the
reason trail shows the whole sequence. A playback test reporting green against
that origin would be reporting that it successfully failed to fetch a stream.
The media-rig suite therefore skips, and the skip names the variable that would
have to be set.

To stand a rig up, the route `docs/RESEARCH_PLAYBACK.md` records:

1. Take a public-domain source you can account for — the Blender open movies,
   or an Internet Archive item whose rights statement you have read.
2. Package it yourself into DASH and HLS, with clear and test-DRM variants, plus
   the multi-period, gap-containing and deliberately-broken manifests that
   failover cannot be tested without. Check in the **output**, and record the
   provenance beside it.
3. Serve it. `http://localhost:<port>` is carved out by `checkPlaybackSource`
   and by the outbound URL policy's loopback rule, so a local rig works without
   TLS; every other host must be `https:`.
4. Run:

```bash
LIBERTY_E2E_MEDIA_ORIGIN=http://localhost:8080 \
LIBERTY_E2E_WEB_MODE=development \
npm test -- --project=chromium
```

`development` is needed for the session-API half; the watch-page half runs in
either mode. The harness verifies the origin against what the **server**
published rather than against the variable this process read, so setting it on
the wrong shell produces a skip rather than a false pass.

## Device matrix

| Project | Device | Why it is in the matrix |
| --- | --- | --- |
| `api` | none | The invariants. Runs on a machine where `playwright install` never succeeded — no GTK, no display, no browser. |
| `chromium` | Desktop Chrome | The reference engine. The critical journey must pass here for the gate. |
| `webkit` | Desktop Safari | The engine most likely to diverge, and the one least likely to be run by a developer on Linux. |
| `mobile-safari` | iPhone 13 | Touch, the mobile viewport, and the iOS engine constraint below. |
| `firefox` | Desktop Firefox | Breadth. Not required for the gate. |

**iOS/Safari is the one that matters, and not for layout.**
`docs/RESEARCH_PLAYBACK.md` names it as the concrete thing to measure: Shaka may
fall back to native `src=` HLS there, and when it does it loses the `getStats()`
reason trail that CMCD depends on. The failure mode is a player that plays
perfectly while reporting nothing — which looks like success on a screenshot and
is a telemetry outage. That is why the media-rig suite asserts a **named
candidate** in the trail alongside the playing state, on every project in the
matrix rather than on Chromium alone, and why the hls.js contingency trigger the
research asks for is a measurement this harness is shaped to take once a rig
exists.

## Files

| Path | Contents |
| --- | --- |
| `e2e/playwright.config.ts` | Projects, the managed web server, the determinism policy |
| `e2e/src/env.ts` | Every knob, read exactly once so config and specs cannot disagree |
| `e2e/src/contract.ts` | The playback session contract, **restated by hand** — importing the server's own schema would only assert that the server agrees with itself |
| `e2e/src/fixtures.ts` | Content ids, device profiles, and the reserved-domain addresses that exist to be refused |
| `e2e/tests/*.api.spec.ts` | The API and rights-boundary suites (project `api`, no browser) |
| `e2e/tests/*.spec.ts` | The browser suites |
