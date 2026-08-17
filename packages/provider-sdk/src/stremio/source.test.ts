import { describe, expect, it } from "vitest";
import { PLAYABLE_CONTENT_RIGHTS } from "@liberty/contracts";
import {
  defineStremioSource,
  defineStremioSources,
  describeRightsBasis,
  RIGHTS_BASIS_FOR_RIGHTS,
  type DeploymentContext
} from "./source";

const valid = {
  id: "public-domain-archive",
  manifestUrl: "https://archive.example.com/manifest.json",
  rights: "public-domain",
  rightsBasis: {
    rights: "public-domain",
    basis: "public-domain",
    reference: "US public domain, pre-1929 catalogue, verified 2026-01"
  }
};

const reasonOf = (input: unknown, deployment: DeploymentContext = {}): string => {
  const result = defineStremioSource(input, deployment);
  return result.ok ? "ok" : result.reason;
};

describe("rights are declared, never inferred", () => {
  it("accepts a source that declares playable rights", () => {
    const result = defineStremioSource(valid);
    expect(result.ok).toBe(true);
    expect(result.ok && result.source.rights).toBe("public-domain");
  });

  it("accepts every value on the contract's allowlist and nothing else", () => {
    for (const rights of PLAYABLE_CONTENT_RIGHTS) {
      const rightsBasis = {
        rights,
        basis: RIGHTS_BASIS_FOR_RIGHTS[rights],
        reference: `evidence-for-${rights}`
      };
      expect(reasonOf({ ...valid, rights, rightsBasis })).toBe("ok");
    }
  });

  it("yields no source when rights are absent", () => {
    expect(reasonOf({ ...valid, rights: undefined })).toBe("rights_not_declared");
    expect(reasonOf({ ...valid, rights: null })).toBe("rights_not_declared");
    expect(reasonOf({ ...valid, rights: "" })).toBe("rights_not_declared");
    const { rights: _dropped, ...withoutRights } = valid;
    expect(reasonOf(withoutRights)).toBe("rights_not_declared");
  });

  it("yields no source when rights are outside the allowlist", () => {
    // Fail closed: an unrecognised rights value is not a weaker permission, it is
    // no permission. Nothing about "unlicensed" or a typo may resolve to allowed.
    expect(reasonOf({ ...valid, rights: "unlicensed" })).toBe("rights_not_playable");
    expect(reasonOf({ ...valid, rights: "public domain" })).toBe("rights_not_playable");
    expect(reasonOf({ ...valid, rights: "LICENSED" })).toBe("rights_not_playable");
    expect(reasonOf({ ...valid, rights: true })).toBe("rights_not_playable");
    expect(reasonOf({ ...valid, rights: ["licensed"] })).toBe("rights_not_playable");
    expect(reasonOf({ ...valid, rights: { value: "licensed" } })).toBe("rights_not_playable");
  });

  it("reports the rights failure first, even when the rest of the config is also broken", () => {
    // The most fundamental reason is the one worth reporting: fixing the id would
    // not make this source servable.
    expect(
      reasonOf({ id: "", manifestUrl: "not a url", rights: "pirated", rightsBasis: undefined })
    ).toBe("rights_not_playable");
  });

  it("carries the declared rights and basis onto the source unchanged", () => {
    const rightsBasis = {
      rights: "licensed",
      basis: "provider-contract",
      reference: "MSA-2026-0142"
    };
    const result = defineStremioSource({ ...valid, rights: "licensed", rightsBasis });
    expect(result.ok && result.source.rights).toBe("licensed");
    expect(result.ok && result.source.rightsBasis).toEqual(rightsBasis);
  });
});

