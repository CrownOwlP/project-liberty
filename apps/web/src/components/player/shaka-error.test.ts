import { describe, expect, it } from "vitest";
import { decodeShakaErrorData, describePlaybackError, redactMediaUrl } from "./shaka-error";

/*
 * Fixtures are plain objects on purpose. `shaka.util.Error` does not extend
 * `Error` at runtime — Shaka says so in its own source and relies on it — so a
 * classifier that reaches for `instanceof` finds nothing.
 */
const shakaError = (
  severity: number,
  category: number,
  code: number,
  data: readonly unknown[] = []
): object => ({ severity, category, code, data, handled: false, message: `Shaka Error ${code}` });

describe("severity split", () => {
  it("treats CRITICAL as fatal and RECOVERABLE as not", () => {
    // Shaka retries a failed segment forever without ever raising CRITICAL, so
    // collapsing these two means giving up on a blip or never giving up at all.
    expect(describePlaybackError(shakaError(2, 4, 4001), "manifest-load")).toMatchObject({
      severity: "critical",
      fatal: true,
      categoryName: "MANIFEST"
    });
    expect(describePlaybackError(shakaError(1, 1, 1002), "player-event")).toMatchObject({
      severity: "recoverable",
      fatal: false,
      categoryName: "NETWORK"
    });
  });

  it("does not report our own interruptions as playback failures", () => {
    // LOAD_INTERRUPTED and OPERATION_ABORTED arrive with CRITICAL severity but
    // describe a second load() or an aborted operation — ours, not the stream's.
    for (const code of [7000, 7001]) {
      const error = describePlaybackError(shakaError(2, 7, code), "manifest-load");
      expect(error.aborted).toBe(true);
      expect(error.severity).toBe("critical");
      expect(error.fatal).toBe(false);
    }
  });

  it("treats an unclassifiable failure as fatal", () => {
    // The alternative leaves a caller retrying a session that will never work,
    // with no state that says so.
    const error = describePlaybackError(new TypeError("import failed"), "engine-load");
    expect(error.severity).toBe("unknown");
    expect(error.fatal).toBe(true);
    expect(error.code).toBeNull();
    expect(error.message).toBe("import failed");
  });

  it("survives values that are not errors at all", () => {
    expect(describePlaybackError(undefined, "engine-load").message).toBe(
      "Unclassified playback error."
    );
    expect(describePlaybackError("network down", "engine-load").message).toBe("network down");
    // A number is not a severity: a partial object must not be read as a Shaka
    // error and given someone else's error code.
    expect(describePlaybackError({ severity: 2 }, "engine-load").severity).toBe("unknown");
  });

  it("carries the origin so the two error routes stay distinguishable", () => {
    expect(describePlaybackError(shakaError(2, 4, 4001), "manifest-load").origin).toBe(
      "manifest-load"
    );
    expect(describePlaybackError(shakaError(2, 4, 4001), "player-event").origin).toBe(
      "player-event"
    );
  });
});

describe("positional error data", () => {
  /*
   * These slot numbers are the whole point of this test: they are pinned to
   * shaka-player 5.2.x, and an upgrade that moves them should fail here rather
   * than at four call sites reading whatever now lives in slot 1.
   */
  it("decodes BAD_HTTP_STATUS from slots 0, 1 and 5", () => {
    const detail = decodeShakaErrorData(1001, [
      "https://cdn.example.com/v/seg1.m4s?sig=secret",
      404,
      "Not Found",
      {},
      1,
      "https://edge.example.com/v/seg1.m4s?sig=secret"
    ]);

    expect(detail).toEqual({
      kind: "http-status",
      url: "https://cdn.example.com/v/seg1.m4s",
      status: 404,
      finalUrl: "https://edge.example.com/v/seg1.m4s"
    });
  });

  it("decodes the network, timeout and media-element shapes", () => {
    expect(decodeShakaErrorData(1002, ["https://cdn.example.com/a.mpd", new Error("x")])).toEqual({
      kind: "network",
      url: "https://cdn.example.com/a.mpd"
    });
    expect(decodeShakaErrorData(1003, ["https://cdn.example.com/a.mpd"])).toEqual({
      kind: "timeout",
      url: "https://cdn.example.com/a.mpd"
    });
    // Slot 0 here is a `MediaError.code` from the video element, not a Shaka
    // code: the two share a number space and mean different things.
    expect(decodeShakaErrorData(3016, [3, undefined, "decode error"])).toEqual({
      kind: "media-element",
      mediaErrorCode: 3
    });
  });

  it("returns null rather than guessing at a code it has not been taught", () => {
    expect(decodeShakaErrorData(6007, [{ code: 1001 }])).toBeNull();
    expect(decodeShakaErrorData(1001, undefined)).toBeNull();
    expect(describePlaybackError(shakaError(2, 6, 6007, ["x"]), "manifest-load").detail).toBeNull();
  });

  it("keeps a missing slot as null instead of as a number", () => {
    expect(decodeShakaErrorData(1001, ["https://cdn.example.com/a.mpd"])).toEqual({
      kind: "http-status",
      url: "https://cdn.example.com/a.mpd",
      status: null,
      finalUrl: null
    });
  });
});

