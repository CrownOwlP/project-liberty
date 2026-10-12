/* Decoding capability (W132-D item 7). Fakes stand in for both APIs, so every
 * failure mode a WebView2 build can present is reachable with no browser. */
import { describe, expect, it, vi } from "vitest";

import {
  type DecodeProbe,
  type DecodeQuery,
  decodingConfiguration,
  describeDecodeCapability,
  detectDecodeCapability,
  probeFromGlobals,
  unknownDecodeCapability
} from "./decode-capability";

const QUERY: DecodeQuery = {
  contentType: 'video/mp4; codecs="avc1.640028"',
  widthPixels: 1280,
  heightPixels: 720,
  bitrateBitsPerSecond: 3_000_000,
  framesPerSecond: 24
};

describe("no probe at all", () => {
  it("is unknown, with a source of none and no invented booleans", async () => {
    const capability = await detectDecodeCapability(QUERY, null);
    expect(capability.conclusion).toBe("unknown");
    expect(capability.source).toBe("none");
    expect(capability.supported).toBeNull();
    expect(capability.smooth).toBeNull();
    expect(capability.powerEfficient).toBeNull();
  });

  it("is the same value `unknownDecodeCapability` exposes for a server render", async () => {
    expect(await detectDecodeCapability(QUERY, null)).toEqual(unknownDecodeCapability());
  });

  it("is unknown for a probe object with neither member", async () => {
    expect((await detectDecodeCapability(QUERY, {})).conclusion).toBe("unknown");
  });
});

describe("MediaCapabilities, read literally", () => {
  const probeWith = (info: Record<string, unknown>): DecodeProbe => ({
    decodingInfo: async () => info
  });

  it("reports power efficiency as REPORTED, never as hardware decoding", async () => {
    const capability = await detectDecodeCapability(
      QUERY,
      probeWith({ supported: true, smooth: true, powerEfficient: true })
    );
    expect(capability.conclusion).toBe("power_efficient_reported");
    expect(capability.source).toBe("media-capabilities");
    expect(capability.powerEfficient).toBe(true);
    expect(capability.reason).toContain("not evidence of a hardware decoder");
  });

  it("distinguishes an explicit false from an absent efficiency claim", async () => {
    expect(
      (await detectDecodeCapability(QUERY, probeWith({ supported: true, powerEfficient: false })))
        .conclusion
    ).toBe("not_power_efficient_reported");
    expect(
      (await detectDecodeCapability(QUERY, probeWith({ supported: true }))).conclusion
    ).toBe("supported_efficiency_unknown");
  });

  it("does not read a non-boolean efficiency as a claim", async () => {
    const capability = await detectDecodeCapability(
      QUERY,
      probeWith({ supported: true, powerEfficient: "yes" })
    );
    expect(capability.conclusion).toBe("supported_efficiency_unknown");
    expect(capability.powerEfficient).toBeNull();
  });

  it("reports unsupported when the API says so, and carries the raw fields", async () => {
    const capability = await detectDecodeCapability(
      QUERY,
      probeWith({ supported: false, smooth: false, powerEfficient: false })
    );
    expect(capability.conclusion).toBe("unsupported");
    expect(capability.supported).toBe(false);
  });

  it("keeps `smooth` verbatim and never promotes it to a conclusion", async () => {
    const capability = await detectDecodeCapability(
      QUERY,
      probeWith({ supported: true, smooth: false, powerEfficient: true })
    );
    expect(capability.smooth).toBe(false);
    expect(capability.conclusion).toBe("power_efficient_reported");
  });
});

