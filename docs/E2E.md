# End-to-End Harness

The critical browser-level gate for PL-0701. It drives a real build of
`apps/web` in a real engine and asserts the things a unit test structurally
cannot: that the rights boundary is still a boundary when a client is on the
other side of HTTP, that a playback decision arrives with a reason trail
attached, that the catalog-to-title-to-player journey is reproducible, and that a
resume point can be leased, written and read back.

Two things to know before reading anything below as coverage. **The suite now
runs in CI, in both modes, and the job is red** — see "The suite runs in CI, and
the job is red" for exactly what that job does and does not do. And **every
mode-split file is a gate only when both modes are run**; one run is half a
statement.

Everything it owns lives in `e2e/`, and **no `data-testid` was added anywhere** —
every locator addresses a role, a heading or an accessible name, so a test failing
here means the thing a reader interacts with changed, not that a private hook
moved. That half still holds exactly: there is no `data-testid` anywhere under
`apps/`.

This paragraph used to add "nothing in `apps/**` or `packages/**` was changed to
make it work", and **one line no longer fits that claim**:
`allowedDevOrigins: ["127.0.0.1"]` in `apps/web/next.config.ts` is there because
this harness points a browser at a numeric loopback host, and Next 16's dev server
blocks `/_next` resources for hosts it was not told about. "Known blockers found
by the first real run" records why that is a declaration the application owed
anyway rather than a test-shaped hole, and why pointing `BASE_URL` at `localhost`
was rejected as the alternative. It is a development-only setting and grants
nothing to a deployment — but it is an application edit made for this harness, and
saying otherwise here would be the small kind of overclaim this file has already
had to correct twice.

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
inside `e2e/` first. In CI it belongs in a job of its own, which it now has — see
below.

### The suite runs in CI, and the job is red

This section used to be headed "This suite is not executed in CI. Only compiled."
That was true when it was written and stopped being true when
`.github/workflows/ci.yml` gained an **`e2e`** job. It is corrected rather than
deleted, because the whole reason the job exists is the argument the old section
made, and because a reader arriving here is trying to establish what a CI result
about this harness means.

`ci.yml` now has **two** jobs that touch `e2e/`, and they are not redundant:

- **`e2e-typecheck`** — unchanged. Installs `e2e/`'s three devDependencies with
  `npm ci --ignore-scripts` from `working-directory: e2e` and runs
  `npm run typecheck` (`tsc --noEmit`). About a minute, no browser, no
  application build. It stays because it is still the fast signal when the suite
  job is red for a product reason, or has not finished.
- **`e2e`** — the suite, executed. What it actually does, step for step:
  - `runs-on: ubuntu-latest`, `timeout-minutes: 45` — a ceiling for a hang, not
    a budget.
  - Pins the same three `@cache-key` variables the `validate` job pins
    (`CONTENT_RIGHTS_ENFORCEMENT`, `LIBERTY_FC_SEED`,
    `LIBERTY_FIXTURE_MEDIA_ORIGIN`), because `playwright.config.ts` runs
    `npm run build` through turbo inside its `webServer` command and turbo hashes
    those from the environment it sees *before* that process starts.
  - `actions/setup-node@v4` with `cache-dependency-path` naming **both**
    lockfiles, because the job installs both trees: `npm ci` at the root, then
    `npm ci --ignore-scripts` in `e2e`.
  - `npx playwright install chromium`, as its own step with `id: browsers`.
    **Not** `npm run browsers` and **not** `--with-deps`: the job downloads only
    the engine it launches, and `--with-deps` is a root `apt-get` on Linux that
    throws outright on Windows, so it is not the spelling this repository
    standardises on.
  - Two suite steps, **sequential, one runner, not a matrix**:
    `LIBERTY_E2E_WEB_MODE=production npm test -- --project=api --project=chromium`
    and then the same line with `=development`. Both are conditioned on the
    browser install having succeeded; the development one adds `!cancelled()`, so
    it runs **even when the production step has already failed** — one mode's
    result is not evidence about the other, and a `fail-fast` here would degrade
    the pair to whichever half ran first.
  - Two `actions/upload-artifact@v4` steps, `playwright-report-production` and
    `playwright-report-development`, 14-day retention. The production one is
    uploaded **between** the runs rather than after both, because the HTML
    reporter writes to one directory and the second run overwrites it.

**The job carries no `continue-on-error`, no `|| true`, and no retries**
(`retries: 0` lives in `playwright.config.ts` and is deliberate there). It fails
when the suite fails, and **it is expected to be red today**. A green tick over a
red suite is the audit fiction this repository keeps deleting; an expected-failure
baseline was considered in that job's header and rejected, on the grounds that the
authoritative list of acceptable failures would then live in the file furthest
from the tests.

**Read the red against "Known blockers found by the first real run" below, and
not against the list in `ci.yml`'s own header.** That header enumerates three
expected failures as of the day the job was added, and one of them has since
stopped being true: it says `catalog.api.spec.ts` asserts non-empty rails and
therefore fails under `production`, and that spec has had its mode split since —
it requires the 503 refusal there and the demo catalog under `development`. The
header is the workflow's file and not this harness's, so the correction belongs to
whoever owns `.github/workflows/**`; it is named here because a reader who trusts
that list will attribute a real regression in this file to a known failure that no
longer exists. That is precisely the failure the same header gives as its reason
for rejecting a baseline.

