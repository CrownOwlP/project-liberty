import { describe, expect, it } from "vitest";
import type {
  EngineConfig,
  EngineLoader,
  RawEngineStats,
  ShakaEngine,
  ShakaPlayerHandle
} from "./engine";
import { PlaybackController, type PlaybackControllerEvent } from "./playback-controller";
import type { PlaybackError } from "./shaka-error";

/*
 * The engine is injected, so none of this needs a browser, a DOM or an 88 MB
 * dependency. What is NOT covered here is stated plainly rather than faked:
 * custom-element registration, shadow-DOM composition and anything that needs a
 * real MediaSource are not exercisable in this app's `node` test environment,
 * and a jsdom stand-in for them would assert that our stubs work.
 */

const MEDIA = {} as HTMLMediaElement;
const FIRST = "https://cdn.example.com/first.mpd";
const SECOND = "https://cdn.example.com/second.mpd";

class FakePlayer implements ShakaPlayerHandle {
  readonly configs: EngineConfig[] = [];
  readonly attached: HTMLMediaElement[] = [];
  readonly loaded: string[] = [];
  readonly #listeners = new Map<string, Set<(event: unknown) => void>>();

  destroyCount = 0;
  unloadCount = 0;
  stats: RawEngineStats = {};
  loadImpl: (uri: string) => Promise<void> = () => Promise.resolve();
  attachImpl: () => Promise<void> = () => Promise.resolve();

  async attach(mediaElement: HTMLMediaElement): Promise<void> {
    await this.attachImpl();
    this.attached.push(mediaElement);
  }

  configure(config: EngineConfig): unknown {
    this.configs.push(config);
    return true;
  }

  async load(uri: string): Promise<void> {
    this.loaded.push(uri);
    await this.loadImpl(uri);
  }

  unload(): Promise<void> {
    this.unloadCount += 1;
    return Promise.resolve();
  }

  destroy(): Promise<void> {
    this.destroyCount += 1;
    return Promise.resolve();
  }

  getStats(): RawEngineStats {
    return this.stats;
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const set = this.#listeners.get(type) ?? new Set<(event: unknown) => void>();
    set.add(listener);
    this.#listeners.set(type, set);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.#listeners.get(type)?.delete(listener);
  }

