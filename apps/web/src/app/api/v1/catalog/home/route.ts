import { catalogHomeResponseSchema } from "@liberty/contracts";
import { getHomeCatalog } from "../../../../../lib/catalog";

/**
 * GET /api/v1/catalog/home
 *
 * Serves the rails the home experience renders. The response is validated
 * against the published contract before it leaves the server, so a fixture or
 * provider regression surfaces here as a 500 with a stable error code rather
 * than as malformed JSON the client has to defend against.
 */
export async function GET() {
  const parsed = catalogHomeResponseSchema.safeParse(getHomeCatalog());

  if (!parsed.success) {
    return Response.json(
      { error: "catalog_response_failed_validation", issues: parsed.error.issues },
      { status: 500 }
    );
  }

  return Response.json(parsed.data, {
    headers: { "cache-control": "no-store" }
  });
}