describe("the rights basis is auditable evidence, not a length", () => {
  it("yields no source when there is no basis at all", () => {
    const { rightsBasis: _dropped, ...withoutBasis } = valid;
    expect(reasonOf(withoutBasis)).toBe("rights_basis_missing");
    expect(reasonOf({ ...valid, rightsBasis: undefined })).toBe("rights_basis_missing");
    expect(reasonOf({ ...valid, rightsBasis: null })).toBe("rights_basis_missing");
  });

  it("refuses free text, which is what a length check used to accept", () => {
    // The old gate passed any eight characters. These are all longer than that
    // and none of them says which contract, collection or determination applies.
    expect(reasonOf({ ...valid, rightsBasis: "abcdefgh" })).toBe("rights_basis_malformed");
    expect(reasonOf({ ...valid, rightsBasis: "we are definitely allowed to serve this" })).toBe(
      "rights_basis_malformed"
    );
    expect(reasonOf({ ...valid, rightsBasis: ["public-domain"] })).toBe("rights_basis_malformed");
    expect(reasonOf({ ...valid, rightsBasis: true })).toBe("rights_basis_malformed");
  });

  it("refuses a basis whose vocabulary is not one this system knows", () => {
    expect(
      reasonOf({
        ...valid,
        rightsBasis: { ...valid.rightsBasis, basis: "fair-use" }
      })
    ).toBe("rights_basis_malformed");
    expect(
      reasonOf({
        ...valid,
        rightsBasis: { ...valid.rightsBasis, rights: "pirated" }
      })
    ).toBe("rights_basis_malformed");
    const { reference: _dropped, ...withoutReference } = valid.rightsBasis;
    expect(reasonOf({ ...valid, rightsBasis: withoutReference })).toBe("rights_basis_malformed");
  });

  it("requires a reference, and does not care how long it is", () => {
    expect(reasonOf({ ...valid, rightsBasis: { ...valid.rightsBasis, reference: "" } })).toBe(
      "rights_basis_malformed"
    );
    expect(reasonOf({ ...valid, rightsBasis: { ...valid.rightsBasis, reference: "   " } })).toBe(
      "rights_basis_malformed"
    );
    // One character is a real collection id. "abcdefgh" was never stronger
    // evidence than "x"; it was only longer.
    expect(reasonOf({ ...valid, rightsBasis: { ...valid.rightsBasis, reference: "x" } })).toBe("ok");
  });

  it("refuses a basis that evidences different rights from the ones declared", () => {
    expect(
      reasonOf({
        ...valid,
        rights: "licensed",
        rightsBasis: { rights: "public-domain", basis: "public-domain", reference: "pd-1928" }
      })
    ).toBe("rights_basis_incoherent");
  });

  it("refuses a classification that contradicts itself", () => {
    // The reviewer's example: licensed content cannot rest on a public-domain
    // determination. A licence has terms and an expiry; a determination has
    // neither, and believing either half would be choosing one at random.
    expect(
      reasonOf({
        ...valid,
        rights: "licensed",
        rightsBasis: { rights: "licensed", basis: "public-domain", reference: "pd-1928" }
      })
    ).toBe("rights_basis_incoherent");

    expect(
      reasonOf({
        ...valid,
        rights: "owned",
        rightsBasis: { rights: "owned", basis: "provider-contract", reference: "MSA-2026-0142" }
      })
    ).toBe("rights_basis_incoherent");

    expect(
      reasonOf({
        ...valid,
        rightsBasis: { ...valid.rightsBasis, basis: "user-library" }
      })
    ).toBe("rights_basis_incoherent");
  });

  it("has exactly one basis per rights value, and accepts only that pairing", () => {
    for (const rights of PLAYABLE_CONTENT_RIGHTS) {
      for (const basis of ["provider-contract", "user-library", "public-domain"] as const) {
        const outcome = reasonOf({
          ...valid,
          rights,
          rightsBasis: { rights, basis, reference: "ref-1" }
        });
        expect(outcome).toBe(basis === RIGHTS_BASIS_FOR_RIGHTS[rights] ? "ok" : "rights_basis_incoherent");
      }
    }
  });

  it("summarises the authorization in one line for the reason trail", () => {
    expect(
      describeRightsBasis({ rights: "licensed", basis: "provider-contract", reference: "MSA-2026-0142" })
    ).toBe("licensed via provider-contract (MSA-2026-0142)");
  });
});

