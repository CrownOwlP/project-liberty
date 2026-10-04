import { authorizeProfileSelection, type AccountIdentity, type LibertySession } from "@liberty/auth";
import { describe, expect, it } from "vitest";

import { NonDeploymentEnvironment } from "../../../deployment-environment";
import {
  createInMemoryRepository,
  createInMemoryStore
} from "../../../../../lib/db/in-memory-repository";
import type { LibertyRepository } from "../../../../../lib/db/repository";
import type { RequestContextOptions } from "../../../../../lib/db/request-context";
import {
  handleForgetPreferences,
  handleReadPreferences,
  handleWritePreferences
} from "./handler";
import { preferencesResponseSchema, type PreferencesResponse } from "./contract";

/* -------------------------------------------------------------------------
 * The preferences endpoint, over HTTP, against the in-memory adapter
 * (PL-0723).
 *
 * The same fixture shape every other profile-scoped route's suite uses: a real
 * in-memory repository admitted by this process's own classification, a real
 * profile created and selected through the real authorization path, and
 * requests that are actual `Request` objects. Nothing is mocked, so what is
 * asserted is what a client would receive.
 *
 * TWO THINGS THIS FILE CARES ABOUT MORE THAN THE OTHERS. First, the
 * distinction between a profile that has never chosen and one that chose
 * nothing, which is the whole reason the storage is shaped as it is and is
 * invisible in the values. Second, that no profile id is accepted from the
 * caller in any position -- the route derives it from the session, and the
 * body schema is strict so a `profileId` field is a refusal rather than an
 * ignored key.
 * ---------------------------------------------------------------------- */

const HOUSEHOLD: AccountIdentity = { userId: "household-a", sessionId: "session-a" };
const OTHER_HOUSEHOLD: AccountIdentity = { userId: "household-b", sessionId: "session-b" };
const INSTANT = new Date("2026-10-04T03:00:00.000Z");

function newRepository(): LibertyRepository {
  const environment = NonDeploymentEnvironment.classify();
  if (environment === null) {
    throw new Error(
      "this process is not classified as a non-deployment; vitest sets NODE_ENV=test, which NON_DEPLOYMENT_ENVIRONMENTS admits"
    );
  }
  return createInMemoryRepository(environment, createInMemoryStore());
}

