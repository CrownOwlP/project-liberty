import { playbackResolveRequestSchema } from "@liberty/contracts/domains/playback";
import { rankStreamCandidates } from "@liberty/media-engine";

export async function POST(request: Request) {
  const parsed = playbackResolveRequestSchema.safeParse(await request.json());

  if (!parsed.success) {
    return Response.json(
      { error: "invalid_request", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  const decision = rankStreamCandidates(parsed.data.candidates, parsed.data.capabilities);

  if (!decision.selected) {
    return Response.json({ error: "no_playable_candidate", detail: decision.reason }, { status: 422 });
  }

  return Response.json(decision);
}
