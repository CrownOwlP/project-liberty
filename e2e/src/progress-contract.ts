/* -------------------------------------------------------------------------
 * The progress and profile wire contracts, restated by hand
 *
 * WHY THIS IS NOT AN IMPORT, for the reason `contract.ts` gives about the
 * playback session: parsing the response with the server's own
 * `progressResponseSchema` would assert only that the server agrees with itself,
 * so a change that relaxed `reasons` from `.nonempty()` to `.optional()` would
 * relax this check in the same commit and the gate would stay green through the
 * regression it exists to catch.
 *
 * So the PROPERTIES are written out independently, from
 * `apps/web/src/app/api/v1/progress/contract.ts`'s stated invariants:
 *
 *   - exactly one of five outcomes, discriminated on `outcome`;
 *   - a non-empty reason trail on EVERY branch, refusals included;
 *   - reasons are codes with a human `detail` and NOTHING ELSE -- the progress
 *     trail line is `{ code, detail }` and, unlike a playback reason, carries no
 *     `candidateId`, because a resume point is about a title and not about a
 *     candidate;
 *   - the payload a branch carries is decided by the branch: `read` publishes a
 *     nullable row, `written` a row, `leased` a lease, and the two refusing
 *     branches publish neither;
 *   - the HTTP status is derivable from the outcome, so the wire status and the
 *     decision cannot disagree.
 *
 * The status mapping is reimplemented here for the same reason. Importing
 * `progressHttpStatus` would make "the status matches the outcome" a tautology.
 * ---------------------------------------------------------------------- */

import { isRecord } from "./contract";

export type ProgressOutcome = "read" | "leased" | "written" | "refused" | "unavailable";

export interface ProgressReasonLine {
  readonly code: string;
  readonly detail: string;
}

export interface ProgressResponseShape {
  readonly outcome: ProgressOutcome;
  readonly reasons: readonly ProgressReasonLine[];
  readonly progress?: unknown;
  readonly lease?: unknown;
}

const OUTCOMES: readonly string[] = ["read", "leased", "written", "refused", "unavailable"];

/** A reason CODE, not prose. Same rule, same reason, as the playback trail. */
const REASON_CODE = /^[a-z0-9_]+$/;

/**
 * Refusals a caller fixes by sending something different (400), and refusals
 * about who holds the write (409).
 *
 * Restated from the contract's own two lists. Everything else that reaches
 * `refused` is an authorization denial and is 403 -- including
 * `profile_unavailable`, where a 404 would restore exactly the "does this id
 * exist" oracle the external reason vocabulary was collapsed to remove.
 */
const CLIENT_INPUT_REFUSALS: readonly string[] = [
  "request_malformed",
  "request_field_not_permitted",
  "development_identifier_malformed",
  "not_a_normalized_content_id",
  "position_not_representable",
  "position_beyond_runtime"
];

const WRITE_CONFLICT_REFUSALS: readonly string[] = [
  "no_writer_lease",
  "epoch_not_issued",
  "superseded_by_newer_writer",
  "writer_id_mismatch",
  "stale_write_within_writer"
];

/**
 * Structural check for one member of the union. Returns the problems it found
 * rather than throwing, so a spec can report ALL of them at once.
 */
export function progressViolations(body: unknown): string[] {
  const problems: string[] = [];

  if (!isRecord(body)) return ["response body is not a JSON object"];

  const outcome = body["outcome"];
  if (typeof outcome !== "string" || !OUTCOMES.includes(outcome)) {
    problems.push(`outcome is ${JSON.stringify(outcome)}, not one of ${OUTCOMES.join("/")}`);
  }

  problems.push(...reasonViolations(body["reasons"], outcome));

  /*
   * The payload rules, both directions. "The branch that should carry a row does"
   * is the half people write; "the branch that refuses carries nothing" is the
   * half with teeth, because a refusal shipping a progress row would hand a
   * client a resume point attached to a decision that said no.
   */
  const hasProgress = "progress" in body;
  const hasLease = "lease" in body;

  if (outcome === "read") {
    if (!hasProgress) problems.push("read response has no progress key");
    else if (body["progress"] !== null) problems.push(...progressViewViolations(body["progress"]));
    if (hasLease) problems.push("read response carries a lease");
  }
  if (outcome === "written") {
    if (!hasProgress) problems.push("written response has no progress key");
    else if (body["progress"] === null) problems.push("written response carries a null progress");
    else problems.push(...progressViewViolations(body["progress"]));
    if (hasLease) problems.push("written response carries a lease");
  }
  if (outcome === "leased") {
    if (!hasLease) problems.push("leased response has no lease key");
    else problems.push(...leaseViolations(body["lease"]));
    if (hasProgress) problems.push("leased response carries a progress row");
  }
  if (outcome === "refused" || outcome === "unavailable") {
    if (hasProgress) problems.push(`${outcome} response carries a progress row`);
    if (hasLease) problems.push(`${outcome} response carries a lease`);
  }

  return problems;
}

