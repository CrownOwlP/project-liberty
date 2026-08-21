import {
  DEFAULT_FAILOVER_POLICY,
  PLAYABLE_RIGHTS,
  rankStreamCandidates,
  type RejectionReason
} from "@liberty/media-engine";
import { checkUrl, compareCodePoint } from "@liberty/provider-sdk";
import { z } from "zod";
import {
  resolveAuthorizedCandidates,
  type AuthorizedCandidate,
  type AuthorizedCandidateResolution,
  type AuthorizedCandidateResolver
} from "./authorized-candidates";
import {
  deniedSession,
  engineReasonCode,
  grantedSession,
  playbackReason,
  playbackSessionRequestSchema,
  unavailableSession,
  urlReasonCode,
  PLAYBACK_SESSION_TTL_MS,
  type PlaybackSessionCandidate,
  type PlaybackSessionReason,
  type PlaybackSessionResponse
} from "./contract";

/* -------------------------------------------------------------------------
 * Issuing a playback session (PL-0501)
 *
 * The whole decision, as one pure-ish function of an UNTRUSTED body and a set
 * of injected capabilities. It never throws: every path a caller can reach --
 * including "the body is the number 7" and "the resolver blew up" -- returns a
 * well-formed member of the response union, with reasons. An endpoint that can
 * throw is an endpoint whose failure mode is a stack trace with no reason
 * trail, which is exactly what invariant 4 exists to prevent.
 *
 * THE ORDER OF THE GATES IS THE POINT, and it is:
 *
 *   1. SHAPE.      Validate the request. Nothing the client sent reaches a
 *                  resolver, an adapter or a URL parser before this passes.
 *   2. RESOLUTION. Ask the server-side resolver for authorized candidates for
 *                  the content id. This is the only source of media URLs.
 *   3. RIGHTS.     Refuse anything not on the playable allowlist -- BEFORE a
 *                  single codec, height, health score, URL or ID is looked at.
 *   4. IDENTITY.   Collapse what rights admitted to distinct ids, so every later
 *                  comparator is total and every failure is attributable.
 *   5. ELIGIBILITY + SCORING. `@liberty/media-engine`.
 *   6. TRANSPORT.  `@liberty/provider-sdk`'s outbound URL policy, over what
 *                  survived, immediately before any URL is published.
 *
 * RIGHTS PRECEDE IDENTITY, and that is a correction rather than a preference.
 * With the identity gate first, two copies of an unrightsed candidate were both
 * dropped as `duplicate_candidate_id` and the rights refusal was never reported
 * at all -- the line a rights review reads, replaced by a resolver-hygiene
 * notice. Everywhere else in this project rights are settled first; the
 * duplicate drop was the one place that quietly was not, and the property suite
 * could not see it because its generator produces distinct ids only.
 *
 * Step 3 is separated from step 5 even though `rankStreamCandidates` also
 * checks rights first. That is not redundancy for its own sake: it is the
 * difference between "the engine happens to check rights first today" and "an
 * unrightsed candidate is never handed to the engine at all". A candidate that
 * never enters resolution cannot be scored, ranked, logged as a near-miss, or
 * reported with a technical reason that would tell a viewer their device was at
 * fault when the real answer was that we have no right to serve the stream.
 * There is still ONE allowlist -- `PLAYABLE_RIGHTS`, imported from the engine,
 * where it is itself an alias of `@liberty/contracts`' `PLAYABLE_CONTENT_RIGHTS`
 * -- consulted at two points, not two allowlists that can drift.
 *
 * DETERMINISM. This repository has had six order-dependence defects and treats
 * determinism as correctness. The response is a function of the SET of resolved
 * candidates, not of the order the resolver happened to return them in: ids are
 * made distinct, the list is canonicalised by code point before ranking, and
 * every reason list is built in a fixed sequence from lists that are themselves
 * ordered. `issue-session.property.test.ts` permutes the input and requires an
 * identical whole response.
 * ---------------------------------------------------------------------- */

/** The non-empty candidate list `issuedPlaybackSessionSchema` requires, named so
 * the assertion at the one construction site can be read at a glance. */
