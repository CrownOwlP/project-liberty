import { handleCmcdReportRequest } from "./handler";

/**
 * POST /api/v1/telemetry/cmcd
 *
 * The first-party CMCD v2 collector. `apps/web/src/components/player/telemetry.ts`
 * names this path -- a same-origin PATH rather than a URL, so a cross-origin
 * target is unrepresentable -- and points shaka-player's Event Mode reporter at
 * it. `packages/observability/src/cmcd-collect.ts` is what converts a report
 * into redacted structured records; `handler.ts` is why that work is not in this
 * file, and `cmcd-sfv.ts` is the decoder for the wire body.
 *
 * TELEMETRY IS NOT A DEPENDENCY OF PLAYING A VIDEO. Every answer this endpoint
 * can give -- including every refusal -- leaves playback untouched, because the
 * player's only relationship to it is a fire-and-forget POST from Shaka's
 * reporter. See `cmcdCollectorHttpStatus` for the one consequence a status code
 * does have, which is what the client's own queue does next.
 *
 * A route module may export only the handlers and a fixed set of segment config
 * values, so it has nowhere to accept an injected clock or sink -- which is the
 * whole reason this one is three lines and `handler.ts` is not.
 */
export async function POST(request: Request): Promise<Response> {
  return handleCmcdReportRequest(request);
}