describe("loopback needs the deployment's permission as well as the source's", () => {
  const localManifest = "https://127.0.0.1:11470/manifest.json";

  it("refuses a loopback manifest when only the source opted in", () => {
    // `allowLoopback` is written by whoever edits a source config. On a hosted
    // instance 127.0.0.1 is the Liberty server itself, so a source must not be
    // able to grant itself an SSRF capability aimed at us.
    expect(reasonOf({ ...valid, manifestUrl: localManifest, allowLoopback: true })).toBe(
      "url_loopback_not_local_deployment"
    );
  });

  it("refuses a loopback manifest when only the deployment is local", () => {
    expect(
      reasonOf({ ...valid, manifestUrl: localManifest }, { localDeployment: true })
    ).toBe("url_loopback_not_permitted");
  });

  it("permits a loopback manifest only when both conditions hold", () => {
    expect(
      reasonOf(
        { ...valid, manifestUrl: localManifest, allowLoopback: true },
        { localDeployment: true }
      )
    ).toBe("ok");
  });

  it("refuses a source config that tries to declare the deployment's mode", () => {
    // Ignoring the key would be safe and would leave an operator believing they
    // had enabled something they had not.
    expect(reasonOf({ ...valid, localDeployment: true })).toBe(
      "local_deployment_not_source_configurable"
    );
    expect(reasonOf({ ...valid, localDeployment: false })).toBe(
      "local_deployment_not_source_configurable"
    );
  });

  it("records the deployment mode the source was authorized under", () => {
    const hosted = defineStremioSource(valid);
    expect(hosted.ok && hosted.source.localDeployment).toBe(false);

    const declared = defineStremioSource(valid, { localDeployment: true });
    expect(declared.ok && declared.source.localDeployment).toBe(true);
  });
});

describe("source configuration is untrusted input", () => {
  it("rejects anything that is not an object", () => {
    for (const input of [null, undefined, "https://addon.example.com/manifest.json", 7, []]) {
      expect(reasonOf(input)).toBe("source_config_malformed");
    }
  });

  it("rejects an id that could collide with the candidate id separator", () => {
    expect(reasonOf({ ...valid, id: "archive:evil" })).toBe("source_id_invalid");
    expect(reasonOf({ ...valid, id: "" })).toBe("source_id_invalid");
    expect(reasonOf({ ...valid, id: "../../etc" })).toBe("source_id_invalid");
  });

  it("applies the URL policy to the configured manifest URL", () => {
    expect(reasonOf({ ...valid, manifestUrl: "http://169.254.169.254/manifest.json" })).toBe(
      "url_private_address"
    );
    expect(reasonOf({ ...valid, manifestUrl: "http://addon.example.com/manifest.json" })).toBe(
      "url_plaintext_http_not_loopback"
    );
    expect(reasonOf({ ...valid, manifestUrl: "file:///srv/manifest.json" })).toBe("url_scheme_not_http");
  });

  it("refuses a loopback manifest for a source that did not declare itself local", () => {
    // The rest of the loopback matrix, including why the opt-in alone is not
    // enough, is in its own describe block below.
    const localUrl = "http://127.0.0.1:11470/manifest.json";
    expect(reasonOf({ ...valid, manifestUrl: localUrl })).toBe("url_loopback_not_permitted");
    expect(reasonOf({ ...valid, manifestUrl: localUrl }, { localDeployment: true })).toBe(
      "url_loopback_not_permitted"
    );
  });

  it("requires the protocol's own entry point, not an arbitrary path", () => {
    expect(reasonOf({ ...valid, manifestUrl: "https://archive.example.com/admin/status" })).toBe(
      "manifest_url_not_manifest_json"
    );
  });

  it("derives a base URL by removing the manifest suffix", () => {
    const result = defineStremioSource({
      ...valid,
      manifestUrl: "https://archive.example.com/cfg=1/manifest.json?ignored=1#frag"
    });
    expect(result.ok && result.source.baseUrl).toBe("https://archive.example.com/cfg=1");
    expect(result.ok && result.source.manifestUrl).toBe(
      "https://archive.example.com/cfg=1/manifest.json"
    );
  });

  it("defaults every permission to the closed position", () => {
    const result = defineStremioSource(valid);
    expect(result.ok && result.source.allowLoopback).toBe(false);
    expect(result.ok && result.source.localDeployment).toBe(false);
    expect(result.ok && result.source.acceptNotWebReady).toBe(false);
    expect(result.ok && result.source.displayName).toBe(valid.id);
  });
});

describe("defineStremioSources", () => {
  it("keeps the good sources and reports the bad ones by index", () => {
    const { sources, rejected } = defineStremioSources([
      valid,
      { ...valid, id: "no-rights", rights: undefined },
      { ...valid, id: "second-good" }
    ]);

    expect(sources.map((source) => source.id)).toEqual(["public-domain-archive", "second-good"]);
    expect(rejected).toEqual([
      { index: 1, reason: "rights_not_declared", detail: expect.any(String) }
    ]);
  });
});
