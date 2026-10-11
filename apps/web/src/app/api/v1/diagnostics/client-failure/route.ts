import { NextResponse } from "next/server";
import {
  MAX_CLIENT_FAILURE_BYTES,
  handleClientFailureReport
} from "./handler";

/*
 * The transport, and nothing else. Every rule is in `handler.ts`, which is a
 * pure function of the body text and the clock -- the arrangement every other
 * route in this application uses, for the reason it uses it: a decision that
 * needs a `Request` to be exercised is a decision that gets tested through a
 * server or not at all.
 *
 * `request.text()` AND NOT `request.json()`. The bound has to be applied before
 * anything parses; `json()` on a body nobody measured parses whatever arrived.
 */
export async function POST(request: Request): Promise<NextResponse> {
  let bodyText: string;
  try {
    bodyText = await request.text();
  } catch {
    return new NextResponse(null, { status: 400, headers: { "cache-control": "no-store" } });
  }
  if (bodyText.length > MAX_CLIENT_FAILURE_BYTES) {
    return new NextResponse(null, { status: 413, headers: { "cache-control": "no-store" } });
  }

  const outcome = handleClientFailureReport(bodyText, Date.now());
  /*
   * STDERR, so the shell tags it `[err]`. The capture in `windows_host.rs`
   * reads both streams and `sidecar_log.rs` redacts and budget-caps them; this
   * writes one line per admitted report and nothing on a refusal.
   */
  for (const line of outcome.logged) console.error(line);

  return new NextResponse(null, {
    status: outcome.status,
    headers: { "cache-control": "no-store" }
  });
}
