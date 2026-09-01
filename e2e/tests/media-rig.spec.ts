import { expect, test } from "@playwright/test";
import { MANAGES_SERVER, MEDIA_RIG_ORIGIN, MEDIA_RIG_SKIP_REASON, WEB_MODE } from "../src/env";
import { DEMO } from "../src/fixtures";

/* -------------------------------------------------------------------------
 * Playback against a real media rig - skipped, loudly, when there isn't one
 *
 * WHY THIS SUITE IS NORMALLY SKIPPED, AND WHY THAT IS THE HONEST DEFAULT.
 *
 * Product invariant 1 admits only licensed, user-owned or public-domain content
 * into playback resolution. There is no shortcut past that for a test: a media
 * URL of unknown provenance pasted into a fixture is a rights claim that no
 * rights review ever saw, and it would sit in the repository looking exactly
 * like a reviewed one. `docs/RESEARCH_PLAYBACK.md` records the legitimate route
 * -- package public-domain sources into DASH and HLS yourself and check the
 * OUTPUT into fixtures -- and that packaging is a task of its own.
 *
 * Until it exists, `LIBERTY_FIXTURE_MEDIA_ORIGIN` defaults to a host reserved
 * by RFC 2606 that resolves nowhere. So there is nothing to play, and a test
 * that reported green here would be reporting that it successfully failed to
 * fetch a stream. A skip that NAMES the missing precondition is worth more than
 * a pass that proved nothing: the report says what would have to be true for
 * this to have been tested, which is the fact a reader of a gate result needs.
 *
 * `docs/E2E.md` has the instructions for standing a rig up.
 * ---------------------------------------------------------------------- */

test.describe("playback against a configured media rig", () => {
  test.skip(MEDIA_RIG_SKIP_REASON !== null, MEDIA_RIG_SKIP_REASON ?? "");

  test("the rig is the origin the harness was told about", async ({ request }) => {
    /*
     * Checked first, and against the SERVER's answer rather than against the
     * variable this process read. An operator who set the variable after the
     * server was already running (or set it on the wrong shell) would otherwise
     * get a run that looks configured and is not.
     */
    const response = await request.post("/api/v1/playback/session", {
      data: {
        contentId: DEMO.movie.id,
        capabilities: {
          maxHeight: 1080,
          supportedVideoCodecs: ["h264"],
          supportedAudioCodecs: ["aac"],
          preferredAudioLanguages: ["en"]
        }
      }
    });

    const body = (await response.json()) as {
      outcome: string;
      session?: { candidates: { uri: string }[] };
    };

    test.skip(
      body.outcome !== "granted",
      `The session endpoint answered "${body.outcome}". A production build resolves no ` +
        "candidates by design; set LIBERTY_E2E_WEB_MODE=development to exercise this path."
    );

    const expected = new URL(MEDIA_RIG_ORIGIN as string).origin;
    for (const candidate of body.session?.candidates ?? []) {
      expect(new URL(candidate.uri).origin).toBe(expected);
    }
  });

  test("the player reaches a playing state and the trail says which candidate", async ({ page }) => {
    await page.goto(`/watch/${DEMO.movie.id}`);

    /*
     * THE WATCH ROUTE NO LONGER SERVES FIXTURES IN EVERY MODE, and this test
     * silently assumed it did. Until PL-0301, `watch/watch-session.ts` carried
     * its own unguarded copy of the fixture provider, so a rig plus the default
     * production build produced a playing player; the route now consumes
     * `resolveAuthorizedCandidates` and answers `not-configured` outside
     * development and test. Left as it was, this test would have spent 45
     * seconds waiting for a `State: playing` that the panel in front of it can
     * never produce, and reported a rights-and-configuration fact as a playback
     * failure.
     *
     * The branch is read off WHAT THE PAGE RENDERED, which is the idiom the test
     * above already uses -- it skips on the SERVER's outcome rather than on a
     * local variable -- and it is what keeps this usable against an external
     * deployment whose build nobody told the harness. What the observation is
     * ALLOWED to conclude is then narrowed by what this process knows, below.
     *
     * It hides nothing either way: `critical-journey.spec.ts` asserts which
     * branch each mode is REQUIRED to take, including that a production build
     * must not mount a player at all.
     */
    const player = page.locator("liberty-video");
    const unavailable = page.getByRole("heading", { name: /available on this deployment/i });
    /* One of the two, waited on as a condition: the panel is server-rendered
     * while the player is appended in an effect, so counting immediately would
     * read "no player" on a development server that is about to mount one. */
    await expect(player.or(unavailable).first()).toBeAttached();
    const rendered = await player.count();

    /*
     * A SKIP ONLY WHERE THE HARNESS GENUINELY CANNOT KNOW BETTER, which is the
     * difference between a skip and a hole. Against an external deployment the
     * build is unknown, and under a production build the missing player is the
     * documented answer -- both are honest skips. But when THIS harness started
     * a DEVELOPMENT build and a rig is configured, fixtures are required to
     * resolve, so a page with no player is a regression and skipping on it would
     * turn the one test that proves playback into a test that quietly excuses
     * its own absence. That case falls through to the assertion below and fails.
     */
    test.skip(
      rendered === 0 && (!MANAGES_SERVER || WEB_MODE === "production"),
      "This deployment's watch route resolves no candidates -- it rendered the " +
        "'not available on this deployment' panel rather than a player -- so there is nothing " +
        "for a rig to play. Set LIBERTY_E2E_WEB_MODE=development, as docs/E2E.md's rig " +
        "instructions already do."
    );
    expect(
      rendered,
      "a development build with a rig configured rendered no player on the watch route"
    ).toBeGreaterThan(0);

    const meta = page.locator(".player-meta").first();

    /*
     * A condition, not a sleep. `toHaveText` retries until the machine's phase
     * reads `playing`, so a slow rig costs time and never a false failure. The
     * timeout is generous because this is the one assertion in the harness that
     * depends on a manifest fetch, an engine load and a first frame.
     */
    await expect(meta).toContainText(/State:\s*playing/, { timeout: 45_000 });

    /*
     * The reason trail is the point, not the pixels. `docs/RESEARCH_PLAYBACK.md`
     * flags iOS/Safari as the concrete thing to measure precisely because Shaka
     * may fall back to native `src=` HLS there and LOSE the `getStats()` trail
     * that CMCD depends on -- a player that plays while reporting nothing is the
     * outcome that would look like success and be a telemetry outage. So a
     * named candidate is asserted alongside the playing state, on every project
     * in the device matrix.
     */
    await expect(meta).not.toContainText("Candidate: none");
  });
});
