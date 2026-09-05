/* -------------------------------------------------------------------------
 * What this harness is pointed at, and what it is allowed to assume
 *
 * Every knob is read exactly once, here, so the config and the specs cannot
 * disagree about what "the target" is. A spec that read `process.env` itself
 * could assert against a rig the server was never started with.
 *
 * All names are prefixed `LIBERTY_E2E_` and NONE of them is added to
 * `.env.example` or `turbo.json`. That is deliberate: these configure the test
 * runner, not the product, and `docs/DEVELOPMENT.md` treats `.env.example` as
 * the contract for variables the APPLICATION reads. The one application
 * variable this harness touches -- `LIBERTY_FIXTURE_MEDIA_ORIGIN` -- is already
 * declared there, and is set on the server process rather than read here.
 * ---------------------------------------------------------------------- */

function read(name: string): string | null {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? null : value.trim();
}

/**
 * The origin `apps/web` uses when nobody configures one.
 *
 * Restated rather than imported. `.invalid` is reserved by RFC 2606 and
 * resolves nowhere, which is the whole point of the default: with no rig
 * configured the fixtures cannot reach a real host, so nothing this harness runs
 * can quietly fetch media of unknown provenance. Copying the literal means a
 * change to that default fails an assertion here instead of being adopted
 * silently by a test whose job is to notice.
 */
export const DEFAULT_FIXTURE_MEDIA_ORIGIN = "https://fixtures.invalid";

/**
 * An already-running deployment to test instead of starting one.
 *
 * When set, the harness starts no server at all. Nothing here writes to the
 * target, but it does POST to the playback session endpoint, so this must not
 * be aimed at production.
 */
export const EXTERNAL_BASE_URL = read("LIBERTY_E2E_BASE_URL");

/**
 * Port for the harness-managed server. 3100 rather than 3000 on purpose: 3000
 * is where a developer's `next dev` already is, and `reuseExistingServer` would
 * happily adopt it -- so the run would silently test whatever that process
 * happened to be built from, with whatever `.env.local` it inherited.
 */
export const PORT = Number(read("LIBERTY_E2E_PORT") ?? "3100");

export const BASE_URL = EXTERNAL_BASE_URL ?? `http://127.0.0.1:${PORT}`;

/** True when this harness owns the server's lifetime and therefore its env. */
export const MANAGES_SERVER = EXTERNAL_BASE_URL === null;

export type WebMode = "production" | "development";

/**
 * Which build the managed server runs.
 *
 * `production` is the default because it is what CI ships and because a dev
 * server recompiles on first hit, which turns a correctness gate into a race
 * against a bundler.
 *
 * It is not the only useful mode. `apps/.../authorized-candidates.ts` makes
 * `resolveAuthorizedCandidates` return `not-configured` when `NODE_ENV` is
 * `production`, because serving fixtures from a hosted deployment would publish
 * fabricated `owned` rights for files that do not exist. So a production build
 * answers the session API with `unavailable` / `provider_not_configured`, and
 * exercising the granted branch end to end requires `development`. Both are
 * asserted; see `tests/playback-session.api.spec.ts`.
 *
 * The same switch decides whether `POST /api/v1/playback/resolve` exists at
 * all: that scaffold lets a caller assert its own `rights`, so it answers 404
 * under a production build. `tests/rights-boundary.api.spec.ts` asserts the 404
 * in this mode and the engine's rights refusal in the other, because under the
 * default mode the gate is the only thing there is to assert.
 */
export const WEB_MODE: WebMode = read("LIBERTY_E2E_WEB_MODE") === "development" ? "development" : "production";

/**
 * A media rig to point the app's fixtures at.
 *
 * NOT a URL this harness fetches, and not a URL that appears in any fixture in
 * this directory. It is handed to the server as `LIBERTY_FIXTURE_MEDIA_ORIGIN`
 * and the server decides what to do with it. Nothing in `e2e/**` may name a
 * media file: product invariant 1 says only licensed, user-owned or
 * public-domain content reaches playback resolution, and a URL checked into a
 * test fixture is a rights claim nobody reviewed. Whoever sets this variable is
 * the person who can make that claim about their own rig.
 */
export const MEDIA_RIG_ORIGIN = read("LIBERTY_E2E_MEDIA_ORIGIN");

