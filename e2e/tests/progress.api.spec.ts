import { expect, test } from "@playwright/test";
import type { APIRequestContext, APIResponse } from "@playwright/test";
import {
  expectedProfilesStatus,
  expectedProgressStatus,
  profilesViolations,
  progressReasonCodes,
  progressViolations,
  type ProfilesResponseShape,
  type ProgressResponseShape
} from "../src/progress-contract";
import { isRecord } from "../src/contract";
import {
  DEPLOYMENT_PREAMBLE_REFUSAL,
  EXPECTED_STORAGE_ADAPTER,
  MANAGES_SERVER,
  WEB_MODE
} from "../src/env";
import { DEMO, developmentIdentity, type DevelopmentIdentity } from "../src/fixtures";

/* -------------------------------------------------------------------------
 * The progress leg of PL-0701's acceptance journey
 *
 * PL-0701's acceptance sentence is "catalog to title to player to PROGRESS
 * fixture journey is reproducible in CI", and until PL-0403 landed an HTTP
 * surface there was nothing here to reach: `playback-session.api.spec.ts` said
 * outright that `startAtSeconds` is always `null` and that no progress step
 * existed. The endpoints exist now, so the leg is asserted.
 *
 * IT IS NOT REACHED THROUGH THE UI, AND THAT IS STATED RATHER THAN FAKED.
 * Nothing under `apps/web/src/components/**` fetches `/api/v1/progress` or
 * `/api/v1/profiles` -- the player surface is handed a session and never asks
 * for a resume point, and there is no profile picker. So there is no click path
 * from the watch page to a progress write, and `critical-journey.spec.ts` does
 * not pretend otherwise: inventing one with a `data-testid` would make a test
 * pass and a gap invisible, which is the rule that file already follows for the
 * card-to-player step. The leg is asserted here, at the wire, which is where it
 * currently exists. When a client surface starts writing progress, the journey
 * spec gains the browser half and this file keeps the contract half.
 *
 * WHAT NO RUN OF THIS FILE CAN COVER: PostgreSQL. `lib/db/index.ts` records it
 * plainly -- there is no database in this environment, `postgres-repository.ts`
 * has never executed a statement, and the guarded `UPDATE`, the
 * `ON CONFLICT DO NOTHING` and the composite foreign key on
 * `active_profile_selection` are all unverified. A development run here
 * exercises the IN-MEMORY adapter, so what it proves is the HTTP contract, the
 * authorization ordering and the writer-epoch rule as this process implements
 * them -- not that the SQL behind the same interface agrees. Passing against a
 * `Map` is evidence about the `Map`. Every response names the adapter that
 * answered it and this file asserts that name, so a result recorded from here
 * cannot be mistaken for the `integration` gate those tasks still need.
 * ---------------------------------------------------------------------- */

const PROGRESS = (contentId: string): string => `/api/v1/progress/${contentId}`;
const LEASE = (contentId: string): string => `/api/v1/progress/${contentId}/lease`;
const PROFILES = "/api/v1/profiles";
const SELECTION = "/api/v1/profiles/selection";

/**
 * Which build this run measured, recorded on every result in this file.
 *
 * THE MODE IS PART OF THE EVIDENCE, for the reason the session and journey specs
 * give: this file asserts one thing under `production` and a different thing
 * under `development`, so a gate record that does not name the mode is half a
 * statement. `docs/E2E.md` states that both runs together are the gate.
 */
test.beforeEach(() => {
  test.info().annotations.push({ type: "web-mode", description: WEB_MODE });
});

const UNKNOWN_BUILD_SKIP_REASON =
  "Testing an external deployment whose build mode this harness was not told, so neither the " +
  "deployment refusal nor the development store is the right expectation. Point the harness at " +
  "a server it starts to assert either.";

const DEPLOYMENT_SKIP_REASON =
  "This server runs a production build, where the shared preamble refuses every request in this " +
  "group before it reaches a decision of its own: no storage is configured, or -- if one is -- " +
  "no authentication instance is constructed. That refusal is asserted by \"the whole progress " +
  "leg is decided by the build\" in this file rather than skipped. Set " +
  "LIBERTY_E2E_WEB_MODE=development to exercise the rule this test is about.";

