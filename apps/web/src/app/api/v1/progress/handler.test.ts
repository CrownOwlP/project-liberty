import { authorizeProfileSelection, type AccountIdentity, type LibertySession } from "@liberty/auth";
import { describe, expect, it } from "vitest";
import { NonDeploymentEnvironment } from "../../deployment-environment";
import {
  createInMemoryRepository,
  createInMemoryStore
} from "../../../../lib/db/in-memory-repository";
import type { LibertyRepository } from "../../../../lib/db/repository";
import type { RequestContextOptions } from "../../../../lib/db/request-context";
import { progressResponseSchema, type ProgressResponse } from "./contract";
import {
  handleIssueWriterLease,
  handleReadProgress,
  handleWriteProgress
} from "./handler";

/*
 * The HTTP half of PL-0403.
 *
 * The interesting assertions are the two-device ones. What is pinned is that a
 * device which lost the lease is told SO -- by name, with a 409 rather than a
 * 403 -- and that a rewind by the current device is accepted, because those are
 * the two behaviours the rejected designs ("latest client timestamp wins",
 * "position must increase") get wrong in opposite directions.
 *
 * There is also no way to write a test that sends a client timestamp, because
 * there is no field for one. The nearest thing is the assertion that trying is
 * refused by name.
 */

const HOUSEHOLD: AccountIdentity = { userId: "household-a", sessionId: "session-a" };
const INSTANT = new Date("2026-09-04T10:00:00.000Z");
const CONTENT = "aurora-fall";

function newRepository(): LibertyRepository {
  const environment = NonDeploymentEnvironment.classify("test");
  if (environment === null) throw new Error('NonDeploymentEnvironment.classify rejected "test"');
  return createInMemoryRepository(environment, createInMemoryStore());
}

/**
 * A household with one profile, selected.
 *
 * Seeded through the REPOSITORY and `authorizeProfileSelection` rather than
 * through the profile routes, so a failure in this suite is a failure in the
 * progress lane rather than a broken dependency on another group's handler. The
 * scope still comes from the one place scopes come from.
 */
async function selectedProfile(
  repository: LibertyRepository,
  account: AccountIdentity
): Promise<void> {
  const session: LibertySession = { account, activeProfileId: null };
  const created = await repository.createProfile({
    session,
    displayName: "Dad",
    avatarKey: null,
    maxRating: null,
    instant: INSTANT
  });
  if (!created.ok) throw new Error(created.reason);

  const ownership = await repository.loadProfileOwnership(created.profile.id);
  const decision = authorizeProfileSelection({ session, ownership });
  if (!decision.allowed) throw new Error(decision.reason);

  const selection = await repository.selectActiveProfile({
    session,
    scope: decision.scope,
    instant: INSTANT
  });
  if (!selection.ok) throw new Error(selection.reason);
}

function optionsOver(repository: LibertyRepository): RequestContextOptions {
  return { repository, account: HOUSEHOLD, now: () => INSTANT };
}

async function readyContext(): Promise<RequestContextOptions> {
  const repository = newRepository();
  await selectedProfile(repository, HOUSEHOLD);
  return optionsOver(repository);
}