/**
 * The value the harness PINS as `LIBERTY_FIXTURE_MEDIA_ORIGIN` on a server it
 * starts. Meaningless when `MANAGES_SERVER` is false -- nothing is started.
 *
 * It exists as its own export so that `playwright.config.ts` and
 * `EXPECTED_MEDIA_ORIGIN` below are the same expression rather than two
 * expressions someone once checked were equal. The whole reason this file reads
 * every knob exactly once is that a spec must not be able to assert against a
 * configuration the server was never given, and "the origin the server got" and
 * "the origin the specs expect" are the pair where that would hurt most.
 *
 * PINNED, NOT LEFT ABSENT. This used to be omitted from `webServer.env` when no
 * rig was configured, on the reasoning that the harness "does not get to invent
 * a media origin" and should let the app fall back to its own default. That
 * reasoning depended on absence meaning absence, and it stopped being true:
 * `apps/web`'s `dev` and `start` scripts now run through
 * `scripts/with-root-env.mjs`, which loads the repository root's dotenv files
 * into `process.env` for any name NOT already set. So an omitted variable is no
 * longer "the app's default" -- it is "whatever is in the developer's
 * `.env.local`", injected into a server this harness started and then measured.
 * Deferring produced a run that asserted against `https://fixtures.invalid`
 * while the server served a rig, and reported the mismatch as a stream of
 * unknown provenance reaching a player: a rights-incident diagnosis for a
 * configuration accident.
 *
 * Restating the app's default here is therefore not inventing an origin, it is
 * refusing to inherit one. `DEFAULT_FIXTURE_MEDIA_ORIGIN` is the app's own
 * documented value, copied on purpose (see its comment) so that a change to it
 * fails an assertion rather than being adopted silently.
 */
export const SERVER_MEDIA_ORIGIN: string = MEDIA_RIG_ORIGIN ?? DEFAULT_FIXTURE_MEDIA_ORIGIN;

/**
 * The origin every published candidate URL must be on, or `null` when this
 * harness cannot know.
 *
 * Against an external deployment with no declared rig we genuinely do not know
 * what the operator configured, and guessing would produce a test that fails on
 * a correct deployment -- which is worse than not asserting, because it teaches
 * people to ignore the result.
 */
export const EXPECTED_MEDIA_ORIGIN: string | null = MANAGES_SERVER
  ? SERVER_MEDIA_ORIGIN
  : MEDIA_RIG_ORIGIN;

/**
 * Why the media-rig suite is skipped, or `null` when it may run.
 *
 * A string rather than a boolean because the string is the whole value of the
 * skip: a suite that quietly does not run is indistinguishable from one that
 * passed, and this is the sentence that makes the difference visible in the
 * report.
 *
 * Keyed on `MEDIA_RIG_ORIGIN`, and that is only sound because
 * `SERVER_MEDIA_ORIGIN` above pins rather than defers. "No rig configured" and
 * "the server is pointed at the unresolvable default" have to be the same
 * statement, or this skip is a claim about the harness's own variables that
 * happens to be printed as a claim about the server. While the origin was left
 * absent they could differ: an inherited root `.env.local` pointed the server at
 * a real rig and this still said there wasn't one, which is the failure mode a
 * sentence-shaped skip exists to prevent and would itself have hidden.
 */
export const MEDIA_RIG_SKIP_REASON: string | null =
  MEDIA_RIG_ORIGIN === null
    ? "No media rig configured. Set LIBERTY_E2E_MEDIA_ORIGIN to a DASH/HLS origin you " +
      "hold rights to serve from (see docs/E2E.md). The default fixture origin is " +
      `${DEFAULT_FIXTURE_MEDIA_ORIGIN}, reserved by RFC 2606, which resolves nowhere - so ` +
      "there is no stream to play and a passing playback test here would have proved nothing."
    : null;

/**
 * A PostgreSQL connection string for the profile and progress routes, or `null`
 * for "this run has no database".
 *
 * PINNED ON THE SERVER FOR THE REASON THE MEDIA ORIGIN IS. `lib/db/index.ts`
 * selects its adapter from `DATABASE_URL` and caches the result for the life of
 * the process, and `apps/web`'s `dev` and `start` scripts run through
 * `scripts/with-root-env.mjs`, which fills any name the environment has not
 * already set from the repository root's dotenv files. So leaving this out of
 * `webServer.env` does not mean "no database" -- it means "whatever is in the
 * developer's `.env.local`", and the progress spec would then be asserting a
 * storage refusal against a server that had quietly found a database, or the
 * reverse. `playwright.config.ts` writes `SERVER_DATABASE_URL` unconditionally,
 * so what the server was given and what the specs expect are one expression.
 *
 * `null` is the default and is a real configuration rather than an absence: with
 * no `DATABASE_URL`, `selectRepository` answers `storage_not_configured` on a
 * deployment and hands `next dev` the in-memory adapter. Both are the behaviours
 * `tests/progress.api.spec.ts` asserts.
 */
export const DATABASE_URL = read("LIBERTY_E2E_DATABASE_URL");

/** The value the harness PINS as `DATABASE_URL`. Empty string = not configured. */
export const SERVER_DATABASE_URL: string = DATABASE_URL ?? "";

/**
 * The adapter line a request must carry on a build where the shared preamble
 * succeeds, derived from the value above rather than guessed.
 *
 * `lib/db/index.ts` chooses PostgreSQL whenever `DATABASE_URL` is set and
 * well-formed, and the in-memory store otherwise, so this harness knows the
 * answer exactly for a server it started. `request-context.ts` puts that choice
 * on every trail, which is what makes it assertable at all.
 */