/** Reads a progress response and asserts the union holds before anything else reads it. */
async function decision(response: APIResponse): Promise<ProgressResponseShape> {
  const body: unknown = await response.json();

  /* Reported as a list so one run names every violation. */
  expect(progressViolations(body), `response body: ${JSON.stringify(body)}`).toEqual([]);

  const shape = body as ProgressResponseShape;

  /* The status is DERIVED from the outcome on the server. Checking it against an
   * independently written mapping is what stops the wire status and the decision
   * drifting apart -- a 200 carrying a refusal is a client that records nothing
   * and reports nothing. */
  expect(response.status()).toBe(expectedProgressStatus(shape));

  /* Per-profile and changing on a heartbeat. A shared cache holding one would
   * serve one household's viewing position to another. */
  expect(response.headers()["cache-control"]).toContain("no-store");

  return shape;
}

/** The same, for the profile group the progress leg has to pass through. */
async function profileDecision(response: APIResponse): Promise<ProfilesResponseShape> {
  const body: unknown = await response.json();
  expect(profilesViolations(body), `response body: ${JSON.stringify(body)}`).toEqual([]);
  const shape = body as ProfilesResponseShape;
  expect(response.status()).toBe(expectedProfilesStatus(shape));
  expect(response.headers()["cache-control"]).toContain("no-store");
  return shape;
}

/**
 * A household with one profile, selected.
 *
 * Every step is asserted rather than assumed, because a silent failure here
 * would surface as a progress refusal three requests later and would be read as
 * a defect in the progress route. The two calls are also the only way to reach
 * the progress leg at all: progress is scoped to the profile a session SELECTED,
 * and there is deliberately no field through which a client can name one.
 */
async function selectedProfileFor(
  request: APIRequestContext,
  identity: DevelopmentIdentity
): Promise<string> {
  const created = await profileDecision(
    await request.post(PROFILES, {
      headers: identity.headers,
      /*
       * `avatarKey` and `maxRating` are REQUIRED AND NULLABLE rather than
       * optional, which is this repository's rule for an unknown fact: `null`
       * says "this profile has no avatar", an absent key says only that somebody
       * did not think about it. Sending them is what a correct client does.
       */
      data: { displayName: "E2E viewer", avatarKey: null, maxRating: null }
    })
  );
  expect(created.outcome).toBe("created");

  const profile = isRecord(created.profile) ? created.profile : {};
  /* Typed rather than coerced: `String(undefined)` is a five-character string,
   * so a length check on the coerced value would pass for a response that
   * published no id at all. */
  const id = profile["id"];
  expect(typeof id, "the created profile carries no id").toBe("string");
  const profileId = String(id);

  /*
   * SELECTION IS A SEPARATE CALL because creating a profile does not select it --
   * the server says so in the creation reason, and modelling selection as a
   * property of the profile rather than of the session would make one device's
   * choice look like an edit to a shared resource.
   */
  const selected = await profileDecision(
    await request.post(SELECTION, { headers: identity.headers, data: { profileId } })
  );
  expect(selected.outcome).toBe("selected");
  expect(selected.profileId).toBe(profileId);

  return profileId;
}

test("a progress request produces a well-formed decision on any build", async ({ request }) => {
  /*
   * Deliberately NOT guarded on the mode. Whatever this deployment is, the
   * response has to be a member of the published union with a non-empty trail and
   * a status derived from its outcome -- `decision()` checks all three -- and the
   * refusing branches must carry neither a lease nor a row. That holds for a
   * hosted build refusing everything and for a development store answering
   * normally, which is exactly why it is the one test here that runs everywhere.
   */
  const identity = developmentIdentity("shape");
  const shape = await decision(
    await request.get(PROGRESS(DEMO.movie.id), { headers: identity.headers })
  );
  expect(["read", "leased", "written", "refused", "unavailable"]).toContain(shape.outcome);
});

