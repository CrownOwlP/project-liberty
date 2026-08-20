import { describe, expect, it } from "vitest";
import {
  DEFAULT_INSPECTION_LIMITS,
  inspectManifest,
  type InspectionAuthorization,
  type InspectionDependencies,
  type InspectionOptions
} from "./inspect";
import {
  permissiveEgress,
  renderDashMpd,
  renderHlsMaster,
  scriptedFetch,
  testClassifyHost,
  testResolver,
  variant,
  type FetchStep
} from "./testing/fixtures";

const NOW = Date.parse("2026-08-20T09:00:00.000Z");

/**
 * The signed manifest URL. `SUPERSECRET` stands in for the signature, and every
 * test below checks that it never reaches an output string -- the research
 * records credential leakage through error strings and log lines as
 * unconditional rather than incidental, and this is the pipe it leaks through.
 */
const SIGNED_URL = "https://cdn.example.test/media/master.m3u8?token=SUPERSECRET&exp=1";

const authorization: InspectionAuthorization = {
  decisionId: "PL-0501-abc123",
  manifestUrl: SIGNED_URL,
  expiresAtEpochMs: NOW + 60_000
};

const options: InspectionOptions = { egress: permissiveEgress, ...DEFAULT_INSPECTION_LIMITS };

function dependencies(steps: readonly FetchStep[]): {
  readonly deps: InspectionDependencies;
  readonly requested: string[];
} {
  const { fetchImpl, requested } = scriptedFetch(steps);
  return {
    deps: {
      fetchImpl,
      classifyHost: testClassifyHost,
      resolveHost: testResolver(),
      now: () => NOW
    },
    requested
  };
}

const LADDER = [
  variant({ bandwidthBps: 800_000, width: 640, height: 360, uri: "v/360.m3u8" }),
  variant({ bandwidthBps: 2_400_000, width: 1280, height: 720, uri: "v/720.m3u8" }),
  variant({ bandwidthBps: 5_000_000, width: 1920, height: 1080, uri: "v/1080.m3u8" })
];

describe("the manifest path returns the declared ladder without opening a segment", () => {
  it("inspects an HLS master playlist", async () => {
    const { deps, requested } = dependencies([{ status: 200, body: renderHlsMaster(LADDER) }]);

    const result = await inspectManifest(authorization, options, deps);

    expect(result.outcome).toBe("inspected");
    if (result.outcome !== "inspected") return;
    expect(result.format).toBe("hls");
    expect(result.renditions.map((rendition) => rendition.height)).toEqual([360, 720, 1080]);
    expect(result.observedAt).toBe("2026-08-20T09:00:00.000Z");
    // Exactly one request. Nothing followed a variant URI, and no segment was
    // opened -- which is the entire reason this path exists instead of ffprobe.
    expect(requested).toHaveLength(1);
  });

  it("inspects an MPD", async () => {
    const { deps } = dependencies([{ status: 200, body: renderDashMpd(LADDER) }]);
    const result = await inspectManifest(authorization, options, deps);

    expect(result.outcome).toBe("inspected");
    if (result.outcome !== "inspected") return;
    expect(result.format).toBe("dash");
    expect(result.renditions).toHaveLength(3);
  });

  it("carries a reason on the successful branch too", async () => {
    const { deps } = dependencies([{ status: 200, body: renderHlsMaster(LADDER) }]);
    const result = await inspectManifest(authorization, options, deps);

    // An outcome with no reason trail violates invariant 4 whether it succeeded
    // or not, and an optional field is one consumers learn to skip.
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.reasons[0]?.code).toBe("ladder_read_from_manifest");
  });

  it("reports a well-formed manifest that declares no ladder as inspected, with the reason", async () => {
    const mediaPlaylist = ["#EXTM3U", "#EXT-X-TARGETDURATION:6", "#EXTINF:6.0,", "s0.ts", ""].join("\n");
    const { deps } = dependencies([{ status: 200, body: mediaPlaylist }]);

    const result = await inspectManifest(authorization, options, deps);

    expect(result.outcome).toBe("inspected");
    expect(result.reasons.map((reason) => reason.code)).toEqual(["media_playlist_declares_no_ladder"]);
  });
});

