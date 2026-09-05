import type { CatalogItemRef, ProviderContext } from "../provider";
import { describe, expect, it } from "vitest";
import { NON_PRODUCTION_RUNTIMES, NonProductionRuntime } from "./environment";
import { FIXTURE_RIGHTS_REFERENCE, isOpaqueRightsReference } from "./rights";
import {
  createFixtureProvider,
  fixtureCatalogItemRegistry,
  type FixtureProvider,
  type FixtureProviderOptions
} from "./provider";

/**
 * Fixture provider tests (PL-0301).
 *
 * The three things worth testing here are the three things that could go wrong
 * in a way nothing else would notice: the runtime witness cannot be forged, the
 * declaration is a category plus an opaque reference and never anything a reader
 * could act on, and no candidate states a media fact nobody measured.
 *
 * Everything is deterministic. This provider opens no socket and reads no clock,
 * so there is nothing to stub and nothing to wait for.
 */

const CONTENT_ID = "big-buck-bunny";
const CONTEXT: ProviderContext = { requestId: "req-1" };

const BASE_OPTIONS: FixtureProviderOptions = {
  mediaOrigin: "https://fixtures.invalid",
  // The engine's latency ceiling. Stated as a literal here rather than imported,
  // because this package deliberately does not depend on `@liberty/media-engine`
  // -- see `FixtureProviderOptions.unmeasuredLatencyMs`.
  unmeasuredLatencyMs: 1000
};

function testRuntime(): NonProductionRuntime {
  const runtime = NonProductionRuntime.attest("test");
  if (runtime === null) throw new Error("attest refused the `test` runtime");
  return runtime;
}

function build(options: FixtureProviderOptions): FixtureProvider {
  const created = createFixtureProvider(testRuntime(), options);
  if (!created.ok) throw new Error(`fixture provider refused: ${created.reason}: ${created.detail}`);
  return created.provider;
}

/**
 * The refusal reason, or the literal `"accepted"`.
 *
 * One helper for both outcomes so that "this configuration is refused, and this
 * neighbouring one is not" can be asserted in one vocabulary -- which is the
 * whole point of the loopback pair below, where the interesting fact is the
 * boundary rather than either side of it.
 */
function refusalReason(options: FixtureProviderOptions): string {
  const created = createFixtureProvider(testRuntime(), options);
  return created.ok ? "accepted" : created.reason;
}

function itemFor(overrides: Partial<CatalogItemRef> = {}): CatalogItemRef {
  return { providerId: "fixture", externalId: CONTENT_ID, rights: "owned", ...overrides };
}

describe("the runtime witness", () => {
  it("admits exactly the non-production runtimes and refuses everything else", () => {
    for (const name of NON_PRODUCTION_RUNTIMES) {
      expect(NonProductionRuntime.attest(name)).not.toBeNull();
    }
    for (const name of ["production", "staging", "preview", "Development", "TEST", ""]) {
      expect(NonProductionRuntime.attest(name)).toBeNull();
    }
  });

  it("reports the name it was attested from rather than re-deriving one", () => {
    expect(NonProductionRuntime.attest("development")?.name).toBe("development");
  });

  /*
   * The two forgeries the type system has to refuse, asserted as COMPILE errors
   * rather than as runtime behaviour, because that is the only place they exist.
   * `@ts-expect-error` fails the build if the line ever stops being an error,
   * which is the regression worth catching: it is exactly what would happen if
   * the private field or the private constructor were removed, and both are load
   * bearing (see `environment.ts`).
   */
  it("cannot be forged structurally or constructed directly", () => {
    /*
     * Each directive is a SINGLE line sitting directly above its statement.
     * `@ts-expect-error` applies to the line after the comment it appears in, so
     * a directive split across two `//` lines would point at the second comment,
     * find no error there, and fail the build as an unused directive -- which
     * would be a broken test rather than the passing one it looks like.
     */
    // @ts-expect-error -- a private field makes the class nominal: a structural stand-in is not assignable.
    const structural: NonProductionRuntime = { name: "test" };
    // @ts-expect-error -- the constructor is private, so `attest` is the only door in.
    const direct = new NonProductionRuntime("test");
    expect(structural).toBeDefined();
    expect(direct).toBeDefined();
  });
});