test("which refusal a progress read meets is decided by the build, and both are asserted", async ({
  request
}) => {
  test.skip(!MANAGES_SERVER, UNKNOWN_BUILD_SKIP_REASON);

  const identity = developmentIdentity("refusal");
  const shape = await decision(
    await request.get(PROGRESS(DEMO.movie.id), { headers: identity.headers })
  );

  if (WEB_MODE === "production") {
    /*
     * NOT A DEGRADED PASS, and not the same refusal as the development branch.
     * A hosted build fails the SHARED PREAMBLE: `resolveRequestContext` resolves
     * storage first and identity second, and a deployment fails one of the two.
     * `unavailable` rather than `refused` because the remedy is an operator's;
     * 503 rather than 401 because there is no credential this deployment could
     * ask for.
     *
     * THE REASON IS EXACT rather than "some refusal", and it is derived from the
     * value the harness itself pinned: with no database the preamble stops at
     * `storage_not_configured`, and with one it gets past storage and stops at
     * `authentication_not_configured`, because nothing in `apps/web` constructs
     * `@liberty/auth/server` yet. Either way the request never reaches a
     * decision about a profile.
     */
    expect(shape.outcome).toBe("unavailable");
    expect(progressReasonCodes(shape)[0]).toBe(DEPLOYMENT_PREAMBLE_REFUSAL);

    /*
     * THE DEVELOPMENT HEADERS ARE READ BY NOTHING HERE, asserted rather than
     * assumed. `resolveRequestAccount` reaches `developmentAccount` only for a
     * `NonDeploymentEnvironment`, which `NODE_ENV=production` cannot produce, so
     * this request -- which names a household -- gets the identical refusal a
     * request naming none does. If it ever stopped doing so, a header would have
     * become an identity on a build that ships.
     */
    const anonymous = await decision(await request.get(PROGRESS(DEMO.movie.id)));
    expect(anonymous.outcome).toBe("unavailable");
    expect(progressReasonCodes(anonymous)[0]).toBe(DEPLOYMENT_PREAMBLE_REFUSAL);
    return;
  }

  /*
   * THE OTHER HALF OF THE PAIR. A development build gets all the way THROUGH the
   * preamble -- storage is the in-memory adapter, the development account is
   * admitted -- and is refused later and for a different reason: this session has
   * selected no profile, so there is no scope to read progress in. That is a 403
   * authorization denial rather than a 503, and the difference between the two
   * branches is the whole point of asserting both: a production run alone cannot
   * tell "refused because the deployment is unconfigured" from "refused because
   * the route is broken", and every check in that branch would be satisfied by a
   * server that had stopped working.
   */
  expect(shape.outcome).toBe("refused");
  expect(progressReasonCodes(shape)[0]).toBe("no_active_profile_selected");

  /*
   * And the trail names the store that answered. `request-context.ts` attaches
   * the adapter line to every outcome as soon as it is known, precisely so an
   * empty answer from a restarted development store is distinguishable from an
   * empty answer from a database -- and `playwright.config.ts` pins
   * `DATABASE_URL`, so which adapter this must be is something the harness
   * knows rather than guesses.
   */
  expect(progressReasonCodes(shape)).toContain(EXPECTED_STORAGE_ADAPTER);
});

