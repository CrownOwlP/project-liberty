/* WebPlayerAdapter (PW-0202): the existing Shaka path behind the boundary. */
import { describe, expect, it, vi } from "vitest";

import type { ContentProtection } from "@liberty/contracts/shared/drm";

import type { PlaybackController } from "./playback-controller";
import type { PlayerAdapterEvent, PlayerCandidate, PlayerLoadRequest } from "./player-adapter";
import { WebPlayerAdapter, type MediaElementLike } from "./web-player-adapter";

class FakeMedia implements MediaElementLike {
  currentTime = 0;
  volume = 1;
  muted = false;
  duration = Number.NaN;
  readonly played: number[] = [];
  readonly #handlers = new Map<string, Set<() => void>>();
  async play(): Promise<void> {
    this.played.push(1);
  }
  pause(): void {}
  addEventListener(type: string, listener: () => void): void {
    (this.#handlers.get(type) ?? this.#handlers.set(type, new Set()).get(type)!).add(listener);
  }
  removeEventListener(type: string, listener: () => void): void {
    this.#handlers.get(type)?.delete(listener);
  }
  fire(type: string): void {
    for (const handler of this.#handlers.get(type) ?? []) handler();
  }
  listenerCount(): number {
    let total = 0;
    for (const set of this.#handlers.values()) total += set.size;
    return total;
  }
}

const SHAKA_TEXT = [
  { id: 3, language: "en", label: "English", forced: false, primary: true },
  { id: 4, language: "fr", label: "Français", forced: true, primary: false }
];
const SHAKA_VARIANTS = [
  { language: "en", label: "English", audioCodec: "mp4a.40.2", channelsCount: 2, primary: true },
  { language: "en", label: "English", audioCodec: "mp4a.40.2", channelsCount: 2, primary: true },
  { language: "de", label: "Deutsch", audioCodec: "ec-3", channelsCount: 6, primary: false }
];

function makeAdapter(overrides: { player?: unknown; destroy?: () => Promise<void> } = {}) {
  const media = new FakeMedia();
  const destroy = overrides.destroy ?? vi.fn(async () => {});
  const player =
    overrides.player === undefined
      ? {
          getTextTracks: () => SHAKA_TEXT,
          getVariantTracks: () => SHAKA_VARIANTS,
          selectTextTrack: vi.fn(),
          setTextTrackVisibility: vi.fn(),
          selectAudioLanguage: vi.fn()
        }
      : overrides.player;
  const controller = {
    getEnginePlayer: () => player,
    destroy
  } as unknown as PlaybackController;
  const setSource = vi.fn(async () => {});
  const adapter = new WebPlayerAdapter({ controller, media, setSource });
  const events: PlayerAdapterEvent[] = [];
  adapter.subscribe((event) => events.push(event));
  return { adapter, media, events, setSource, player, destroy };
}

const candidate = (protection: ContentProtection = { state: "clear" }): PlayerCandidate => ({
  id: "c1",
  providerId: "fixture",
  uri: "https://fixtures.invalid/a.mpd",
  mimeType: "application/dash+xml",
  compatibility: "unverified",
  protection
});

const request = (c: PlayerCandidate = candidate()): PlayerLoadRequest => ({
  session: { contentId: "demo", candidates: [c], startAtSeconds: null, reasons: ["fixture"] },
  candidateId: c.id,
  startAtSeconds: null,
  loadId: 7
});

describe("canPlay delegates the protection axis and does not re-decide it", () => {
  it("accepts a clear candidate with a reason", () => {
    const { adapter } = makeAdapter();
    const decision = adapter.canPlay(candidate());
    expect(decision.playable).toBe(true);
    if (decision.playable) expect(decision.reason).toContain("clear");
  });

  it("accepts a protected candidate, because this is the DRM path on both targets", () => {
    const { adapter } = makeAdapter();
    expect(
      adapter.canPlay(candidate({ state: "protected", keySystem: "widevine", licenseUrl: null }))
        .playable
    ).toBe(true);
  });

  it("refuses everything once disposed", async () => {
    const { adapter } = makeAdapter();
    await adapter.dispose();
    const decision = adapter.canPlay(candidate());
    expect(decision.playable).toBe(false);
    if (!decision.playable) expect(decision.refusal).toBe("adapter_unavailable");
  });
});

describe("load", () => {
  it("emits loadstarted then loaded, with the timeline and the tracks", async () => {
    const { adapter, events, setSource } = makeAdapter();
    await adapter.load(request());
    expect(setSource).toHaveBeenCalledWith("https://fixtures.invalid/a.mpd", "application/dash+xml", null);
    expect(events.map((e) => e.type)).toEqual(["loadstarted", "loaded"]);
  });

  it("rejects a candidate id the session does not carry, rather than loading the first", async () => {
    const { adapter } = makeAdapter();
    await expect(adapter.load({ ...request(), candidateId: "nope" })).rejects.toThrow(/does not carry/);
  });

  it("rejects a load that canPlay would refuse, so routing cannot be bypassed", async () => {
    /* `load` calls the SAME canPlay, not a copy: a caller that skipped the router
     * must not be able to reach the engine by calling load directly. */
    const { adapter } = makeAdapter();
    await adapter.dispose();
    await expect(adapter.load(request())).rejects.toThrow(/adapter_unavailable/);
  });
});

describe("tracks — the first code in this repository to read them", () => {
  it("reads subtitle tracks with forced and default preserved", async () => {
    const { adapter } = makeAdapter();
    await adapter.load(request());
    const subtitles = adapter.getTracks().filter((t) => t.kind === "subtitle");
    expect(subtitles).toHaveLength(2);
    expect(subtitles[1]?.isForced).toBe(true);
    expect(subtitles[0]?.language).toBe("en");
  });

  it("collapses variants to ONE audio row per language", async () => {
    /* Shaka publishes a variant per video rendition, so a five-bitrate stream
     * would otherwise produce five identical "English" rows in a menu. */
    const { adapter } = makeAdapter();
    await adapter.load(request());
    const audio = adapter.getTracks().filter((t) => t.kind === "audio");
    expect(audio.map((t) => t.language)).toEqual(["en", "de"]);
    expect(audio[1]?.channels).toBe(6);
  });

  it("yields no tracks rather than throwing when the engine cannot report them", async () => {
    const { adapter } = makeAdapter({ player: {} });
    await adapter.load(request());
    expect(adapter.getTracks()).toEqual([]);
  });

  /* ======================================================================
   * WHAT A TRACK IS FOR, READ RATHER THAN GUESSED (PW-0206)
   * ===================================================================== */

  async function tracksFrom(text: readonly unknown[], variants: readonly unknown[] = []) {
    const { adapter } = makeAdapter({
      player: {
        getTextTracks: () => text,
        getVariantTracks: () => variants,
        selectTextTrack: vi.fn(),
        setTextTrackVisibility: vi.fn(),
        selectAudioLanguage: vi.fn()
      }
    });
    await adapter.load(request());
    return adapter.getTracks();
  }

  it("reads an audio role out of audioRoles, and prefers it to the variant's roles", async () => {
    /* On a Shaka VARIANT, `roles` is the union of the video and audio roles, so
     * reading it first would let a VIDEO role describe the soundtrack. */
    const [track] = await tracksFrom(
      [],
      [{ language: "en", audioCodec: "mp4a.40.2", audioRoles: ["commentary"], roles: ["main"] }]
    );
    expect(track?.audioRole).toBe("commentary");
  });

  it("falls back to roles when the engine states no audioRoles", async () => {
    const [track] = await tracksFrom(
      [],
      [{ language: "en", audioCodec: "mp4a.40.2", roles: ["description"] }]
    );
    expect(track?.audioRole).toBe("descriptive");
  });

  it("LEAVES THE ROLE NULL when the engine named none, rather than defaulting it", async () => {
    /* The only plausible default, "main", is the one that would make a
     * commentary track automatically selectable. Null is what "the engine did
     * not say" means, and the bridge decides what to do about it. */
    const [track] = await tracksFrom([], [{ language: "en", audioCodec: "mp4a.40.2" }]);
    expect(track?.audioRole).toBeNull();
    const [unknownRole] = await tracksFrom(
      [],
      [{ language: "en", audioCodec: "mp4a.40.2", audioRoles: ["supplementary"] }]
    );
    expect(unknownRole?.audioRole).toBeNull();
  });

  it("reports a caption track as sdh, which a forced boolean could never say", async () => {
    const [track] = await tracksFrom([
      { id: 1, language: "en", kind: "caption", mimeType: "text/vtt" }
    ]);
    expect(track?.subtitleKind).toBe("sdh");
  });

  it("reports a commentary subtitle track as commentary", async () => {
    const [track] = await tracksFrom([
      { id: 1, language: "en", roles: ["commentary"], mimeType: "text/vtt" }
    ]);
    expect(track?.subtitleKind).toBe("commentary");
  });

  it("NEVER DISAGREES WITH ITSELF about forced", async () => {
    /* `player-adapter.ts` states the invariant: subtitleKind is "forced"
     * exactly when isForced is true, for any track whose kind is known. An
     * adapter that broke it would hand the policy two contradictory facts. */
    const tracks = await tracksFrom([
      { id: 1, language: "en", forced: true, kind: "caption", mimeType: "text/vtt" },
      { id: 2, language: "fr", forced: false, kind: "subtitle", mimeType: "text/vtt" },
      { id: 3, language: "de", forced: true, roles: ["commentary"], mimeType: "text/vtt" }
    ]);
    for (const track of tracks) {
      if (track.subtitleKind === null) continue;
      expect(track.subtitleKind === "forced").toBe(track.isForced);
    }
  });

  it("reads the text format from the mime type, parameters and all", async () => {
    const tracks = await tracksFrom([
      { id: 1, language: "en", mimeType: "text/vtt; charset=utf-8" },
      { id: 2, language: "fr", mimeType: "application/ttml+xml" },
      { id: 3, language: "de", mimeType: "application/mp4" },
      { id: 4, language: "es", mimeType: "application/x-subrip" },
      { id: 5, language: "it", mimeType: "video/mp2t" },
      { id: 6, language: "ja" }
    ]);
    expect(tracks.map((track) => track.textFormat)).toEqual([
      "webvtt",
      "ttml",
      /* A TEXT track in an ISO-BMFF wrapper is segmented TTML; Shaka reports
       * the container and the renderable format inside it is TTML. */
      "ttml",
      "srt",
      /* Unrecognised, and null rather than a guess -- an unrenderable subtitle
       * format fails silently, so the policy must be allowed to reject it. */
      null,
      null
    ]);
  });

  it("never reads a LABEL to decide any of the three", async () => {
    /* subtitles.ts: "SDH" in a label is a naming convention and this is a
     * decision input. A stream that calls a plain subtitle track "English SDH"
     * must not be promoted by its own marketing. */
    const [track] = await tracksFrom([
      { id: 1, language: "en", label: "English SDH (Commentary, Forced)", mimeType: "text/vtt" }
    ]);
    expect(track?.subtitleKind).toBeNull();
    expect(track?.isForced).toBe(false);
  });

  it("puts no audio fields on a subtitle track, or the reverse", async () => {
    const [text] = await tracksFrom([{ id: 1, language: "en", mimeType: "text/vtt" }]);
    expect(text?.audioRole).toBeNull();
    const [variant] = await tracksFrom([], [{ language: "en", audioCodec: "mp4a.40.2" }]);
    expect(variant?.subtitleKind).toBeNull();
    expect(variant?.textFormat).toBeNull();
  });

  /* ======================================================================
   * THE TWO READS THE CONTROL BAR CANNOT DO WITHOUT (PW-0306)
   * ===================================================================== */

  it("reports BUFFERED RANGES, which a fill percentage cannot express", async () => {
    const { adapter, media } = makeAdapter();
    await adapter.load(request());
    expect(adapter.getBufferedRanges()).toEqual([]);
    /* Two ranges with a gap: the same total as one 60-second range and the
     * opposite answer to "can I jump to 45 seconds". */
    (media as unknown as { buffered: unknown }).buffered = {
      length: 2,
      start: (i: number) => (i === 0 ? 0 : 60),
      end: (i: number) => (i === 0 ? 30 : 90)
    };
    expect(adapter.getBufferedRanges()).toEqual([
      { startSeconds: 0, endSeconds: 30 },
      { startSeconds: 60, endSeconds: 90 }
    ]);
  });

  it("answers an EMPTY LIST, not a throw, for an element that cannot report them", async () => {
    /* `MediaElementLike.buffered` is optional so a structural double written
     * before the field existed still satisfies the type, and an absent
     * reading means nothing is held. */
    const { adapter } = makeAdapter();
    await adapter.load(request());
    expect(adapter.getBufferedRanges()).toEqual([]);
  });

  it("RESYNCHRONISES by re-reading the engine and publishing what it found", async () => {
    /* The case the boundary names: a consumer attached to an adapter that did
     * not perform the load. Its track list starts empty and no `loaded` event
     * is ever coming. */
    const { adapter } = makeAdapter();
    const events: string[] = [];
    adapter.subscribe((event) => events.push(event.type));
    expect(adapter.getTracks()).toEqual([]);

    adapter.resynchronise();

    expect(adapter.getTracks().length).toBeGreaterThan(0);
    expect(events).toEqual(["tracks", "duration", "position", "resynchronised"]);
  });

  it("puts the MARKER LAST, so everything before it is the new truth", async () => {
    const { adapter } = makeAdapter();
    const events: string[] = [];
    adapter.subscribe((event) => events.push(event.type));
    adapter.resynchronise();
    expect(events[events.length - 1]).toBe("resynchronised");
  });

  it("carries a dropped-event count when it has one, and null when it does not", async () => {
    const { adapter } = makeAdapter();
    const seen: (number | null)[] = [];
    adapter.subscribe((event) => {
      if (event.type === "resynchronised") seen.push(event.droppedEvents);
    });
    adapter.resynchronise();
    adapter.resynchronise(12);
    /* Never 0 for unknown -- that is a count, and the adapter does not have
     * one unless the engine gave it one. */
    expect(seen).toEqual([null, 12]);
  });

  it("DOES NOT CLAIM A PLAY STATE it has no load id for", async () => {
    /* `playing` and `paused` correlate to a load. This adapter did not perform
     * one here, and inventing an id would attribute a state to a load that
     * never happened; whether playback is running is the state machine's. */
    const { adapter } = makeAdapter();
    const events: string[] = [];
    adapter.subscribe((event) => events.push(event.type));
    adapter.resynchronise();
    expect(events).not.toContain("playing");
    expect(events).not.toContain("paused");
  });

  it("says nothing at all once disposed", async () => {
    const { adapter } = makeAdapter();
    await adapter.dispose();
    const events: string[] = [];
    adapter.subscribe((event) => events.push(event.type));
    adapter.resynchronise();
    expect(events).toEqual([]);
  });

  it("rejects an unknown track id rather than silently doing nothing", async () => {
    /* A menu that appears to change the language and does not is worse than an
     * error. */
    const { adapter } = makeAdapter();
    await adapter.load(request());
    await expect(adapter.selectSubtitleTrack("999")).rejects.toThrow(/no subtitle track/);
    await expect(adapter.selectAudioTrack("audio:zz")).rejects.toThrow(/no audio track/);
  });

  it("deselects subtitles with null, and refuses to deselect audio", async () => {
    const { adapter, player } = makeAdapter();
    await adapter.load(request());
    await adapter.selectSubtitleTrack(null);
    expect((player as { setTextTrackVisibility: ReturnType<typeof vi.fn> }).setTextTrackVisibility).toHaveBeenCalledWith(false);
    await expect(adapter.selectAudioTrack(null)).rejects.toThrow(/cannot be deselected/);
  });
});

describe("timeline, volume and media events", () => {
  it("reports an unknown duration as null, never 0", async () => {
    const { adapter, media } = makeAdapter();
    expect(adapter.getTimeline().durationSeconds).toBeNull();
    media.duration = 120;
    expect(adapter.getTimeline().durationSeconds).toBe(120);
  });

  it("treats muting as a separate fact from a zero level", async () => {
    const { adapter, media } = makeAdapter();
    await adapter.setVolume(0);
    expect(media.volume).toBe(0);
    expect(media.muted).toBe(false);
    await adapter.setVolume(0.5, { muted: true });
    expect(media.muted).toBe(true);
  });

  it("refuses a volume outside 0-1", async () => {
    const { adapter } = makeAdapter();
    await expect(adapter.setVolume(1.5)).rejects.toThrow(/outside 0-1/);
  });

  it("translates media events into boundary events", async () => {
    const { adapter, media, events } = makeAdapter();
    await adapter.load(request());
    events.length = 0;
    media.fire("playing");
    media.fire("waiting");
    media.fire("seeked");
    media.fire("ended");
    expect(events.map((e) => e.type)).toEqual(["playing", "buffering", "seekcompleted", "ended"]);
  });
});

describe("A/V sync is reported honestly", () => {
  it("is unavailable, and carries no magnitude", () => {
    /* A browser has no audio clock for a media element. A number here would be
     * an invention, and a dashboard averaging absent readings as 0 would report
     * perfect synchronisation for a player that cannot measure it. */
    const { adapter } = makeAdapter();
    const telemetry = adapter.readAvSyncTelemetry();
    expect(telemetry.available).toBe(false);
    expect(telemetry).not.toHaveProperty("internalAvSyncSeconds");
  });
});

describe("dispose", () => {
  it("is idempotent and destroys the controller once", async () => {
    const destroy = vi.fn(async () => {});
    const { adapter } = makeAdapter({ destroy });
    await adapter.dispose();
    await adapter.dispose();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("is safe on an adapter that never loaded", async () => {
    const { adapter } = makeAdapter();
    await expect(adapter.dispose()).resolves.toBeUndefined();
  });

  it("removes every media listener, so nothing outlives the element", async () => {
    const { adapter, media } = makeAdapter();
    expect(media.listenerCount()).toBeGreaterThan(0);
    await adapter.dispose();
    expect(media.listenerCount()).toBe(0);
  });

  it("does not let a throwing subscriber abort teardown", async () => {
    const destroy = vi.fn(async () => {});
    const { adapter } = makeAdapter({ destroy });
    adapter.subscribe(() => {
      throw new Error("subscriber fault");
    });
    await expect(adapter.dispose()).resolves.toBeUndefined();
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