  emit(type: string, event: unknown): void {
    for (const listener of [...(this.#listeners.get(type) ?? [])]) listener(event);
  }

  listenerCount(type: string): number {
    return this.#listeners.get(type)?.size ?? 0;
  }
}

const engineFor = (player: FakePlayer, supported = true): ShakaEngine => ({
  isBrowserSupported: () => supported,
  createPlayer: () => player
});

const loaderFor = (player: FakePlayer, supported = true): EngineLoader => () =>
  Promise.resolve(engineFor(player, supported));

/** A `shaka.util.Error` is a plain object and is NOT `instanceof Error`. */
const shakaError = (init: {
  severity: number;
  category: number;
  code: number;
  data?: readonly unknown[];
}): object => ({
  severity: init.severity,
  category: init.category,
  code: init.code,
  data: init.data ?? [],
  handled: false
});

/** Drain queued microtasks without depending on how many awaits deep they are. */
const flush = async (): Promise<void> => {
  for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
};

function collectErrors(sink: PlaybackError[]): (event: PlaybackControllerEvent) => void {
  return (event) => {
    if (event.type === "error") sink.push(event.error);
  };
}

describe("engine loading", () => {
  it("reports a rejected engine import as a state rather than an exception", async () => {
    const events: PlaybackControllerEvent[] = [];
    const controller = new PlaybackController({
      loadEngine: () => Promise.reject(new Error("blocked by client")),
      onEvent: (event) => events.push(event)
    });

    // The ad-blocker case. If this ever rejects, the caller is a lifecycle
    // callback and nobody is holding the promise.
    await expect(controller.attach(MEDIA)).resolves.toBeUndefined();

    const state = controller.getEngineState();
    expect(state.status).toBe("unavailable");
    if (state.status !== "unavailable") return;
    expect(state.reason).toBe("engine_load_failed");
    expect(state.error.message).toBe("blocked by client");
    expect(state.error.fatal).toBe(true);
    expect(events.filter((event) => event.type === "error")).toHaveLength(1);
  });

  it("reports an unsupported browser as a capability answer, not an error from the import", async () => {
    const controller = new PlaybackController({ loadEngine: loaderFor(new FakePlayer(), false) });
    await controller.attach(MEDIA);

    const state = controller.getEngineState();
    expect(state.status).toBe("unavailable");
    if (state.status !== "unavailable") return;
    expect(state.reason).toBe("browser_unsupported");
  });

  it("retries on the next attach instead of staying permanently dead", async () => {
    const player = new FakePlayer();
    let attempts = 0;
    const loadEngine: EngineLoader = () => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new Error("transient"))
        : Promise.resolve(engineFor(player));
    };

    const controller = new PlaybackController({ loadEngine });
    await controller.attach(MEDIA);
    await controller.attach(MEDIA);

    expect(attempts).toBe(2);
    expect(controller.getEngineState().status).toBe("ready");
  });

  it("loads the engine once for concurrent callers", async () => {
    const player = new FakePlayer();
    let attempts = 0;
    const controller = new PlaybackController({
      loadEngine: () => {
        attempts += 1;
        return Promise.resolve(engineFor(player));
      }
    });

    await Promise.all([controller.attach(MEDIA), controller.setSource({ uri: FIRST })]);
    expect(attempts).toBe(1);
  });
});

describe("engine configuration", () => {
  it("asserts sequenceMode: false for both DASH and HLS before anything else", async () => {
    const player = new FakePlayer();
    const controller = new PlaybackController({ loadEngine: loaderFor(player) });
    await controller.attach(MEDIA);

    /*
     * Explicit rather than inherited. It is the shipped default in Shaka 5.2.6
     * for both, but Shaka's own JSDoc for `manifest.hls.sequenceMode` still
     * claims the HLS default is `true` — so the documentation and the code
     * disagree and we should not be depending on which one wins.
     */
    expect(player.configs[0]).toEqual({
      manifest: { dash: { sequenceMode: false }, hls: { sequenceMode: false } }
    });
  });

  it("applies caller configuration after the baseline so it can override it", async () => {
    const player = new FakePlayer();
    const controller = new PlaybackController({ loadEngine: loaderFor(player) });

    controller.configure({ cmcd: { enabled: true } });
    await controller.attach(MEDIA);

    expect(player.configs).toHaveLength(2);
    expect(player.configs[1]).toEqual({ cmcd: { enabled: true } });
  });

  it("passes configuration straight through once a player exists", async () => {
    const player = new FakePlayer();
    const controller = new PlaybackController({ loadEngine: loaderFor(player) });

    await controller.attach(MEDIA);
    controller.configure({ abr: { enabled: false } });

    expect(player.configs).toHaveLength(2);
    expect(player.configs[1]).toEqual({ abr: { enabled: false } });
  });
});

describe("teardown", () => {
  it("destroys the player and unsubscribes from it", async () => {
    const player = new FakePlayer();
    const controller = new PlaybackController({ loadEngine: loaderFor(player) });

    await controller.attach(MEDIA);
    expect(player.listenerCount("error")).toBe(1);

    await controller.destroy();

    expect(player.destroyCount).toBe(1);
    expect(player.listenerCount("error")).toBe(0);
    expect(controller.getEnginePlayer()).toBeNull();
    expect(controller.getEngineState().status).toBe("destroyed");
  });

  it("destroys a player that was created while teardown was already running", async () => {
    // The leak this guards: the dynamic import resolves after unmount, a Player
    // is constructed, and nothing owns it — so it keeps its networking engine,
    // its buffers and its CDM session alive, and keeps making requests.
    const player = new FakePlayer();
    let controller!: PlaybackController;
    const engine: ShakaEngine = {
      isBrowserSupported: () => true,
      createPlayer: () => {
        void controller.destroy();
        return player;
      }
    };

    controller = new PlaybackController({ loadEngine: () => Promise.resolve(engine) });
    await controller.attach(MEDIA);
    await flush();

    expect(player.destroyCount).toBe(1);
    expect(player.listenerCount("error")).toBe(0);
    expect(player.attached).toEqual([]);
  });

  it("is idempotent and stops accepting work afterwards", async () => {
    const player = new FakePlayer();
    const controller = new PlaybackController({ loadEngine: loaderFor(player) });

    await controller.attach(MEDIA);
    await controller.destroy();
    await controller.destroy();
    await controller.setSource({ uri: FIRST });

    expect(player.destroyCount).toBe(1);
    expect(player.loaded).toEqual([]);
  });
});

describe("error surfacing", () => {
  it("wires both routes: a rejected load() and the error event afterwards", async () => {
    const player = new FakePlayer();
    const errors: PlaybackError[] = [];
    const controller = new PlaybackController({
      loadEngine: loaderFor(player),
      onEvent: collectErrors(errors)
    });

    player.loadImpl = () =>
      Promise.reject(shakaError({ severity: 2, category: 4, code: 4001 }));

    await controller.attach(MEDIA);
    await controller.setSource({ uri: FIRST });

    // Route one: a manifest that never parses only ever arrives this way.
    expect(errors).toHaveLength(1);
    expect(errors[0]?.origin).toBe("manifest-load");
    expect(errors[0]?.severity).toBe("critical");
    expect(errors[0]?.fatal).toBe(true);

    // Route two: a segment failing mid-playback only ever arrives this way, and
    // a recoverable one must not read as the end of the session.
    player.emit("error", { detail: shakaError({ severity: 1, category: 1, code: 1002 }) });

    expect(errors).toHaveLength(2);
    expect(errors[1]?.origin).toBe("player-event");
    expect(errors[1]?.severity).toBe("recoverable");
    expect(errors[1]?.fatal).toBe(false);
    expect(controller.getEngineState().status).toBe("ready");
  });

  it("does not report the LOAD_INTERRUPTED a second source causes", async () => {
    const player = new FakePlayer();
    const errors: PlaybackError[] = [];
    let controller!: PlaybackController;

    player.loadImpl = (uri) => {
      if (uri !== FIRST) return Promise.resolve();
      // A second candidate is chosen while the first is still loading. Shaka
      // rejects the superseded call; that is our own control flow, not a fault.
      void controller.setSource({ uri: SECOND });
      return Promise.reject(shakaError({ severity: 2, category: 7, code: 7000 }));
    };

    controller = new PlaybackController({
      loadEngine: loaderFor(player),
      onEvent: collectErrors(errors)
    });

    await controller.attach(MEDIA);
    await controller.setSource({ uri: FIRST });
    await flush();

    expect(errors).toEqual([]);
    expect(player.loaded).toEqual([FIRST, SECOND]);
  });

  it("keeps a listener that throws from breaking the session", async () => {
    const player = new FakePlayer();
    const controller = new PlaybackController({
      loadEngine: loaderFor(player),
      onEvent: () => {
        throw new Error("subscriber is broken");
      }
    });

    await expect(controller.attach(MEDIA)).resolves.toBeUndefined();
    expect(controller.getEngineState().status).toBe("ready");
  });
});

describe("source handling", () => {
  it("refuses a source that is not served over https", async () => {
    const player = new FakePlayer();
    const errors: PlaybackError[] = [];
    const controller = new PlaybackController({
      loadEngine: loaderFor(player),
      onEvent: collectErrors(errors)
    });

    await controller.attach(MEDIA);
    await controller.setSource({ uri: "http://cdn.example.com/insecure.mpd" });

    expect(player.loaded).toEqual([]);
    expect(errors[0]?.origin).toBe("source-rejected");
  });

  it("unloads rather than loading when the source is cleared", async () => {
    const player = new FakePlayer();
    const controller = new PlaybackController({ loadEngine: loaderFor(player) });

    await controller.attach(MEDIA);
    await controller.setSource(null);

    expect(player.unloadCount).toBe(1);
    expect(player.loaded).toEqual([]);
    expect(controller.getSource()).toBeNull();
  });
});

describe("stats seam", () => {
  it("has no stats before a player exists", () => {
    const controller = new PlaybackController({ loadEngine: loaderFor(new FakePlayer()) });
    expect(controller.getPlaybackStats()).toBeNull();
    expect(controller.getRawEngineStats()).toBeNull();
  });

  it("normalises units and leaves the raw object untouched", async () => {
    const player = new FakePlayer();
    player.stats = { loadLatency: 0.25, timeToFirstFrame: 1.5, droppedFrames: Number.NaN };

    const controller = new PlaybackController({ loadEngine: loaderFor(player) });
    await controller.attach(MEDIA);

    expect(controller.getPlaybackStats()?.loadLatencyMs).toBe(250);
    expect(controller.getPlaybackStats()?.timeToFirstFrameMs).toBe(1500);
    expect(controller.getPlaybackStats()?.droppedFrames).toBeNull();
    expect(controller.getRawEngineStats()).toBe(player.stats);
  });
});