export type StorageAdapterCode = "served_by_in_memory_adapter" | "served_by_postgres_adapter";

export const EXPECTED_STORAGE_ADAPTER: StorageAdapterCode =
  DATABASE_URL === null ? "served_by_in_memory_adapter" : "served_by_postgres_adapter";

/**
 * The reason a DEPLOYMENT refuses a profile/progress request before it reaches
 * any decision of its own, for the configuration this harness pinned.
 *
 * `resolveRequestContext` resolves storage FIRST and identity second, so which
 * of the two refusals a hosted build produces is decided by whether a database
 * was configured:
 *
 *   - no `DATABASE_URL` -> `storage_not_configured`, from `selectRepository`;
 *   - a `DATABASE_URL` -> storage resolves, and then
 *     `resolveRequestAccount` answers `authentication_not_configured`, because
 *     nothing in `apps/web` constructs `@liberty/auth/server` yet.
 *
 * Both are `unavailable` / 503 rather than 401 or 500: the remedy is an
 * operator's, and neither is a fault in handling the request.
 */
export type DeploymentPreambleRefusal = "storage_not_configured" | "authentication_not_configured";

export const DEPLOYMENT_PREAMBLE_REFUSAL: DeploymentPreambleRefusal =
  DATABASE_URL === null ? "storage_not_configured" : "authentication_not_configured";

/**
 * Whether the catalog metadata source can be constructed on the build under
 * test, which decides what every DISCOVERY surface is allowed to contain.
 *
 * `lib/catalog-source-registry.ts` resolves `demoCatalogSource` only for a
 * `NonDeploymentEnvironment`, the same nominal witness the playback fixtures
 * need, so a deployment has no metadata source at all. The title route does not
 * go through that registry -- `demo-title-details.ts` needs a SYNCHRONOUS source
 * and says why -- but it calls `NonDeploymentEnvironment.classify()` itself, so
 * it is the same witness and the same gate rather than a second one. The demo
 * titles are
 * therefore present under `development` and absent under `production`, exactly
 * as the playback fixtures are, and for the same stated reason -- serving
 * invented titles from a hosted build presents them to a reader as the product's
 * catalog.
 *
 * FOUR SURFACES ANSWER TO THIS ONE FLAG, AND THEY NOW ALL REFUSE IN ONE
 * VOCABULARY. `loadHomeCatalog` answers `error` / `catalog_source_not_configured`,
 * which the home PAGE renders as a panel and which
 * `api/v1/catalog/home/handler.ts` maps onto HTTP 503. `loadSearchResults` answers
 * the same reason, ahead of its emptiness test, so a non-empty query on a
 * deployment is refused rather than reported as matching nothing.
 * `demo-title-details.ts` throws `CatalogMetadataSourceNotConfiguredError`, whose
 * `reason` field is that same literal, and `title-detail.ts`'s catch tests the
 * class by `instanceof` and republishes the field -- so `/title/<id>` publishes
 * `catalog_source_not_configured` too, at HTTP 200.
 *
 * THIS PARAGRAPH USED TO RECORD A SECOND CODE FOR THE FOURTH SURFACE. It said
 * the title route
 * reported `title_source_unavailable` and called that "the one gap this flag's
 * consumers have to keep asserting until that catch learns to distinguish". The
 * catch has learned, `critical-journey.spec.ts` asserts the shared code, and the
 * gap is closed. `title_source_unavailable` still exists and is still correct: it
 * is what the loader answers for a source that throws anything else, which is
 * unreachable from a deployment's default source.
 *
 * IT ALSO USED TO CITE `readFixtureCatalogItems` as a synchronous accessor that
 * "still answers `[]`". That function has been DELETED from
 * `lib/catalog-source-registry.ts`, together with `getHomeCatalog` in
 * `lib/catalog.ts` -- the one caller it existed to be the default argument of --
 * now that the home route awaits `loadHomeCatalog`. Nothing in this harness ever
 * depended on it; the citation was a description of the application that outlived
 * the application.
 *
 * THREE VALUES, NOT TWO. Against an external deployment this harness was not
 * told which build is behind the URL, and both answers are correct there; a spec
 * that guessed would fail on a correct deployment, which is worse than not
 * asserting because it teaches people to ignore the result. `unknown` is what
 * the catalog, search and journey specs skip on, with that sentence as the
 * reason.
 */
export type CatalogAvailability = "fixtures" | "refused" | "unknown";

export const CATALOG_AVAILABILITY: CatalogAvailability = !MANAGES_SERVER
  ? "unknown"
  : WEB_MODE === "development"
    ? "fixtures"
    : "refused";

/** Why a catalog-content assertion cannot be made against an unidentified build. */
export const UNKNOWN_CATALOG_SKIP_REASON =
  "Testing an external deployment whose build mode this harness was not told, so neither " +
  "the demo catalog's presence nor its absence is the right expectation. Point the harness " +
  "at a server it starts to assert either.";
