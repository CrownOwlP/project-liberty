import { handleIssueWriterLease } from "../../handler";

/**
 * POST /api/v1/progress/{contentId}/lease
 *
 * Claims the right to write progress for this title on this device, and returns
 * the `{ epoch, writerId }` pair every subsequent write must echo.
 *
 * POST rather than PUT: each call ALLOCATES a new epoch, so two identical
 * requests produce two different leases and the second supersedes the first.
 * That is the opposite of idempotent, and it is the whole mechanism -- a device
 * picking a title up takes authority from whatever held it.
 *
 * A SEPARATE PATH RATHER THAN A FLAG ON THE WRITE, because a write that could
 * also mint its own lease would let a superseded device re-take authority by
 * writing, which is exactly the handoff the writer epoch exists to arbitrate.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ contentId: string }> }
): Promise<Response> {
  const { contentId } = await context.params;
  return handleIssueWriterLease(request, contentId);
}