**What the `e2e` job does not claim.** It runs `api` and `chromium` only —
exactly the pair the gate commands below name. WebKit, mobile-safari and Firefox
are **not** run there, so every WebKit result this repository has (PL-0705's
acceptance requires one) comes from a local run and has to be recorded as such.
It also does not depend on `validate`: the two jobs run in parallel, so a red
root build fails in both places rather than once.

Two things that make the result citable rather than merely present.
`process.env.CI` is set by GitHub, so `playwright.config.ts` turns off
`reuseExistingServer` (an adopted server is a server nobody can say what was
built from) and turns on `forbidOnly`. And every result in every mode-split file
carries a `web-mode` annotation, so each uploaded report says which half of the
pair it is; **both artifacts have to exist before `e2e` is a gate rather than
half of one.**

Cost, stated rather than discovered: one runner doing a cold `turbo run build`
for the production run, an on-demand dev compile for the other, and one Chromium
download. If that ever has to come down, the honest reduction is fewer projects —
**not** dropping one mode, which would leave the remaining half unproven to be
non-vacuous.

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
| `LIBERTY_E2E_WEB_MODE`   | `production`     | `production` runs `npm run build` + `next start`. `development` runs `next dev`. See the notes below — the two answer the session API differently, disagree about whether `/api/v1/playback/resolve` exists, disagree about whether the **watch route** mounts a player, disagree about whether there is a **catalog** at all (which now decides the home API, the home page, **search** and the **title route** together), and disagree about whether **progress** can be written. All five on purpose, and all five the same switch. **Neither mode is the gate on its own**: see "Both modes are the gate, not a choice". |
| `LIBERTY_E2E_MEDIA_ORIGIN` | unset          | A DASH/HLS origin you hold rights to serve from. Passed to the server as `LIBERTY_FIXTURE_MEDIA_ORIGIN`. Unset means the harness pins the server to `https://fixtures.invalid` — never to an inherited value — and the media-rig suite skips. |
| `LIBERTY_E2E_DATABASE_URL` | unset          | A PostgreSQL connection string for the profile, progress and watchlist routes — the three groups that share `resolveRequestContext`, though only the first two are asserted here. Passed to the server as `DATABASE_URL`, and **pinned to the empty string when unset** rather than omitted, for the same reason the media origin is: `apps/web`'s `dev` and `start` run through `scripts/with-root-env.mjs`, so an omitted variable means "whatever is in the developer's root `.env.local`". Unset is the default and is a real configuration — `next dev` then uses the in-memory store, and a production build answers `storage_not_configured`. Both are asserted. |

### The two web modes are not the same deployment

`resolveAuthorizedCandidates` returns `not-configured` outside `development` and
`test`, because no provider registry is wired into this app yet and serving
fixtures from a hosted deployment would publish fabricated `owned` rights for
files that do not exist. So under the default `production` mode the session API
answers `unavailable` / `provider_not_configured` / 503, and the harness asserts
exactly that. The `granted` branch is reachable only under
`LIBERTY_E2E_WEB_MODE=development`.

**The gate is structural, not conditional, and that distinction is what PL-0703
added.** The fixture provider is not "built and then withheld in production": it
cannot be built at all. `fixtureProvider` takes a `NonDeploymentEnvironment`,
which only `apps/web/src/app/api/deployment-environment.ts` can mint and only
for a `NODE_ENV` on its allowlist, so a caller in a hosted process has nothing to
pass it and the fabricated `owned` declaration is never constructed. The
previous gate was an `if` inside the resolver — correct, and deletable without
breaking the build, which is precisely how the watch route came to carry a
second copy of the same fixtures under no environment test at all.

Both modes are asserted rather than one being treated as the real one. If a
production build ever starts answering `granted`, a fixture has escaped into a
shipped artifact, and that is a rights incident rather than a test failure. The
specs assert the absence as well as the refusal: on a production build no fixture
file name and no fixture candidate id may appear anywhere in the session response
or anywhere in the watch page's HTML, and the development run asserts that those
same strings **are** present, so the production check cannot pass vacuously. The
session spec adds one string to its production half that the development half
deliberately does not pair — `fixtures.invalid`, the default media origin, which
a configured rig legitimately replaces; that one absence is unpaired and the spec
says so at the constant.

The fixture **rights basis** is not asserted in either direction, and that is a
correction rather than a gap. `playbackSessionCandidateSchema` publishes `id`,
`providerId`, `uri`, `mimeType` and `compatibility` and no rights field, and no
reason `detail` renders a basis either, so a check for it could not fail under
production and could not be paired under development.

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
`resolveAuthorizedCandidates` from the session API, so **on the path this harness
measures** there is one fixture provider, one environment allowlist
(`development` and `test`) and one rights basis. Under the default `production`
mode the watch route answers
`not-configured` and renders an explanation naming an operator remedy; no player
mounts. A guarded-and-corrected second copy would have satisfied every bullet of
the repair and left the *arrangement* that produced the bug in place — two
adapters asserting rights over the same imaginary media, agreeing only by
coincidence. If a future change wants a fixture provider on a route because the
shared one refuses to serve there, the refusal is the feature.

So the browser journey does **not** run identically in both modes, and the specs
say which is which: `critical-journey.spec.ts` asserts the production branch (the
unavailable panel, no `liberty-video`, no reason trail, and no fixture artefact
anywhere in the document) rather than skipping it, because a production build
that mounts a player here is a rights incident and not a test that needs
relaxing. The mode-independent half — `/watch/<id>` answers 200, carries the
requested id, offers "Back to catalog", and no `liberty-video[src]` exists
anywhere — still runs in both.

