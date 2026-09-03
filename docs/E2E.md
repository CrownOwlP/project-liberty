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
| `LIBERTY_E2E_WEB_MODE`   | `production`     | `production` runs `npm run build` + `next start`. `development` runs `next dev`. See the note below — the two answer the session API differently, disagree about whether `/api/v1/playback/resolve` exists, and disagree about whether the **watch route** mounts a player. All three on purpose, and all three the same switch. **`development` is currently blocked**: see "Known blockers" — the dev server refuses to serve its own client chunks to `127.0.0.1`, so nothing hydrates. |
| `LIBERTY_E2E_MEDIA_ORIGIN` | unset          | A DASH/HLS origin you hold rights to serve from. Passed to the server as `LIBERTY_FIXTURE_MEDIA_ORIGIN`. Unset means the harness pins the server to `https://fixtures.invalid` — never to an inherited value — and the media-rig suite skips. |

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

### The watch page shares that switch, and the sentence that said otherwise was the defect

The section above used to end with: *"The watch page does not share that switch —
`watch/watch-session.ts` is PL-0501's stand-in and serves fixtures in either mode
— so the browser journey runs in both."* That was an accurate description of the
code and a written licence for a rights breach.

`watch/watch-session.ts` carried its **own** copy of the fixture provider: a
hardcoded `owned` rights basis, invented codecs, heights and bitrates, URLs built
by string concatenation, and **no environment guard at all**.
`[contentId]/page.tsx` calls that loader unconditionally, so a production
`next start` rendered `/watch/<id>` with a player aimed at candidates declaring
ownership of files nobody had ever opened. The session API's copy of the same
fixtures was gated for precisely that reason. The watch route's copy was not, and
this document recorded the difference as intended behaviour.

That is the part worth keeping, because it is the part that generalises: the
divergence did not survive because nobody noticed it. It survived because it was
**written down as a design decision**. A review that gated one copy of a
rights-asserting fixture set had documentary grounds for leaving the second copy
alone, so one was fixed and the other shipped. A doc that merely said "these now
match" would leave that mechanism intact and invite the next person to re-split
them.

The duplicate is deleted rather than guarded. `watch/watch-session.ts` imports
`resolveAuthorizedCandidates` from the session API, so there is exactly one
fixture provider, one environment allowlist (`development` and `test`) and one
rights basis. Under the default `production` mode the watch route answers
`not-configured` and renders an explanation naming an operator remedy; no player
mounts. A guarded-and-corrected second copy would have satisfied every bullet of
the repair and left the *arrangement* that produced the bug in place — two
adapters asserting rights over the same imaginary media, agreeing only by
coincidence. If a future change wants a fixture provider on a route because the
shared one refuses to serve there, the refusal is the feature.

So the browser journey does **not** run identically in both modes, and the specs
say which is which: `critical-journey.spec.ts` asserts the production branch (the
unavailable panel, no `liberty-video`, no reason trail) rather than skipping it,
because a production build that mounts a player here is a rights incident and not
a test that needs relaxing. The mode-independent half — `/watch/<id>` answers
200, carries the requested id, offers "Back to catalog", and no
`liberty-video[src]` exists anywhere — still runs in both.

## Known blockers found by the first real run

Until this section is empty, a run of this harness is not a clean gate. Both
entries were found the first time the suite was actually executed rather than
typechecked, both are reproducible, and neither is a defect in a spec. The
assertions that catch them are left failing: a suite lowered to match a defect
is the same mechanism the section above describes for the watch route's
fixtures, and it is worse than a red result because it is silent.

### `LIBERTY_E2E_WEB_MODE=development` served no client JavaScript — fixed, unverified

Next 16's dev server refuses requests for `/_next/*` dev resources whose host is
not listed in `allowedDevOrigins`. `e2e/src/env.ts` builds `BASE_URL` as
`http://127.0.0.1:<port>`, and `127.0.0.1` is not on the default list, so every
client chunk and the HMR endpoint are blocked. The server says so itself, in
`apps/web/.next/dev/logs/next-development.log`:

```
⚠ Blocked cross-origin request to Next.js dev resource
  /_next/static/chunks/node_modules_next_dist_20wefz_._.js from "127.0.0.1".
```

Nothing hydrates. The consequences are exactly the browser tests that need the
client, and no others — which is why the failure reads as several unrelated
product bugs:

- `critical-journey.spec.ts`, the development branch of the watch route:
  `PlayerSurface`'s effect never runs, so `<liberty-video>` — created with
  `document.createElement` inside that effect rather than rendered as JSX — is
  never in the DOM, and the reason trail never appears. The server half is fine
  and the same run proves it: the page rendered the player shell, so candidates
  resolved, the URL policy admitted the pinned origin, and the session was
  granted;
- `search.spec.ts`, "typing commits the query to the address bar": Playwright's
  `fill` writes into the DOM, React never sees a change event, the debounce
  never fires and the URL never gains `?q=`. This one fails on **every** project
  in `development`, including Chromium.

