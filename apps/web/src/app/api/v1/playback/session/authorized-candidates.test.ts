import { unknownMediaFacts } from "@liberty/contracts/domains/playback";
import {
  PROTECTION_NOT_STATED,
  requiresContentDecryptionModule
} from "@liberty/contracts/shared/drm";
import { MEDIA_FACTS } from "@liberty/contracts/shared/media-facts";
import { PLAYABLE_CONTENT_RIGHTS } from "@liberty/contracts/shared/rights";
import { LATENCY_CEILING_MS, PROVIDER_HEALTH_FLOOR } from "@liberty/media-engine";
import {
  checkUrl,
  DEFAULT_PROVIDER_HEALTH_POLICY,
  FIXTURE_RIGHTS_REFERENCE,
  healthPriorScore,
  isOpaqueRightsReference,
  MAX_RIGHTS_REFERENCE_LENGTH,
  RIGHTS_BASES_FOR_RIGHTS
} from "@liberty/provider-sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  isNonDeploymentEnvironmentName,
  NON_DEPLOYMENT_ENVIRONMENTS,
  NonDeploymentEnvironment
} from "../../../deployment-environment";
import {
  fixtureProvider,
  resolveAuthorizedCandidates,
  type AuthorizedCandidateResolver,
  type FixtureProvider,
  type ResolverContext
} from "./authorized-candidates";
import type { PlaybackSessionResponse } from "./contract";
import { issuePlaybackSession } from "./issue-session";

/*
 * What these pin is what the FIXTURE PROVIDER ASSERTS, and where it may assert
 * it. A fixture adapter is the place a shortcut gets taken "just for testing"
 * and then ships, so the things worth holding still are: it states no fact it
 * did not observe, it cannot run in a deployment, the operator's origin reaches
 * the outbound URL policy intact rather than pre-laundered -- and, since the
 * corrective that collapsed two fixture providers into one, that what this route
 * publishes comes from `@liberty/provider-sdk` rather than from a second
 * implementation living here.
 */

const CONTENT_ID = "aurora-fall";

/** A hosted deployment's answer: no source opt-in, no local instance. */
const HOSTED = { allowLoopback: false, localDeployment: false } as const;

/**
 * The resolver context. Generated per request by the server in production; a
 * literal here, because nothing in this module reads it beyond forwarding it to
 * the provider as a correlation id.
 */
const CONTEXT: ResolverContext = { requestId: "test-request" };

/**
 * The origin these tests pin.
 *
 * PINNED IN EVERY TEST THAT LOOKS AT A CANDIDATE, because the module's default
 * is `LIBERTY_FIXTURE_MEDIA_ORIGIN`, and a test whose expectations depend on an
 * operator's environment is a test that passes on one machine and fails on
 * another. The default path is exercised separately, and only for the question
 * it can answer without knowing what the origin is.
 */
const PINNED_ORIGIN = "https://rig.test/media";

/**
 * This process's own witness, minted once at import.
 *
 * A TEST CANNOT FABRICATE ONE AND CAN NO LONGER ASK FOR ONE BY NAME.
 * `NonDeploymentEnvironment` carries a brand whose key is a `unique symbol`
 * private to `@liberty/contracts/shared/runtime`, so there is no cast-free way
 * to build one here -- and a cast would not help either, because
 * `createFixtureProvider` asks that module's registry whether the object it was
 * handed was really issued. `classify()` takes no argument either: it answers
 * for the process. This suite gets a real witness because the process running
 * it really is a test process, which is the point of the arrangement rather
 * than a way around it. The throw reports the only condition that leaves this
 * file without one.
 *
 * MINTED AT IMPORT, BEFORE ANY TEST REWRITES `NODE_ENV`, and held. A
 * classification records what the process was when it was issued and the
 * registry answers by identity, so tests below that make the process look
 * hosted still hold a genuine witness -- which is what lets them assert what a
 * hosted process does to a candidate it was GIVEN, as opposed to whether it
 * could have obtained one.
 */