**"One fixture provider" is now a claim about `apps/web`, and the qualifier is
load-bearing.** `@liberty/provider-sdk` has since grown one of its own, at
`packages/provider-sdk/src/fixture/` — a second `NonProductionRuntime` witness
type, a second opaque-rights-reference check, a second fabricated `owned` basis.
It is not a recurrence of the watch-route defect and this harness cannot observe
it either way: **nothing in `apps/web` imports it.** `authorized-candidates.ts`
takes `classifyHost`, the health policy and the `RightsBasis` *type* from that
package and builds its own provider, so no route serves the SDK's copy and no
assertion below is about it. What has to stay true is the reason the sentence was
narrowed: two fixture providers agree by coincidence, and the day something wires
the SDK's into a route is the day one of them has to be deleted rather than both
kept. That belongs to whoever owns `packages/provider-sdk/**` and `apps/web/**`;
it is recorded here because this file is where the previous divergence was
written down as intended behaviour.

### The catalog shares that switch too, and that is what broke this suite's default mode

`apps/web/src/lib/catalog-source-registry.ts` resolves the demo catalog only for
a `NonDeploymentEnvironment` — the same nominal witness `fixtureProvider`
requires, obtained only from `NonDeploymentEnvironment.classify()` and only for a
`NODE_ENV` on its allowlist. So a deployment has **no metadata source at all**,
and the gate is structural in the same sense the playback one is: the fixtures
are not withheld from a hosted build, they are unconstructible in it.

The reasoning is close to the rights argument but not identical, and
`docs/CATALOG_SOURCE.md` states it: the `owned` category on those six works is
true — they are original works written for this project — but the claim a
deployment would be making by serving them is not "these are owned", it is
"**this is the catalog**". Invented titles on a hosted build are presented to a
reader as the product's content.

**Three of the four surfaces below moved in one round, and this section used to
describe the arrangement before that.** The API route, search and the title route
each had a follow-up recorded against them in `docs/CATALOG_SOURCE.md`; all three
landed together, and the sentences here that named them as outstanding were
therefore false the moment they did. They are corrected rather than deleted,
because "which surface migrated when" is the thing a reader of this file is
actually trying to establish.

What that changes, per surface:

- **`GET /api/v1/catalog/home` refuses with `503` and
  `{ "error": "catalog_source_not_configured" }`** on a deployment. It used to
  serve `{ rails: [] }` at 200, which was a property of *that route* rather than
  of the gate: it called the synchronous `getHomeCatalog`, whose return type has
  nowhere to put a reason, so a process with no catalog made a statement about
  the catalog. `route.ts` now awaits `loadHomeCatalog()` and hands the result to
  `home/handler.ts`, which maps the reason onto a status — 503 for
  `catalog_source_not_configured` and `catalog_source_unavailable`, matching what
  the profile, progress and watchlist routes answer for
  `authentication_not_configured`, and 500 for
  `catalog_response_failed_validation`, which stays a fault on this side of the
  boundary. `rails: []` at 200 is now reserved for a *configured* catalog that
  genuinely surfaces nothing, which is what `docs/API_CONTRACTS.md` defines it to
  mean. Every branch is served `cache-control: no-store`. The 500 body no longer
  carries the Zod `issues` array — `CatalogLoadResult` carries a reason and not
  the issues — and the issues were never part of the published contract.
- **The home page renders a refusal, with a code, and is unchanged by the route
  edit.** The page awaits `loadHomeCatalog` directly; the API route is a separate
  caller of the same loader, so the two now agree by construction rather than by
  coincidence. It answers `error` / `catalog_source_not_configured`, deliberately
  not `empty`, because the empty branch tells the reader "No titles are currently
  available in your region", which would be false.
  `critical-journey.spec.ts` asserts that exact code, and asserts that the empty
  panel is **not** the one shown: an empty rail and a refused source are different
  facts and only one of them has an operator remedy.
- **Search refuses too, and no longer reaches `empty`.** `app/search/search.ts`
  reads the same port, answers `null` when there is no source, and
  `loadSearchResults` maps that to `error` / `catalog_source_not_configured`
  **ahead of** the emptiness test — because "No titles match" is a statement about
  a catalog and a deployment consulted none. So on a hosted build every non-empty
  query reaches "We couldn't run that search" with that reason code and the live
  region says "Search is currently unavailable."; `/search` with no `q` still
  reaches the **idle** panel, because `idle` is decided before the source is
  consulted and a search that was never run cannot have been refused.
  `search.spec.ts` asserts all of that, and this document previously said the
  opposite — that the state was `empty` and "specifically not `error`". That was
  correct while `search.ts` held a direct import of the fixture array and stopped
  being correct when it moved.
- **`/title/<id>` refuses as well, and it does so at `200` rather than `404`.**
  `app/title/demo-title-details.ts` no longer imports the fixture array; it
  reaches `demoCatalogSource` through a `NonDeploymentEnvironment` witness and
  throws `CatalogMetadataSourceNotConfiguredError` when it cannot get one.
  `title-detail.ts` catches that throw and reports `error` /
  `catalog_source_not_configured`, and `notFound()` is called only for the
  `not-found` status — which a throwing source never produces. So on a hosted
  build **every**
  well-formed id, known or unknown, gets the "We couldn't load this title" panel
  at 200. That is the honest answer rather than a regression: a 404 asserts that
  nothing has this address, and a process with no catalog has not established
  that. `TITLE_UNAVAILABLE_METADATA` carries `robots: index false` for exactly
  this 200. **The reason code is now the shared one, and the sentence here that
  said otherwise was the last one owed.** This bullet used to record a gap — that
  a reader gets the loader's generic `title_source_unavailable` rather than the
  `catalog_source_not_configured` the other two surfaces publish — and named the
  remedy as a two-line branch in `title-detail.ts`'s catch. That branch has
  landed: the catch tests
  `error instanceof CatalogMetadataSourceNotConfiguredError` and republishes the
  `reason` field the class declares, and `[titleId]/page.tsx` renders it verbatim
  in `p.code.state-detail`. So all four surfaces publish one code and
  `critical-journey.spec.ts` asserts it. `title_source_unavailable` is **not**
  deleted — it is still what the loader answers for a source that throws anything
  else, which is unreachable from a deployment's default source and is covered by
  `title-detail.ts`'s unit suite rather than from here. What remains true is the
  consequence: the play affordance is absent on that build, which
  `critical-journey.spec.ts` asserts as a rights property rather than skipping.