async function selectProfile(
  repository: LibertyRepository,
  account: AccountIdentity,
  displayName: string
): Promise<void> {
  const session: LibertySession = { account, activeProfileId: null };
  const created = await repository.createProfile({
    session,
    displayName,
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

function optionsOver(
  repository: LibertyRepository,
  account: AccountIdentity
): RequestContextOptions {
  return { repository, account, now: () => INSTANT };
}

async function readyContext(): Promise<RequestContextOptions> {
  const repository = newRepository();
  await selectProfile(repository, HOUSEHOLD, "Dad");
  return optionsOver(repository, HOUSEHOLD);
}

const URL_ = "https://liberty.test/api/v1/profiles/preferences";

const getRequest = (): Request => new Request(URL_, { method: "GET" });
const deleteRequest = (): Request => new Request(URL_, { method: "DELETE" });
const putRequest = (body: unknown): Request =>
  new Request(URL_, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });

async function decision(response: Response): Promise<PreferencesResponse> {
  return preferencesResponseSchema.parse(await response.json());
}

const CHOSEN = {
  preferredAudioLanguages: ["ja", "en"],
  preferredSubtitleLanguages: ["en"],
  subtitleMode: "auto" as const,
  hearingImpaired: false,
  /* `false`, deliberately NOT the neutral value (PL-0724). This is the
   * object a viewer is supposed to have CHOSEN, and every other field in it
   * differs from `NO_MEDIA_PREFERENCES` for the same reason: a fixture that
   * matched the default in a field would let a read that silently dropped
   * that field still pass. */
  playbackDiagnostics: false
};

describe("reading a profile that has chosen nothing", () => {
  it("ANSWERS stored:false WITH THE NEUTRAL VALUE, not an error and not a 404", async () => {
    /* Every profile is in this state until somebody opens the settings
     * screen, so it is the ordinary case and must read as one. */
    const options = await readyContext();
    const response = await handleReadPreferences(getRequest(), options);
    expect(response.status).toBe(200);

    const body = await decision(response);
    expect(body.outcome).toBe("read");
    if (body.outcome !== "read") return;
    expect(body.stored).toBe(false);
    expect(body.preferences).toEqual({
      preferredAudioLanguages: [],
      preferredSubtitleLanguages: [],
      subtitleMode: "auto",
      hearingImpaired: false,
      playbackDiagnostics: true
    });
  });

  it("says which of the two answers it is, because the values cannot", async () => {
    const options = await readyContext();
    const body = await decision(await handleReadPreferences(getRequest(), options));
    expect(JSON.stringify(body.reasons)).toContain("has chosen nothing");
  });
});

describe("writing, and reading back", () => {
  it("stores what was sent and reports it", async () => {
    const options = await readyContext();
    const written = await decision(await handleWritePreferences(putRequest(CHOSEN), options));
    expect(written.outcome).toBe("written");
    if (written.outcome !== "written") return;
    expect(written.stored).toBe(true);
    expect(written.preferences).toEqual(CHOSEN);
  });

  it("PRESERVES THE ORDER OF A LANGUAGE LIST THROUGH HTTP AND STORAGE", async () => {
    /* Order is the only information these lists carry; a round trip that
     * sorted or de-duplicated would silently demote a viewer's first choice. */
    const options = await readyContext();
    await handleWritePreferences(
      putRequest({ ...CHOSEN, preferredAudioLanguages: ["ja", "de", "en"] }),
      options
    );
    const read = await decision(await handleReadPreferences(getRequest(), options));
    if (read.outcome !== "read") throw new Error(read.outcome);
    expect(read.preferences.preferredAudioLanguages).toEqual(["ja", "de", "en"]);
    expect(read.stored).toBe(true);
  });

  it("CHOOSING NOTHING IS A CHOICE, and reads back as stored", async () => {
    /*
     * The distinction the whole design exists for. Empty lists written
     * deliberately must come back with `stored: true`, because the player
     * treats "prefer no language" differently from "nobody has said".
     */
    const options = await readyContext();
    await handleWritePreferences(
      putRequest({ ...CHOSEN, preferredAudioLanguages: [], preferredSubtitleLanguages: [] }),
      options
    );
    const read = await decision(await handleReadPreferences(getRequest(), options));
    if (read.outcome !== "read") throw new Error(read.outcome);
    expect(read.stored).toBe(true);
    expect(read.preferences.preferredAudioLanguages).toEqual([]);
  });

  it("overwrites rather than merging, so a cleared list stays cleared", async () => {
    const options = await readyContext();
    await handleWritePreferences(putRequest(CHOSEN), options);
    await handleWritePreferences(
      putRequest({ ...CHOSEN, preferredAudioLanguages: [] }),
      options
    );
    const read = await decision(await handleReadPreferences(getRequest(), options));
    if (read.outcome !== "read") throw new Error(read.outcome);
    expect(read.preferences.preferredAudioLanguages).toEqual([]);
  });
});

describe("forgetting", () => {
  it("IS NOT THE SAME AS WRITING EMPTY LISTS", async () => {
    const options = await readyContext();
    await handleWritePreferences(
      /*
       * EVERY FIELD SET TO ITS NEUTRAL VALUE, AND `playbackDiagnostics` IS
       * NOW NAMED AMONG THEM (PL-0724).
       *
       * This case's whole claim is "identical values, different answers": a
       * profile that deliberately chose the defaults and a profile that
       * chose nothing look the same in `preferences` and are told apart only
       * by `stored`. That requires the written object to BE the neutral
       * value in every field, which it used to be by coincidence -- `CHOSEN`
       * differed from the default only in the two lists, so emptying them
       * was enough.
       *
       * `CHOSEN.playbackDiagnostics` is `false` and the neutral value is
       * `true`, so the coincidence is gone and the field has to be stated.
       * Written out rather than the alternative of making `CHOSEN` match the
       * default here, because a fixture that agreed with the default in a
       * field could not catch a read that silently dropped that field.
       */
      putRequest({
        ...CHOSEN,
        preferredAudioLanguages: [],
        preferredSubtitleLanguages: [],
        playbackDiagnostics: true
      }),
      options
    );
    const beforeForget = await decision(await handleReadPreferences(getRequest(), options));
    if (beforeForget.outcome !== "read") throw new Error(beforeForget.outcome);
    expect(beforeForget.stored).toBe(true);

    await handleForgetPreferences(deleteRequest(), options);
    const afterForget = await decision(await handleReadPreferences(getRequest(), options));
    if (afterForget.outcome !== "read") throw new Error(afterForget.outcome);
    /* Identical values, different answers. */
    expect(afterForget.preferences).toEqual(beforeForget.preferences);
    expect(afterForget.stored).toBe(false);
  });

  it("answers with the neutral value rather than echoing what it deleted", async () => {
    /* A client repopulating its form from this response must not get the
     * fields the viewer just cleared. */
    const options = await readyContext();
    await handleWritePreferences(putRequest(CHOSEN), options);
    const forgotten = await decision(await handleForgetPreferences(deleteRequest(), options));
    expect(forgotten.outcome).toBe("forgotten");
    if (forgotten.outcome !== "forgotten") return;
    expect(forgotten.stored).toBe(false);
    expect(forgotten.preferences.preferredAudioLanguages).toEqual([]);
  });

  it("is idempotent, so a second request is not an error", async () => {
    const options = await readyContext();
    expect((await handleForgetPreferences(deleteRequest(), options)).status).toBe(200);
    expect((await handleForgetPreferences(deleteRequest(), options)).status).toBe(200);
  });
});

describe("the body is refused at the boundary, with a reason a screen can use", () => {
  it("names an unusable language tag rather than dropping it", async () => {
    const options = await readyContext();
    const response = await handleWritePreferences(
      putRequest({ ...CHOSEN, preferredAudioLanguages: ["english please"] }),
      options
    );
    expect(response.status).toBe(400);
    const body = await decision(response);
    expect(body.reasons[0].code).toBe("language_tag_unusable");
  });

  it("names a duplicate and a too-long list separately", async () => {
    const options = await readyContext();
    const duplicate = await decision(
      await handleWritePreferences(
        putRequest({ ...CHOSEN, preferredAudioLanguages: ["en", "EN"] }),
        options
      )
    );
    expect(duplicate.reasons[0].code).toBe("language_listed_twice");

    const tooMany = await decision(
      await handleWritePreferences(
        putRequest({
          ...CHOSEN,
          preferredSubtitleLanguages: ["en", "fr", "de", "es", "it", "ja", "ko", "nl", "pt"]
        }),
        options
      )
    );
    expect(tooMany.reasons[0].code).toBe("too_many_languages");
  });

  it("DOES NOT ECHO THE REJECTED VALUE INTO THE REASON TRAIL", async () => {
    /* The rejected tag is a string the caller typed. Every other detail in a
     * trail is one this application wrote, and a trail is logged. */
    const options = await readyContext();
    const body = await decision(
      await handleWritePreferences(
        putRequest({ ...CHOSEN, preferredAudioLanguages: ["<script>alert(1)</script>"] }),
        options
      )
    );
    expect(JSON.stringify(body.reasons)).not.toContain("script");
  });

  it("REFUSES A BODY CARRYING A profileId, rather than ignoring the field", async () => {
    /*
     * The security-relevant case. The route derives the profile from the
     * session and accepts one from nobody; a silently ignored field is how a
     * caller comes to believe it chose which profile it was editing.
     */
    const options = await readyContext();
    const response = await handleWritePreferences(
      putRequest({ ...CHOSEN, profileId: "someone-elses-profile" }),
      options
    );
    expect(response.status).toBe(400);
    const body = await decision(response);
    expect(body.reasons[0].code).toBe("preferences_malformed");
  });

  it("refuses a partial body, so a write cannot half-set a profile", async () => {
    const options = await readyContext();
    const { subtitleMode: _omitted, ...partial } = CHOSEN;
    expect((await handleWritePreferences(putRequest(partial), options)).status).toBe(400);
  });
});

describe("one household's preferences are not another's", () => {
  it("NEITHER READS NOR WRITES ACROSS A PROFILE BOUNDARY", async () => {
    /*
     * Two accounts, two profiles, one repository. The route takes no profile
     * id at all, so this is the end-to-end statement of that: what each
     * session sees is its own, and a write by one is invisible to the other.
     */
    const repository = newRepository();
    await selectProfile(repository, HOUSEHOLD, "Dad");
    await selectProfile(repository, OTHER_HOUSEHOLD, "Someone Else");

    const mine = optionsOver(repository, HOUSEHOLD);
    const theirs = optionsOver(repository, OTHER_HOUSEHOLD);

    await handleWritePreferences(
      putRequest({ ...CHOSEN, preferredAudioLanguages: ["ja"] }),
      mine
    );

    const theirRead = await decision(await handleReadPreferences(getRequest(), theirs));
    if (theirRead.outcome !== "read") throw new Error(theirRead.outcome);
    expect(theirRead.stored).toBe(false);
    expect(theirRead.preferences.preferredAudioLanguages).toEqual([]);

    /* And the other direction: their write does not disturb mine. */
    await handleWritePreferences(
      putRequest({ ...CHOSEN, preferredAudioLanguages: ["fr"] }),
      theirs
    );
    const myRead = await decision(await handleReadPreferences(getRequest(), mine));
    if (myRead.outcome !== "read") throw new Error(myRead.outcome);
    expect(myRead.preferences.preferredAudioLanguages).toEqual(["ja"]);
  });

  it("refuses when no profile is selected, rather than guessing one", async () => {
    const repository = newRepository();
    /* An account with no profile selected: signed in, nothing chosen. */
    const response = await handleReadPreferences(
      getRequest(),
      optionsOver(repository, HOUSEHOLD)
    );
    expect(response.status).toBe(403);
    const body = await decision(response);
    expect(body.reasons[0].code).toBe("no_active_profile_selected");
  });
});