function classifiedProcess(): NonDeploymentEnvironment {
  const environment = NonDeploymentEnvironment.classify();
  if (environment === null) {
    throw new Error(
      "this process is not classified as a non-deployment; vitest sets NODE_ENV=test, which NON_DEPLOYMENT_ENVIRONMENTS admits"
    );
  }
  return environment;
}

const TEST_RUNTIME: NonDeploymentEnvironment = classifiedProcess();

/**
 * The provider under test, built for the environment vitest itself runs in.
 *
 * SAFE TO BUILD INSIDE A TEST THAT HAS REWRITTEN `NODE_ENV`. Construction is a
 * pure function of the witness and the origin: the deployment half of the
 * loopback permission is `localDeploymentFor(witness)`, which asks the registry
 * whether that object was issued rather than re-reading `process.env`, and
 * nothing under `@liberty/provider-sdk` reads the environment at all. So the
 * distinction being asserted below -- that the provider cannot be OBTAINED in a
 * deployment, as opposed to answering differently once it has been -- stays
 * visible.
 */
function fixtures(origin: string): FixtureProvider {
  const created = fixtureProvider(TEST_RUNTIME, origin);
  if (created.status === "refused") {
    throw new Error(`the fixture provider refused ${created.reason}: ${created.detail}`);
  }
  return created.provider;
}

/** The candidates a pinned origin produces, which is what most of this file is about. */
function candidates(origin: string = PINNED_ORIGIN) {
  return fixtures(origin).candidates(CONTENT_ID, CONTEXT);
}

/**
 * `process.env.NODE_ENV` is typed as a three-value union by Next's ambient
 * declarations, and half of what is under test here is the values OUTSIDE that
 * union -- `staging`, the empty string, unset. Written through a widened view of
 * the same object so the test can express the states a real deployment can
 * actually be in.
 */
function setNodeEnv(value: string | undefined): void {
  const env = process.env as unknown as Record<string, string | undefined>;
  if (value === undefined) delete env["NODE_ENV"];
  else env["NODE_ENV"] = value;
}

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

afterEach(() => {
  setNodeEnv(ORIGINAL_NODE_ENV);
});

/** Mirrors the watch route's conservative profile: narrow enough that a refusal
 * means something, wide enough that a stated h264/aac would have passed it. */
const CAPABILITIES = {
  maxHeight: 1080,
  supportedVideoCodecs: ["h264"],
  supportedAudioCodecs: ["aac"],
  preferredAudioLanguages: ["en"]
};

/**
 * The fixtures put through the real endpoint, with the clock, the id generator
 * and the deployment mode pinned. `localDeployment: false` keeps these running
 * as the hosted deployment does, matching `issue-session.test.ts`.
 */
function issueFixtureSession(origin = PINNED_ORIGIN): Promise<PlaybackSessionResponse> {
  const resolve: AuthorizedCandidateResolver = () => ({
    status: "resolved",
    candidates: candidates(origin)
  });

  return issuePlaybackSession(
    { contentId: CONTENT_ID, capabilities: CAPABILITIES },
    {
      resolve,
      now: () => new Date("2026-08-20T09:00:00.000Z"),
      newId: () => "fixed-id",
      localDeployment: false
    }
  );
}