The pairing is the session spec's: the strings the production branch requires to
be **absent** are the strings the development branch requires to be **present**,
iterated from one array in both halves. Which array depends on what the surface
can show:

- The **home API** and the **home page** use `CATALOG_ARTEFACTS` in
  `e2e/src/fixtures.ts`, whole. Two of them — `Series`, which is in the home
  route's primary navigation, and `aurora-fall`, which is in the hero's "Open demo
  player" href — are excluded from the **document** check by a derived subset,
  because they are static page copy on every build and requiring their absence
  would fail on a page that correctly rendered no catalog. That subset is derived
  from the same array, and the exclusions are named where they are declared.
- **Search** and the **title route** pair over smaller arrays declared in their
  own specs, and that is a fact about those surfaces rather than a weakening. A
  search for `aurora` legitimately returns one title, so requiring `Northstar`
  present under `development` would be false; a title page shows one work. Each
  spec states which strings it pairs over and why the excluded ones are excluded.

### Progress, profiles, and the storage the harness pins

PL-0403's HTTP surface exists: `GET`/`PUT /api/v1/progress/{contentId}`,
`POST /api/v1/progress/{contentId}/lease`, and the `/api/v1/profiles` group the
progress leg has to pass through, because progress is scoped to the profile a
session **selected** and there is no field through which a client can name one.
`progress.api.spec.ts` asserts the leg, and the same switch decides what it can
assert:

- **On a production build every request in this group is refused before it
  reaches a decision of its own**, with `unavailable` and 503. Which reason is
  decided by whether a database was configured, and the harness knows because it
  pinned the value: with no `DATABASE_URL`, `resolveRequestContext` resolves
  storage first and stops at `storage_not_configured`; with one, storage resolves
  and identity stops at `authentication_not_configured`, because nothing in
  `apps/web` constructs `@liberty/auth/server` yet. The spec asserts the exact
  code rather than "some refusal", and asserts that the development identity
  headers change nothing on that build — a header that became an identity on a
  shipped build is the finding.
- **On a development build the leg runs end to end**: create a profile, select
  it, read `progress: null` with `progress_absent`, take a lease, write a
  position, read it back, and see a replayed or unissued write refused with 409
  rather than applied.
- **Each test acts as its own household.** `fullyParallel` is on and the
  in-memory store is one map per server process, so the specs send
  `x-liberty-development-account` / `x-liberty-development-session` headers with a
  per-test value. Without that, two tests sharing the default account would race
  on one row of `active_profile_selection` and the failure would read as an
  authorization defect in the product.

**What no run of this harness can cover: PostgreSQL.** There is none in this
environment, `postgres-repository.ts` has never executed a statement, and the
guarded progress `UPDATE`, the `ON CONFLICT DO NOTHING`, the
`UNIQUE (user_id, display_name)` violation and the composite foreign key on
`active_profile_selection` are all unverified. A development run here exercises
the **in-memory** adapter, so what it proves is the HTTP contract, the
authorization ordering and the writer-epoch rule as this process implements them
— not that the SQL behind the same interface agrees. `lib/db/index.ts` says the
same thing and draws the same conclusion: the `integration` gate on PL-0402,
PL-0403 and PL-0404 is **not** satisfiable from this harness, and a result
recorded from here must not be read as satisfying it. Every response names the
adapter that answered it and the spec asserts that name, so the distinction is
visible in the report rather than only here.

### Both modes are the gate, not a choice

`critical-journey.spec.ts`, `playback-session.api.spec.ts`,
`catalog.api.spec.ts`, `search.spec.ts`, `progress.api.spec.ts` and
`rights-boundary.api.spec.ts` each assert one thing under `production` and a
**different** thing under `development`. Neither run is a subset of the other, so
neither run on its own is evidence about the pair:

- a `production`-only run proves the refusal and never proves it is not vacuous.
  Every "no player", "no fixture URI", "no candidate id" assertion in that branch
  is also satisfied by a page that renders nothing at all, or by a server that is
  broken in some way none of these specs looks at;
- a `development`-only run proves the fixtures still resolve and says nothing
  whatsoever about the build that ships.

The pairing is deliberate: the strings the production branch requires to be
**absent** are the strings the development branch requires to be **present** —
literally the same array, iterated whole in both halves rather than restated as a
second list. The one exception is `fixtures.invalid` in `playback-session.api.spec.ts`,
which is required absent under production and is not paired, because a rig may
legitimately change the media origin. The pairing only works as a control if both
modes are executed.

Both commands, in full. The second is not optional and a gate recorded from one
of them is not this gate:

```bash
cd e2e
LIBERTY_E2E_WEB_MODE=production  npm test -- --project=api --project=chromium
LIBERTY_E2E_WEB_MODE=development npm test -- --project=api --project=chromium
```