function reasonViolations(reasons: unknown, outcome: unknown): string[] {
  const problems: string[] = [];

  if (!Array.isArray(reasons)) return ["reasons is not an array"];
  if (reasons.length === 0) {
    /* Invariant 4. A refusal with no trail is unanswerable by the viewer,
     * unactionable by support and undebuggable by us -- checked on every branch
     * and not only on the interesting one. */
    return [`outcome ${String(outcome)} carries an empty reason trail`];
  }

  reasons.forEach((line, index) => {
    if (!isRecord(line)) {
      problems.push(`reasons[${index}] is not an object`);
      return;
    }
    const code = line["code"];
    if (typeof code !== "string" || !REASON_CODE.test(code)) {
      problems.push(`reasons[${index}].code is ${JSON.stringify(code)}, not a snake_case code`);
    }
    const detail = line["detail"];
    if (typeof detail !== "string" || detail.trim() === "") {
      problems.push(`reasons[${index}].detail is empty`);
    }
    /* The line is `.strict()` server-side and is two fields on purpose: the code
     * is what a machine reads and the detail is what a person reads. A third key
     * here means something started travelling in the trail that no consumer was
     * told about. */
    const extra = Object.keys(line).filter((key) => key !== "code" && key !== "detail");
    if (extra.length > 0) {
      problems.push(`reasons[${index}] carries unexpected key(s) ${extra.join(", ")}`);
    }
  });

  return problems;
}

/**
 * A published progress row.
 *
 * `positionSeconds` IS NULLABLE AND `null` IS NOT `0`. A row created by a lease
 * has been claimed for writing and never watched; a client reading that as zero
 * would offer "continue watching" at 0:00 for a title nobody started.
 * `runtimeSeconds` is nullable for the neighbouring reason -- an absent duration
 * must not be inferred, and a zero would make every title look complete.
 */
function progressViewViolations(view: unknown): string[] {
  const problems: string[] = [];
  if (!isRecord(view)) return ["progress is neither null nor a JSON object"];

  if (typeof view["contentId"] !== "string" || view["contentId"] === "") {
    problems.push("progress.contentId is empty");
  }

  const position = view["positionSeconds"];
  if (!("positionSeconds" in view)) problems.push("progress has no positionSeconds key");
  else if (position !== null && !isWholeAtLeast(position, 0)) {
    problems.push("progress.positionSeconds is neither null nor a whole non-negative number");
  }

  const runtime = view["runtimeSeconds"];
  if (!("runtimeSeconds" in view)) problems.push("progress has no runtimeSeconds key");
  else if (runtime !== null && !isWholeAtLeast(runtime, 1)) {
    problems.push("progress.runtimeSeconds is neither null nor a whole positive number");
  }

  if (!isWholeAtLeast(view["writerEpoch"], 1)) {
    /* Epochs are allocated by the server and start at 1. A published `0` would
     * be a row claiming a lease that was never issued. */
    problems.push("progress.writerEpoch is not a positive whole number");
  }
  if (typeof view["writerId"] !== "string" || view["writerId"] === "") {
    problems.push("progress.writerId is empty");
  }
  if (!isWholeAtLeast(view["writeSeq"], 0)) {
    problems.push("progress.writeSeq is not a whole non-negative number");
  }

  const updatedAt = view["updatedAt"];
  if (typeof updatedAt !== "string" || Number.isNaN(Date.parse(updatedAt))) {
    problems.push("progress.updatedAt is not an ISO datetime");
  }

  /*
   * The account identifier must not be here, and neither must the profile id.
   * `progressViewSchema` publishes neither: a client already knows which profile
   * it selected, and echoing the id into every heartbeat response would put a
   * profile identifier into request logs at the highest request rate in the
   * product.
   */
  for (const forbidden of ["profileId", "userId"]) {
    if (forbidden in view) problems.push(`progress publishes ${forbidden}`);
  }

  return problems;
}

function leaseViolations(lease: unknown): string[] {
  const problems: string[] = [];
  if (!isRecord(lease)) return ["lease is not a JSON object"];

  if (!isWholeAtLeast(lease["epoch"], 1)) {
    problems.push("lease.epoch is not a positive whole number");
  }
  if (typeof lease["writerId"] !== "string" || lease["writerId"] === "") {
    problems.push("lease.writerId is empty");
  }
  return problems;
}

function isWholeAtLeast(value: unknown, minimum: number): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum;
}

/**
 * The status a response of this shape must have arrived with.
 *
 * `refused` splits three ways because the three mean different things to the
 * caller: 400 says fix the request, 409 says take a new lease, 403 says this
 * session may not act on that profile. `unavailable` is always 503 and never
 * 500 -- none of the conditions that reach it is a fault in handling the
 * request, and all of them are things an operator can act on.
 */