test("the whole progress leg is decided by the build, and both are asserted", async ({
  request
}) => {
  test.skip(!MANAGES_SERVER, UNKNOWN_BUILD_SKIP_REASON);

  const identity = developmentIdentity("leg");

  if (WEB_MODE === "production") {
    /*
     * ASSERTED RATHER THAN SKIPPED, for the reason the session spec's production
     * branch is: a suite that went quiet under the mode CI actually builds would
     * say nothing about the only build that ships. What a hosted deployment must
     * do with a progress leg is refuse every step of it, with a stated reason and
     * without minting anything.
     *
     * The absence half is `progressViolations`'s: it treats an `unavailable`
     * response carrying a `lease` or a `progress` row as a violation, so "no
     * epoch was allocated and no row was published" is checked on all three
     * calls rather than being inferred from the status.
     */
    const creation = await profileDecision(
      await request.post(PROFILES, {
        headers: identity.headers,
        data: { displayName: "E2E viewer", avatarKey: null, maxRating: null }
      })
    );
    expect(creation.outcome).toBe("unavailable");
    expect(creation.reasons[0]?.code).toBe(DEPLOYMENT_PREAMBLE_REFUSAL);

    const lease = await decision(
      await request.post(LEASE(DEMO.movie.id), {
        headers: identity.headers,
        data: { writerId: "e2e-writer" }
      })
    );
    expect(lease.outcome).toBe("unavailable");
    expect(progressReasonCodes(lease)[0]).toBe(DEPLOYMENT_PREAMBLE_REFUSAL);

    const write = await decision(
      await request.put(PROGRESS(DEMO.movie.id), {
        headers: identity.headers,
        data: {
          lease: { epoch: 1, writerId: "e2e-writer" },
          writeSeq: 1,
          positionSeconds: 42,
          runtimeSeconds: 5400
        }
      })
    );
    expect(write.outcome).toBe("unavailable");
    expect(progressReasonCodes(write)[0]).toBe(DEPLOYMENT_PREAMBLE_REFUSAL);
    return;
  }

  /* The development build, where the leg is reachable end to end. */
  await selectedProfileFor(request, identity);

  /*
   * `null` IS AN ANSWER, not a failure, and it is a 200. A title nobody has
   * started is the ordinary case, and a 404 here would make every client's fetch
   * wrapper treat the most common state in the product as an error. The reason
   * code is what distinguishes it from a row that happens to be empty.
   */
  const before = await decision(
    await request.get(PROGRESS(DEMO.movie.id), { headers: identity.headers })
  );
  expect(before.outcome).toBe("read");
  expect(before.progress).toBeNull();
  expect(progressReasonCodes(before)).toContain("progress_absent");

  /*
   * The lease is what makes a write possible at all: a write with none is
   * refused, by design, so ordering comes from a counter the SERVER allocated
   * rather than from a clock the client controls.
   */
  const leased = await decision(
    await request.post(LEASE(DEMO.movie.id), {
      headers: identity.headers,
      data: { writerId: "e2e-writer" }
    })
  );
  expect(leased.outcome).toBe("leased");
  expect(progressReasonCodes(leased)).toContain("writer_lease_issued");
  const lease = isRecord(leased.lease) ? leased.lease : {};
  const epoch = Number(lease["epoch"]);
  expect(epoch).toBeGreaterThan(0);
  expect(lease["writerId"]).toBe("e2e-writer");

  const written = await decision(
    await request.put(PROGRESS(DEMO.movie.id), {
      headers: identity.headers,
      data: {
        lease: { epoch, writerId: "e2e-writer" },
        writeSeq: 1,
        positionSeconds: 42,
        runtimeSeconds: 5400
      }
    })
  );
  expect(written.outcome).toBe("written");
  const stored = isRecord(written.progress) ? written.progress : {};
  expect(stored["contentId"]).toBe(DEMO.movie.id);
  expect(stored["positionSeconds"]).toBe(42);
  expect(stored["runtimeSeconds"]).toBe(5400);

  /*
   * The note the accepted write published. `writer-epoch.ts` produces these
   * because a grant that quietly discarded information is as hard to debug as an
   * unexplained denial -- and this one is the load-bearing distinction the row's
   * nullable position exists for: the row the lease created had NO position, so
   * this is the first write to report one. A client that read the leased row's
   * `null` as `0` would have offered "continue watching" at 0:00 for a title
   * nobody had started.
   */
  expect(progressReasonCodes(written)).toContain("position_first_reported");

  /*
   * READ BACK THROUGH THE ROUTE, not asserted from the write's own echo. The
   * write's `progress` is the resolver's post-write state; this is the question a
   * resuming client actually asks, and the two agreeing is what makes the leg a
   * journey rather than one round trip.
   */
  const after = await decision(
    await request.get(PROGRESS(DEMO.movie.id), { headers: identity.headers })
  );
  expect(after.outcome).toBe("read");
  const resumed = isRecord(after.progress) ? after.progress : {};
  expect(resumed["positionSeconds"]).toBe(42);
  expect(resumed["writeSeq"]).toBe(1);
  expect(resumed["writerEpoch"]).toBe(epoch);
  expect(progressReasonCodes(after)).toContain("progress_read");
});

