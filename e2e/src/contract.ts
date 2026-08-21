/* -------------------------------------------------------------------------
 * The playback session wire contract, restated by hand
 *
 * WHY THIS IS NOT AN IMPORT. The obvious move is to import
 * `playbackSessionResponseSchema` from the app and parse the response with it.
 * That would assert only that the server agrees with itself: the same object
 * that built the response would be the one approving it, so a change that
 * relaxed `reasons` from `.nonempty()` to `.optional()` would relax this test in
 * the same commit and the gate would stay green through the regression it
 * exists to catch.
 *
 * So the properties below are written out independently, from
 * `docs/API_CONTRACTS.md` and the contract module's stated invariants, and they
 * are deliberately the PROPERTIES rather than the schema:
 *
 *   - exactly one of three outcomes, discriminated on `outcome`;
 *   - a non-empty reason trail on EVERY branch, including the ones that refuse;
 *   - reasons are codes, not sentences;
 *   - the HTTP status is derivable from the outcome, so the wire status and the
 *     decision cannot disagree.
 *
 * The status mapping is reimplemented here for the same reason. Importing
 * `playbackSessionHttpStatus` would make "the status matches the outcome" a
 * tautology.
 * ---------------------------------------------------------------------- */

export type PlaybackOutcome = "granted" | "denied" | "unavailable";

export interface PlaybackReason {
  readonly code: string;
  readonly candidateId: string | null;
  readonly detail: string;
}

export interface PlaybackSessionResponseShape {
  readonly outcome: PlaybackOutcome;
  readonly reasons: readonly PlaybackReason[];
  readonly session?: unknown;
}

/**
 * A reason CODE, not prose.
 *
 * `contract.ts` states that the moment a consumer decides anything by matching
 * substrings of prose, a reworded message becomes a behaviour change no type,
 * test or review can see. This is the assertion that keeps `code` a code: a
 * space or a capital in it means somebody put a sentence where the machine-
 * readable field goes, and `detail` is the field for humans.
 */
const REASON_CODE = /^[a-z0-9_]+$/;

/** Denials that are the caller's problem (400) rather than a rights refusal (403). */
const REQUEST_LEVEL_DENIALS: readonly string[] = ["request_malformed", "request_field_not_permitted"];

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Structural check for one member of the union. Returns the problems it found
 * rather than throwing, so a spec can report ALL of them at once -- a harness
 * that stops at the first violation makes a reader fix one thing per run.
 */
export function playbackSessionViolations(body: unknown): string[] {
  const problems: string[] = [];

  if (!isRecord(body)) return ["response body is not a JSON object"];

  const outcome = body["outcome"];
  if (outcome !== "granted" && outcome !== "denied" && outcome !== "unavailable") {
    problems.push(`outcome is ${JSON.stringify(outcome)}, not one of granted/denied/unavailable`);
  }

  const reasons = body["reasons"];
  if (!Array.isArray(reasons)) {
    problems.push("reasons is not an array");
  } else if (reasons.length === 0) {
    /* Invariant 4. A denial with no trail is unanswerable by the viewer,
     * unactionable by support and undebuggable by us -- exactly as bad as a
     * grant with none, which is why this is checked on every branch and not
     * only on the interesting one. */
    problems.push(`outcome ${String(outcome)} carries an empty reason trail`);
  } else {
    reasons.forEach((reason, index) => {
      if (!isRecord(reason)) {
        problems.push(`reasons[${index}] is not an object`);
        return;
      }
      const code = reason["code"];
      if (typeof code !== "string" || !REASON_CODE.test(code)) {
        problems.push(`reasons[${index}].code is ${JSON.stringify(code)}, not a snake_case code`);
      }
      if (!("candidateId" in reason)) {
        /* Required-and-nullable, not optional: `null` says "this reason is
         * about the request as a whole", an absent key says only that somebody
         * did not think about it. */
        problems.push(`reasons[${index}] has no candidateId key`);
      } else {
        const candidateId = reason["candidateId"];
        if (candidateId !== null && (typeof candidateId !== "string" || candidateId === "")) {
          problems.push(`reasons[${index}].candidateId is neither null nor a non-empty string`);
        }
      }
      const detail = reason["detail"];
      if (typeof detail !== "string" || detail.trim() === "") {
        problems.push(`reasons[${index}].detail is empty`);
      }
    });
  }

  const hasSession = "session" in body;
  if (outcome === "granted" && !hasSession) {
    problems.push("granted response carries no session");
  }
  if (outcome !== "granted" && hasSession) {
    /* A refusal that ships a session is the failure mode with teeth: whatever
     * consumed it would have a playable candidate list attached to a decision
     * that said no. */
    problems.push(`${String(outcome)} response carries a session`);
  }

  if (outcome === "granted") problems.push(...grantedSessionViolations(body["session"]));

  return problems;
}