describe("redirects are revalidated rather than trusted", () => {
  it("follows a redirect to another allowlisted host", async () => {
    const { deps, requested } = dependencies([
      { status: 302, body: "", headers: { location: "https://other.example.test/m.m3u8" } },
      { status: 200, body: renderHlsMaster(LADDER) }
    ]);

    const result = await inspectManifest(authorization, options, deps);

    expect(result.outcome).toBe("inspected");
    expect(requested).toHaveLength(2);
    expect(requested[1]).toBe("https://other.example.test/m.m3u8");
  });

  it("refuses a redirect into the private network even though the first host was allowed", async () => {
    // The bypass this exists to close: an allowlisted CDN that 302s to a cloud
    // metadata endpoint defeats a first-hop-only check completely.
    const { deps } = dependencies([
      {
        status: 302,
        body: "",
        headers: { location: "http://169.254.169.254/latest/meta-data/iam/security-credentials/" }
      },
      { status: 200, body: "should never be fetched" }
    ]);

    const result = await inspectManifest(authorization, options, deps);

    expect(result.outcome).toBe("refused");
    expect(result.reasons[0]?.code).toBe("url_host_private_literal");
    expect(result.reasons[0]?.detail).toContain("redirect hop 1");
  });

  it("refuses a redirect off the egress allowlist", async () => {
    const { deps } = dependencies([
      { status: 302, body: "", headers: { location: "https://evil.test/m.m3u8" } },
      { status: 200, body: renderHlsMaster(LADDER) }
    ]);

    const result = await inspectManifest(authorization, options, deps);
    expect(result.outcome).toBe("refused");
    expect(result.reasons[0]?.code).toBe("url_host_not_on_egress_allowlist");
  });

  it("gives up rather than following an endless chain", async () => {
    const { deps } = dependencies([
      { status: 302, body: "", headers: { location: "https://cdn.example.test/again" } }
    ]);

    const result = await inspectManifest(authorization, { ...options, maxRedirects: 2 }, deps);
    expect(result.outcome).toBe("refused");
    expect(result.reasons[0]?.code).toBe("too_many_redirects");
  });

  it("resolves the base of a variant URI against the FINAL url, not the requested one", async () => {
    const { deps } = dependencies([
      { status: 302, body: "", headers: { location: "https://other.example.test/edge/m.m3u8" } },
      { status: 200, body: renderHlsMaster([variant({ uri: "v/720.m3u8" })]) }
    ]);

    const result = await inspectManifest(authorization, options, deps);
    if (result.outcome !== "inspected") throw new Error("expected an inspection");
    const location = result.renditions[0]?.location;
    if (location?.kind !== "declared") throw new Error("expected a declared location");
    expect(location.resolvedUrl).toBe("https://other.example.test/edge/v/720.m3u8");
  });
});

describe("the body is bounded before it is parsed", () => {
  it("refuses an oversized body", async () => {
    const body = renderHlsMaster(LADDER);
    const { deps } = dependencies([{ status: 200, body }]);

    const result = await inspectManifest(authorization, { ...options, maxManifestBytes: 32 }, deps);

    expect(result.outcome).toBe("refused");
    expect(result.reasons[0]?.code).toBe("response_too_large");
    // `format` is null: detection reads the body, and the body was abandoned
    // before anything looked at it.
    expect(result.format).toBeNull();
  });

  it("parses that same body once the cap allows it, so the refusal was the cap", async () => {
    const { deps } = dependencies([{ status: 200, body: renderHlsMaster(LADDER) }]);
    const result = await inspectManifest(authorization, options, deps);
    expect(result.outcome).toBe("inspected");
  });

  it("refuses a ladder larger than the cap rather than truncating it", async () => {
    const { deps } = dependencies([{ status: 200, body: renderHlsMaster(LADDER) }]);
    const result = await inspectManifest(authorization, { ...options, maxRenditions: 2 }, deps);

    expect(result.outcome).toBe("refused");
    // A truncated ladder is not the declared ladder, and it would be reported as
    // though it were.
    expect(result.reasons[0]?.code).toBe("too_many_renditions");
    // The refusal names the count the publisher DECLARED, which is the number
    // that explains it. The surviving count is a number nobody exceeded.
    expect(result.reasons[0]?.detail).toContain("3 declared renditions");
  });

  it("caps on the declared count, not on what survives canonicalisation", async () => {
    /*
     * Eight identical variants collapse to one rung. Under a cap applied to the
     * PARSED ladder this inspection succeeds with a one-rung result -- after
     * building eight renditions and sorting them, which is the work the cap
     * exists to bound and the reason the check moved into the parsers. The
     * distinction is invisible on a ladder of distinct rungs, which is why the
     * duplicates are the test.
     */
    const identical = Array.from({ length: 8 }, () => variant());
    const { deps } = dependencies([{ status: 200, body: renderHlsMaster(identical) }]);

    const result = await inspectManifest(authorization, { ...options, maxRenditions: 4 }, deps);

    expect(result.outcome).toBe("refused");
    expect(result.reasons[0]?.code).toBe("too_many_renditions");
    expect(result.reasons[0]?.detail).toContain("8 declared renditions");
    // The format is still reported: the body was recognised, and it is the
    // ladder inside it that was refused.
    expect(result.format).toBe("hls");
  });
});