On Windows `cmd`, `set LIBERTY_E2E_WEB_MODE=development` on its own line first;
in PowerShell, `$env:LIBERTY_E2E_WEB_MODE = "development"`. The variable is read
once, in `src/env.ts`, and it also chooses the server subcommand — so it must be
set for the process that starts Playwright, not exported into a shell that only
runs the browsers.

**Sequentially, never in parallel.** Both runs use `LIBERTY_E2E_PORT` (3100) and
`reuseExistingServer` is on outside CI, so a second run started while the first
one's server is still up would adopt it — and would then assert the *other*
mode's expectations against it, reporting the mode mix-up as a product failure.
Give the second run its own `LIBERTY_E2E_PORT` if you want them concurrent.

Every result in all six files carries a `web-mode` annotation naming the mode it
ran under, so the HTML and GitHub reports say which half of the pair a given run
is. `media-rig.spec.ts` carries one too, even though it skips rather than
splitting: a skip is the result somebody reads, and one that does not name the
build it was taken on is what "a skip must say why" exists to prevent. **When you record `e2e` as a gate result, cite both runs.** A single line
saying "e2e passed" is, for these files, a statement about one deployment that
was never identified.

**CI does run both**, as two sequential steps of the `e2e` job with the second
guarded so a red production run cannot suppress it — see "The suite runs in CI,
and the job is red". What CI does not do is make the local pair optional: the job
runs `api` and `chromium` only, so a WebKit or mobile-safari claim still comes
from a local run of both modes.

There is still no `npm run test:modes` in `e2e/package.json` and no
`npm run e2e:both` at the root. The reason the two-run script is a follow-up has
changed and is worth stating precisely rather than leaving the old one: it used
to be that `e2e/package.json` was outside PL-0703's allowed paths, and now it is
that the line wants `cross-env` for the Windows case and adding a dependency
means an install and a lockfile refresh, which the round that would have added it
could not run. The exact line is
`"test:modes": "cross-env LIBERTY_E2E_WEB_MODE=production playwright test && cross-env LIBERTY_E2E_WEB_MODE=development playwright test"`.
`e2e/package.json` does already carry `browsers:chromium`
(`playwright install --with-deps chromium`), which is the narrower install the
`e2e` job wants but deliberately does not use — that job runs
`npx playwright install chromium` without `--with-deps`, for the reason recorded
above it.

## Known blockers found by the first real run

Until this section is empty, a run of this harness is not a clean gate. Both
entries here were found the first time the suite was actually executed rather
than typechecked, both were reproducible, and neither was a defect in a spec. The
assertions that catch them were never relaxed: a suite lowered to match a defect
is the same mechanism the section above describes for the watch route's
fixtures, and it is worse than a red result because it is silent.

**Neither entry is closed, and both are now open in the same way.** Each is fixed
in the application and neither has been re-executed since, so the assertions that
catch them are **unproven rather than failing** — expected to pass, and not yet
observed passing. That is the weaker of the two things a reader might take from
this section, and it is the accurate one. Both are kept below in full, because
each repair is the reason the assertions that catch it are shaped the way they
are, and because the illegal state behind the second can be recreated by adding
a single file.

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

This is also the reason "Both modes are the gate, not a choice" exists as a
written rule rather than as an assumption. The development half of every paired
assertion in `critical-journey.spec.ts` and `playback-session.api.spec.ts` is
currently **unexecuted**, so the production half of each pair is currently
unproven to be non-vacuous. That is a gap in the evidence, not in the specs, and
it closes on the first `LIBERTY_E2E_WEB_MODE=development` run.

### `notFound()` did not produce a 404 on any route in this app — fixed by PL-0704, unverified

`critical-journey.spec.ts` asserts a real 404 for an unknown title
(`/title/<unknown>`) and for a malformed watch id (`/watch/Not%20A%20Valid%20Id`).
Both used to receive **200**, in `production` and in `development`, on all four
browser projects.

**The title half of that pair is now asserted under `development` only**, and the
reason is a later change rather than a relaxation of this one: since
`demo-title-details.ts` started reading the metadata port, a hosted build's source
throws instead of answering `null`, `loadTitleDetail` reports `error` rather than
`not-found`, and `notFound()` is never reached — so on that build there is no 404
to assert and the spec asserts the refusal instead. Everything below is about the
build where `notFound()` *is* reached, which is the one the defect was found on.

Neither route was deciding wrongly. `loadTitleDetail` answers `not-found` for an
id the catalog does not define; `loadPlaybackSession` answers `not-found` for an
id that is not normalized, and it does so *before* the resolver is consulted —
so the reading that blamed the rights repair's `not-configured` branch was
refuted by the order of the code. Both then call `notFound()`.

Next sets that status in one place only: the catch around the render in
`app-render.tsx`, which runs when the access-fallback error **escapes** the HTML
render. A response's status line precedes the first byte of its body, and React
flushes the shell — body bytes — as soon as it has a Suspense boundary to fall
back to. A segment's `loading.tsx` wraps that segment's child slots in a
`<Suspense>`, so `app/loading.tsx` wrapped every route in the application, and
these two routes each added one of their own. The captured failures show
precisely that: the title 404 failing with the "Loading title…" skeleton on
screen, the watch one with "Loading player…".

**What the repair did, both halves of it.** The existence decision on each route
now runs above every Suspense boundary on that route, and the three `loading.tsx`
files that installed a boundary above one are **removed**:
`apps/web/src/app/loading.tsx`, `apps/web/src/app/title/[titleId]/loading.tsx`
and `apps/web/src/app/watch/[contentId]/loading.tsx`. They are deleted ahead of
`npm install` and ahead of every check phase in the round that commits the
repair, so no gate recorded in that round ever ran against a tree still holding
one.

