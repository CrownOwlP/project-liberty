import { handleReadProgress, handleWriteProgress } from "../handler";

/**
 * GET /api/v1/progress/{contentId} -- the resume point for one title on the
 * profile this session selected, or `progress: null` when there is none.
 *
 * PUT /api/v1/progress/{contentId} -- record a position. The body echoes the
 * lease `POST .../lease` issued and carries a sequence number; there is no field
 * through which a client can assert a time, and there must never be one. See
 * `../contract.ts`.
 *
 * PUT rather than POST because the row is keyed by `(profileId, contentId)` and
 * a repeated write upserts: the operation is idempotent in the sense that
 * matters, since replaying the same `writeSeq` is refused as
 * `stale_write_within_writer` rather than applied twice.
 *
 * `params` is a promise in the App Router and is awaited here. Nothing else may
 * be exported from a route module, which is why the work is in `../handler.ts`.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ contentId: string }> }
): Promise<Response> {
  const { contentId } = await context.params;
  return handleReadProgress(request, contentId);
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ contentId: string }> }
): Promise<Response> {
  const { contentId } = await context.params;
  return handleWriteProgress(request, contentId);
}