function grantedSessionViolations(session: unknown): string[] {
  const problems: string[] = [];
  if (!isRecord(session)) return ["session is not a JSON object"];

  if (typeof session["sessionId"] !== "string" || session["sessionId"] === "") {
    problems.push("session.sessionId is empty");
  }
  if (typeof session["contentId"] !== "string" || session["contentId"] === "") {
    problems.push("session.contentId is empty");
  }

  const candidates = session["candidates"];
  if (!Array.isArray(candidates) || candidates.length === 0) {
    /* A grant with no candidates cannot be acted on. The player would go
     * straight to `fatal` with `no_candidates` -- a true statement made by the
     * layer that does not know why. `unavailable` is the outcome for that. */
    problems.push("session.candidates is empty on a granted session");
  } else {
    const ids = new Set<string>();
    candidates.forEach((candidate, index) => {
      if (!isRecord(candidate)) {
        problems.push(`session.candidates[${index}] is not an object`);
        return;
      }
      const id = candidate["id"];
      if (typeof id !== "string" || id === "") {
        problems.push(`session.candidates[${index}].id is empty`);
      } else if (ids.has(id)) {
        /* The id is the key a player attributes failures against. Two streams
         * sharing one means every failover decision about either is made from
         * the other's evidence. */
        problems.push(`session.candidates[${index}].id "${id}" is a duplicate`);
      } else {
        ids.add(id);
      }
      if (typeof candidate["providerId"] !== "string" || candidate["providerId"] === "") {
        problems.push(`session.candidates[${index}].providerId is empty`);
      }
      if (typeof candidate["uri"] !== "string" || candidate["uri"] === "") {
        problems.push(`session.candidates[${index}].uri is empty`);
      }
      if (!("mimeType" in candidate)) {
        problems.push(`session.candidates[${index}] has no mimeType key`);
      }
      const compatibility = candidate["compatibility"];
      if (compatibility !== "verified" && compatibility !== "unverified") {
        problems.push(`session.candidates[${index}].compatibility is ${JSON.stringify(compatibility)}`);
      }
    });
  }

  const startAt = session["startAtSeconds"];
  if (!("startAtSeconds" in session)) {
    problems.push("session has no startAtSeconds key");
  } else if (startAt !== null && (typeof startAt !== "number" || startAt < 0)) {
    problems.push("session.startAtSeconds is neither null nor a non-negative number");
  }

  const expiresAt = session["expiresAt"];
  if (typeof expiresAt !== "string" || Number.isNaN(Date.parse(expiresAt))) {
    problems.push("session.expiresAt is not an ISO datetime");
  }

  const policy = session["failoverPolicy"];
  if (!isRecord(policy)) {
    /* Published rather than left for the client to hardcode: a client with its
     * own copy is a second policy that can disagree with the reason trail this
     * same response published. */
    problems.push("session.failoverPolicy is missing");
  }

  return problems;
}

/**
 * The status a response of this shape must have arrived with.
 *
 * `denied` splits on the primary reason because the two codes mean different
 * things downstream: 400 tells a client to fix its request, 403 is a rights
 * signal that lands in the metrics a rights review reads. `unavailable` splits
 * for the mirror-image reason -- telling a client a title does not exist
 * because a provider timed out is how a viewer concludes their library lost
 * something.
 */
export function expectedStatus(body: PlaybackSessionResponseShape): number {
  const primary = body.reasons[0];
  switch (body.outcome) {
    case "granted":
      return 200;
    case "denied":
      return primary !== undefined && REQUEST_LEVEL_DENIALS.includes(primary.code) ? 400 : 403;
    case "unavailable":
      return primary !== undefined && primary.code === "content_not_found" ? 404 : 503;
  }
}

export function reasonCodes(body: PlaybackSessionResponseShape): string[] {
  return body.reasons.map((reason) => reason.code);
}

/**
 * Every string anywhere in a JSON value.
 *
 * Used to ask "did this response echo something the client sent, anywhere at
 * all". Checking named fields would only find the leak in the field somebody
 * already thought of, and the whole point of the assertion is the field nobody
 * thought of.
 */
export function collectStrings(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const entry of value) collectStrings(entry, into);
  else if (isRecord(value)) for (const entry of Object.values(value)) collectStrings(entry, into);
  return into;
}

/** Every object key anywhere in a JSON value, for "no route publishes a media address". */
export function collectKeys(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) for (const entry of value) collectKeys(entry, into);
  else if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      into.push(key);
      collectKeys(entry, into);
    }
  }
  return into;
}
