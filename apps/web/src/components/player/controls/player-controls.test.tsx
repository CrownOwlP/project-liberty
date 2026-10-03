/* -------------------------------------------------------------------------
 * The control bar's FIRST RENDER (PW-0306)
 *
 * WHAT THIS FILE CAN AND CANNOT PROVE, STATED FIRST SO NOBODY READS MORE INTO
 * IT. `apps/web/vitest.config.ts` sets `environment: "node"`. There is no DOM
 * here, so no effect runs, no subscription is made, no keystroke is dispatched
 * and no menu opens. `season-navigation.test.tsx` makes the same observation
 * one task earlier and uses it the same way: `renderToStaticMarkup` produces
 * exactly the markup a browser receives before hydration, which is the one
 * thing a DOM-based test is bad at asserting.
 *
 * So the work is split three ways and each part is tested where it can be:
 *   - the DECISIONS -- seek steps, the idle rule, track labels -- are pure
 *     functions in `controls-state.ts` with their own suite;
 *   - the MARKUP a viewer first receives, and every accessibility promise that
 *     lives in an attribute, is here;
 *   - the BEHAVIOUR -- keyboard, menus, commands reaching the adapter -- is
 *     `e2e/tests/player-controls.spec.ts`, in a real browser, because a
 *     keyboard test without a keyboard proves nothing.
 * ---------------------------------------------------------------------- */
import { readFileSync } from "node:fs";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type {
  AvSyncTelemetry,
  CanPlayDecision,
  PlayerAdapter,
  PlayerTimeline,
  PlayerTrack
} from "../player-adapter";
import type { BufferedRange } from "../diagnostics/buffered-ranges";
import { PlayerControls } from "./player-controls";

function fakeAdapter(overrides: Partial<PlayerAdapter> = {}): PlayerAdapter {
  const base: PlayerAdapter = {
    id: "web-shaka",
    canPlay: (): CanPlayDecision => ({
      playable: true,
      adapterId: "web-shaka",
      confidence: "unverified",
      reason: "fake"
    }),
    load: async () => {},
    play: async () => {},
    pause: async () => {},
    seek: async () => {},
    stop: async () => {},
    selectAudioTrack: async () => {},
    selectSubtitleTrack: async () => {},
    setVolume: async () => {},
    getTimeline: (): PlayerTimeline => ({ positionSeconds: 0, durationSeconds: null }),
    getTracks: (): readonly PlayerTrack[] => [],
    getBufferedRanges: (): readonly BufferedRange[] => [],
    readAvSyncTelemetry: (): AvSyncTelemetry => ({ available: false, why: "not_yet_sampled" }),
    resynchronise: () => {},
    subscribe: () => () => {},
    dispose: async () => {}
  };
  return { ...base, ...overrides };
}

function render(props: Partial<React.ComponentProps<typeof PlayerControls>> = {}): string {
  return renderToStaticMarkup(
    <PlayerControls
      adapter={props.adapter ?? fakeAdapter()}
      fullscreenTarget={null}
      running={props.running ?? null}
      candidateId={props.candidateId ?? "cdn-a"}
      attemptsUsed={props.attemptsUsed ?? 1}
      maxAttempts={props.maxAttempts ?? 3}
      engineStatus={props.engineStatus ?? "ready"}
      restarting={props.restarting ?? false}
    />
  );
}

describe("every control the acceptance names is in the first render", () => {
  const markup = render();

  it("has play, seek, volume, mute, fullscreen and both track menus", () => {
    for (const id of [
      "control-play",
      "control-seek",
      "control-volume",
      "control-mute",
      "control-fullscreen",
      "control-subtitle-menu",
      "control-audio-menu",
      "control-time",
      "control-source"
    ]) {
      expect(markup).toContain(`data-testid="${id}"`);
    }
  });

  it("labels every control, because an icon-shaped button with no name is unusable", () => {
    for (const label of ["Play", "Seek", "Volume", "Mute", "Full screen", "Player controls"]) {
      expect(markup).toContain(`aria-label="${label}"`);
    }
  });

  it("IS A GROUP AND NOT A TOOLBAR", () => {
    /* `role="toolbar"` promises arrow-key navigation BETWEEN the controls, and
     * this player spends the arrow keys on seeking and volume. Claiming the
     * role and not honouring it is worse than not claiming it. */
    expect(markup).toContain('role="group"');
    expect(markup).not.toContain('role="toolbar"');
  });

  it("says Play when nothing is running and Pause when something is", () => {
    expect(render({ running: false })).toContain('aria-label="Play"');
    expect(render({ running: true })).toContain('aria-label="Pause"');
    /* `null` is "the machine has not said yet" and must not read as playing. */
    expect(render({ running: null })).toContain('aria-label="Play"');
  });
});

