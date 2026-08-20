import { describe, expect, it } from "vitest";
import { LIBERTY_VIDEO_TAG, LibertyVideoElement, defineLibertyVideo } from "./liberty-video";

/*
 * Honest scope. This app's vitest environment is `node`, and the parts of a
 * custom element that matter — upgrade, shadow-DOM composition, attribute
 * reflection, and anything that needs a real MediaSource — are not exercisable
 * there. jsdom would not rescue it either: it has no media pipeline, so a test
 * of playback against it would assert that our own stubs behave.
 *
 * What IS worth testing without a browser is here: that the module can be
 * evaluated where there are no browser globals at all, and the one piece of
 * pure logic the element owns.
 */

describe("registration", () => {
  it("evaluates and registers safely where there is no custom element registry", () => {
    /*
     * This is the prerender path. Importing this module at all is the real
     * assertion — a top-level reference to `window`, `document` or `HTMLElement`
     * would throw before the first expectation runs, and it would throw during
     * a Next build rather than in a test.
     */
    expect(() => defineLibertyVideo()).not.toThrow();
    // Twice, because React strict mode double-invokes the effect that calls it.
    expect(() => defineLibertyVideo()).not.toThrow();
    expect(LIBERTY_VIDEO_TAG).toBe("liberty-video");
  });
});

describe("template", () => {
  it("renders the inner <video> without a src", () => {
    /*
     * The trap this closes: a `src` on the inner element starts a second,
     * native load of the same URL alongside Shaka's. On a platform with native
     * HLS that load can win, and playback then runs through a path where
     * getStats(), the switch history and CMCD report nothing at all.
     */
    const html = LibertyVideoElement.getTemplateHTML({
      src: "https://cdn.example.com/title/master.m3u8",
      poster: "https://cdn.example.com/title/poster.jpg",
      muted: "",
      playsinline: ""
    });

    expect(html).toContain("<video");
    expect(html).not.toContain("master.m3u8");
    expect(html).not.toContain("src=");
    expect(html).toContain('poster="https://cdn.example.com/title/poster.jpg"');
    expect(html).toContain(" muted");
    expect(html).toContain(" playsinline");
  });
});
