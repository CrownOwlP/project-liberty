import {
  handleForgetPreferences,
  handleReadPreferences,
  handleWritePreferences
} from "./handler";

/* -------------------------------------------------------------------------
 * The route module, which is three lines of plumbing and no decisions
 * (PL-0723).
 *
 * Every other route in this application has the same shape and for the same
 * reason: a route module is the only file Next.js can address, so putting
 * logic here would put it somewhere no unit test can call without a Request
 * and a running framework. `handler.ts` takes a `Request` and returns a
 * `Response`, which is testable with neither.
 * ---------------------------------------------------------------------- */

export async function GET(request: Request): Promise<Response> {
  return handleReadPreferences(request);
}

export async function PUT(request: Request): Promise<Response> {
  return handleWritePreferences(request);
}

/**
 * DELETE is "I have not chosen", which is NOT `PUT` with empty lists.
 *
 * `PUT { preferredAudioLanguages: [] }` stores a decision -- prefer no
 * particular language -- and the player honours it. `DELETE` removes the row,
 * so the player falls back to whatever it does for a profile nobody has
 * configured. Two different answers, two different verbs.
 */
export async function DELETE(request: Request): Promise<Response> {
  return handleForgetPreferences(request);
}