describe("there is one fixture provider, and it is the SDK's", () => {
  /*
   * THE ASSERTION THE CORRECTIVE EXISTS FOR. This module used to build its own
   * `owned` basis, its own reserved reference token, its own three candidates
   * and its own copy of the opaque-reference rule, while
   * `packages/provider-sdk/src/fixture/` independently implemented the same
   * adapter. Two providers asserting rights over the same imaginary media is the
   * arrangement that produced the original incident, and a copy inside a package
   * is not less of a copy than one inside a route.
   *
   * Each assertion below fails if this file starts stating the value itself
   * again: the reference is compared against the SDK's exported constant rather
   * than a literal, and `attestedRuntime` exists only on a basis built by
   * `fixtureRightsBasis`, which this app cannot call -- `@liberty/provider-sdk`
   * exports neither it nor the witness it requires.
   */
  it("publishes the SDK's reserved reference rather than one of its own", () => {
    const provider = fixtures(PINNED_ORIGIN);
    expect(provider.rightsBasis.reference).toBe(FIXTURE_RIGHTS_REFERENCE);
  });

  it("publishes a basis that only the SDK's factory could have built", () => {
    /* `attestedRuntime` is the provenance field `fixtureRightsBasis` writes from
     * the witness it was handed. A hand-rolled `RightsBasis` in this file could
     * carry the same `rights` and `basis` and could not carry this. */
    expect(fixtures(PINNED_ORIGIN).rightsBasis.attestedRuntime).toBe("test");
  });

  it("composes its addresses with the SDK's file names and candidate ids", () => {
    /* The wire-visible identifiers. Two suites under `e2e/` assert these exact
     * ids as present on a development build and absent on a production one, so
     * they are pinned as literals here rather than derived from the same
     * constant the code uses. */
    expect(candidates().map((entry) => entry.candidate.id)).toEqual([
      `${CONTENT_ID}-progressive`,
      `${CONTENT_ID}-hls`,
      `${CONTENT_ID}-dash`
    ]);
    expect(candidates().map((entry) => entry.source.uri)).toEqual([
      `https://rig.test/media/${CONTENT_ID}/720p.mp4`,
      `https://rig.test/media/${CONTENT_ID}/master.m3u8`,
      `https://rig.test/media/${CONTENT_ID}/manifest.mpd`
    ]);
  });
});

describe("the rights declaration", () => {
  it("is coherent against the provider SDK's own compatibility table", () => {
    /*
     * The claim cannot be verified -- nothing here opens a file -- so what CAN
     * be checked is that it is a declaration this system recognises rather than
     * a literal somebody typed. `defineStremioSource` refuses an incoherent
     * rights/basis pair for a configured source; the fixture provider does not
     * go through that constructor, so the same table is applied here.
     */
    const { rightsBasis } = fixtures(PINNED_ORIGIN);
    expect(PLAYABLE_CONTENT_RIGHTS).toContain(rightsBasis.rights);
    expect(RIGHTS_BASES_FOR_RIGHTS[rightsBasis.rights]).toContain(rightsBasis.basis);
  });

  it("is the only rights value any fixture candidate carries", () => {
    /* Not "is on the allowlist" -- that would still pass if one candidate
     * quietly declared a different basis from the one documented above. */
    const provider = fixtures(PINNED_ORIGIN);
    const rights = provider
      .candidates(CONTENT_ID, CONTEXT)
      .map((entry) => entry.candidate.rights);
    expect(new Set(rights)).toEqual(new Set([provider.rightsBasis.rights]));
  });

  it("carries an opaque reference rather than a description of the arrangement", () => {
    /*
     * A rights basis in this repository is a CATEGORY plus an OPAQUE INTERNAL
     * IDENTIFIER, and nothing else. Provider agreements and their terms are not
     * this repository's to carry, so the reference must name a record the
     * operator holds elsewhere -- and `describeRightsBasis` renders it into
     * reason trails and logs, so whatever is here can leave in a screenshot.
     *
     * THE RULE IS APPLIED FROM WHERE IT LIVES. `isOpaqueRightsReference` and
     * `MAX_RIGHTS_REFERENCE_LENGTH` are imported from `@liberty/provider-sdk`,
     * which is the one place the pattern is written; this file used to export
     * its own pair, and the point of importing them is that a divergence is now
     * impossible rather than merely unlikely. The pattern's own unit behaviour
     * -- prose, URLs, addresses, capitals, over-length tokens -- is asserted
     * beside the pattern, in `fixture/provider.test.ts`, rather than copied here
     * as a second table to keep in step.
     */
    const { reference } = fixtures(PINNED_ORIGIN).rightsBasis;
    expect(isOpaqueRightsReference(reference)).toBe(true);
    expect(reference.length).toBeLessThanOrEqual(MAX_RIGHTS_REFERENCE_LENGTH);
  });
});

