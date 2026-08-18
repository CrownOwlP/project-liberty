import Link from "next/link";
import { rankStreamCandidates } from "@liberty/media-engine";
import type { PlaybackCapabilities, StreamCandidate } from "@liberty/contracts/domains/playback";

const capabilities: PlaybackCapabilities = {
  maxHeight: 2160,
  supportedVideoCodecs: ["h264", "hevc", "av1"],
  supportedAudioCodecs: ["aac", "ac3", "eac3"],
  preferredAudioLanguages: ["en"]
};

const candidates: StreamCandidate[] = [
  {
    id: "fixture-1080",
    providerId: "fixture",
    rights: "public-domain",
    protocol: "https",
    height: 1080,
    bitrateKbps: 6500,
    estimatedLatencyMs: 65,
    healthScore: 0.99,
    videoCodec: "h264",
    audioCodec: "aac"
  },
  {
    id: "fixture-2160",
    providerId: "fixture",
    rights: "public-domain",
    protocol: "https",
    height: 2160,
    bitrateKbps: 18000,
    estimatedLatencyMs: 160,
    healthScore: 0.94,
    videoCodec: "hevc",
    audioCodec: "eac3"
  }
];

export default async function WatchPage({ params }: { params: Promise<{ contentId: string }> }) {
  const { contentId } = await params;
  const decision = rankStreamCandidates(candidates, capabilities);

  return (
    <main className="shell player-shell">
      <section className="player-card">
        <div className="player-stage">
          <strong>Player surface placeholder</strong>
        </div>
        <div className="player-meta">
          <strong>Content: {contentId}</strong>
          <span>Selected candidate: <span className="code">{decision.selected?.candidate.id ?? "none"}</span></span>
          <span>Decision: {decision.selected?.reason ?? decision.reason}</span>
          <Link href="/">Back to catalog</Link>
        </div>
      </section>
    </main>
  );
}
