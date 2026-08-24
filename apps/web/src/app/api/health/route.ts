/**
 * GET /api/health
 *
 * Liveness only. It states that this process answered, and deliberately states
 * nothing else: no version, no commit, no dependency status, no environment
 * name. A health endpoint is the one route that is reachable unauthenticated
 * from everywhere by design, so every fact added to it is a fact published to
 * everyone, and "which build is running" is reconnaissance rather than health.
 *
 * `no-store` because the answer is a claim about RIGHT NOW. A cached 200 is a
 * liveness check that reports the state of a process that may have died
 * minutes ago, which is worse than no check at all -- it is a check that
 * actively suppresses the alarm. The `timestamp` makes a stale answer
 * detectable; the header stops one being produced.
 */
export async function GET() {
  return Response.json(
    {
      status: "ok",
      service: "project-liberty-web",
      timestamp: new Date().toISOString()
    },
    { headers: { "cache-control": "no-store" } }
  );
}