**`allowedDevOrigins: ["127.0.0.1"]` is now set in `apps/web/next.config.ts`.**
It is a development-only setting — Next reaches that guard only when the server
was started in dev mode, and it covers `/_next` resources rather than app routes
— and `127.0.0.1` is loopback, so it grants nothing a local developer does not
already have and nothing at all to a deployment.

Rejected: changing `BASE_URL` to `localhost`. It makes the symptom disappear
without the application ever declaring which dev origins it trusts, and it
re-breaks for anyone who points `LIBERTY_E2E_BASE_URL` at a numeric host. The
harness is not the thing that is misconfigured.

The setting is applied and has never been exercised. Every row in the coverage
table below marked **`development` build only** is therefore still unproven —
not because the blocker stands, but because no run has happened since it was
removed. The next `development` execution is what turns this entry from a
diagnosis into a result, and it is the first thing that should be run.

### `notFound()` does not produce a 404 on any route in this app

`critical-journey.spec.ts` asserts a real 404 for an unknown title
(`/title/<unknown>`) and for a malformed watch id (`/watch/Not%20A%20Valid%20Id`).
Both receive **200**, in `production` and in `development`.

Neither route is deciding wrongly. `loadTitleDetail` answers `not-found` for an
id the catalog does not define; `loadPlaybackSession` answers `not-found` for an
id that is not normalized, and it does so *before* the resolver is consulted —
so the reading that blamed the rights repair's `not-configured` branch is
refuted by the order of the code. Both then call `notFound()`.

Next sets that status in one place only: the catch around `renderToStream` in
`app-render.tsx`, which runs when the access-fallback error **escapes** the HTML
render. A segment's `loading.tsx` wraps that segment's child slots in a
`<Suspense>`, so `app/loading.tsx` wraps every route in the application, and
these two routes each add one of their own. React completes the shell — the root
layout, nothing more — and flushes it at 200 while the loader is still pending;
the throw arrives afterwards and is handled by the boundary. The captured
failures show precisely that: the title 404 fails with the "Loading title…"
skeleton on screen, the watch one with "Loading player…".

The fix is to keep the identity decision out of a Suspense boundary. The
arrangement that keeps both the skeletons and the status is:

1. scope `apps/web/src/app/loading.tsx` to the home route by moving it and
   `app/page.tsx` into an `app/(home)/` route group, so it stops wrapping
   `/title` and `/watch`;
2. move each route's identity decision into that segment's `layout.tsx`, which
   renders **outside** its own segment's loading boundary, deduplicating the
   load with React `cache()` the way `title/[titleId]/page.tsx` already does.

Deleting a segment's `loading.tsx` on its own only changes which skeleton is
shown. Rejected: `generateStaticParams` with `dynamicParams: false`, which does
answer 404 at the router before any render, but pins the addressable ids to a
build-time list — the catalog's data answering a provider's question.

## What it covers

| Area | Assertion |
| --- | --- |
| Catalog API | 200, `no-store`, non-empty rails; every surfaced item's `rights` is on the playable allowlist; **no key anywhere in the response is a media address, and no value is an absolute URL** |
| Session API shape | Exactly one of `granted` / `denied` / `unavailable`; a **non-empty reason trail on every branch**; reasons are `snake_case` codes with a non-empty human `detail` and a required, nullable `candidateId`; `no-store` |
| Session API status | The HTTP status is re-derived from the outcome by the harness and compared. A 200 carrying a denial is a client that plays nothing and reports nothing |
| Session API grants | **`development` build only.** Candidate ids are distinct; `startAtSeconds` is `null` (engine default), not `0`; `expiresAt` parses; a failover policy is published; **every candidate URI is on the configured media origin and no other**. Under `production` the session answers `unavailable`, so the granted-session checks never run, and the media-origin spec skips with the outcome it saw as its stated reason. What a production run asserts instead is the row above: that the outcome *is* `unavailable` with `provider_not_configured` |
| Session API determinism | The same request twice produces a byte-identical response once the session id and expiry are removed |
| Rights boundary | A request carrying `uri` is **refused**, not stripped, with `request_field_not_permitted` as the **primary** reason and no session attached; the same for a URL smuggled into the nested `capabilities` object; a non-normalized `contentId` is refused before any resolver runs; no response echoes the submitted address anywhere in its body |
| Resolve gate | Under the default `production` mode, `/api/v1/playback/resolve` answers **404 `route_not_available` with no verdict attached** to the request that would otherwise have succeeded |
| Rights boundary | Under `development`, an unrightsed candidate posted to `/api/v1/playback/resolve` never yields `selected` or `ranked` — with a rightsed control candidate beside it, so the refusal is about rights and not about an outage |
| Robustness | `"not json"`, `7`, `null`, `[]` all produce a well-formed `denied` and never a 500 |
| Journey | Catalog rail → title route → Play link → watch route → back; unknown ids are real 404s. **The 404 half is asserted and currently fails** — see "Known blockers" above; it is not relaxed |
| Player | **`development` build only.** `<liberty-video>` mounts and **never carries a `src`**; the reason trail renders. Under `production` the same spec asserts the opposite and does not skip: the unavailable panel is shown, `liberty-video` has count **0**, and no reason trail exists — a player on that build would mean a fixture escaped into a shipped artifact. The `src` half is mode-independent: `liberty-video[src]` must match nothing in either mode, though on a production build it is the development branch that stops the pair being vacuous |
| Search | Idle, results and empty stay three distinct states; the query is escaped rather than interpreted; typing becomes an addressable URL. **The typing test failed on the first real run**: on every project under `development`, for the `allowedDevOrigins` reason above — that cause is now removed and the development result is unknown until the next run — and under `production` on WebKit and mobile-safari because `fill` lands before the form has hydrated — React never sees the change, and nothing on the surface re-reads the input's value afterwards. It also trips Playwright strict mode on Chromium and Firefox, where `getByRole("heading", { name: "Northstar" })` matches both the results `<h2>` and the card `<h3>` (role-name matching is substring by default). Both belong to the search surface's own task |