describe("the witness the fixture provider requires", () => {
  /*
   * THE STRUCTURAL HALF OF THE CORRECTIVE. The gate used to be a condition
   * inside `resolveAuthorizedCandidates`; a condition can be deleted and the
   * build stays green, which is how `watch/watch-session.ts` came to carry a
   * second copy of these fixtures with no environment test at all. The gate is
   * now a VALUE that only `deployment-environment.ts` can mint, so a caller
   * cannot reach `fixtureProvider` in a deployment without first handling a
   * `null` the compiler will not let it ignore -- and the SDK behind it cannot
   * mint a substitute, because it holds no allowlist and exports neither the
   * runtime witness nor the basis constructor that needs one.
   *
   * THE ALLOWLIST AND THE MINT ARE NOW ASSERTED SEPARATELY, because they are two
   * questions and only one of them may be asked about an arbitrary string.
   * `isNonDeploymentEnvironmentName` answers "would this NAME be admitted" and
   * issues nothing, so a test may hand it anything; the mint answers only about
   * the process, so a test that wants a different answer changes the process.
   * They used to be one function with one argument, and that argument was the
   * whole gate.
   */
  it.each(["production", "staging", "preview", "Production", "PRODUCTION", "", "dev", "prod"])(
    "is a name the allowlist refuses: %j",
    (value) => {
      expect(isNonDeploymentEnvironmentName(value)).toBe(false);
    }
  );

  it.each([...NON_DEPLOYMENT_ENVIRONMENTS])("is a name the allowlist admits: %s", (value) => {
    expect(isNonDeploymentEnvironmentName(value)).toBe(true);
  });

  /*
   * THE MINT, WHICH CAN ONLY BE ASKED ABOUT THIS PROCESS. `classify` takes no
   * argument -- there is nothing to pass -- so the only way to change its answer
   * is to change what the process is. That is what `setNodeEnv` does here, and
   * it is the whole difference between the mechanism before this corrective and
   * after it: a hosted process could previously call `classify("test")` and be
   * issued a genuine capability, and now a caller that wants a different answer
   * has to BE a different process. `afterEach` puts the environment back.
   */
  it("answers for the process, and refuses one that is a deployment", () => {
    setNodeEnv("production");
    expect(NonDeploymentEnvironment.classify()).toBeNull();

    setNodeEnv("staging");
    expect(NonDeploymentEnvironment.classify()).toBeNull();
  });

  it("cannot be obtained when NODE_ENV is unset", () => {
    setNodeEnv(undefined);
    expect(NonDeploymentEnvironment.classify()).toBeNull();
  });

  it.each([...NON_DEPLOYMENT_ENVIRONMENTS])("is obtainable by a NODE_ENV=%s process", (value) => {
    setNodeEnv(value);
    const environment = NonDeploymentEnvironment.classify();
    expect(environment).not.toBeNull();
    if (environment === null) return;
    /* The name in the capability is the process's own, never a caller's. */
    expect(environment.nodeEnv).toBe(value);

    const created = fixtureProvider(environment, PINNED_ORIGIN);
    expect(created.status).toBe("ready");
    if (created.status !== "ready") return;
    /* Reported rather than re-derived, so a caller that logs which environment
     * admitted the fixtures reads the value the classification actually used --
     * and it survives the trip through the SDK, which carries it as the basis's
     * `attestedRuntime` and the provider's `runtime`. */
    expect(created.provider.environment).toBe(value);
    expect(created.provider.rightsBasis.attestedRuntime).toBe(value);
  });
});

