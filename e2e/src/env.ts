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
