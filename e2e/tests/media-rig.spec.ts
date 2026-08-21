import { expect, test } from "@playwright/test";
import { MEDIA_RIG_ORIGIN, MEDIA_RIG_SKIP_REASON } from "../src/env";
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