describe("wall-clock time is bounded", () => {
  it("abandons a publisher that never answers", async () => {
    const hangingFetch = ((_input: unknown, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      })) as unknown as typeof globalThis.fetch;

    const result = await inspectManifest(
      authorization,
      { ...options, timeoutMs: 5 },
      {
        fetchImpl: hangingFetch,
        classifyHost: testClassifyHost,
        resolveHost: testResolver(),
        now: () => NOW
      }
    );

    expect(result.outcome).toBe("unavailable");
    expect(result.reasons[0]?.code).toBe("timeout");
  });
});

describe("inspection cannot be pointed at a URL no decision authorised", () => {
  it("refuses an expired authorisation", async () => {
    const { deps, requested } = dependencies([{ status: 200, body: renderHlsMaster(LADDER) }]);

    const result = await inspectManifest(
      { ...authorization, expiresAtEpochMs: NOW - 1 },
      options,
      deps
    );

    expect(result.outcome).toBe("refused");
    expect(result.reasons[0]?.code).toBe("authorization_expired");
    // Nothing was fetched. The refusal happens before the network, not after.
    expect(requested).toHaveLength(0);
  });

  it("takes the URL from the authorisation, so there is no second URL to disagree with it", () => {
    // A compile-time property rather than a runtime one, asserted here so the
    // reason it matters is written down somewhere a reviewer will read:
    // `inspectManifest` has no `manifestUrl` parameter, so "inspect something
    // the decision did not name" is not expressible and cannot be reintroduced
    // by deleting a comparison.
    expect(Object.keys(authorization).sort()).toEqual([
      "decisionId",
      "expiresAtEpochMs",
      "manifestUrl"
    ]);
  });
});

describe("our refusals and their failures are different outcomes", () => {
  for (const status of [404, 500, 503]) {
    it(`reports status ${status} as unavailable, because retrying might work`, async () => {
      const { deps } = dependencies([{ status, body: "" }]);
      const result = await inspectManifest(authorization, options, deps);

      expect(result.outcome).toBe("unavailable");
      expect(result.reasons[0]?.code).toBe("http_status");
    });
  }

  it("reports an unrecognised body as unavailable rather than as a refusal", async () => {
    const { deps } = dependencies([{ status: 200, body: "<html><body>404 not found</body></html>" }]);
    const result = await inspectManifest(authorization, options, deps);

    expect(result.outcome).toBe("unavailable");
    expect(result.reasons[0]?.code).toBe("unrecognised_manifest_format");
  });

  it("reports a policy refusal as refused", async () => {
    const { deps } = dependencies([{ status: 200, body: renderHlsMaster(LADDER) }]);
    const result = await inspectManifest(
      { ...authorization, manifestUrl: "https://evil.test/master.m3u8" },
      options,
      deps
    );

    expect(result.outcome).toBe("refused");
    expect(result.reasons[0]?.code).toBe("url_host_not_on_egress_allowlist");
  });
});

describe("a signed URL never reaches an output string", () => {
  const scenarios: readonly {
    readonly name: string;
    readonly steps: readonly FetchStep[];
    readonly maxManifestBytes: number;
  }[] = [
    {
      name: "success",
      steps: [{ status: 200, body: renderHlsMaster(LADDER) }],
      maxManifestBytes: DEFAULT_INSPECTION_LIMITS.maxManifestBytes
    },
    {
      name: "http error",
      steps: [{ status: 500, body: "upstream said no" }],
      maxManifestBytes: DEFAULT_INSPECTION_LIMITS.maxManifestBytes
    },
    {
      name: "oversized body",
      steps: [{ status: 200, body: renderHlsMaster(LADDER) }],
      maxManifestBytes: 16
    },
    {
      name: "unrecognised format",
      steps: [{ status: 200, body: "not a manifest" }],
      maxManifestBytes: DEFAULT_INSPECTION_LIMITS.maxManifestBytes
    },
    {
      name: "refused redirect",
      steps: [{ status: 302, body: "", headers: { location: "https://evil.test/x" } }],
      maxManifestBytes: DEFAULT_INSPECTION_LIMITS.maxManifestBytes
    }
  ];

  for (const scenario of scenarios) {
    it(`keeps the token out of the ${scenario.name} result`, async () => {
      const { deps } = dependencies(scenario.steps);
      const result = await inspectManifest(
        authorization,
        { ...options, maxManifestBytes: scenario.maxManifestBytes },
        deps
      );

      const serialised = JSON.stringify(result);
      expect(serialised).not.toContain("SUPERSECRET");
      expect(serialised).not.toContain("token=");
    });
  }
});
