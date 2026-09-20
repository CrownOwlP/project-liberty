import {
  MAX_STREAM_CANDIDATE_ID_CHARS,
  MAX_STREAM_CANDIDATE_PROVIDER_ID_CHARS
} from "@liberty/contracts/domains/playback";
import { describe, expect, it } from "vitest";
import {
  playbackSessionCandidateSchema,
  playbackSessionResponseSchema
} from "./contract";

const baseCandidate = {
  uri: "https://media.example.test/stream.m3u8",
  mimeType: "application/vnd.apple.mpegurl",
  compatibility: "verified" as const,
  protection: { state: "clear" as const }
};

describe("playback session candidate identifier bounds", () => {
  it("accepts the exact authoritative maxima", () => {
    const parsed = playbackSessionCandidateSchema.parse({
      ...baseCandidate,
      id: "i".repeat(MAX_STREAM_CANDIDATE_ID_CHARS),
      providerId: "p".repeat(MAX_STREAM_CANDIDATE_PROVIDER_ID_CHARS)
    });

    expect(parsed.id).toHaveLength(MAX_STREAM_CANDIDATE_ID_CHARS);
    expect(parsed.providerId).toHaveLength(MAX_STREAM_CANDIDATE_PROVIDER_ID_CHARS);
  });

  it("rejects maximum plus one without echoing the oversized identifiers", () => {
    const oversizedId = "i".repeat(MAX_STREAM_CANDIDATE_ID_CHARS + 1);
    const oversizedProviderId = "p".repeat(MAX_STREAM_CANDIDATE_PROVIDER_ID_CHARS + 1);

    const idResult = playbackSessionCandidateSchema.safeParse({
      ...baseCandidate,
      id: oversizedId,
      providerId: "provider"
    });
    const providerResult = playbackSessionCandidateSchema.safeParse({
      ...baseCandidate,
      id: "candidate",
      providerId: oversizedProviderId
    });

    expect(idResult.success).toBe(false);
    expect(providerResult.success).toBe(false);

    if (!idResult.success) {
      const serializedIssues = JSON.stringify(idResult.error.issues);
      expect(serializedIssues).not.toContain(oversizedId);
      expect(idResult.error.issues[0]?.path).toEqual(["id"]);
      expect(idResult.error.issues[0]?.code).toBe("too_big");
    }

    if (!providerResult.success) {
      const serializedIssues = JSON.stringify(providerResult.error.issues);
      expect(serializedIssues).not.toContain(oversizedProviderId);
      expect(providerResult.error.issues[0]?.path).toEqual(["providerId"]);
      expect(providerResult.error.issues[0]?.code).toBe("too_big");
    }
  });

  it("continues to accept legitimate fixture and Wikidata-shaped identifiers", () => {
    expect(
      playbackSessionCandidateSchema.safeParse({
        ...baseCandidate,
        id: "big-buck-bunny-progressive",
        providerId: "public-domain-archive"
      }).success
    ).toBe(true);

    expect(
      playbackSessionCandidateSchema.safeParse({
        ...baseCandidate,
        id: "wikidata-q83495-progressive",
        providerId: "wikidata"
      }).success
    ).toBe(true);
  });

  it("keeps the same bounds on the serialized granted-session response", () => {
    const id = "i".repeat(MAX_STREAM_CANDIDATE_ID_CHARS);
    const providerId = "p".repeat(MAX_STREAM_CANDIDATE_PROVIDER_ID_CHARS);

    const parsed = playbackSessionResponseSchema.parse({
      outcome: "granted",
      reasons: [
        {
          code: "session_issued",
          candidateId: null,
          detail: "session issued"
        }
      ],
      session: {
        sessionId: "session-1",
        contentId: "wikidata-q83495",
        candidates: [{ ...baseCandidate, id, providerId }],
        startAtSeconds: null,
        expiresAt: "2026-09-20T12:00:00.000Z",
        failoverPolicy: {
          maxAttempts: 3,
          maxTransientRetriesPerCandidate: 1
        }
      }
    });

    expect(parsed.outcome).toBe("granted");
    if (parsed.outcome !== "granted") {
      throw new Error("the granted-session fixture did not parse as granted");
    }

    const wire = JSON.stringify(parsed);
    expect(wire).toContain(id);
    expect(wire).toContain(providerId);

    const oversized = playbackSessionResponseSchema.safeParse({
      ...parsed,
      session: {
        ...parsed.session,
        candidates: [
          {
            ...parsed.session.candidates[0],
            id: "x".repeat(MAX_STREAM_CANDIDATE_ID_CHARS + 1)
          }
        ]
      }
    });

    expect(oversized.success).toBe(false);
    if (!oversized.success) {
      const serializedIssues = JSON.stringify(oversized.error.issues);
      expect(serializedIssues).not.toContain("x".repeat(MAX_STREAM_CANDIDATE_ID_CHARS + 1));
      expect(oversized.error.issues[0]?.path).toEqual(["session", "candidates", 0, "id"]);
    }
  });
});
