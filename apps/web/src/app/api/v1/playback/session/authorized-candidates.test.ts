import { unknownMediaFacts } from "@liberty/contracts/domains/playback";
import { MEDIA_FACTS } from "@liberty/contracts/shared/media-facts";
import { PLAYABLE_CONTENT_RIGHTS } from "@liberty/contracts/shared/rights";
import { LATENCY_CEILING_MS, PROVIDER_HEALTH_FLOOR } from "@liberty/media-engine";
import {
  checkUrl,
  DEFAULT_PROVIDER_HEALTH_POLICY,
  healthPriorScore,
  RIGHTS_BASES_FOR_RIGHTS
} from "@liberty/provider-sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  NON_DEPLOYMENT_ENVIRONMENTS,
  NonDeploymentEnvironment
} from "../../../deployment-environment";
import {
  fixtureProvider,
  isOpaqueRightsReference,
  resolveAuthorizedCandidates,
  MAX_RIGHTS_REFERENCE_LENGTH,
  type AuthorizedCandidateResolver
} from "./authorized-candidates";
import type { PlaybackSessionResponse } from "./contract";
import { issuePlaybackSession } from "./issue-session";

/*
 * What these pin is what the FIXTURE PROVIDER ASSERTS, and where it may assert
 * it. A fixture adapter is the place a shortcut gets taken "just for testing"
 * and then ships, so the three things worth holding still are: it states no fact
 * it did not observe, it cannot run in a deployment, and the operator's origin
 * reaches the outbound URL policy intact rather than pre-laundered.
 */

const CONTENT_ID = "aurora-fall";

/** A hosted deployment's answer: no source opt-in, no local instance. */
const HOSTED = { allowLoopback: false, localDeployment: false } as const;

/**
 * A witness for a named non-deployment environment.
 *
 * The witness is the whole point of the gate under test, so a test cannot
 * fabricate one: `NonDeploymentEnvironment` has a private constructor and a
 * private field, so there is no cast-free way to build one here, and a cast
 * would make every assertion below about a value the application can never see.
 * The throw is for the mistake of asking for a witness for `production` in a
 * test that meant `development` -- it names the value rather than returning
 * something usable.
 */
function nonDeployment(nodeEnv: string): NonDeploymentEnvironment {
  const environment = NonDeploymentEnvironment.classify(nodeEnv);
  if (environment === null) {
    throw new Error(`${JSON.stringify(nodeEnv)} is not on NON_DEPLOYMENT_ENVIRONMENTS`);
  }
  return environment;
}

/**
 * The provider under test, built once from the environment vitest itself runs
 * in.
 *
 * PINNED rather than derived from `process.env` at each call, because several
 * tests below rewrite `NODE_ENV` to prove what a HOSTED process does. A provider
 * that re-read the environment would stop existing halfway through those tests,
 * and the distinction being asserted -- the provider cannot be OBTAINED in a
 * deployment, as opposed to answering differently once it has been -- would be
 * invisible.
 */