type NonEmptyCandidates = [PlaybackSessionCandidate, ...PlaybackSessionCandidate[]];

/**
 * Everything this function will not decide for itself.
 *
 * The clock and the id generator are INPUTS rather than ambient calls, because
 * "the response is deterministic given identical inputs" is only a testable
 * claim if the non-deterministic parts are inputs. A session id must be
 * unguessable in production and pinned in a property test, and those are the
 * same requirement stated from two ends.
 *
 * `localDeployment` is threaded from the process boundary and defaults to
 * "hosted" in production, matching `url-policy.ts`: an instance that never says
 * it is local is not local, and no source configuration can say it on its
 * behalf.
 */
export interface IssueSessionOptions {
  readonly resolve?: AuthorizedCandidateResolver;
  readonly now?: () => Date;
  readonly newId?: () => string;
  readonly localDeployment?: boolean;
  readonly sessionTtlMs?: number;
}

/** Human text for an engine eligibility rejection. Exhaustive on purpose: a new
 * `RejectionReason` fails to compile here rather than reaching a viewer as an
 * unexplained code. */
function describeEngineRejection(reason: RejectionReason): string {
  switch (reason) {
    case "rights_not_playable":
      return "the candidate's rights basis is not on the playable allowlist";
    case "unsupported_video_codec":
      return "the device did not list the video codec this candidate states";
    case "unsupported_audio_codec":
      return "the device did not list the audio codec this candidate states";
    case "resolution_exceeds_capability":
      return "the candidate's stated height is above the device's ceiling";
    case "provider_health_below_floor":
      return "the provider's health score is below the playable floor";
  }
}

/**
 * One validation failure, as a reason.
 *
 * An unrecognised key gets its own code rather than being folded into
 * `request_malformed`, because it is the one validation failure that is a
 * RIGHTS event: it is a client trying to hand this endpoint a field it does not
 * accept, and the field a client would most like to hand it is a media URL. It
 * needs to be visible as itself in logs and metrics, not averaged into typos.
 */
function issueReason(issue: z.ZodIssue): PlaybackSessionReason {
  if (issue.code === "unrecognized_keys") {
    /* Sorted so the message is a function of the SET of extra keys rather than
     * of the order the client happened to serialise them in. */
    const keys = [...issue.keys].sort(compareCodePoint).join(", ");
    const where = issue.path.length === 0 ? "the request" : issue.path.join(".");
    return playbackReason(
      "request_field_not_permitted",
      `${where} carries field(s) this endpoint does not accept: ${keys}`
    );
  }

  const where = issue.path.length === 0 ? "request" : issue.path.join(".");
  return playbackReason("request_malformed", `${where}: ${issue.message}`);
}

/**
 * Refusals ordered so a smuggled field is always the PRIMARY reason.
 *
 * A client that posts `{ contentId, uri }` produces two issues -- an unaccepted
 * field and a missing `capabilities` -- and if the missing field spoke first,
 * the rights-boundary refusal would be buried in a trail nobody reads past the
 * first line of. Ties break on the detail text by code point, so the whole list
 * is a function of the request rather than of zod's traversal.
 */
function orderedRequestReasons(issues: readonly z.ZodIssue[]): PlaybackSessionReason[] {
  const rank = (reason: PlaybackSessionReason): number =>
    reason.code === "request_field_not_permitted" ? 0 : 1;

  return issues
    .map(issueReason)
    .sort((a, b) => rank(a) - rank(b) || compareCodePoint(a.detail, b.detail));
}

/**
 * Issues a playback session, or explains why it did not.
 *
 * `body` is `unknown` deliberately: the parse is part of the decision, so a
 * malformed request is answered with the same union as a rights refusal instead
 * of being a different kind of event that some caller forgets to handle.
 */