**The skeletons were relocated, not surrendered.** Two of the three moved into a
`<Suspense>` declared inside their own page, below the existence decision; the
title route needs none, for the reason the first bullet below gives.

So this entry is now open the same way the one above it is: **fixed, unverified**.
With no boundary above either decision, the access-fallback error escapes the HTML
render, and the two 404 assertions in `critical-journey.spec.ts` are **expected to
pass** — but this suite runs after the commit that lands the deletion, so nothing
has yet observed them passing, and "expected to pass" is not "passes". The
authority on the deletion is neither this document nor the shape of those specs:
`apps/web/src/app/watch/route-loading-boundaries.test.ts` walks the whole `app/`
tree, fails while any loading file sits above a `notFound()`-capable page, and
runs in the unit gate. Read that, and read it again the next time a `loading.tsx`
appears in a diff.

`apps/web/src/app/search/loading.tsx` is the one loading file that remains, and it
is deliberately not one of the three. `/search` never calls `notFound()`, so its
boundary sits above nothing that decides a status and the unit gate does not
object to it.

- `title/[titleId]/page.tsx` awaits its load and calls `notFound()` before
  rendering anything, and records why this route can have **no skeleton at all**:
  whether a title exists *is* the load, so there is nothing that could honestly
  be streamed before the answer arrives.
- `watch/[contentId]/page.tsx` keeps its skeleton, by checking
  `isWatchableContentId` first and moving the `<Suspense>` **inside** the page,
  below that decision and around the provider round-trip. Identity is cheap and
  decides a status; playback is slow and decides a body.
- `app/loading.tsx`'s skeleton moved into `app/page.tsx`, around the catalog load
  — the only thing on the home route that ever waited, and where it can affect no
  other route.

Rejected during the repair: an `app/(home)/` route group holding a copy of
`loading.tsx`, which reaches the same scoping through an extra segment but
replaces the whole page while the catalog loads and needs two files moved in
lockstep. Also rejected: hoisting each decision into a `layout.tsx`, which does
render outside its own segment's loading boundary — it works, and it costs a
`not-found.tsx` moved up a level plus a second load or a request-scoped cache
added only to satisfy the arrangement. Also rejected, then and now:
`generateStaticParams` with `dynamicParams: false`, which does answer 404 at the
router before any render, but pins the addressable ids to a build-time list — the
catalog's data answering a provider's question.

**The rule is now enforced by the unit gate, not by prose.**
`apps/web/src/app/watch/route-loading-boundaries.test.ts` walks the whole `app/`
tree and fails while any loading file sits above a page that can call
`notFound()`, and separately requires each such page to call it above any
`<Suspense>` it declares itself. That matters because the illegal state is
created by **adding a file**, in a directory that need not be anywhere near the
route it breaks, and it is invisible to `tsc` and to review of the diff that
introduces it. Three comments already stated the rule in prose and the defect
shipped and survived a review anyway.

**What the two specs may therefore assert: the status, and not the copy.** The
body Next serves with a 404 is its own minimal error shell; `not-found.tsx` is a
client boundary and renders on hydration, so a crawler, a link checker or any
other non-JS consumer receives the status and none of the words. Asserting "We
don't have that title" would be asserting a browser behaviour while claiming to
assert the product property. Each test therefore checks the status, and then
checks the **served bytes** for the skeleton string that was the old failure's
signature — which is what would name the regression in a report read by somebody
who does not already know that a new `loading.tsx` three directories up can do
this.

## What it covers