test("one household's resume point is not another's", async ({ request }) => {
  test.skip(!MANAGES_SERVER, UNKNOWN_BUILD_SKIP_REASON);
  test.skip(WEB_MODE === "production", DEPLOYMENT_SKIP_REASON);

  /*
   * The isolation this whole scoping arrangement exists for, asserted from
   * outside the process. Two development households write the SAME content id;
   * neither may see the other's position.
   *
   * It is worth having here rather than only as a unit test because the scope a
   * request acts in is assembled from a header, a stored selection and an
   * authorization decision across three modules, and only a real HTTP round trip
   * puts all three in the same sentence.
   */
  const first = developmentIdentity("household-a");
  const second = developmentIdentity("household-b");
  expect(first.accountId).not.toBe(second.accountId);

  await selectedProfileFor(request, first);
  await selectedProfileFor(request, second);

  const leased = await decision(
    await request.post(LEASE(DEMO.series.id), {
      headers: first.headers,
      data: { writerId: "household-a-writer" }
    })
  );
  expect(leased.outcome).toBe("leased");
  const lease = isRecord(leased.lease) ? leased.lease : {};

  const written = await decision(
    await request.put(PROGRESS(DEMO.series.id), {
      headers: first.headers,
      data: {
        lease: { epoch: Number(lease["epoch"]), writerId: "household-a-writer" },
        writeSeq: 1,
        positionSeconds: 610,
        runtimeSeconds: 3000
      }
    })
  );
  expect(written.outcome).toBe("written");

  /* The control: the household that wrote it can read it back. Without this, the
   * assertion below would still pass if progress had simply stopped being stored
   * at all, and an isolation test indistinguishable from an outage proves
   * nothing. */
  const mine = await decision(
    await request.get(PROGRESS(DEMO.series.id), { headers: first.headers })
  );
  expect(isRecord(mine.progress) ? mine.progress["positionSeconds"] : null).toBe(610);

  const theirs = await decision(
    await request.get(PROGRESS(DEMO.series.id), { headers: second.headers })
  );
  expect(theirs.outcome).toBe("read");
  expect(theirs.progress, "one household read another household's resume point").toBeNull();
});

test("a replayed or unissued write is refused as a conflict, not applied", async ({ request }) => {
  test.skip(!MANAGES_SERVER, UNKNOWN_BUILD_SKIP_REASON);
  test.skip(WEB_MODE === "production", DEPLOYMENT_SKIP_REASON);

  const identity = developmentIdentity("conflict");
  await selectedProfileFor(request, identity);

  const leased = await decision(
    await request.post(LEASE(DEMO.movie.id), {
      headers: identity.headers,
      data: { writerId: "e2e-writer" }
    })
  );
  const lease = isRecord(leased.lease) ? leased.lease : {};
  const epoch = Number(lease["epoch"]);

  const accepted = await decision(
    await request.put(PROGRESS(DEMO.movie.id), {
      headers: identity.headers,
      data: {
        lease: { epoch, writerId: "e2e-writer" },
        writeSeq: 4,
        positionSeconds: 120,
        runtimeSeconds: 5400
      }
    })
  );
  expect(accepted.outcome).toBe("written");

  /*
   * 409 AND NOT 400, which is the distinction the status mapping exists to make:
   * the caller is authorized and its request is well formed, and what it has lost
   * is the ordering argument. The remedy is to take a new lease, not to correct
   * the body -- and a client told "malformed" would go and change a field that
   * was never the problem.
   */
  const replay = await decision(
    await request.put(PROGRESS(DEMO.movie.id), {
      headers: identity.headers,
      data: {
        lease: { epoch, writerId: "e2e-writer" },
        /* Not ahead of the accepted write. A retransmit, or a packet that
         * overtook a newer one -- both are the same fact to the receiver. */
        writeSeq: 4,
        positionSeconds: 5,
        runtimeSeconds: 5400
      }
    })
  );
  expect(replay.outcome).toBe("refused");
  expect(progressReasonCodes(replay)[0]).toBe("stale_write_within_writer");

  const unissued = await decision(
    await request.put(PROGRESS(DEMO.movie.id), {
      headers: identity.headers,
      data: {
        /* An epoch higher than any this server allocated. Guessing "the current
         * epoch is probably the next one" is exactly what the server-minted half
         * of the pair exists to defeat. */
        lease: { epoch: epoch + 1, writerId: "e2e-writer" },
        writeSeq: 99,
        positionSeconds: 3,
        runtimeSeconds: 5400
      }
    })
  );
  expect(unissued.outcome).toBe("refused");
  expect(progressReasonCodes(unissued)[0]).toBe("epoch_not_issued");

  /*
   * NEITHER REFUSAL MOVED THE ROW. This is the half with teeth: a 409 that had
   * already applied the write would be a refusal a caller could ignore, and both
   * rejected writes named a position the accepted one did not.
   */
  const current = await decision(
    await request.get(PROGRESS(DEMO.movie.id), { headers: identity.headers })
  );
  const row = isRecord(current.progress) ? current.progress : {};
  expect(row["positionSeconds"]).toBe(120);
  expect(row["writeSeq"]).toBe(4);
});

