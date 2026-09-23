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