describe("what the fixtures state about the media", () => {
  it("states none of the four media facts, on any candidate", () => {
    /*
     * The regression this exists for: the fixtures used to claim h264/aac, which
     * is the most widely supported pair in existence, so every candidate passed
     * capability eligibility PRECISELY BECAUSE the values were ones every device
     * accepts. Nothing had opened these files. `null` is the contract's word for
     * unknown and it is the only honest answer here.
     */
    for (const entry of candidates()) {
      expect(unknownMediaFacts(entry.candidate)).toEqual([...MEDIA_FACTS]);
    }
  });

  it("states that the provider did not state a protection status, and never that it is clear", () => {
    /*
     * THE OPEN QUESTION THIS TASK DECIDED, pinned so the decision is visible if
     * it is ever changed. `@liberty/provider-sdk`'s `FixtureCandidate` carries
     * no protection field, so this shape adapter has nothing to forward. The
     * honest descriptor for a clear development fixture is `{ state: "clear" }`
     * -- and that is an ASSERTION ABOUT THE BYTES, which product invariant 3
     * reserves to a provider adapter. What this module may state, because it is
     * a true observation about the producer rather than about the media, is
     * that the provider stated nothing.
     *
     * The value is safe by construction, and that is the reason it is
     * acceptable rather than merely convenient:
     * `requiresContentDecryptionModule` is `true` for `unknown`, so the failure
     * mode is a clear fixture routed to the adapter that HAS a CDM, refused by
     * the mpv adapter under `drm_required_no_cdm` with a reason that says the
     * state was unstated. It is never a candidate attempted without the CDM it
     * needs.
     *
     * `not: clear` is asserted separately from the equality. The equality could
     * be relaxed one day -- if the SDK starts stating `clear` here, this route
     * will forward it and this test becomes wrong in the right direction -- but
     * a fixture reaching a router as `clear` FROM THIS FILE, which has looked at
     * nothing, is the invariant-2 reading §4 names, and that must never become
     * true no matter who edits the mapping.
     */
    for (const entry of candidates()) {
      expect(entry.protection).toEqual(PROTECTION_NOT_STATED);
      expect(entry.protection).toEqual({ state: "unknown", why: "provider_did_not_state" });
      expect(entry.protection.state).not.toBe("clear");
      expect(requiresContentDecryptionModule(entry.protection)).toBe(true);
    }
  });

  it("scores health at the policy prior, which survives the engine's floor by no margin", () => {
    /* 0.82/0.94/0.97 were invented, and at weight 30 they were the largest
     * fabricated contribution to the ranking. The prior is what a source with
     * zero observations is worth, and it sits exactly ON the floor -- which
     * media-engine compares with a strict `<`. The SDK reaches it through
     * `evaluateProviderHealth` over a zero summary, so the number a candidate
     * ranks on and the number a health report shows cannot drift. */
    const prior = healthPriorScore(DEFAULT_PROVIDER_HEALTH_POLICY);
    expect(prior).toBe(PROVIDER_HEALTH_FLOOR);
    for (const entry of candidates()) {
      expect(entry.candidate.healthScore).toBe(prior);
      expect(entry.candidate.healthScore < PROVIDER_HEALTH_FLOOR).toBe(false);
    }
  });

  it("charges the latency penalty in full rather than claiming a fast start", () => {
    /* An unknown POSITIVE dimension earns nothing; an unknown PENALTY that
     * contributed nothing would reward the candidate for withholding. Nothing
     * timed these. The engine's ceiling is handed to the SDK by this app, which
     * is the composition root -- the adapter must not depend on the ranker that
     * scores its output. */
    for (const entry of candidates()) {
      expect(entry.candidate.estimatedLatencyMs).toBe(LATENCY_CEILING_MS);
    }
  });

  it("still reorders the list, so the worst-first ordering has something to prove", async () => {
    const response = await issueFixtureSession();

    expect(response.outcome).toBe("granted");
    if (response.outcome !== "granted") return;
    /* Adaptive delivery outranks progressive on the one fact these candidates
     * genuinely have, and the dash/hls tie falls to the id tiebreak rather than
     * to the order the resolver listed them in. */
    expect(response.session.candidates.map((entry) => entry.id)).toEqual([
      `${CONTENT_ID}-dash`,
      `${CONTENT_ID}-hls`,
      `${CONTENT_ID}-progressive`
    ]);
  });

  it("publishes an unverified session, because no codec was ever established", async () => {
    const response = await issueFixtureSession();

    expect(response.outcome).toBe("granted");
    if (response.outcome !== "granted") return;
    /* The claim the old fixtures made and could not support: that we had
     * ESTABLISHED this decodes on the requesting device. */
    for (const entry of response.session.candidates) {
      expect(entry.compatibility).toBe("unverified");
    }
    expect(response.reasons[0].code).toBe("session_issued_unverified_compatibility");
  });
});