| Area | Assertion |
| --- | --- |
| Catalog API | `no-store`, a non-empty JSON body, and one of the two statuses a correct build may answer (200 or 503) on every build — 500 is deliberately **not** admitted, since `catalog_response_failed_validation` is a fault on this side of the boundary. Then the mode split: under `development` the response is 200, the rails are non-empty and every string in `CATALOG_ARTEFACTS` is present; under `production` it is **503 with `{ "error": "catalog_source_not_configured" }`**, carries **no `rails` key at all**, and **none** of those same strings appears anywhere in the body |
| Catalog API items | **`development` build only, by skip on a response with no rail items rather than by a guard that passes.** Every surfaced item's `rights` is on the playable allowlist; **no key anywhere in the response is a media address, and no value is an absolute URL.** The absence those skips rest on is not taken on trust — the row above requires the refusal under `production` and requires rails carrying the demo catalog under `development` |
| Catalog refusal | **Home page.** On a `production` build the page renders `catalog_source_not_configured` and **not** the "Nothing to watch yet" panel: an empty catalog and a refused source are different facts, and only one has an operator remedy. The page awaits `loadHomeCatalog` directly and is a separate caller from the API route, so this row and the two above it are three assertions about one loader rather than one restated three times. Under `development` the named rails and the demo titles are on the page instead |
| Session API shape | Exactly one of `granted` / `denied` / `unavailable`; a **non-empty reason trail on every branch**; reasons are `snake_case` codes with a non-empty human `detail` and a required, nullable `candidateId`; `no-store` |
| Session API status | The HTTP status is re-derived from the outcome by the harness and compared. A 200 carrying a denial is a client that plays nothing and reports nothing |
| Session API grants | **`development` build only.** Candidate ids are distinct; `startAtSeconds` is `null` (engine default), not `0`; `expiresAt` parses; a failover policy is published; **every candidate URI is on the configured media origin and no other**; the three fixture candidate ids and the three fixture file names are present. Under `production` the session answers `unavailable`, so the granted-session checks never run, and the media-origin spec skips with the outcome it saw as its stated reason. What a production run asserts instead is the row above, plus the mirror of the last item: **no fixture file name and no fixture candidate id appears anywhere in the body**, plus one unpaired string — `fixtures.invalid`, the default media origin, which is not required present under `development` because a rig may replace it. Apart from that one exception the two halves iterate the same array, so they are only a control when both modes are run |
| Session API determinism | The same request twice produces a byte-identical response once the session id and expiry are removed |
| Rights boundary | A request carrying `uri` is **refused**, not stripped, with `request_field_not_permitted` as the **primary** reason and no session attached; the same for a URL smuggled into the nested `capabilities` object; a non-normalized `contentId` is refused before any resolver runs; no response echoes the submitted address anywhere in its body |
| Resolve gate | Under the default `production` mode, `/api/v1/playback/resolve` answers **404 `route_not_available` with no verdict attached** to the request that would otherwise have succeeded |
| Rights boundary | Under `development`, an unrightsed candidate posted to `/api/v1/playback/resolve` never yields `selected` or `ranked` — with a rightsed control candidate beside it, so the refusal is about rights and not about an outage |
| Robustness | `"not json"`, `7`, `null`, `[]` all produce a well-formed `denied` and never a 500 |
| Journey | Home route → title route → Play link → watch route → back. **Every step is now mode-split.** The rail step is the catalog rows above. The **title** step asserts the demo title and its genre under `development`, and under `production` asserts 200 with the "We couldn't load this title" panel, **`catalog_source_not_configured`** in `p.code.state-detail`, and neither the title nor the genre anywhere in the document — `demo-title-details.ts` reads the metadata port now, and the previous note here saying that step was mode-independent described the round before it moved. **This row previously named `title_source_unavailable` as the code asserted here**; that was the loader's generic reason, and it stopped being what the page publishes when `title-detail.ts`'s catch learned to test for `CatalogMetadataSourceNotConfiguredError` and republish its `reason`. The generic code still exists for a source that throws anything else and is not asserted from here. The **Play** step asserts the link and the click under `development` and asserts that **no Play control exists** under `production`, which is a rights property: a page that has read no rights basis must not offer one. An **unknown title** is a real 404 under `development` — the **status**, plus the absence of the loading-skeleton string from the served bytes, never the 404's copy, which renders on hydration and a non-JS consumer never sees — and under `production` gets the same 200 refusal a known id gets, because a process with no catalog cannot tell the two apart and must not claim to. The **watch** 404 (`/watch/Not%20A%20Valid%20Id`) stays mode-independent: it is decided by `isWatchableContentId`, a format check that consults nothing |
| Journey | **Progress is not in it, and the spec says so rather than faking it.** Nothing under `components/**` fetches `/api/v1/progress` or `/api/v1/profiles`, so there is no click path from the player to a progress write. The leg is asserted at the wire instead. That is a claim about those two route groups specifically and not about client code in general — `components/player/cmcd-beacon.ts` does POST to `/api/v1/telemetry/cmcd`, which nothing here asserts either |
| Player | **`development` build only.** `<liberty-video>` mounts and **never carries a `src`**; the reason trail renders; the three fixture candidate ids and the three fixture file names are in the document. Under `production` the same spec asserts the opposite and does not skip: the unavailable panel is shown, `liberty-video` has count **0**, no reason trail exists, and **no fixture file name or candidate id appears anywhere in the HTML** — a player on that build would mean a fixture escaped into a shipped artifact. The document check holds whether or not the client hydrated, because the session reaches the page as props of a client component and therefore as serialised RSC payload. The `src` half is mode-independent: `liberty-video[src]` must match nothing in either mode, though on a production build it is the development branch that stops the pair being vacuous |
| Search | Idle, results, empty and refused stay **four** distinct states; the query is escaped rather than interpreted; typing becomes an addressable URL, and text typed before hydration survives it. **Which settled state any non-empty query reaches is mode-split**: under `development` a matching query lists the demo title with its `matchedOn` reason and a non-matching one reaches `empty`, while under `production` **both** reach `error` / `catalog_source_not_configured` — the heading "We couldn't run that search", the reason code in `p.code.state-detail`, and "Search is currently unavailable." in the one live region. That the two queries get the *same* refusal is itself asserted: on a build that consults no catalog the answer cannot depend on the query. `/search` with **no** `q` reaches the idle panel on both builds, and that is asserted as an ordering property — `loadSearchResults` decides `idle` before the source, so a deployment must not greet a reader with a refusal for a search they never ran. The escaping test reads the **field's value** rather than a results heading, because the refusal panel does not quote the query, and the two typing tests assert whichever settled panel the build can reach plus the absence of the idle one, so they stay about the address bar and about hydration on both builds. **This row previously said the production state was `empty` and "specifically not `error`"; that described `search.ts` before it moved off the fixture array.** **The typing test failed on the first real run, for three causes, and all three have since been addressed in code that has not been executed yet.** On every project under `development`, for the `allowedDevOrigins` reason above. Under `production` on WebKit and mobile-safari, because `fill` landed before the form had hydrated and nothing on the surface re-read the input's value afterwards — PL-0705 is that repair: `search-form.tsx` now adopts the DOM value once, at the hydration commit, and `search.spec.ts` asserts it from outside by holding every client script until the text is typed. And on Chromium and Firefox it tripped Playwright strict mode, because `getByRole("heading", { name: "Northstar" })` matched both the results `<h2>` and the card `<h3>` (role-name matching is substring by default) — the matching test now passes `exact: true` and the two typing tests no longer address the card at all. **Unproven until the next run of both modes** |
| Progress API shape | Exactly one of `read` / `leased` / `written` / `refused` / `unavailable`; a **non-empty reason trail on every branch**; each trail line is exactly `{ code, detail }` with a `snake_case` code — no `candidateId`, because a resume point is about a title; the status is re-derived from the outcome by the harness and compared; `no-store`; a refusing branch carries **neither** a lease nor a row |
| Progress API, `production` | Every call in the group — create profile, lease, write — is refused with `unavailable` / 503 and the **exact** preamble reason the harness's own `DATABASE_URL` pin implies (`storage_not_configured`, or `authentication_not_configured` when one is configured). The development identity headers change nothing on that build, which is asserted rather than assumed |
| Progress API, `development` | **`development` build only.** Create a profile, select it, read `progress: null` with `progress_absent` at 200, take a lease, write a position, read it back through the route; a replayed `writeSeq` is `409 stale_write_within_writer` and an unissued epoch is `409 epoch_not_issued`, and **neither moves the row**; a `updatedAt` or `profileId` smuggled into a write is refused as `request_field_not_permitted` rather than stripped; one household cannot read another's resume point, with the writing household's own read as the control. Each test acts as its own development household, so `fullyParallel` stays safe |
| Progress storage | **Never PostgreSQL.** A development run exercises the in-memory adapter and says so: every response names the adapter that answered, and the spec asserts that name. The `integration` gate on PL-0402/0403/0404 is not satisfiable from here |