test("there is no field through which a client can assert a time", async ({ request }) => {
  test.skip(!MANAGES_SERVER, UNKNOWN_BUILD_SKIP_REASON);
  test.skip(WEB_MODE === "production", DEPLOYMENT_SKIP_REASON);

  /*
   * REFUSED, NOT STRIPPED, and it is the rights-boundary argument in a different
   * domain. Zod's default is to drop unknown keys, so a stripped `updatedAt`
   * would produce a perfectly successful write with no indication that the field
   * the client believed in was discarded -- and the next person to add a field to
   * that schema would be one keystroke from honouring it. `writer-epoch.ts` opens
   * by rejecting "latest client timestamp wins" (a device an hour fast wins every
   * argument forever; one an hour slow can never write again), so the absence of
   * that field is a design decision, and this is where it becomes observable from
   * outside the process.
   *
   * No profile selection is needed: the body is parsed before the authorization
   * scope is resolved, so this reaches the refusal it is about even on a session
   * that has selected nothing.
   */
  const identity = developmentIdentity("no-clock");

  for (const smuggled of [
    { updatedAt: "2020-01-01T00:00:00.000Z" },
    { profileId: "somebody-elses-profile" }
  ]) {
    const shape = await decision(
      await request.put(PROGRESS(DEMO.movie.id), {
        headers: identity.headers,
        data: {
          lease: { epoch: 1, writerId: "e2e-writer" },
          writeSeq: 1,
          positionSeconds: 10,
          runtimeSeconds: null,
          ...smuggled
        }
      })
    );

    const label = `smuggled ${Object.keys(smuggled).join(", ")}`;
    expect(shape.outcome, label).toBe("refused");
    /* The PRIMARY reason. An unaccepted field gets its own code and is sorted to
     * the front of the trail rather than being folded into `request_malformed`,
     * because buried at position 3 it would not be visible to anybody reading
     * only the first line. */
    expect(progressReasonCodes(shape)[0], label).toBe("request_field_not_permitted");
    for (const key of Object.keys(smuggled)) {
      expect(shape.reasons[0]?.detail, label).toContain(key);
    }
  }
});

test("a content id that cannot name anything is refused before any row is touched", async ({
  request
}) => {
  test.skip(!MANAGES_SERVER, UNKNOWN_BUILD_SKIP_REASON);
  test.skip(WEB_MODE === "production", DEPLOYMENT_SKIP_REASON);

  /*
   * The same ordering the playback session route enforces, on the storage side:
   * raw URL path input is refused for its SHAPE before it is used as a key.
   * `%20` rather than a literal space so the router hands the segment through
   * intact.
   */
  const identity = developmentIdentity("bad-id");
  await selectedProfileFor(request, identity);

  const shape = await decision(
    await request.get("/api/v1/progress/Not%20A%20Valid%20Id", { headers: identity.headers })
  );

  /*
   * A 400 rather than a 404, and `refused` rather than `unavailable`: the address
   * is one no id in this system could ever have, which is the caller's to fix.
   * A 404 would also make it indistinguishable from the ordinary "this profile
   * has no row for this title", which is a 200 carrying `null`.
   */
  expect(shape.outcome).toBe("refused");
  expect(progressReasonCodes(shape)[0]).toBe("not_a_normalized_content_id");
});