describe("redactMediaUrl", () => {
  it("keeps the origin and path and drops the signed query string", () => {
    // An error object is the one place a credential travels without anyone
    // deciding to log it.
    expect(redactMediaUrl("https://cdn.example.com/a/b.mpd?Policy=x&Signature=y#f")).toBe(
      "https://cdn.example.com/a/b.mpd"
    );
  });

  it("returns null for anything it cannot parse rather than echoing it", () => {
    expect(redactMediaUrl("not a url")).toBeNull();
    expect(redactMediaUrl("")).toBeNull();
    expect(redactMediaUrl(404)).toBeNull();
    expect(redactMediaUrl(null)).toBeNull();
  });
});

/* -------------------------------------------------------------------------
 * PL-0904 — the engine axis
 *
 * Everything above this line predates PL-0904 and is UNCHANGED, including the
 * import on line 2. The engine axis was added beside the route axis rather than
 * on top of it precisely so that none of it had to move; if any assertion above
 * had needed editing, the design would have been changing the meaning of an
 * existing Shaka case, which is the thing this task may not do.
 * ---------------------------------------------------------------------- */

import {
  describeNativePlaybackError,
  type NativeMpvPlaybackError,
  type PlaybackError
} from "./shaka-error";

describe("the engine that produced the error", () => {
  it("names the web engine on every route through the Shaka normaliser", () => {
    // Including the routes where nothing Shaka-shaped arrived: the engine is a
    // claim about who produced the error, and `fault: null` is the separate
    // claim that no engine-numbered code came with it.
    expect(describePlaybackError(shakaError(2, 4, 4001), "manifest-load").engine).toBe("web-shaka");
    expect(describePlaybackError(new TypeError("import failed"), "engine-load")).toMatchObject({
      engine: "web-shaka",
      fault: null
    });
  });

  it("carries Shaka's numbering in a fault that only the web tag unlocks", () => {
    const error = describePlaybackError(shakaError(2, 6, 6007), "player-event");
    expect(error.fault).toEqual({ code: 6007, category: 6, categoryName: "DRM" });
    // The flat trio is a projection of the same three values, kept because
    // `summarisePlaybackError` reads them by name. It cannot disagree with the
    // fault because both are written from one source.
    expect(error.code).toBe(error.fault?.code ?? null);
    expect(error.category).toBe(error.fault?.category ?? null);
    expect(error.categoryName).toBe(error.fault?.categoryName ?? null);
  });

  it("keeps the route axis and the engine axis independent", () => {
    // The ruling PL-0903 asked for, made executable: one route, two engines,
    // and neither field says anything about the other. A single union would
    // have had to spell this pair as one member and would have lost the ability
    // to ask either question on its own.
    const web = describePlaybackError(shakaError(2, 1, 1002), "player-event");
    const native = describeNativePlaybackError({ reason: "error" }, "player-event");
    expect([web.origin, web.engine]).toEqual(["player-event", "web-shaka"]);
    expect([native.origin, native.engine]).toEqual(["player-event", "native-mpv"]);
    expect(describeNativePlaybackError({ reason: "error" }, "engine-load").origin).toBe(
      "engine-load"
    );
  });
});

