import { loadHomeCatalog } from "../../../../../lib/catalog";
import { handleCatalogHomeResult } from "./handler";

/**
 * GET /api/v1/catalog/home
 *
 * Serves the rails the home experience renders. The payload is validated against
 * the published contract inside `loadHomeCatalog` before it leaves the server, so
 * a fixture or provider regression surfaces here as a 500 with a stable error
 * code rather than as malformed JSON the client has to defend against.
 *
 * IT AWAITS THE LOADER RATHER THAN CALLING `getHomeCatalog()`, and the difference
 * is visible on a deployment. The synchronous variant returns a
 * `CatalogHomeResponse`, which has nowhere to say "no metadata source is
 * configured", so a hosted build served `{ rails: [] }` at 200 — a claim that
 * there is genuinely nothing to show, made by a process with no catalog to look
 * at. `loadHomeCatalog` reports that state as `catalog_source_not_configured`
 * and `./handler.ts` answers it 503. Awaiting is also what a real metadata
 * provider needs: it does I/O, and no synchronous entry point can serve one.
 *
 * Everything else lives in `./handler.ts` so the branches are testable without
 * mutating `process.env`; this module is the wiring Next actually deploys.
 */
export async function GET() {
  return handleCatalogHomeResult(await loadHomeCatalog());
}
