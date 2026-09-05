import { handleAddToWatchlist, handleRemoveFromWatchlist } from "../handler";

/**
 * PUT /api/v1/watchlist/{contentId} -- put a title on this profile's list.
 * DELETE /api/v1/watchlist/{contentId} -- take it off.
 *
 * PUT rather than POST because the path already names the entry and the
 * operation is idempotent: adding twice is one row, and the second call answers
 * `already_present` with `changed: false` rather than creating a duplicate or
 * failing. DELETE is idempotent in the same way -- removing something absent
 * answers `not_present` and a 200, because the caller is a button on a remote
 * control behind an unreliable network and a retried request must converge.
 *
 * Neither carries a body. Both parse one anyway, against a `.strict()` empty
 * object, so a client that believed it could also send `addedAt` is told the
 * field is not accepted rather than having it silently dropped.
 */
export async function PUT(
  request: Request,
  context: { params: Promise<{ contentId: string }> }
): Promise<Response> {
  const { contentId } = await context.params;
  return handleAddToWatchlist(request, contentId);
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ contentId: string }> }
): Promise<Response> {
  const { contentId } = await context.params;
  return handleRemoveFromWatchlist(request, contentId);
}
