/* -------------------------------------------------------------------------
 * The shipped answer is "no licensed feed", and that is asserted rather than
 * assumed (Wave 132, Worker E).
 * ---------------------------------------------------------------------- */
import { describe, expect, it, beforeEach } from "vitest";

import {
  LIVE_FEED_NOT_CONFIGURED_REASON,
  clearRegisteredLiveFeed,
  registerLiveFeed,
  registeredLiveFeed,
  resolveLiveFeed,
  type RegisteredLiveFeed
} from "./feed-configuration";
import { sourceWithoutComments } from "./testing/fixtures";

const FEED: RegisteredLiveFeed = {
  label: "Synthetic Test Provider",
  playlistText: '#EXTM3U\n#EXTINF:-1 tvg-id="a.example",A\nhttps://edge.example.invalid/a\n',
  epgText: null,
  authorization: {
    providerId: "synthetic-test-provider",
    declaredOrigins: ["edge.example.invalid"],
    channelRights: { "a.example": "licensed" }
  }
};

beforeEach(() => {
  clearRegisteredLiveFeed();
});

describe("registration, not discovery", () => {
  it("reads no environment variable, no file and no credential", () => {
    const source = sourceWithoutComments(new URL("./feed-configuration.ts", import.meta.url));
    for (const forbidden of ["process.env", "node:fs", "readFile", "fetch(", "require("]) {
      expect(source, `must not reach ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("imports no fixture, in any environment", () => {
    const source = sourceWithoutComments(new URL("./feed-configuration.ts", import.meta.url));
    expect(source).not.toContain("fixtures");
    expect(source).not.toContain("media/");
  });
});

describe("the shipped configuration", () => {
  it("has no feed registered, so /live says so", () => {
    expect(registeredLiveFeed()).toBeNull();
    const resolution = resolveLiveFeed();
    expect(resolution.status).toBe("not-configured");
    if (resolution.status === "not-configured") {
      expect(resolution.reason).toBe(LIVE_FEED_NOT_CONFIGURED_REASON);
      expect(resolution.detail).toContain("PL-0602");
    }
  });
});

describe("a registered feed", () => {
  it("resolves as configured once registered, and stops when cleared", () => {
    registerLiveFeed(FEED);
    expect(resolveLiveFeed().status).toBe("configured");
    clearRegisteredLiveFeed();
    expect(resolveLiveFeed().status).toBe("not-configured");
  });

  it("can be passed explicitly without touching process state", () => {
    expect(resolveLiveFeed(FEED).status).toBe("configured");
    expect(registeredLiveFeed()).toBeNull();
  });

  it("is NOT configured when it declared no origin, because it would admit nothing", () => {
    const resolution = resolveLiveFeed({
      ...FEED,
      authorization: { ...FEED.authorization, declaredOrigins: [] }
    });
    expect(resolution.status).toBe("not-configured");
    if (resolution.status === "not-configured") {
      expect(resolution.detail).toContain("without declaring any origin");
    }
  });

  it("is NOT configured when it states a rights basis for no channel", () => {
    const resolution = resolveLiveFeed({
      ...FEED,
      authorization: { ...FEED.authorization, channelRights: {} }
    });
    expect(resolution.status).toBe("not-configured");
    if (resolution.status === "not-configured") {
      expect(resolution.detail).toContain("without a rights basis");
    }
  });

  it("carries supplied TEXT rather than a URL to fetch", () => {
    /* The adapter that proved authorization is what opened the connection; by
     * the time the presentation layer has a feed there is nothing left to fetch. */
    expect(typeof FEED.playlistText).toBe("string");
    expect("playlistUrl" in FEED).toBe(false);
    expect("epgUrl" in FEED).toBe(false);
  });
});
