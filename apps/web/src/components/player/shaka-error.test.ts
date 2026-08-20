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