describe("the rights declaration", () => {
  it("is a category plus an opaque reference, and the reference is the reserved token", () => {
    const provider = build(BASE_OPTIONS);
    expect(provider.rightsBasis.rights).toBe("owned");
    expect(provider.rightsBasis.basis).toBe("operator-owned-master");
    expect(provider.rightsBasis.reference).toBe(FIXTURE_RIGHTS_REFERENCE);
    expect(provider.rightsBasis.attestedRuntime).toBe("test");
  });

  /*
   * The shape rule, applied to the value this package actually ships. The
   * pattern's own unit behaviour is not the interesting part -- what matters is
   * that the reference carried into every reason trail cannot become prose, a
   * URL, an address or anything with a counterparty's punctuation in it without
   * this failing.
   */
  it("carries a reference that is mechanically incapable of holding prose or a URL", () => {
    expect(isOpaqueRightsReference(FIXTURE_RIGHTS_REFERENCE)).toBe(true);
    for (const candidate of [
      "licensed from Example Media Group for EMEA until 2027-01-01",
      "https://rights.example.test/contracts/4711",
      "user:secret@rights.example.test",
      "Contract_4711",
      ""
    ]) {
      expect(isOpaqueRightsReference(candidate)).toBe(false);
    }
  });
});

describe("construction refuses configuration it cannot serve", () => {
  it("refuses an origin the outbound URL policy rejects", () => {
    expect(refusalReason({ ...BASE_OPTIONS, mediaOrigin: "http://10.0.0.5/" })).toBe(
      "url_private_address"
    );
    expect(refusalReason({ ...BASE_OPTIONS, mediaOrigin: "https://user:pass@rig.test/" })).toBe(
      "url_credentials_present"
    );
    expect(refusalReason({ ...BASE_OPTIONS, mediaOrigin: "http://rig.test/" })).toBe(
      "url_plaintext_http_not_loopback"
    );
  });

  /*
   * Not a hypothetical, and the reason it is asserted rather than assumed: the
   * scheme gate is the only thing standing between "an operator typed an origin"
   * and a non-HTTP transport reaching this adapter. Product invariant 2 and
   * docs/CONTENT_RIGHTS.md forbid the whole family.
   */
  it("refuses a magnet origin outright", () => {
    expect(
      refusalReason({ ...BASE_OPTIONS, mediaOrigin: "magnet:?xt=urn:btih:0000000000" })
    ).toBe("url_scheme_not_http");
  });

  it("requires both loopback permissions, and neither alone is enough", () => {
    const loopback = "http://127.0.0.1:8080/";
    expect(refusalReason({ ...BASE_OPTIONS, mediaOrigin: loopback })).toBe(
      "url_loopback_not_permitted"
    );
    expect(
      refusalReason({ ...BASE_OPTIONS, mediaOrigin: loopback, allowLoopback: true })
    ).toBe("url_loopback_not_local_deployment");
    expect(
      refusalReason({
        ...BASE_OPTIONS,
        mediaOrigin: loopback,
        allowLoopback: true,
        localDeployment: true
      })
    ).toBe("accepted");
  });

  it("refuses a latency it cannot put on a candidate", () => {
    expect(refusalReason({ ...BASE_OPTIONS, unmeasuredLatencyMs: Number.NaN })).toBe(
      "fixture_latency_not_stated"
    );
    expect(refusalReason({ ...BASE_OPTIONS, unmeasuredLatencyMs: -1 })).toBe(
      "fixture_latency_not_stated"
    );
    expect(refusalReason({ ...BASE_OPTIONS, unmeasuredLatencyMs: Number.POSITIVE_INFINITY })).toBe(
      "fixture_latency_not_stated"
    );
  });

  it("refuses an id that could smuggle a delimiter into a candidate id", () => {
    expect(refusalReason({ ...BASE_OPTIONS, id: "fix:ture" })).toBe("fixture_id_invalid");
    expect(refusalReason({ ...BASE_OPTIONS, id: "" })).toBe("fixture_id_invalid");
  });
});