describe("where the fixture path may run", () => {
  /* Awaited because the resolver TYPE admits a promise -- the fixture one is
   * synchronous, and a test that leaned on that would stop compiling the day a
   * real registry lands behind the same seam. */
  it.each([...NON_DEPLOYMENT_ENVIRONMENTS])(
    "does not refuse the fixture path under NODE_ENV=%s",
    async (value) => {
      setNodeEnv(value);
      const resolution = await resolveAuthorizedCandidates(CONTENT_ID, CONTEXT);
      /*
       * Asserted as "not `not-configured`" rather than as "`resolved`", and the
       * difference is the environment variable this path reads. The default
       * origin is `LIBERTY_FIXTURE_MEDIA_ORIGIN`, and an operator whose rig is
       * on a private host or plaintext http gets `provider-unavailable` with a
       * named URL-policy reason -- a correct answer from a DIFFERENT gate, and
       * one this assertion has no business failing on. `not-configured` is the
       * only status the environment gate itself produces, so it is the only one
       * worth pinning here; the resolved shape is asserted everywhere above
       * against a pinned origin.
       */
      expect(resolution.status).not.toBe("not-configured");
    }
  );

  /*
   * The values the old `!== "production"` test admitted. Each one of these used
   * to resolve fabricated `owned` candidates from whatever process was running,
   * which is a rights claim published by a deployment nobody meant to be a
   * development one. This branch short-circuits before the origin is read, so it
   * is the same answer on every machine.
   */
  it.each(["production", "staging", "preview", "Production", "PRODUCTION", ""])(
    "resolves nothing under NODE_ENV=%j",
    async (value) => {
      setNodeEnv(value);
      const resolution = await resolveAuthorizedCandidates(CONTENT_ID, CONTEXT);
      expect(resolution).toEqual({ status: "not-configured" });
    }
  );

  it("resolves nothing when NODE_ENV is unset", async () => {
    setNodeEnv(undefined);
    const resolution = await resolveAuthorizedCandidates(CONTENT_ID, CONTEXT);
    expect(resolution).toEqual({ status: "not-configured" });
  });

  it("reads the environment at call time, not at import time", async () => {
    /* A module-scope read would have frozen the answer to whatever the process
     * looked like when the route was first loaded, which in a serverless cold
     * start is not necessarily the request's environment. */
    setNodeEnv("production");
    const hosted = await resolveAuthorizedCandidates(CONTENT_ID, CONTEXT);
    setNodeEnv("development");
    const local = await resolveAuthorizedCandidates(CONTENT_ID, CONTEXT);

    expect(hosted.status).toBe("not-configured");
    expect(local.status).not.toBe("not-configured");
  });
});

