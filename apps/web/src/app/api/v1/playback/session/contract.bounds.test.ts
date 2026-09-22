import {
  MAX_STREAM_CANDIDATE_ID_CHARS,
  MAX_STREAM_CANDIDATE_PROVIDER_ID_CHARS,
  streamCandidateSchema
} from "@liberty/contracts/domains/playback";
import { PROTECTION_NOT_STATED } from "@liberty/contracts/shared/drm";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  grantedSession,
  playbackSessionCandidateSchema,
  playbackSessionResponseSchema,
  type PlaybackSessionCandidate
} from "./contract";
import { handlePlaybackSessionRequest } from "./handler";

/**
 * PL-0711: the session wire carries the SAME candidate bounds as the contract.
 *
 * THE DEFECT THESE PIN, in one sentence: the ranker's `StreamCandidate` bounds
 * `id` and `providerId`, the session's wire candidate did not, and those are two
 * seams on one value -- so an oversized identifier refused at the provider seam
 * could RE-EXPAND downstream, published on the session response, with the bound
 * stopping at the seam rather than travelling with the value.
 *
 * WHY THE TESTS LOOK LIKE THIS. A bound tested only from above proves nothing
 * about where the boundary is: `.max(200)` also rejects 1000 characters. Every
 * bound below is therefore exercised at the EXACT MAXIMUM and at MAXIMUM PLUS
 * ONE, which is the only pair that locates it. And the bound is asserted to be
 * the IMPORTED constant rather than a number, because a copied literal that
 * happens to agree today is the defect this task exists to close, not a
 * shortcut past it.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRACT_SOURCE = readFileSync(join(HERE, "contract.ts"), "utf8");

const candidate = (over: Partial<PlaybackSessionCandidate> = {}): PlaybackSessionCandidate => ({
  id: "fixture:aurora-fall:1080p",
  providerId: "fixture",
  uri: "https://fixtures.invalid/aurora-fall/1080p.m3u8",
  mimeType: "application/vnd.apple.mpegurl",
  compatibility: "verified",
  protection: PROTECTION_NOT_STATED,
  ...over
});

const chars = (n: number) => "a".repeat(n);

describe("the session candidate is bounded at the contract's own limits", () => {
  it("accepts an id of exactly the maximum", () => {
    const parsed = playbackSessionCandidateSchema.safeParse(
      candidate({ id: chars(MAX_STREAM_CANDIDATE_ID_CHARS) })
    );
    expect(parsed.success).toBe(true);
  });

  it("refuses an id of the maximum plus one", () => {
    const parsed = playbackSessionCandidateSchema.safeParse(
      candidate({ id: chars(MAX_STREAM_CANDIDATE_ID_CHARS + 1) })
    );
    expect(parsed.success).toBe(false);
  });

  it("accepts a providerId of exactly the maximum", () => {
    const parsed = playbackSessionCandidateSchema.safeParse(
      candidate({ providerId: chars(MAX_STREAM_CANDIDATE_PROVIDER_ID_CHARS) })
    );
    expect(parsed.success).toBe(true);
  });

  it("refuses a providerId of the maximum plus one", () => {
    const parsed = playbackSessionCandidateSchema.safeParse(
      candidate({ providerId: chars(MAX_STREAM_CANDIDATE_PROVIDER_ID_CHARS + 1) })
    );
    expect(parsed.success).toBe(false);
  });

  it("still accepts the legitimate fixture and Wikidata-shaped identifiers", () => {
    // A bound that rejects a real upstream id is an outage, not a fix.
    for (const id of [
      "fixture:aurora-fall:1080p",
      "wikidata:Q83495:hls:1080p",
      "wikidata:Q1079120:dash:2160p:hdr10"
    ]) {
      expect(playbackSessionCandidateSchema.safeParse(candidate({ id })).success).toBe(true);
    }
    for (const providerId of ["fixture", "wikidata", "stremio-community-addon"]) {
      expect(playbackSessionCandidateSchema.safeParse(candidate({ providerId })).success).toBe(true);
    }
  });
});

describe("the two seams agree by construction, not by coincidence", () => {
  it("uses the imported constants and writes no numeric literal of its own", () => {
    // The assertion that actually carries the guarantee. A `.max(141)` here
    // would satisfy every value test above and would be exactly the defect.
    expect(CONTRACT_SOURCE).toContain("id: z.string().min(1).max(MAX_STREAM_CANDIDATE_ID_CHARS)");
    expect(CONTRACT_SOURCE).toContain(
      "providerId: z.string().min(1).max(MAX_STREAM_CANDIDATE_PROVIDER_ID_CHARS)"
    );
    expect(CONTRACT_SOURCE).not.toMatch(
      new RegExp(`max\\(\\s*${String(MAX_STREAM_CANDIDATE_ID_CHARS)}\\s*\\)`)
    );
    expect(CONTRACT_SOURCE).not.toMatch(
      new RegExp(`max\\(\\s*${String(MAX_STREAM_CANDIDATE_PROVIDER_ID_CHARS)}\\s*\\)`)
    );
  });

  it("declares no second bound vocabulary of its own", () => {
    // No new constant, no local alias, no derived figure: `grep
    // MAX_STREAM_CANDIDATE` must find one definition and its readers.
    expect(CONTRACT_SOURCE).not.toMatch(/(?:const|let|var)\s+MAX_[A-Z0-9_]*(?:ID|PROVIDER)[A-Z0-9_]*\s*=/);
  });

  it("agrees with the ranker's own schema at both boundaries", () => {
    // Read from the other seam rather than restated, so the two cannot drift
    // apart while both tests stay green.
    const base = {
      providerId: "fixture",
      uri: "https://fixtures.invalid/x.m3u8",
      protocol: "hls" as const,
      rights: "public-domain" as const,
      videoCodec: "h264" as const,
      audioCodec: "aac" as const,
      height: 1080,
      bitrateKbps: 6000,
      estimatedLatencyMs: 70,
      healthScore: 0.9
    };
    expect(
      streamCandidateSchema.safeParse({ ...base, id: chars(MAX_STREAM_CANDIDATE_ID_CHARS) }).success
    ).toBe(true);
    expect(
      streamCandidateSchema.safeParse({ ...base, id: chars(MAX_STREAM_CANDIDATE_ID_CHARS + 1) })
        .success
    ).toBe(false);
  });
});

describe("an oversized candidate cannot re-expand on the serialized response", () => {
  const oversizedId = chars(MAX_STREAM_CANDIDATE_ID_CHARS + 40);

  const grantedWithCandidate = (c: PlaybackSessionCandidate) =>
    grantedSession(
      {
        sessionId: "01J0000000000000000000000A",
        contentId: "aurora-fall",
        candidates: [c],
        startAtSeconds: null,
        expiresAt: "2026-09-22T12:00:00.000Z",
        failoverPolicy: { maxAttempts: 3, maxTransientRetriesPerCandidate: 1 }
      },
      { code: "session_issued", candidateId: null, detail: "1 candidate authorized" }
    );

  it("is refused by the response schema the handler validates against", () => {
    const parsed = playbackSessionResponseSchema.safeParse(
      grantedWithCandidate(candidate({ id: oversizedId }))
    );
    expect(parsed.success).toBe(false);
  });

  it("does not echo the oversized value in the failure output", async () => {
    // The handler answers a schema failure with `parsed.error.issues`, and this
    // is the assertion that those issues describe the violation WITHOUT
    // reprinting the value that caused it -- an error body that quotes a
    // 181-character attacker-supplied identifier is a reflection of untrusted
    // input into an operator's logs.
    const parsed = playbackSessionResponseSchema.safeParse(
      grantedWithCandidate(candidate({ id: oversizedId }))
    );
    expect(parsed.success).toBe(false);
    const serialized = JSON.stringify(parsed.success ? {} : parsed.error.issues);
    expect(serialized).not.toContain(oversizedId);
    // Not merely the whole string: no run of it long enough to be the value.
    expect(serialized).not.toContain(chars(40));
    // It still says what went wrong and where.
    expect(serialized).toContain("too_big");
    expect(serialized).toContain("candidates");
  });

  it("cannot leave the process as a granted session, driven through the real handler", async () => {
    /*
     * NO `as never` ON THE OPTIONS, deliberately. The first draft of this test
     * passed `resolveAuthorizedCandidates` -- a name the handler does not take;
     * the option is `resolve` -- and the cast silenced the very check that would
     * have said so, so the stub was ignored, a normal session was produced and
     * the test read 200 as a missing bound. A test whose harness is cast past
     * the type system measures the cast.
     */
    const response = await handlePlaybackSessionRequest(
      new Request("https://liberty.invalid/api/v1/playback/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contentId: "aurora-fall",
          capabilities: {
            maxHeight: 2160,
            supportedVideoCodecs: ["h264"],
            supportedAudioCodecs: ["aac"],
            preferredAudioLanguages: ["en"]
          }
        })
      }),
      {
        localDeployment: true,
        resolve: () => ({
          status: "resolved",
          candidates: [
            {
              candidate: {
                id: oversizedId,
                providerId: "fixture",
                rights: "public-domain",
                protocol: "https",
                videoCodec: "h264",
                audioCodec: "aac",
                height: 1080,
                bitrateKbps: 6000,
                estimatedLatencyMs: 70,
                healthScore: 0.9
              },
              source: {
                uri: "https://fixtures.invalid/aurora-fall/1080p.m3u8",
                mimeType: "application/vnd.apple.mpegurl",
                allowLoopback: false
              },
              protection: PROTECTION_NOT_STATED
            }
          ]
        })
      }
    );

    const body = await response.text();
    // Whatever the exact refusal, the oversized identifier must not reach a
    // caller inside a session this service is claiming to have granted.
    expect(body).not.toContain(oversizedId);
    expect(response.status).not.toBe(200);
  });
});