describe("resolution", () => {
  it("returns three candidates, worst-first, with provider-namespaced ids", () => {
    const resolution = build(BASE_OPTIONS).resolve(itemFor(), CONTEXT);

    expect(resolution.reason).toBe("resolved");
    expect(resolution.requestId).toBe("req-1");
    expect(resolution.candidates.map((candidate) => candidate.protocol)).toEqual([
      "https",
      "hls",
      "dash"
    ]);
    expect(resolution.candidates.map((candidate) => candidate.id)).toEqual([
      "fixture:big-buck-bunny:progressive",
      "fixture:big-buck-bunny:hls",
      "fixture:big-buck-bunny:dash"
    ]);
  });

  /*
   * THE ASSERTION THIS FILE EXISTS FOR. A stated `h264`/`aac` pair is the most
   * widely supported combination in existence, so stating it would make every
   * fixture pass capability eligibility precisely because every device accepts
   * it -- and the session would then be labelled `verified` about a file nobody
   * has opened.
   */
  it("states no media fact about a file nothing has opened", () => {
    for (const entry of build(BASE_OPTIONS).resolve(itemFor(), CONTEXT).mapped) {
      expect(entry.candidate.videoCodec).toBeNull();
      expect(entry.candidate.audioCodec).toBeNull();
      expect(entry.candidate.height).toBeNull();
      expect(entry.candidate.bitrateKbps).toBeNull();
      expect(entry.unknownFacts).toEqual(["videoCodec", "audioCodec", "height", "bitrateKbps"]);
    }
  });

  it("charges the full latency penalty and ranks on a prior, never a measurement", () => {
    const provider = build(BASE_OPTIONS);
    const report = provider.providerHealthReport();

    expect(report.status).toBe("unknown");
    expect(report.sampleCount).toBe(0);
    expect(report.observedSuccessRate).toBeNull();

    for (const candidate of provider.resolve(itemFor(), CONTEXT).candidates) {
      expect(candidate.estimatedLatencyMs).toBe(1000);
      expect(candidate.healthScore).toBe(0.5);
    }
  });

  it("composes addresses through URL, so a query, a fragment or a trailing slash cannot move them", () => {
    const provider = build({ ...BASE_OPTIONS, mediaOrigin: "https://rig.test/media/?v=2#top" });

    expect(provider.resolve(itemFor(), CONTEXT).mapped.map((entry) => entry.uri)).toEqual([
      "https://rig.test/media/big-buck-bunny/720p.mp4",
      "https://rig.test/media/big-buck-bunny/master.m3u8",
      "https://rig.test/media/big-buck-bunny/manifest.mpd"
    ]);
  });

  it("only ever produces https addresses from an https origin", () => {
    for (const entry of build(BASE_OPTIONS).resolve(itemFor(), CONTEXT).mapped) {
      expect(new URL(entry.uri).protocol).toBe("https:");
    }
  });

  it("refuses an item routed to a different provider", () => {
    const resolution = build(BASE_OPTIONS).resolve(itemFor({ providerId: "somebody-else" }), CONTEXT);
    expect(resolution.reason).toBe("item_provider_mismatch");
    expect(resolution.candidates).toEqual([]);
  });

  it("refuses to choose between a catalog's rights and its own", () => {
    const resolution = build(BASE_OPTIONS).resolve(itemFor({ rights: "licensed" }), CONTEXT);
    expect(resolution.reason).toBe("item_rights_conflict");
    expect(resolution.candidates).toEqual([]);
  });

  it("refuses an external id it would otherwise interpolate into a path", () => {
    for (const externalId of ["../secrets", "Big-Buck-Bunny", "big buck bunny", "a/b"]) {
      const resolution = build(BASE_OPTIONS).resolve(itemFor({ externalId }), CONTEXT);
      expect(resolution.reason).toBe("item_id_not_normalized");
      expect(resolution.candidates).toEqual([]);
    }
  });

  it("is deterministic: the same item resolves identically however often it is asked", () => {
    const provider = build(BASE_OPTIONS);
    const first = provider.resolve(itemFor(), CONTEXT);
    expect(provider.resolve(itemFor(), CONTEXT)).toEqual(first);
    expect(provider.resolve(itemFor(), CONTEXT)).toEqual(first);
  });

  it("hands the AuthorizedMediaProvider surface exactly the candidates and nothing more", async () => {
    const provider = build(BASE_OPTIONS);
    await expect(provider.resolveAuthorizedCandidates(itemFor(), CONTEXT)).resolves.toEqual(
      provider.resolve(itemFor(), CONTEXT).candidates
    );
  });
});

describe("the catalog registry port", () => {
  it("maps a normalized content id onto this provider's own item, and refuses anything else", () => {
    const registry = fixtureCatalogItemRegistry("fixture", "owned");

    expect(registry.lookup(CONTENT_ID)).toEqual({
      providerId: "fixture",
      externalId: CONTENT_ID,
      rights: "owned"
    });
    for (const contentId of ["../secrets", "Big-Buck-Bunny", "", "a/b"]) {
      expect(registry.lookup(contentId)).toBeNull();
    }
  });

  it("is the registry the provider publishes", () => {
    const provider = build(BASE_OPTIONS);
    expect(provider.registry.lookup(CONTENT_ID)).toEqual(itemFor());
  });
});