describe("a native failure, without borrowing a Shaka number", () => {
  it("keeps every Shaka-numbered field null while keeping mpv's own value", () => {
    // THE WHOLE POINT. -13 is an `mpv_error`; 13 is not a Shaka category and
    // 1001 is. Neither may ever appear in `code` or `category`, because
    // `classifyPlaybackFailure`, the reason trail and every dashboard
    // downstream read those on shaka-player 5.2.x's scale.
    const error = describeNativePlaybackError({ reason: "error", mpvError: -13 }, "player-event");
    expect(error.code).toBeNull();
    expect(error.category).toBeNull();
    expect(error.categoryName).toBeNull();
    expect(error.fault).toEqual({ reason: "error", mpvError: -13 });
  });

  it("does not discard the diagnostic when there is no number at all", () => {
    const error = describeNativePlaybackError({ reason: "error" }, "player-event");
    expect(error.fault).toEqual({ reason: "error", mpvError: null });
    expect(error.message).toBe("mpv playback ended with an error (END_FILE error)");
    expect(
      describeNativePlaybackError({ reason: "error", mpvError: -13 }, "player-event").message
    ).toBe("mpv playback ended with an error (END_FILE error, mpv_error -13)");
  });

  it("treats END_FILE _STOP and _REDIRECT as our own control flow", () => {
    // Exactly as LOAD_INTERRUPTED is on the web path: a stop we issued and a
    // redirect we followed are not candidate failures, and charging one would
    // make every failover look like a fault caused by what it failed over to.
    for (const reason of ["stop", "redirect"] as const) {
      const error = describeNativePlaybackError({ reason }, "player-event");
      expect(error.aborted, reason).toBe(true);
      expect(error.fatal, reason).toBe(false);
    }

    const failed = describeNativePlaybackError({ reason: "error" }, "player-event");
    expect(failed.aborted).toBe(false);
    expect(failed.fatal).toBe(true);
  });

  it("reports a severity of unknown rather than inventing one libmpv never sent", () => {
    // mpv has no severity concept. "critical" would be a field we filled in on
    // its behalf, and `errorIsRecoverableWithinBudget` reads `fatal` anyway.
    expect(describeNativePlaybackError({ reason: "error" }, "player-event").severity).toBe(
      "unknown"
    );
  });

  it("carries an engine-neutral detail when the adapter has one", () => {
    // `detail` is the slot a classifier is allowed to act on, because every one
    // of its variants names a number space that belongs to neither engine.
    const error = describeNativePlaybackError(
      { reason: "error", detail: { kind: "timeout", url: "https://cdn.example.com/a.mkv" } },
      "player-event"
    );
    expect(error.detail).toEqual({ kind: "timeout", url: "https://cdn.example.com/a.mkv" });
    expect(describeNativePlaybackError({ reason: "error" }, "player-event").detail).toBeNull();
  });
});

describe("what the type system refuses, rather than what a comment asks for", () => {
  it("will not let an mpv number be written into the Shaka-numbered code", () => {
    const native = describeNativePlaybackError({ reason: "error", mpvError: -13 }, "player-event");
    const borrowed = { ...native, code: 1001 };
    // @ts-expect-error `code` on a native error is `null`, not `number | null`.
    const rejected: NativeMpvPlaybackError = borrowed;
    expect(rejected.engine).toBe("native-mpv");
  });

  it("will not build a playback error out of a clean end of file or a quit", () => {
    // DESKTOP_PLAYBACK.md §6 routes `_EOF` to MEDIA_ENDED and `_QUIT` to
    // ENGINE_STATE destroyed. `NativeFailureReason` is that routing table as a
    // type, so getting it wrong fails the build rather than charging the
    // attempt budget for a file that played to the end.
    // @ts-expect-error "eof" is not a NativeFailureReason.
    const eof = describeNativePlaybackError({ reason: "eof" }, "player-event");
    // @ts-expect-error "quit" is not a NativeFailureReason.
    const quit = describeNativePlaybackError({ reason: "quit" }, "player-event");
    expect([eof.engine, quit.engine]).toEqual(["native-mpv", "native-mpv"]);
  });

  it("will not let a caller read an engine code without narrowing first", () => {
    const errors: PlaybackError[] = [
      describePlaybackError(shakaError(2, 3, 3016), "player-event"),
      describeNativePlaybackError({ reason: "error", mpvError: -13 }, "player-event")
    ];

    const numbers = errors.map((error) => {
      // @ts-expect-error `fault` is a union: `code` exists on only one arm.
      const unnarrowed = error.fault?.code ?? null;
      void unnarrowed;
      return error.engine === "web-shaka" ? (error.fault?.code ?? null) : null;
    });

    expect(numbers).toEqual([3016, null]);
  });
});