## What it deliberately does not cover

- **Playback of actual media, unless you configure a rig.** See below.
- **Resume, as opposed to progress.** The progress endpoints are covered (see the
  rows above). What is not is the **join**: `issue-session.ts` writes
  `startAtSeconds: null` unconditionally and never asks for a stored position, so
  a session issued on a build where a resume point demonstrably exists still
  states none. `playback-session.api.spec.ts` asserts the `null` for that reason
  — it says the issuer states no resume point rather than a wrong one — and it is
  the assertion that must change deliberately when the issuer starts reading
  progress. That is a different event from PL-0403 landing, which has happened.
- **Progress through a user interface.** There is no client code that writes a
  position and no profile picker, so the leg is asserted at the wire only. The
  journey spec says this at the point where a reader would expect the step,
  rather than inventing a `data-testid` for a control that does not exist.
- **PostgreSQL.** See "Progress, profiles, and the storage the harness pins".
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
- **Authentication.** There is none to exercise. `@liberty/auth` ships the seam
  and nothing in `apps/web` constructs it — no route handler, no configured
  `baseUrl`, `secret` or mail transport — so a deployment answers
  `authentication_not_configured` and a development build acts as a named
  development account admitted only by `NonDeploymentEnvironment`. Both are
  asserted; neither is a sign-in.
- **The watchlist.** `GET /api/v1/watchlist`, `PUT`/`DELETE
  /api/v1/watchlist/{contentId}` exist and no spec in `e2e/` sends a request to
  any of them. They share `resolveRequestContext` with the profile and progress
  routes, so a deployment refuses them with the same preamble reason
  `progress.api.spec.ts` asserts there — but that is an inference from shared
  code and not something this harness has observed, and nothing here covers the
  list's own behaviour. Adding the leg is a spec of its own, shaped like
  `progress.api.spec.ts`; it is named here so the absence is a stated gap rather
  than a reader's assumption that every `/api/v1` group in the app is in the
  table above.
- **The CMCD collector.** `POST /api/v1/telemetry/cmcd` exists and
  `components/player/cmcd-beacon.ts` posts to it from the player. No spec here
  sends an event, asserts what the route does with one, or asserts that the
  beacon fired — and it could not usefully assert the last of those against the
  default `https://fixtures.invalid` origin, because nothing plays, so there is
  no interval to report on. This is the one place where "no rig configured"
  removes coverage rather than merely skipping it.
- **Visual regression and axe/a11y scans.** Both worth having; neither is the
  critical gate PL-0701 asks for, and each brings a flake surface of its own.
  This entry used to name "CMCD telemetry assertions" in the same breath, which
  was accurate as a statement of scope and became misleading once the collector
  and the beacon shipped — the two bullets above say what actually exists and is
  unasserted.

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
- **No test encodes a timing constant.** The search debounce is 250 ms
  (`SEARCH_DEBOUNCE_MS` in `components/search/search-form.tsx`) and no spec waits
  it out, computes against it or asserts it — the two typing tests assert that the
  URL *eventually* carries the query, so the number can be retuned without
  touching `e2e/`. One comment in `search.spec.ts` names the figure while
  explaining why the other tests address states by URL instead of by typing; that
  is prose about the design and not a constant any assertion reads.
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

**Only the first two of these run in CI.** The `e2e` job passes
`--project=api --project=chromium` and downloads only Chromium, so `webkit`,
`mobile-safari` and `firefox` are exercised by a local run or by nothing. A
result recorded against any of those three names a laptop.

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
| `e2e/src/progress-contract.ts` | The progress and profile contracts, restated by hand for the same reason |
| `e2e/src/fixtures.ts` | Content ids, catalog artefacts, device profiles, the development-household headers, and the reserved-domain addresses that exist to be refused |
| `e2e/tests/*.api.spec.ts` | The API and rights-boundary suites (project `api`, no browser) |
| `e2e/tests/*.spec.ts` | The browser suites |