function jsonRequest(method: string, body: unknown): Request {
  return new Request(`https://liberty.test/api/v1/progress/${CONTENT}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

function getRequest(): Request {
  return new Request(`https://liberty.test/api/v1/progress/${CONTENT}`, { method: "GET" });
}

async function decision(response: Response): Promise<ProgressResponse> {
  return progressResponseSchema.parse(await response.json());
}

/** Takes a lease and returns the epoch it was issued. */
async function lease(context: RequestContextOptions, writerId: string): Promise<number> {
  const body = await decision(
    await handleIssueWriterLease(jsonRequest("POST", { writerId }), CONTENT, context)
  );
  if (body.outcome !== "leased") throw new Error(`expected a lease, got ${body.outcome}`);
  return body.lease.epoch;
}

describe("authorization comes before anything else", () => {
  it("refuses a session that has selected no profile", async () => {
    const context = optionsOver(newRepository());
    const response = await handleReadProgress(getRequest(), CONTENT, context);

    expect(response.status).toBe(403);
    const body = await decision(response);
    expect(body.outcome).toBe("refused");
    /*
     * Not "no progress" and not a 404: the request never reached storage,
     * because there is no profile to scope it to. That is the profile picker's
     * state and the client's remedy is to select one.
     */
    expect(body.reasons[0].code).toBe("no_active_profile_selected");
  });
});

describe("reading", () => {
  it("answers a title nobody has started with 200 and a null row", async () => {
    const context = await readyContext();
    const response = await handleReadProgress(getRequest(), CONTENT, context);

    /*
     * A 404 here would make the most common state in the product -- a title
     * nobody has started -- look like an error to every client's fetch wrapper.
     */
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const body = await decision(response);
    expect(body.outcome).toBe("read");
    if (body.outcome !== "read") return;
    expect(body.progress).toBeNull();
    expect(body.reasons[0].code).toBe("progress_absent");
  });

  it("refuses a content id the contracts schema rejects", async () => {
    const context = await readyContext();
    const response = await handleReadProgress(getRequest(), "../etc/passwd", context);

    expect(response.status).toBe(400);
    expect((await decision(response)).reasons[0].code).toBe("not_a_normalized_content_id");
  });
});

describe("the writer epoch", () => {
  it("issues a lease that does not report a position", async () => {
    const context = await readyContext();
    const epoch = await lease(context, "television");
    expect(epoch).toBe(1);

    const body = await decision(await handleReadProgress(getRequest(), CONTENT, context));
    expect(body.outcome).toBe("read");
    if (body.outcome !== "read") return;
    /*
     * The row exists and its position is NULL, not 0. A 0 would put the title at
     * the top of "continue watching" at 0:00 with nothing to continue.
     */
    expect(body.progress?.positionSeconds).toBeNull();
    expect(body.progress?.writerEpoch).toBe(1);
  });

  it("refuses a write with no lease rather than writing blind", async () => {
    const context = await readyContext();
    const response = await handleWriteProgress(
      jsonRequest("PUT", {
        lease: { epoch: 1, writerId: "television" },
        writeSeq: 1,
        positionSeconds: 60,
        runtimeSeconds: null
      }),
      CONTENT,
      context
    );

    /*
     * 409 rather than 403: the caller is authorized for this profile and its
     * request is well-formed. What it lacks is a lease, and the remedy is to ask
     * for one -- a different action from "you may not touch this profile".
     */
    expect(response.status).toBe(409);
    expect((await decision(response)).reasons[0].code).toBe("no_writer_lease");
  });

  it("records a position and publishes what the write did", async () => {
    const context = await readyContext();
    const epoch = await lease(context, "television");

    const response = await handleWriteProgress(
      jsonRequest("PUT", {
        lease: { epoch, writerId: "television" },
        writeSeq: 1,
        positionSeconds: 600,
        runtimeSeconds: 7200
      }),
      CONTENT,
      context
    );

    expect(response.status).toBe(200);
    const body = await decision(response);
    expect(body.outcome).toBe("written");
    if (body.outcome !== "written") return;
    expect(body.progress.positionSeconds).toBe(600);
    expect(body.progress.runtimeSeconds).toBe(7200);

    const codes = body.reasons.map((line) => line.code);
    expect(codes).toContain("current_writer");
    /* The note that distinguishes "unknown became known" from "0 became 600". */
    expect(codes).toContain("position_first_reported");
  });

  it("accepts a rewind and says it was one", async () => {
    const context = await readyContext();
    const epoch = await lease(context, "television");
    await handleWriteProgress(
      jsonRequest("PUT", {
        lease: { epoch, writerId: "television" },
        writeSeq: 1,
        positionSeconds: 600,
        runtimeSeconds: 7200
      }),
      CONTENT,
      context
    );

    const response = await handleWriteProgress(
      jsonRequest("PUT", {
        lease: { epoch, writerId: "television" },
        writeSeq: 2,
        positionSeconds: 570,
        runtimeSeconds: null
      }),
      CONTENT,
      context
    );

    /*
     * THE REJECTED "POSITION MUST INCREASE" RULE WOULD REFUSE THIS. A viewer who
     * skips back thirty seconds to re-hear a line is doing something ordinary,
     * on the current device.
     */
    expect(response.status).toBe(200);
    const body = await decision(response);
    if (body.outcome !== "written") throw new Error(body.outcome);
    expect(body.progress.positionSeconds).toBe(570);

    const codes = body.reasons.map((line) => line.code);
    expect(codes).toContain("position_moved_backwards");
    /* An unknown runtime must not overwrite a known one. */
    expect(codes).toContain("retained_known_runtime");
    expect(body.progress.runtimeSeconds).toBe(7200);
  });

  it("refuses a replayed packet from the same writer", async () => {
    const context = await readyContext();
    const epoch = await lease(context, "television");
    const write = {
      lease: { epoch, writerId: "television" },
      writeSeq: 1,
      positionSeconds: 600,
      runtimeSeconds: null
    };

    await handleWriteProgress(jsonRequest("PUT", write), CONTENT, context);
    const replay = await handleWriteProgress(jsonRequest("PUT", write), CONTENT, context);

    /* Re-applying a used sequence number would resurrect a position the viewer
     * has since moved past. */
    expect(replay.status).toBe(409);
    expect((await decision(replay)).reasons[0].code).toBe("stale_write_within_writer");
  });

  it("silences the device that lost the handoff, at any position", async () => {
    const context = await readyContext();
    const television = await lease(context, "television");
    await handleWriteProgress(
      jsonRequest("PUT", {
        lease: { epoch: television, writerId: "television" },
        writeSeq: 1,
        positionSeconds: 600,
        runtimeSeconds: 7200
      }),
      CONTENT,
      context
    );

    const phone = await lease(context, "phone");
    expect(phone).toBe(television + 1);

    const stale = await handleWriteProgress(
      jsonRequest("PUT", {
        lease: { epoch: television, writerId: "television" },
        writeSeq: 2,
        /* A perfectly plausible position. It loses because of WHO sent it. */
        positionSeconds: 610,
        runtimeSeconds: 7200
      }),
      CONTENT,
      context
    );

    expect(stale.status).toBe(409);
    expect((await decision(stale)).reasons[0].code).toBe("superseded_by_newer_writer");

    /* And the handoff did not move the resume point. */
    const read = await decision(await handleReadProgress(getRequest(), CONTENT, context));
    expect(read.outcome === "read" && read.progress?.positionSeconds).toBe(600);
  });

  it("refuses a forged epoch rather than letting a large number seize authority", async () => {
    const context = await readyContext();
    const epoch = await lease(context, "television");

    const forged = await handleWriteProgress(
      jsonRequest("PUT", {
        lease: { epoch: epoch + 999, writerId: "television" },
        writeSeq: 1,
        positionSeconds: 60,
        runtimeSeconds: null
      }),
      CONTENT,
      context
    );

    expect(forged.status).toBe(409);
    expect((await decision(forged)).reasons[0].code).toBe("epoch_not_issued");
  });

  it("refuses the epoch belonging to a different writer", async () => {
    const context = await readyContext();
    const epoch = await lease(context, "television");

    const impostor = await handleWriteProgress(
      jsonRequest("PUT", {
        lease: { epoch, writerId: "phone" },
        writeSeq: 1,
        positionSeconds: 60,
        runtimeSeconds: null
      }),
      CONTENT,
      context
    );

    /* The epoch is a PAIR, not a guessable integer. */
    expect(impostor.status).toBe(409);
    expect((await decision(impostor)).reasons[0].code).toBe("writer_id_mismatch");
  });
});

describe("the request boundary", () => {
  it("refuses a write that tries to assert when it happened", async () => {
    const context = await readyContext();
    const epoch = await lease(context, "television");

    const response = await handleWriteProgress(
      jsonRequest("PUT", {
        lease: { epoch, writerId: "television" },
        writeSeq: 1,
        positionSeconds: 60,
        runtimeSeconds: null,
        /*
         * The field the rejected design would need. There is nowhere for it to
         * go in `ProgressWrite`, and the schema refuses it rather than stripping
         * it -- so a client that believed in it is told, instead of having its
         * write silently ordered by something else.
         */
        updatedAt: "2030-01-01T00:00:00.000Z"
      }),
      CONTENT,
      context
    );

    expect(response.status).toBe(400);
    const body = await decision(response);
    expect(body.reasons[0].code).toBe("request_field_not_permitted");
    expect(body.reasons[0].detail).toContain("updatedAt");
  });

  it("refuses a field smuggled into the nested lease object", async () => {
    const context = await readyContext();
    const epoch = await lease(context, "television");

    /* `.strict()` at BOTH levels. A nested object left open is the half of the
     * boundary people forget. */
    const response = await handleWriteProgress(
      jsonRequest("PUT", {
        lease: { epoch, writerId: "television", profileId: "somebody-else" },
        writeSeq: 1,
        positionSeconds: 60,
        runtimeSeconds: null
      }),
      CONTENT,
      context
    );

    expect(response.status).toBe(400);
    expect((await decision(response)).reasons[0].detail).toContain("profileId");
  });

  it("answers a body that is not JSON with a refusal rather than a 500", async () => {
    const context = await readyContext();
    const response = await handleWriteProgress(
      new Request(`https://liberty.test/api/v1/progress/${CONTENT}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "{not json"
      }),
      CONTENT,
      context
    );

    expect(response.status).toBe(400);
    expect((await decision(response)).outcome).toBe("refused");
  });
});