export function expectedProgressStatus(shape: ProgressResponseShape): number {
  switch (shape.outcome) {
    case "read":
    case "leased":
    case "written":
      return 200;
    case "unavailable":
      return 503;
    case "refused": {
      const primary = shape.reasons[0];
      if (primary === undefined) return 403;
      if (CLIENT_INPUT_REFUSALS.includes(primary.code)) return 400;
      if (WRITE_CONFLICT_REFUSALS.includes(primary.code)) return 409;
      return 403;
    }
  }
}

export function progressReasonCodes(shape: ProgressResponseShape): string[] {
  return shape.reasons.map((line) => line.code);
}

/* -------------------------------------------------------------------------
 * Profiles
 *
 * The progress leg cannot be reached without them -- progress is scoped to the
 * profile a session SELECTED, and there is no field through which a client can
 * name one -- so the two responses this suite needs from that group are checked
 * here too rather than being read as untyped JSON in the middle of a progress
 * test.
 * ---------------------------------------------------------------------- */

export type ProfilesOutcome = "listed" | "created" | "selected" | "refused" | "unavailable";

export interface ProfilesResponseShape {
  readonly outcome: ProfilesOutcome;
  readonly reasons: readonly ProgressReasonLine[];
  readonly profiles?: unknown;
  readonly profile?: unknown;
  readonly profileId?: unknown;
  readonly activeProfileId?: unknown;
}

const PROFILE_OUTCOMES: readonly string[] = [
  "listed",
  "created",
  "selected",
  "refused",
  "unavailable"
];

/**
 * The same structural check for the profile group.
 *
 * `created` answers 201 and is the only call in the product that brings a
 * resource into existence; the other two grants answer 200. The refusal split is
 * the group's own: 400 for malformed input, 409 for a state conflict (the
 * household is at its ceiling, or the name is taken), 403 for everything else.
 */
export function profilesViolations(body: unknown): string[] {
  const problems: string[] = [];

  if (!isRecord(body)) return ["response body is not a JSON object"];

  const outcome = body["outcome"];
  if (typeof outcome !== "string" || !PROFILE_OUTCOMES.includes(outcome)) {
    problems.push(`outcome is ${JSON.stringify(outcome)}, not one of ${PROFILE_OUTCOMES.join("/")}`);
  }

  problems.push(...reasonViolations(body["reasons"], outcome));

  if (outcome === "listed") {
    if (!Array.isArray(body["profiles"])) problems.push("listed response has no profiles array");
    if (!("activeProfileId" in body)) {
      /* Required-and-nullable: `null` is "signed in, nothing chosen yet", which
       * is the profile picker's own state and a real answer. An absent key says
       * only that somebody did not think about it. */
      problems.push("listed response has no activeProfileId key");
    }
  }
  if (outcome === "created") problems.push(...profileViewViolations(body["profile"]));
  if (outcome === "selected") {
    if (typeof body["profileId"] !== "string" || body["profileId"] === "") {
      problems.push("selected response has no profileId");
    }
  }
  if (outcome === "refused" || outcome === "unavailable") {
    for (const key of ["profile", "profiles", "profileId"]) {
      if (key in body) problems.push(`${outcome} response carries ${key}`);
    }
  }

  return problems;
}

function profileViewViolations(profile: unknown): string[] {
  const problems: string[] = [];
  if (!isRecord(profile)) return ["profile is not a JSON object"];

  if (typeof profile["id"] !== "string" || profile["id"] === "") problems.push("profile.id is empty");
  if (typeof profile["displayName"] !== "string" || profile["displayName"] === "") {
    problems.push("profile.displayName is empty");
  }
  const createdAt = profile["createdAt"];
  if (typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt))) {
    problems.push("profile.createdAt is not an ISO datetime");
  }
  /* `user_id` is the ACCOUNT identifier and is never published: nothing a client
   * does with a profile needs it, and a household's account id in a response body
   * is the kind of value that ends up in a URL, a log or an analytics event. */
  if ("userId" in profile) problems.push("profile publishes userId");

  return problems;
}

const PROFILE_INPUT_REFUSALS: readonly string[] = [
  "request_malformed",
  "request_field_not_permitted",
  "development_identifier_malformed",
  "display_name_is_blank",
  "display_name_too_long",
  "avatar_key_too_long",
  "max_rating_too_long"
];

const PROFILE_STATE_CONFLICTS: readonly string[] = [
  "profile_limit_reached",
  "display_name_already_used"
];

export function expectedProfilesStatus(shape: ProfilesResponseShape): number {
  switch (shape.outcome) {
    case "created":
      return 201;
    case "listed":
    case "selected":
      return 200;
    case "unavailable":
      return 503;
    case "refused": {
      const primary = shape.reasons[0];
      if (primary === undefined) return 403;
      if (PROFILE_INPUT_REFUSALS.includes(primary.code)) return 400;
      if (PROFILE_STATE_CONFLICTS.includes(primary.code)) return 409;
      return 403;
    }
  }
}