describe("MediaCapabilities failures degrade rather than lie", () => {
  it("falls back to canPlayType when decodingInfo rejects", async () => {
    const capability = await detectDecodeCapability(QUERY, {
      decodingInfo: async () => {
        throw new TypeError("illegal invocation");
      },
      canPlayType: () => "probably"
    });
    expect(capability.conclusion).toBe("supported_efficiency_unknown");
    expect(capability.source).toBe("can-play-type");
  });

  it("falls back when decodingInfo throws synchronously", async () => {
    /* A member that throws SYNCHRONOUSLY rather than rejecting: Chromium's
     * illegal-invocation TypeError arrives this way. Typed through
     * `NonNullable` so the double is a real implementation of the optional
     * member and not a cast that hides a mismatch. */
    const throwing: NonNullable<DecodeProbe["decodingInfo"]> = () => {
      throw new TypeError("sync throw");
    };
    const capability = await detectDecodeCapability(QUERY, {
      decodingInfo: throwing,
      canPlayType: () => "maybe"
    });
    expect(capability.source).toBe("can-play-type");
  });

  it("is unknown — not unsupported — when decodingInfo rejects and nothing else answers", async () => {
    const capability = await detectDecodeCapability(QUERY, {
      decodingInfo: async () => {
        throw new Error("no");
      }
    });
    expect(capability.conclusion).toBe("unknown");
    expect(capability.reason).toContain("did not answer");
  });

  it("falls through rather than reading a malformed result as a yes or a no", async () => {
    const capability = await detectDecodeCapability(QUERY, {
      decodingInfo: async () => ({ supported: "true" }) as never,
      canPlayType: () => ""
    });
    expect(capability.conclusion).toBe("unsupported");
    expect(capability.source).toBe("can-play-type");
  });

  it("never rejects, whatever the probe does", async () => {
    await expect(
      detectDecodeCapability(QUERY, {
        decodingInfo: async () => {
          throw new Error("boom");
        },
        canPlayType: () => {
          throw new Error("boom");
        }
      })
    ).resolves.toMatchObject({ conclusion: "unknown" });
  });
});

describe("canPlayType is a fallback and is never promoted", () => {
  it.each(["probably", "maybe"])("reads %p as decodable with no efficiency claim", async (answer) => {
    const capability = await detectDecodeCapability(QUERY, { canPlayType: () => answer });
    expect(capability.conclusion).toBe("supported_efficiency_unknown");
    expect(capability.powerEfficient).toBeNull();
    expect(capability.smooth).toBeNull();
  });

  it("reads the empty string as unsupported", async () => {
    expect((await detectDecodeCapability(QUERY, { canPlayType: () => "" })).conclusion).toBe(
      "unsupported"
    );
  });

  it.each(["yes", "no", "PROBABLY", "1"])(
    "treats the non-standard answer %p as unknown rather than a yes",
    async (answer) => {
      expect((await detectDecodeCapability(QUERY, { canPlayType: () => answer })).conclusion).toBe(
        "unknown"
      );
    }
  );

  it("is not consulted when decodingInfo answered, so the two are never merged", async () => {
    const canPlayType = vi.fn(() => "probably");
    const capability = await detectDecodeCapability(QUERY, {
      decodingInfo: async () => ({ supported: false }),
      canPlayType
    });
    expect(capability.conclusion).toBe("unsupported");
    expect(canPlayType).not.toHaveBeenCalled();
  });
});

describe("the configuration handed to decodingInfo", () => {
  it("is a media-source video configuration with the query's values", () => {
    const configuration = decodingConfiguration(QUERY) as {
      type: string;
      video: Record<string, unknown>;
    };
    expect(configuration.type).toBe("media-source");
    expect(configuration.video.contentType).toBe(QUERY.contentType);
    expect(configuration.video.width).toBe(1280);
    expect(configuration.video.framerate).toBe(24);
  });

  it("repairs the values the spec rejects, so a bad ask is not read as unsupported", () => {
    const configuration = decodingConfiguration({
      contentType: "video/mp4",
      widthPixels: 0,
      heightPixels: -4,
      bitrateBitsPerSecond: 0,
      framesPerSecond: 0
    }) as { video: Record<string, number> };
    expect(configuration.video.width).toBeGreaterThan(0);
    expect(configuration.video.height).toBeGreaterThan(0);
    expect(configuration.video.bitrate).toBeGreaterThan(0);
    expect(configuration.video.framerate).toBeGreaterThan(0);
  });

  it("rounds fractional dimensions, which the spec requires to be integers", () => {
    const configuration = decodingConfiguration({ ...QUERY, widthPixels: 1279.6 }) as {
      video: Record<string, number>;
    };
    expect(Number.isInteger(configuration.video.width)).toBe(true);
  });
});