## What it deliberately does not cover

- **Playback of actual media, unless you configure a rig.** See below.
- **Progress and resume.** PL-0403 has not landed in `apps/web`; `startAtSeconds`
  is always `null` today, and the harness asserts that it is `null` rather than
  pretending to test a resume point. When PL-0403 lands, that assertion is the
  thing that must be changed deliberately.
- **The click from a catalog card to a title.** This entry used to read "There
  isn't one", and that stopped being true when PL-0104 landed `lib/routes.ts`:
  `catalog-card.tsx` now renders the heading as a `<Link href="/title/:id">`
  whenever the item resolves to one, on the home rails and in the search results
  alike. The journey still crosses that step by address, so the link is
  **untested coverage rather than a missing affordance**, and
  `critical-journey.spec.ts` says so where it used to say the opposite. What has
  not changed is that a card carries no *play* affordance —
  `search-results.tsx` states that search is discovery and that a stream is
  resolved at playback time rather than implied by a result being visible — so
  the title-to-watch step is asserted through the Play link on the title page,
  which is the only control making that claim. Faking either click with a
  `data-testid` would have made a test pass and a gap invisible.
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

On a server the harness starts, `LIBERTY_FIXTURE_MEDIA_ORIGIN` is **always
pinned** in `webServer.env` — to `LIBERTY_E2E_MEDIA_ORIGIN` when you set one,
and to `https://fixtures.invalid` when you do not. That second value is the
app's own default, restated in `e2e/src/env.ts` rather than imported, so a
change to it fails an assertion here instead of being adopted silently.

It resolves nowhere, and that is the honest default: with no rig configured
there is nothing to play, the fixtures fail, failover walks all three
candidates, and the reason trail shows the whole sequence. A playback test
reporting green against that origin would be reporting that it successfully
failed to fetch a stream. The media-rig suite therefore skips, and the skip
names the variable that would have to be set.

**Pinned, rather than omitted so the app falls back on its own.** Omitting it
used to be the deliberate choice — the harness does not get to invent a media
origin — and that reasoning inverted the moment `apps/web`'s `dev` and `start`
scripts started running through `scripts/with-root-env.mjs`, which loads the
repository root's dotenv files into `process.env` for every name not already
set. From then on, leaving the variable out of `webServer.env` did not mean "the
app's default"; it meant "whatever is in the developer's root `.env.local`",
injected into a server this harness started and is about to measure. The
observable failure was a `LIBERTY_E2E_WEB_MODE=development` run asserting
candidates against `https://fixtures.invalid` while the server served a rig, and
reporting the mismatch as *a stream of unknown provenance being published to a
player* — a rights-incident diagnosis for a configuration accident — while
`MEDIA_RIG_SKIP_REASON` said in the same report that no rig was configured.

The rule the block follows now: every application variable a spec asserts
against is written there with a value the harness can name. `NODE_ENV` is the
one exception, because `LIBERTY_E2E_WEB_MODE` already decides it by choosing the
subcommand, and pinning it would let the two disagree about which deployment is
under test.

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

`development` is needed for **both** halves, and the `LIBERTY_E2E_WEB_MODE` line
above is not optional. A production build resolves no candidates in either place:
the session API answers `unavailable` / `provider_not_configured`, and since the
watch route stopped carrying its own unguarded fixture provider it renders the
"not available on this deployment" panel rather than a player. There is nothing
for a rig to feed on that build, so both media-rig tests skip — the first on the
server's own outcome, the second on the panel it found instead of a player — and
a `production` run against a correctly configured rig would report a green suite
that never touched it.

This is why those skips name the variable rather than reporting a boolean, and
why the player test reads the branch off **what the page rendered** instead of off
a local flag. A suite that quietly did not run is indistinguishable in a report
from one that passed — and the outcome being avoided here is worse than
indistinguishable: without that branch the test would spend 45 seconds waiting for
a `State: playing` that the panel in front of it can never produce, and then
report a configuration-and-rights fact as a playback failure.

The harness verifies the origin against what the **server** published rather than
against the variable this process read, so setting it on the wrong shell produces
a skip rather than a false pass.

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