describe("the state a viewer can read before anything has loaded", () => {
  it("shows --:-- for a DURATION nobody knows, and 0:00 for a position that is zero", () => {
    /*
     * The asymmetry is the boundary's and it is right. `PlayerTimeline` makes
     * `durationSeconds` nullable and `positionSeconds` a plain number, because
     * a stream can genuinely have no duration -- live, or metadata not yet
     * parsed -- and a position before anything has been played IS zero rather
     * than unknown. Rendering the duration as 0:00 would tell a viewer the
     * programme is empty; rendering the position as --:-- would invent an
     * uncertainty the player does not have.
     */
    expect(render()).toContain("0:00 / --:--");
  });

  it("DISABLES the seek bar rather than offering a seek that cannot happen", () => {
    /* Attribute order is React's, so the test must not depend on it. */
    const markup = render();
    const input = /<input[^>]*data-testid="control-seek"[^>]*>/.exec(markup)?.[0] ?? "";
    expect(input).not.toBe("");
    expect(input).toContain("disabled");
  });

  it("announces the seek position as a TIME, not as a percentage", () => {
    /* The element carries a percentage because that is what a range input is;
     * a viewer needs the time, and an unknown duration is spoken as unknown
     * rather than as a number. */
    expect(render()).toContain('aria-valuetext="0 seconds of unknown"');
  });

  it("renders the source line as a polite status, so a failover is announced", () => {
    const markup = render({ candidateId: "cdn-b", attemptsUsed: 2, maxAttempts: 4 });
    expect(markup).toContain('role="status"');
    expect(markup).toContain("source cdn-b — attempt 2 of 4, engine ready");
  });
});

describe("the overlay is DIMMED, never removed", () => {
  it("starts shown and carries its state as data rather than as a display rule", () => {
    expect(render()).toContain('data-visibility="shown"');
  });

  it("NEVER HIDES THE BAR OR ANY CONTROL FROM THE ACCESSIBILITY TREE", () => {
    /*
     * The acceptance clause, asserted mechanically: "an idle-hide overlay that
     * never hides a control from a keyboard or screen-reader user". Each of
     * `aria-hidden`, `inert`, `hidden` and an inline display rule removes the
     * controls from the accessibility tree or from the tab order, and each is
     * a one-line edit away.
     *
     * CHECKED PER ELEMENT RATHER THAN OVER THE WHOLE STRING, because one
     * `aria-hidden` is CORRECT and must stay: the painted seek track behind
     * the real input is decoration, and announcing it would give a screen
     * reader two seek bars. A blanket assertion would have forbidden the right
     * thing along with the wrong ones.
     */
    const markup = render();
    const root = /<div[^>]*data-testid="player-controls"[^>]*>/.exec(markup)?.[0] ?? "";
    expect(root).not.toBe("");
    for (const forbidden of ["aria-hidden", "inert", "hidden="]) {
      expect(root).not.toContain(forbidden);
    }
    for (const control of markup.match(/<(?:button|input)[^>]*>/g) ?? []) {
      expect(control).not.toContain("aria-hidden");
      expect(control).not.toMatch(/\binert\b/);
    }
    expect(markup).not.toMatch(/display:\s*none/);
    expect(markup).not.toMatch(/visibility:\s*hidden/);
  });

  it("and the stylesheet dims with OPACITY and nothing stronger", () => {
    /*
     * The markup cannot prove this on its own, because the rule lives in CSS.
     * Read the file: `.dimmed` may set opacity and may not reach for anything
     * that takes the bar out of the tree or off the keyboard.
     */
    const css = readFileSync(
      new URL("./player-controls.module.css", import.meta.url),
      "utf8"
    );
    const dimmed = css.slice(css.indexOf(".dimmed"), css.indexOf(".row"));
    expect(dimmed).toMatch(/opacity:/);
    for (const forbidden of ["display:", "visibility:", "pointer-events:", "content-visibility:"]) {
      expect(dimmed).not.toContain(forbidden);
    }
  });
});

describe("track menus", () => {
  it("are closed on first render, and say so", () => {
    const markup = render();
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain('role="listbox"');
  });

  it("declare what they control, so the relationship survives without JavaScript", () => {
    const markup = render();
    expect(markup).toContain('aria-controls="player-subtitle-menu"');
    expect(markup).toContain('aria-controls="player-audio-menu"');
    expect(markup).toContain('aria-haspopup="listbox"');
  });
});

describe("the adapter is the only thing it commands", () => {
  it("reads the timeline and the tracks through the boundary on first render", () => {
    /* No effect runs here, so the proof is negative and precise: the component
     * compiles against `PlayerAdapter` alone. The fake above implements that
     * interface and nothing else -- no Shaka handle, no media element, no
     * machine -- and the component renders from it. */
    const calls: string[] = [];
    const adapter = fakeAdapter({
      getTimeline: () => {
        calls.push("getTimeline");
        return { positionSeconds: 12, durationSeconds: 120 };
      }
    });
    const markup = render({ adapter });
    /* The first render uses the component's own initial state rather than the
     * adapter, because the pull happens in an effect. Stated rather than
     * asserted the other way round: a reader comparing this to the browser
     * should know the numbers arrive one tick later. */
    expect(calls).toEqual([]);
    expect(markup).toContain("0:00 / --:--");
  });
});