describe("probeFromGlobals touches nothing it has not checked", () => {
  it("answers null in this environment, which has no navigator media capabilities", () => {
    /* `environment: "node"`: no `document`, and `navigator` without
     * `mediaCapabilities`. The point of the assertion is that it does not throw. */
    expect(() => probeFromGlobals()).not.toThrow();
    expect(probeFromGlobals()).toBeNull();
  });

  it("binds decodingInfo to its owner, so the call is not an illegal invocation", async () => {
    const mediaCapabilities = {
      calls: 0,
      decodingInfo(this: { calls: number }) {
        if (this === undefined || typeof this.calls !== "number") {
          throw new TypeError("Illegal invocation");
        }
        this.calls += 1;
        return Promise.resolve({ supported: true, powerEfficient: true });
      }
    };
    vi.stubGlobal("navigator", { mediaCapabilities });
    try {
      const probe = probeFromGlobals();
      expect(probe).not.toBeNull();
      const capability = await detectDecodeCapability(QUERY, probe);
      expect(capability.conclusion).toBe("power_efficient_reported");
      expect(mediaCapabilities.calls).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("ignores a mediaCapabilities without a decodingInfo function", () => {
    vi.stubGlobal("navigator", { mediaCapabilities: { decodingInfo: "nope" } });
    try {
      expect(probeFromGlobals()).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("survives a navigator whose property getter throws", () => {
    vi.stubGlobal("navigator", {
      get mediaCapabilities() {
        throw new TypeError("stripped webview");
      }
    });
    try {
      expect(() => probeFromGlobals()).not.toThrow();
      expect(probeFromGlobals()).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("survives a document whose createElement throws, keeping any decodingInfo it found", () => {
    vi.stubGlobal("navigator", { mediaCapabilities: { decodingInfo: async () => ({}) } });
    vi.stubGlobal("document", {
      createElement() {
        throw new TypeError("no elements here");
      }
    });
    try {
      const probe = probeFromGlobals();
      expect(probe?.decodingInfo).toBeTypeOf("function");
      expect(probe?.canPlayType).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("picks up canPlayType from a created element when that is all there is", () => {
    vi.stubGlobal("document", {
      createElement: () => ({ canPlayType: (type: string) => (type ? "probably" : "") })
    });
    try {
      const probe = probeFromGlobals();
      expect(probe?.canPlayType?.("video/mp4")).toBe("probably");
      expect(probe?.decodingInfo).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("the panel line never claims a hardware decoder", () => {
  const conclusions = [
    "unknown",
    "unsupported",
    "supported_efficiency_unknown",
    "power_efficient_reported",
    "not_power_efficient_reported"
  ] as const;

  it.each(conclusions)("says nothing about hardware for %s", (conclusion) => {
    const line = describeDecodeCapability({
      conclusion,
      source: "media-capabilities",
      supported: null,
      smooth: null,
      powerEfficient: null,
      reason: ""
    });
    expect(line.toLowerCase()).not.toContain("hardware");
    expect(line.toLowerCase()).not.toContain("gpu");
    expect(line.toLowerCase()).not.toContain("accelerat");
    expect(line.length).toBeGreaterThan(0);
  });

  it("attributes the only efficiency claim it makes to the browser", () => {
    const line = describeDecodeCapability({
      conclusion: "power_efficient_reported",
      source: "media-capabilities",
      supported: true,
      smooth: true,
      powerEfficient: true,
      reason: ""
    });
    expect(line).toContain("the browser reports");
  });

  it("says unknown out loud rather than hedging into a yes", () => {
    const line = describeDecodeCapability(unknownDecodeCapability());
    expect(line).toContain("unknown");
  });
});