const FIXTURES = fixtureProvider(nonDeployment("test"));

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
function issueFixtureSession(origin = "https://fixtures.invalid"): Promise<PlaybackSessionResponse> {
  const resolve: AuthorizedCandidateResolver = () => ({
    status: "resolved",
    candidates: FIXTURES.candidates(CONTENT_ID, origin)
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

describe("the rights declaration", () => {
  it("is coherent against the provider SDK's own compatibility table", () => {
    /*
     * The claim cannot be verified -- nothing here opens a file -- so what CAN
     * be checked is that it is a declaration this system recognises rather than
     * a literal somebody typed. `defineStremioSource` refuses an incoherent
     * rights/basis pair for a configured source; the fixture provider does not
     * go through that constructor, so the same table is applied here.
     */
    expect(PLAYABLE_CONTENT_RIGHTS).toContain(FIXTURES.rightsBasis.rights);
    expect(RIGHTS_BASES_FOR_RIGHTS[FIXTURES.rightsBasis.rights]).toContain(FIXTURES.rightsBasis.basis);
  });

  it("is the only rights value any fixture candidate carries", () => {
    /* Not "is on the allowlist" -- that would still pass if one candidate
     * quietly declared a different basis from the one documented above. */
    const rights = FIXTURES.candidates(CONTENT_ID).map((entry) => entry.candidate.rights);
    expect(new Set(rights)).toEqual(new Set([FIXTURES.rightsBasis.rights]));
  });

  it("carries an opaque reference rather than a description of the arrangement", () => {
    /*
     * A rights basis in this repository is a CATEGORY plus an OPAQUE INTERNAL
     * IDENTIFIER, and nothing else. Provider agreements and their terms are not
     * this repository's to carry, so the reference must name a record the
     * operator holds elsewhere -- and `describeRightsBasis` renders it into
     * reason trails and logs, so whatever is here can leave in a screenshot.
     *
     * `not.toBe("")` is what this used to assert, and a sentence passes that.
     */
    expect(isOpaqueRightsReference(FIXTURES.rightsBasis.reference)).toBe(true);
    expect(FIXTURES.rightsBasis.reference.length).toBeLessThanOrEqual(
      MAX_RIGHTS_REFERENCE_LENGTH
    );
  });

  it.each<[string, string]>([
    ["an empty string", ""],
    ["whitespace", "   "],
    [
      "the prose reference this provider carried before PL-0703",
      "media the operator packaged and serves from their own rig at LIBERTY_FIXTURE_MEDIA_ORIGIN"
    ],
    ["a URL", "https://rights.example.com/contract/17"],
    ["a document pointer", "see docs/E2E.md"],
    ["an address", "rights@example.com"],
    ["a capitalised label", "Contract-17"],
    /* Conforming in every way except length, so this entry tests the bound and
     * not the pattern -- 16 characters plus seven 16-character groups is 135. */
    ["a conforming token that is too long", `${"a".repeat(16)}${`-${"b".repeat(16)}`.repeat(7)}`]
  ])("refuses %s as a rights reference", (label, value) => {
    /*
     * The prose entry is the reference this provider actually carried before
     * PL-0703. It is here so the regression has a name: a scope description sat
     * in a rights basis and passed every check this file made.
     *
     * What the shape rule CANNOT catch is a conforming token that still says
     * something -- `acme-tv-2026-emea` matches the pattern. That is a rights
     * review's job, and `authorized-candidates.ts` says so where the pattern is
     * defined rather than letting this list imply a completeness it does not
     * have.
     */
    expect(isOpaqueRightsReference(value), label).toBe(false);
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
   * `null` the compiler will not let it ignore.
   */
  it.each(["production", "staging", "preview", "Production", "PRODUCTION", "", "dev", "prod"])(
    "cannot be obtained for NODE_ENV=%j",
    (value) => {
      expect(NonDeploymentEnvironment.classify(value)).toBeNull();
    }
  );

  it("cannot be obtained when NODE_ENV is unset", () => {
    /*
     * Through the PROCESS rather than by passing `undefined`. An explicit
     * `undefined` argument triggers the parameter default, which reads
     * `process.env.NODE_ENV` -- so `classify(undefined)` is `classify()` and
     * under vitest that answers `test`. `afterEach` puts it back.
     */
    setNodeEnv(undefined);
    expect(NonDeploymentEnvironment.classify()).toBeNull();
  });

  it.each([...NON_DEPLOYMENT_ENVIRONMENTS])("is obtainable for NODE_ENV=%s", (value) => {
    const environment = NonDeploymentEnvironment.classify(value);
    expect(environment).not.toBeNull();
    /* Reported rather than re-derived, so a caller that logs which environment
     * admitted the fixtures reads the value the classification actually used. */
    expect(fixtureProvider(nonDeployment(value)).environment).toBe(value);
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
    for (const entry of FIXTURES.candidates(CONTENT_ID)) {
      expect(unknownMediaFacts(entry.candidate)).toEqual([...MEDIA_FACTS]);
    }
  });

  it("scores health at the policy prior, which survives the engine's floor by no margin", () => {
    /* 0.82/0.94/0.97 were invented, and at weight 30 they were the largest
     * fabricated contribution to the ranking. The prior is what a source with
     * zero observations is worth, and it sits exactly ON the floor -- which
     * media-engine compares with a strict `<`. */
    const prior = healthPriorScore(DEFAULT_PROVIDER_HEALTH_POLICY);
    expect(prior).toBe(PROVIDER_HEALTH_FLOOR);
    for (const entry of FIXTURES.candidates(CONTENT_ID)) {
      expect(entry.candidate.healthScore).toBe(prior);
      expect(entry.candidate.healthScore < PROVIDER_HEALTH_FLOOR).toBe(false);
    }
  });

  it("charges the latency penalty in full rather than claiming a fast start", () => {
    /* An unknown POSITIVE dimension earns nothing; an unknown PENALTY that
     * contributed nothing would reward the candidate for withholding. Nothing
     * timed these. */
    for (const entry of FIXTURES.candidates(CONTENT_ID)) {
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
  it.each([...NON_DEPLOYMENT_ENVIRONMENTS])("resolves fixtures under NODE_ENV=%s", async (value) => {
    setNodeEnv(value);
    const resolution = await resolveAuthorizedCandidates(CONTENT_ID, { requestId: "r" });
    expect(resolution.status).toBe("resolved");
  });

  /*
   * The values the old `!== "production"` test admitted. Each one of these used
   * to resolve fabricated `owned` candidates from whatever process was running,
   * which is a rights claim published by a deployment nobody meant to be a
   * development one.
   */
  it.each(["production", "staging", "preview", "Production", "PRODUCTION", ""])(
    "resolves nothing under NODE_ENV=%j",
    async (value) => {
      setNodeEnv(value);
      const resolution = await resolveAuthorizedCandidates(CONTENT_ID, { requestId: "r" });
      expect(resolution).toEqual({ status: "not-configured" });
    }
  );

  it("resolves nothing when NODE_ENV is unset", async () => {
    setNodeEnv(undefined);
    const resolution = await resolveAuthorizedCandidates(CONTENT_ID, { requestId: "r" });
    expect(resolution).toEqual({ status: "not-configured" });
  });

  it("reads the environment at call time, not at import time", async () => {
    /* A module-scope read would have frozen the answer to whatever the process
     * looked like when the route was first loaded, which in a serverless cold
     * start is not necessarily the request's environment. */
    setNodeEnv("production");
    const hosted = await resolveAuthorizedCandidates(CONTENT_ID, { requestId: "r" });
    setNodeEnv("development");
    const local = await resolveAuthorizedCandidates(CONTENT_ID, { requestId: "r" });

    expect(hosted.status).toBe("not-configured");
    expect(local.status).toBe("resolved");
  });
});

describe("the operator-supplied origin", () => {
  function uris(origin: string): string[] {
    return FIXTURES.candidates(CONTENT_ID, origin).map((entry) => entry.source.uri);
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

  it("preserves embedded credentials so the URL policy can refuse them", () => {
    /* Stripping userinfo here would turn a credential-bearing misconfiguration
     * into a working stream and silence the only check that names it. */
    const [uri] = uris("https://user:pass@rig.test");
    expect(uri).toBeDefined();
    const check = checkUrl(uri ?? "", HOSTED);
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.reason).toBe("url_credentials_present");
    /* And the reason does not echo the secret back into the trail. */
    expect(check.detail).not.toContain("pass");
  });

  it.each([
    ["http://169.254.169.254", "url_private_address"],
    ["https://169.254.169.254", "url_private_address"],
    ["https://[fd00::1]", "url_private_address"],
    ["https://10.0.0.5", "url_private_address"],
    ["https://rig.internal", "url_private_address"],
    ["http://cdn.example.test", "url_plaintext_http_not_loopback"],
    ["not-a-url", "url_unparseable"]
  ])("hands %s to the transport gate, which refuses it as %s", (origin, reason) => {
    const [uri] = uris(origin);
    expect(uri).toBeDefined();
    const check = checkUrl(uri ?? "", HOSTED);
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.reason).toBe(reason);
  });

  it("admits a bare public IP, because being an IP is not being private", () => {
    const [uri] = uris("https://203.1.2.3");
    const check = checkUrl(uri ?? "", HOSTED);
    expect(check.ok).toBe(true);
  });
});

describe("the loopback opt-in", () => {
  it("is false for every origin that is not loopback", () => {
    /* It used to be hardcoded `true`, which collapsed url-policy's two
     * independently-owned permissions into the one variable that also decides
     * whether fixtures resolve at all. */
    for (const origin of ["https://fixtures.invalid", "https://rig.test", "https://10.0.0.5"]) {
      for (const entry of FIXTURES.candidates(CONTENT_ID, origin)) {
        expect(entry.source.allowLoopback).toBe(false);
      }
    }
  });

  it.each(["http://localhost:8080", "http://127.0.0.1:8096", "http://[::1]:8080"])(
    "is true for %s, and still needs the deployment to be local",
    (origin) => {
      const entries = FIXTURES.candidates(CONTENT_ID, origin);
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
});

describe("the content id", () => {
  it.each(["../../etc/passwd", "..", "a/b", "Aurora-Fall", "", "aurora fall", "aurora_fall"])(
    "produces no candidates for %j",
    (contentId) => {
      /*
       * The route's schema already refuses these, but this function is exported
       * and pure, so it will eventually be called by something that did not come
       * through the route. Percent-encoding is not a defence: dots are
       * unreserved, so `..` survives it and would walk out of the origin's path
       * prefix.
       */
      expect(FIXTURES.candidates(contentId, "https://rig.test/media")).toEqual([]);
    }
  );

  it("keeps every published URL under the configured origin", () => {
    for (const entry of FIXTURES.candidates(CONTENT_ID, "https://rig.test/media")) {
      expect(new URL(entry.source.uri).origin).toBe("https://rig.test");
      expect(new URL(entry.source.uri).pathname.startsWith("/media/")).toBe(true);
    }
  });

  it("is an empty set rather than a throw, so the route can report it", async () => {
    /*
     * An id this function refuses cannot reach the route -- the request schema
     * refuses it first -- so the empty set is reached through the seam instead.
     * What matters is that an empty resolution is an ANSWER the endpoint can
     * report (`no_candidates_resolved`) rather than a stack trace with no reason
     * trail, which is what a throw here would have produced.
     */
    const resolve: AuthorizedCandidateResolver = () => ({
      status: "resolved",
      candidates: FIXTURES.candidates("../../etc/passwd")
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
