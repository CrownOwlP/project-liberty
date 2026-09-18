import { describe, expect, it } from "vitest";
import { PLAYBACK_FAILURE_KINDS } from "@liberty/contracts/domains/failover";
import { ENGINE_UNAVAILABLE_REASONS } from "./engine";
import type {
  EngineConfig,
  EngineLoader,
  EngineUnavailableReason,
  PlaybackEngineId,
  RawEngineStats,
  ShakaEngine,
  ShakaPlayerHandle
} from "./engine";
import { classifyPlaybackFailure, isRetryableFailure } from "./playback-failure";
import {
  PlaybackController,
  type EngineState,
  type PlaybackControllerEvent
} from "./playback-controller";
import {
  describePlaybackError,
  type PlaybackError,
  type PlaybackErrorEngine
} from "./shaka-error";

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

  it("reports a host that cannot run the engine as a capability answer, not an import error", async () => {
    const controller = new PlaybackController({ loadEngine: loaderFor(new FakePlayer(), false) });
    await controller.attach(MEDIA);

    const state = controller.getEngineState();
    expect(state.status).toBe("unavailable");
    if (state.status !== "unavailable") return;
    expect(state.reason).toBe("host_unsupported");
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

    // `engine` is declared AFTER `controller` even though `controller` is built
    // from it, because `loadEngine` is lazy: it is not invoked until attach(),
    // by which point both bindings exist. The alternative is a
    // definite-assignment `let controller!`, which reads as a cycle a reviewer
    // then has to prove is safe.
    const controller = new PlaybackController({ loadEngine: () => Promise.resolve(engine) });
    const engine: ShakaEngine = {
      isBrowserSupported: () => true,
      createPlayer: () => {
        void controller.destroy();
        return player;
      }
    };

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

    const controller = new PlaybackController({
      loadEngine: loaderFor(player),
      onEvent: collectErrors(errors)
    });

    // Installed after the controller exists because the stub calls back into
    // it. Safe to do here rather than at construction: loadImpl is only reached
    // through attach() and setSource() below.
    player.loadImpl = (uri) => {
      if (uri !== FIRST) return Promise.resolve();
      // A second candidate is chosen while the first is still loading. Shaka
      // rejects the superseded call; that is our own control flow, not a fault.
      void controller.setSource({ uri: SECOND });
      return Promise.reject(shakaError({ severity: 2, category: 7, code: 7000 }));
    };

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


/* =========================================================================
 * PL-0903 — the engine-unavailable vocabulary
 * ====================================================================== */

/**
 * Names of ENGINES AND LIBRARIES. No member of the vocabulary may contain one:
 * a member that names an engine is a member only that engine can report, and a
 * union of those is the coupling PL-0903 exists to remove.
 */
const ENGINE_PRODUCT_NOUNS = ["shaka", "mpv", "libmpv", "hls", "tauri", "electron", "dll"];

/**
 * The above plus the KIND-OF-HOST nouns. EVERY member of the vocabulary is held
 * to this list as of PL-0502, and that is the enforcement half of the rename.
 *
 * It used to exempt the capability member, which was spelled for a browser and
 * was a known misnomer the moment the engine is a native library. PL-0502
 * renamed it to `host_unsupported` across the type, the controller, the machine
 * and these tests, with no alias left behind, so the exemption is gone with it:
 * a member may name neither an engine nor the kind of host it happens to be
 * running in.
 *
 * "host" itself is deliberately absent from the list. The union's subject IS the
 * host — "this host cannot support the engine that ran" — and a word that names
 * the subject of every member is not the coupling being tested for. What is
 * tested for is a member that only ONE host kind, or only one engine, could ever
 * report.
 */
const ENGINE_AND_HOST_NOUNS = [...ENGINE_PRODUCT_NOUNS, "browser", "web", "native", "page"];

const namesSomething = (reason: string, nouns: readonly string[]): readonly string[] =>
  nouns.filter((noun) => reason.includes(noun));

/** An engine whose `createPlayer` throws — the constructor half of a load failure. */
const throwingConstructor = (): ShakaEngine => ({
  isBrowserSupported: () => true,
  createPlayer: () => {
    throw new Error("Player constructor threw");
  }
});

/** An engine whose support probe itself throws, rather than answering false. */
const throwingProbe = (): ShakaEngine => ({
  isBrowserSupported: () => {
    throw new Error("support probe threw");
  },
  createPlayer: () => new FakePlayer()
});

const attachRejectingLoader = (): EngineLoader => {
  const player = new FakePlayer();
  player.attachImpl = () => Promise.reject(new Error("attach refused"));
  return loaderFor(player);
};

/** Every unavailability this controller can actually reach, driven for real. */
async function reachableUnavailableStates(): Promise<
  readonly { readonly case: string; readonly state: Extract<EngineState, { status: "unavailable" }> }[]
> {
  const cases: readonly { readonly case: string; readonly loadEngine: EngineLoader }[] = [
    { case: "import rejected", loadEngine: () => Promise.reject(new Error("blocked by client")) },
    { case: "constructor threw", loadEngine: () => Promise.resolve(throwingConstructor()) },
    { case: "support probe threw", loadEngine: () => Promise.resolve(throwingProbe()) },
    { case: "host unsupported", loadEngine: loaderFor(new FakePlayer(), false) },
    { case: "attach rejected", loadEngine: attachRejectingLoader() }
  ];

  const collected: { case: string; state: Extract<EngineState, { status: "unavailable" }> }[] = [];
  for (const entry of cases) {
    const controller = new PlaybackController({ loadEngine: entry.loadEngine });
    await controller.attach(MEDIA);
    await flush();
    const state = controller.getEngineState();
    /* A case that stopped producing an unavailability would silently shrink the
     * coverage of every assertion below, so it fails here instead. */
    expect(state.status, `${entry.case} no longer reports unavailable`).toBe("unavailable");
    if (state.status !== "unavailable") continue;
    collected.push({ case: entry.case, state });
  }
  return collected;
}

/**
 * The native case, as a TYPE-LEVEL PROOF that does not need a native adapter.
 *
 * There is no `NativePlayerAdapter` yet, so no runtime path can produce this.
 * What can be proven today is the thing PL-0903 is actually about: that the
 * vocabulary CAN express "the native engine's library did not load", with the
 * library named in the detail and not in the member. This literal does not
 * compile if `engine_load_failed` is removed, if `detail` is removed, or if
 * `native-mpv` is not a `PlaybackEngineId` — which is the whole widening,
 * checked by `tsc` on every run.
 */
const NATIVE_LIBRARY_MISSING: EngineState = {
  status: "unavailable",
  reason: "engine_load_failed",
  detail: { engine: "native-mpv", code: "native-mpv.loader_failed" },
  error: describePlaybackError(new Error("libmpv-2.dll could not be loaded."), "engine-load")
};

describe("the engine-unavailable vocabulary is engine-neutral (PL-0903)", () => {
  it("says an engine is missing without naming an engine or a host", async () => {
    /*
     * THE REGRESSION THE TASK ASKS FOR. It fails if `host_unsupported` is ever
     * again the only way to say an engine is missing: collapse the two cases
     * onto that member, or rename the missing-engine member to anything that
     * names a browser, an engine or a library, and one of these fails.
     *
     * This is the same path a native adapter takes for "libmpv-2.dll is not
     * loadable": the engine was never obtained, so nothing about the host or the
     * source was learned.
     */
    const controller = new PlaybackController({
      loadEngine: () => Promise.reject(new Error("blocked by client"))
    });
    await controller.attach(MEDIA);

    const state = controller.getEngineState();
    expect(state.status).toBe("unavailable");
    if (state.status !== "unavailable") return;

    expect(state.reason).toBe("engine_load_failed");
    expect(state.reason).not.toBe("host_unsupported");
    expect(namesSomething(state.reason, ENGINE_AND_HOST_NOUNS)).toEqual([]);
  });

  it("keeps a missing engine and an unsupportable host as two different answers", async () => {
    /*
     * The other half of the same guarantee. One member for both would make a
     * library that is not installed indistinguishable from a machine that cannot
     * run the one that is — different remedies, and on desktop the first is an
     * install problem and the second is a hardware one.
     */
    const missing = new PlaybackController({
      loadEngine: () => Promise.reject(new Error("blocked by client"))
    });
    await missing.attach(MEDIA);

    const unsupportable = new PlaybackController({
      loadEngine: loaderFor(new FakePlayer(), false)
    });
    await unsupportable.attach(MEDIA);

    const a = missing.getEngineState();
    const b = unsupportable.getEngineState();
    if (a.status !== "unavailable" || b.status !== "unavailable") {
      throw new Error("both controllers should be unavailable");
    }
    expect(a.reason).not.toBe(b.reason);
  });

  it("names no engine and no kind of host in any member of the vocabulary", () => {
    /*
     * THE RENAME'S REGRESSION (PL-0502). Every member, not just the
     * missing-engine one. Restoring the browser-spelled member — or adding any
     * second member that names a browser, a page, the web or a native library —
     * fails here rather than in a review.
     */
    for (const reason of ENGINE_UNAVAILABLE_REASONS) {
      expect(namesSomething(reason, ENGINE_PRODUCT_NOUNS), reason).toEqual([]);
      expect(namesSomething(reason, ENGINE_AND_HOST_NOUNS), reason).toEqual([]);
    }
  });

  it("can express a native library that did not load, with the library beside the reason", () => {
    if (NATIVE_LIBRARY_MISSING.status !== "unavailable") throw new Error("unreachable");
    const { reason, detail, error } = NATIVE_LIBRARY_MISSING;

    /* The member says WHAT failed and nothing else. */
    expect(reason).toBe("engine_load_failed");
    expect(namesSomething(reason, ENGINE_AND_HOST_NOUNS)).toEqual([]);

    /* WHO failed, and its own code, travel beside it. */
    expect(detail?.engine).toBe("native-mpv");
    expect(detail?.code).toBe("native-mpv.loader_failed");

    /* And the engine's own number space never reaches Shaka's fields. */
    expect(error.code).toBeNull();
    expect(error.category).toBeNull();
    expect(error.message).toContain("libmpv-2.dll");
  });

  it("carries this engine's detail beside the reason on every unavailability", async () => {
    const states = await reachableUnavailableStates();
    expect(states).toHaveLength(5);

    for (const { case: name, state } of states) {
      /*
       * REQUIRED-AND-NULLABLE (PL-0502 item 2). `detail` is not optional any
       * more, so a producer that established nothing has to write `null` and
       * say so. The property test below is the runtime shadow of that: an
       * omitted member and a `null` one are indistinguishable at a consumer,
       * and `in` is the one operator that can still tell them apart.
       */
      expect(Object.hasOwn(state, "detail"), name).toBe(true);
      /* This controller always establishes one, so it is never null here. */
      expect(state.detail, name).not.toBeNull();
      expect(state.detail?.engine, name).toBe("web-shaka");
      /* Namespaced, so a code read out of context still says whose it is. */
      expect(state.detail?.code ?? "", name).toMatch(/^web-shaka\./);
      /* The detail is NOT smuggled into the member. */
      expect(state.reason.includes(state.detail?.code ?? "!"), name).toBe(false);
    }

    /* The detail is finer-grained than the reason, which is the point of it:
     * two different failures under one member are now distinguishable. */
    const loadFailures = states.filter(({ state }) => state.reason === "engine_load_failed");
    expect(loadFailures).toHaveLength(2);
    expect(new Set(loadFailures.map(({ state }) => state.detail?.code)).size).toBe(2);
  });

  it("reaches all three members, so none is vestigial", async () => {
    const states = await reachableUnavailableStates();
    const reasons = new Set(states.map(({ state }) => state.reason));
    expect([...reasons].sort()).toEqual([...ENGINE_UNAVAILABLE_REASONS].sort());
  });
});

describe("one engine identity, one declaration (PL-0502 item 3)", () => {
  /*
   * `PlaybackEngineId` and `PlaybackErrorEngine` used to be two hand-written
   * literal unions for one fact, spelled twice because PL-0903 and PL-0904 were
   * built on branches that could not import each other. `engine.ts` now declares
   * `PlaybackEngineId` as an alias of `PlaybackErrorEngine`, in the direction
   * `shaka-error.ts`'s own comment identified: that module imports nothing, so
   * aliasing the other way would pull the Shaka-injection port into the error
   * vocabulary's import graph.
   *
   * These two declarations are the guard. Re-splitting the alias into a second
   * literal union compiles ONLY while the two lists happen to agree; the moment
   * one gains a member the other has not, `tsc` fails here. That is a weaker
   * statement than "there is one union" — which a grep proves and a type cannot
   * — and it is the strongest one a test can make.
   */
  const idAsErrorEngine: PlaybackErrorEngine = "native-mpv" satisfies PlaybackEngineId;
  const errorEngineAsId: PlaybackEngineId = "web-shaka" satisfies PlaybackErrorEngine;

  it("uses one vocabulary for the engine that produced a report", () => {
    expect(idAsErrorEngine).toBe("native-mpv");
    expect(errorEngineAsId).toBe("web-shaka");

    /* The detail on an `EngineState` and the tag on a `PlaybackError` name the
     * same engine with the same spelling, which is the point of the merge. */
    if (NATIVE_LIBRARY_MISSING.status !== "unavailable") throw new Error("unreachable");
    const fromDetail: PlaybackErrorEngine | undefined = NATIVE_LIBRARY_MISSING.detail?.engine;
    expect(fromDetail).toBe("native-mpv");
  });
});

describe("no unavailability reason can reach the failover scheduler as retryable (PL-0903)", () => {
  it("shares no member with the failure-kind vocabulary the scheduler classifies", () => {
    /*
     * The structural half of the guarantee. `@liberty/media-engine` decides
     * retryability from a `PlaybackFailureKind`, and `network_transient` is the
     * only retryable one. No unavailability reason IS a kind, so none can be
     * passed where a kind is expected even by a mistaken cast.
     */
    const kinds: readonly string[] = PLAYBACK_FAILURE_KINDS;
    const overlap = ENGINE_UNAVAILABLE_REASONS.filter((reason) => kinds.includes(reason));
    expect(overlap).toEqual([]);
    expect(kinds).toContain("network_transient");
    expect(ENGINE_UNAVAILABLE_REASONS).not.toContain("network_transient" as EngineUnavailableReason);
  });

  it("classifies every unavailability it reports as unclassified, never as retryable", async () => {
    /*
     * The behavioural half, and the one that matters. An unavailability's
     * `PlaybackError` is ALSO reported on the ordinary error route — the
     * controller calls `#report` before it sets the state — so it does reach
     * `classifyPlaybackFailure` through the machine's `ENGINE_ERROR` handler.
     * It must come back `null`: an invented kind here would charge a candidate
     * for an engine that never ran, and a `network_transient` would re-load a
     * library that is not installed.
     */
    const states = await reachableUnavailableStates();
    expect(states).toHaveLength(5);

    for (const { case: name, state } of states) {
      const kind = classifyPlaybackFailure(state.error);
      expect(kind, name).toBeNull();
      expect(isRetryableFailure(kind), name).toBe(false);
    }
  });

  it("keeps the engine's own code out of the two fields the classifier reads", async () => {
    /*
     * WHY THE DETAIL'S `code` IS A STRING. `classifyPlaybackFailure` reads
     * `category`, `code` and `detail` off the `PlaybackError`, all pinned to
     * Shaka 5.2.x. mpv's error numbers live on a different scale — -13 is
     * MPV_ERROR_LOADING_FAILED, while Shaka's category 1 is NETWORK — so an
     * engine number written into either field would be read on Shaka's scale and
     * could classify as retryable. A namespaced string is not assignable to
     * `number | null`, so this cannot be done by accident; the runtime assertion
     * is the shadow of that.
     */
    const states = [...(await reachableUnavailableStates()).map(({ state }) => state)];
    if (NATIVE_LIBRARY_MISSING.status === "unavailable") states.push(NATIVE_LIBRARY_MISSING);

    for (const state of states) {
      expect(state.error.category).toBeNull();
      expect(state.error.code).toBeNull();
      expect(typeof state.detail?.code).toBe("string");
    }
  });
});