describe("the operator-supplied origin", () => {
  function uris(origin: string): string[] {
    return candidates(origin).map((entry) => entry.source.uri);
  }

  /**
   * The refusal reason, or the literal `"accepted"`.
   *
   * One helper for both outcomes so "this origin is refused, and this
   * neighbouring one is not" is stated in one vocabulary.
   */
  function outcome(origin: string): string {
    const created = fixtureProvider(TEST_RUNTIME, origin);
    return created.status === "ready" ? "accepted" : created.reason;
  }

  it("joins a trailing slash without doubling it", () => {
    expect(uris("https://rig.test/")).toEqual([
      `https://rig.test/${CONTENT_ID}/720p.mp4`,
      `https://rig.test/${CONTENT_ID}/master.m3u8`,
      `https://rig.test/${CONTENT_ID}/manifest.mpd`
    ]);
  });

  it("keeps a base path", () => {
    expect(uris("https://rig.test/media")[0]).toBe(`https://rig.test/media/${CONTENT_ID}/720p.mp4`);
  });

  it("does not let a query string or a fragment swallow the path", () => {
    /* String concatenation produced `https://rig.test/?v=2/aurora-fall/720p.mp4`
     * -- a URL that passes every transport check and points at the wrong
     * resource, so the failure arrives as a 404 with nothing in the trail. */
    expect(uris("https://rig.test/?v=2")[0]).toBe(`https://rig.test/${CONTENT_ID}/720p.mp4`);
    expect(uris("https://rig.test/#frag")[0]).toBe(`https://rig.test/${CONTENT_ID}/720p.mp4`);
  });

  it("refuses embedded credentials without echoing them", () => {
    /*
     * REFUSED EARLIER THAN IT USED TO BE, and that is the visible consequence of
     * consuming the SDK provider: the origin is checked by the same `checkUrl`
     * at CONSTRUCTION, so a credential-bearing rig produces a named refusal
     * before a candidate exists rather than three candidates that the session
     * route's own gate then drops one at a time. Both gates still run -- see
     * `issue-session.ts`, which checks every URI immediately before publishing
     * it -- and neither of them sanitises. Stripping userinfo here would turn a
     * credential-bearing misconfiguration into a working stream and silence the
     * only check that names it.
     */
    const created = fixtureProvider(TEST_RUNTIME, "https://user:pass@rig.test");
    expect(created.status).toBe("refused");
    if (created.status !== "refused") return;
    expect(created.reason).toBe("url_credentials_present");
    expect(created.detail).not.toContain("pass");
  });

  it.each([
    ["http://169.254.169.254", "url_private_address"],
    ["https://169.254.169.254", "url_private_address"],
    ["https://[fd00::1]", "url_private_address"],
    ["https://10.0.0.5", "url_private_address"],
    ["https://rig.internal", "url_private_address"],
    ["http://cdn.example.test", "url_plaintext_http_not_loopback"],
    ["magnet:?xt=urn:btih:0000000000", "url_scheme_not_http"],
    ["not-a-url", "url_unparseable"]
  ])("refuses %s as %s", (origin, reason) => {
    expect(outcome(origin)).toBe(reason);
  });

  it("admits a bare public IP, because being an IP is not being private", () => {
    expect(outcome("https://203.1.2.3")).toBe("accepted");
  });

  it("reports a refused origin as an unavailable provider, with the reason intact", async () => {
    /*
     * What a refusal has to become by the time it reaches a caller.
     * `not-configured` would tell an operator to configure a provider they
     * already configured, and an empty list would tell them nothing at all;
     * `provider_unavailable` carries the SDK's own named reason into the
     * response trail, which is invariant 4.
     *
     * The resolution is composed here rather than obtained from
     * `resolveAuthorizedCandidates`, and the reason is a limitation worth
     * naming: that function reads `LIBERTY_FIXTURE_MEDIA_ORIGIN` at module
     * scope, so a test cannot give it an origin the URL policy refuses. What is
     * asserted is therefore the SHAPE -- that a real refusal from the real
     * provider survives the endpoint with its reason legible -- and the refusal
     * itself is the genuine one, not a stubbed string.
     */
    const resolve: AuthorizedCandidateResolver = () => {
      const created = fixtureProvider(TEST_RUNTIME, "https://10.0.0.5");
      if (created.status === "ready") throw new Error("a private origin was admitted");
      return {
        status: "provider-unavailable",
        detail: `the fixture provider could not be constructed (${created.reason}): ${created.detail}`
      };
    };

    const response = await issuePlaybackSession(
      { contentId: CONTENT_ID, capabilities: CAPABILITIES },
      { resolve, now: () => new Date(), newId: () => "fixed-id", localDeployment: false }
    );

    expect(response.outcome).toBe("unavailable");
    expect(response.reasons[0].code).toBe("provider_unavailable");
    expect(response.reasons[0].detail).toContain("url_private_address");
  });
});