export async function issuePlaybackSession(
  body: unknown,
  options: IssueSessionOptions = {}
): Promise<PlaybackSessionResponse> {
  const resolve = options.resolve ?? resolveAuthorizedCandidates;
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => crypto.randomUUID());
  const localDeployment = options.localDeployment ?? process.env.NODE_ENV !== "production";
  const sessionTtlMs = options.sessionTtlMs ?? PLAYBACK_SESSION_TTL_MS;

  /* ---- 1. Shape ------------------------------------------------------- */

  const parsed = playbackSessionRequestSchema.safeParse(body);
  if (!parsed.success) {
    const [primary, ...rest] = orderedRequestReasons(parsed.error.issues);
    /* zod never reports a failure with zero issues, but the type does not say
     * so, and a `!` here would be the one place in this file where the trail
     * depends on a library's undocumented behaviour. */
    if (primary === undefined) {
      return deniedSession(
        playbackReason("request_malformed", "the request did not match the playback session contract")
      );
    }
    return deniedSession(primary, ...rest);
  }

  const { contentId, capabilities } = parsed.data;

  /* ---- 2. Resolution -------------------------------------------------- */

  let resolution: AuthorizedCandidateResolution;
  try {
    resolution = await resolve(contentId, { requestId: newId() });
  } catch {
    /*
     * The thrown value is NOT echoed. A resolver talks to third parties and its
     * exception text is whatever a library felt like saying -- an internal
     * hostname, a query string, a credential in a URL. The deliberate
     * `provider-unavailable` branch below carries a `detail` the resolver CHOSE
     * to publish, which is safe by construction; a throw did not choose
     * anything.
     */
    return unavailableSession(
      playbackReason("provider_unavailable", "the candidate resolver failed before it could answer")
    );
  }

  if (resolution.status === "not-found") {
    return unavailableSession(
      playbackReason("content_not_found", `no title is registered under the id ${contentId}`)
    );
  }
  if (resolution.status === "not-configured") {
    return unavailableSession(
      playbackReason(
        "provider_not_configured",
        "no authorized media provider is configured for this deployment"
      )
    );
  }
  if (resolution.status === "provider-unavailable") {
    return unavailableSession(playbackReason("provider_unavailable", resolution.detail));
  }

  const resolved = resolution.candidates;
  if (resolved.length === 0) {
    return unavailableSession(
      playbackReason("no_candidates_resolved", `no provider offered a stream for ${contentId}`)
    );
  }

  /* ---- 3. Rights, before anything technical and before identity -------- */

  /*
   * Refusals are collected BY ID rather than per resolved entry, and that is
   * what makes this gate safe to run ahead of the duplicate drop:
   *
   *   - an id refused once is refused, so a resolver that repeats itself adds no
   *     second line to the trail. "An unrightsed candidate carries exactly one
   *     reason and it is the rights one" is asserted by the property suite and
   *     has to survive a repeated id, which the generator never produces;
   *   - an id resolved under BOTH a playable and an unplayable basis is refused
   *     as a whole. The two copies are indistinguishable by the only key
   *     anything downstream has, so admitting the id would be admitting a stream
   *     we may have no right to serve. Refusing is the reversible direction.
   *
   * The map is keyed by id and holds the set of unplayable bases seen under it,
   * listed by code point in the detail so the text is a function of the SET and
   * not of the order the resolver returned them in.
   */
  const refusedRights = new Map<string, Set<string>>();
  for (const entry of resolved) {
    if (PLAYABLE_RIGHTS.includes(entry.candidate.rights)) continue;
    const bases = refusedRights.get(entry.candidate.id) ?? new Set<string>();
    bases.add(entry.candidate.rights);
    refusedRights.set(entry.candidate.id, bases);
  }

  const rightsReasons: PlaybackSessionReason[] = [...refusedRights.entries()]
    .sort(([left], [right]) => compareCodePoint(left, right))
    .map(([id, bases]) => {
      const quoted = [...bases].sort(compareCodePoint).map((basis) => `"${basis}"`).join(", ");
      return playbackReason(
        "rights_not_playable",
        (bases.size === 1
          ? `rights basis ${quoted} is not on the playable allowlist`
          : `rights bases ${quoted} are not on the playable allowlist`) +
          ", so this candidate was never entered into playback resolution",
        id
      );
    });

  const rightsed = resolved.filter((entry) => !refusedRights.has(entry.candidate.id));

  if (rightsed.length === 0) {
    /*
     * DENIED, not `unavailable`. Nothing about this is transient and retrying
     * is not robustness -- it is a second attempt to play something we are not
     * entitled to play. The remedy is a rights one, and the outcome has to say
     * so or a client will schedule a retry against it forever.
     */
    return deniedSession(
      playbackReason(
        "rights_not_established",
        `no candidate for ${contentId} carries a rights basis this platform may play from`
      ),
      ...rightsReasons
    );
  }

  /* ---- 4. Identity ---------------------------------------------------- */

  /*
   * Candidate ids must be distinct, and a duplicate is dropped rather than
   * deduplicated. Two reasons, both load-bearing:
   *
   *   - ATTRIBUTION. The id is the key a player reports failures against
   *     (`PlaybackAttemptFailure`). Two streams sharing one id means every
   *     failover decision about either is made from the other's evidence.
   *   - DETERMINISM. Every comparator downstream terminates in a code-point
   *     tiebreak on the id, which is total only while ids are distinct. Keeping
   *     "the first one" would make the survivor depend on the resolver's
   *     ordering -- exactly the class of defect this project has already found
   *     six of. Dropping ALL entries that share an id is the only rule whose
   *     result does not depend on input order.
   *
   * Counted over what rights admitted, not over everything resolved: an id the
   * rights gate already refused is gone, and counting it here would only let it
   * report a second, less informative reason for the same drop.
   */
  const occurrences = new Map<string, number>();
  for (const entry of rightsed) {
    occurrences.set(entry.candidate.id, (occurrences.get(entry.candidate.id) ?? 0) + 1);
  }

  const duplicateReasons = [...occurrences.entries()]
    .filter(([, count]) => count > 1)
    .map(([id]) => id)
    .sort(compareCodePoint)
    .map((id) =>
      playbackReason(
        "duplicate_candidate_id",
        "the resolver returned more than one candidate under this id, so no failure reported " +
          "against it could be attributed; all of them were dropped",
        id
      )
    );

  /*
   * Canonicalised before anything reads it. The engine's comparator is already
   * total over distinct ids, so this changes no answer today -- it makes the
   * response order-invariant even if that ever stops being true, and it means
   * the property test is checking this route rather than checking the engine.
   */
  const authorized: readonly AuthorizedCandidate[] = rightsed
    .filter((entry) => occurrences.get(entry.candidate.id) === 1)
    .sort((a, b) => compareCodePoint(a.candidate.id, b.candidate.id));

  if (authorized.length === 0) {
    /*
     * `unavailable`, not `denied`: everything that reached this point carried a
     * rights basis we may play from and lost on attribution, which is a resolver
     * problem and can stop being true on the next request. Reporting it as a
     * rights refusal would also have been a false statement -- these candidates
     * are exactly the ones whose rights we DID establish.
     */
    return unavailableSession(
      playbackReason(
        "no_candidates_resolved",
        `every candidate for ${contentId} carrying a playable rights basis shared an id with another`
      ),
      ...rightsReasons,
      ...duplicateReasons
    );
  }

  /* ---- 5. Eligibility and scoring ------------------------------------- */

  const decision = rankStreamCandidates(
    authorized.map((entry) => entry.candidate),
    capabilities
  );

  /* Already sorted by candidate id inside the engine, so this list is a
   * function of the candidate set and not of the order it was handed over. */
  const eligibilityReasons = decision.rejected.map((entry) =>
    playbackReason(engineReasonCode(entry.reason), describeEngineRejection(entry.reason), entry.candidateId)
  );

  /* ---- 6. Transport, immediately before a URL is published ------------ */

  const sources = new Map(authorized.map((entry) => [entry.candidate.id, entry.source]));
  const playable: PlaybackSessionCandidate[] = [];
  const transportReasons: PlaybackSessionReason[] = [];
  const rankedReasons: PlaybackSessionReason[] = [];

  for (const entry of decision.ranked) {
    const id = entry.candidate.id;
    const source = sources.get(id);

    if (source === undefined) {
      /* Reachable only if the ranking returned an id it was not given, which is
       * a defect rather than a data problem -- so it is reported rather than
       * skipped in silence. */
      transportReasons.push(
        playbackReason("candidate_source_missing", "ranked, but no authorized source was issued for it", id)
      );
      continue;
    }

    /*
     * The SSRF and transport gate, run here rather than trusted from the
     * adapter. It is the same `checkUrl` the provider SDK runs before it
     * fetches anything, and this is the last moment before a URL leaves the
     * server -- a resolver that was compromised, misconfigured, or simply new
     * gets no opportunity to publish `http://169.254.169.254/...`, a `magnet:`,
     * a `file:` or an origin carrying embedded credentials.
     */
    const check = checkUrl(source.uri, { allowLoopback: source.allowLoopback, localDeployment });
    if (!check.ok) {
      transportReasons.push(playbackReason(urlReasonCode(check.reason), check.detail, id));
      continue;
    }

    playable.push({
      id,
      providerId: entry.candidate.providerId,
      /* The PARSED form, so what ships is byte-for-byte what the policy
       * checked. Publishing the raw string would leave a gap between the URL
       * that was validated and the URL a player fetches. */
      uri: check.url.toString(),
      /* An empty string is normalised to `null` because it is a plausible
       * value rather than a contract violation: an origin that answered with a
       * blank `Content-Type` has told us nothing, which is exactly what `null`
       * means here. Publishing `""` would fail this response's own schema and
       * turn a working stream into a 500. */
      mimeType: source.mimeType === null || source.mimeType.trim() === "" ? null : source.mimeType,
      compatibility: entry.compatibility
    });
    rankedReasons.push(playbackReason("candidate_ranked", entry.reason, id));
  }

  const [head, ...rest] = playable;
  if (head === undefined) {
    /*
     * `unavailable`, not `denied`: by this point every remaining candidate had
     * a rights basis we may play from, and lost on a codec, a ceiling, a health
     * score or a URL. None of those is a refusal, and calling it one would
     * report a device or provider problem as an entitlement problem.
     */
    return unavailableSession(
      playbackReason(
        "no_playable_candidate",
        `no candidate for ${contentId} survived eligibility and transport checks`
      ),
      /* Trail in gate order -- rights, identity, eligibility, transport -- so a
       * reader walks it in the order the decisions were actually taken. */
      ...rightsReasons,
      ...duplicateReasons,
      ...eligibilityReasons,
      ...transportReasons
    );
  }

  /*
   * Read off the HEAD OF THE PUBLISHED LIST rather than off `decision.selected`.
   * They can differ: the engine's pick may have failed the transport check and
   * been dropped, and reporting the session as verified because the candidate
   * we are NOT sending was verified would be a reason trail describing a choice
   * nobody made.
   */
  const primaryCode =
    head.compatibility === "verified" ? "session_issued" : "session_issued_unverified_compatibility";

  const issuedAt = now();

  return grantedSession(
    {
      sessionId: newId(),
      contentId,
      /* The tuple is asserted rather than left to the contextual type to infer.
       * `issuedPlaybackSessionSchema` requires a NON-EMPTY list, `head` is
       * non-optional by the guard above, and whether a spread literal widens to
       * an array or stays a tuple is one of the few things here that depends on
       * inference rules rather than on something written down. */
      candidates: [head, ...rest] as NonEmptyCandidates,
      /* `null`, not `0`: engine default, which is the beginning for VOD and the
       * live edge for live. PL-0403 is what will set a resume point. */
      startAtSeconds: null,
      expiresAt: new Date(issuedAt.getTime() + sessionTtlMs).toISOString(),
      failoverPolicy: DEFAULT_FAILOVER_POLICY
    },
    playbackReason(
      primaryCode,
      `${playable.length} candidate(s) authorized and ranked for ${contentId}`
    ),
    ...rightsReasons,
    ...duplicateReasons,
    ...eligibilityReasons,
    ...transportReasons,
    ...rankedReasons
  );
}