describe("the loopback opt-in", () => {
  it("is false for every origin that is not loopback", () => {
    /* It used to be hardcoded `true`, which collapsed url-policy's two
     * independently-owned permissions into the one variable that also decides
     * whether fixtures resolve at all. */
    for (const origin of ["https://fixtures.invalid", "https://rig.test", "https://203.1.2.3"]) {
      for (const entry of candidates(origin)) {
        expect(entry.source.allowLoopback).toBe(false);
      }
    }
  });

  it.each(["http://localhost:8080", "http://127.0.0.1:8096", "http://[::1]:8080"])(
    "is true for %s, and still needs the deployment to be local",
    (origin) => {
      /*
       * The provider is CONSTRUCTIBLE for a loopback origin only because both
       * permissions are present: the source half is derived from the origin, and
       * the deployment half from the witness this app was issued. The
       * per-candidate gate downstream then asks the same question again, from
       * the request's environment rather than the provider's -- which is why a
       * candidate built here still fails on a hosted process.
       */
      const entries = candidates(origin);
      for (const entry of entries) {
        expect(entry.source.allowLoopback).toBe(true);
      }

      const uri = entries[0]?.source.uri ?? "";
      const hosted = checkUrl(uri, { allowLoopback: true, localDeployment: false });
      expect(hosted.ok).toBe(false);
      if (!hosted.ok) expect(hosted.reason).toBe("url_loopback_not_local_deployment");

      expect(checkUrl(uri, { allowLoopback: true, localDeployment: true }).ok).toBe(true);
    }
  );

  it("is the half this route owns, and a caller that supplied neither is refused", () => {
    /*
     * The two owners, side by side. This route builds the provider successfully
     * for a loopback rig because it supplies BOTH facts -- the source half
     * derived from the operator's origin, the deployment half from the witness
     * the contracts module issued to this process --
     * while the same address checked with neither permission is refused for the
     * source half first, which is the reason that names something an operator
     * can fix.
     */
    const created = fixtureProvider(TEST_RUNTIME, "http://127.0.0.1:8096");
    expect(created.status).toBe("ready");

    const neither = checkUrl("http://127.0.0.1:8096", HOSTED);
    expect(neither.ok).toBe(false);
    if (neither.ok) return;
    expect(neither.reason).toBe("url_loopback_not_permitted");
  });
});

describe("the content id", () => {
  it.each(["../../etc/passwd", "..", "a/b", "Aurora-Fall", "", "aurora fall", "aurora_fall"])(
    "produces no candidates for %j",
    (contentId) => {
      /*
       * The route's schema already refuses these, but the resolver is exported
       * and will eventually be called by something that did not come through the
       * route. Percent-encoding is not a defence: dots are unreserved, so `..`
       * survives it and would walk out of the origin's path prefix. The refusal
       * is the SDK registry's -- `lookup` answers `null` for anything that is not
       * a normalized content id, and this route turns that into an empty list
       * rather than a throw.
       */
      expect(fixtures(PINNED_ORIGIN).candidates(contentId, CONTEXT)).toEqual([]);
    }
  );

  it("keeps every published URL under the configured origin", () => {
    for (const entry of candidates()) {
      expect(new URL(entry.source.uri).origin).toBe("https://rig.test");
      expect(new URL(entry.source.uri).pathname.startsWith("/media/")).toBe(true);
    }
  });

  it("is an empty set rather than a throw, so the route can report it", async () => {
    /*
     * An id this resolver refuses cannot reach the route -- the request schema
     * refuses it first -- so the empty set is reached through the seam instead.
     * What matters is that an empty resolution is an ANSWER the endpoint can
     * report (`no_candidates_resolved`) rather than a stack trace with no reason
     * trail, which is what a throw here would have produced.
     */
    const resolve: AuthorizedCandidateResolver = () => ({
      status: "resolved",
      candidates: fixtures(PINNED_ORIGIN).candidates("../../etc/passwd", CONTEXT)
    });

    const response = await issuePlaybackSession(
      { contentId: CONTENT_ID, capabilities: CAPABILITIES },
      {
        resolve,
        now: () => new Date("2026-08-20T09:00:00.000Z"),
        newId: () => "fixed-id",
        localDeployment: false
      }
    );

    expect(response.outcome).toBe("unavailable");
    expect(response.reasons[0].code).toBe("no_candidates_resolved");
  });
});
