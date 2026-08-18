import { describe, expect, it } from "vitest";
import { PLAYABLE_CONTENT_RIGHTS } from "@liberty/contracts/shared/rights";
import {
  defineStremioSource,
  defineStremioSources,
  describeRightsBasis,
  RIGHTS_BASES_FOR_RIGHTS,
  RIGHTS_BASIS_KINDS,
  RIGHTS_BASIS_MEANING,
  type DeploymentContext,
  type RightsBasisKind
} from "./source";

const valid = {
  id: "public-domain-archive",
  manifestUrl: "https://archive.example.com/manifest.json",
  rights: "public-domain",
  rightsBasis: {
    rights: "public-domain",
    basis: "public-domain-determination",
    reference: "US public domain, pre-1929 catalogue, verified 2026-01"
  }
};

const reasonOf = (input: unknown, deployment: DeploymentContext = {}): string => {
  const result = defineStremioSource(input, deployment);
  return result.ok ? "ok" : result.reason;
};

const detailOf = (input: unknown): string => {
  const result = defineStremioSource(input);
  return result.ok ? "" : result.detail;
};

describe("rights are declared, never inferred", () => {
  it("accepts a source that declares playable rights", () => {
    const result = defineStremioSource(valid);
    expect(result.ok).toBe(true);
    expect(result.ok && result.source.rights).toBe("public-domain");
  });

  it("accepts every value on the contract's allowlist and nothing else", () => {
    for (const rights of PLAYABLE_CONTENT_RIGHTS) {
      for (const basis of RIGHTS_BASES_FOR_RIGHTS[rights]) {
        const rightsBasis = { rights, basis, reference: `evidence-for-${basis}` };
        expect(reasonOf({ ...valid, rights, rightsBasis })).toBe("ok");
      }
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
    // The retired one-to-one vocabulary. `user-library` was custody wearing the
    // clothes of a legal basis, so it is gone rather than remapped: a config
    // still carrying it must fail loudly, not be quietly reinterpreted.
    expect(
      reasonOf({
        ...valid,
        rightsBasis: { ...valid.rightsBasis, basis: "user-library" }
      })
    ).toBe("rights_basis_malformed");
    expect(
      reasonOf({
        ...valid,
        rightsBasis: { ...valid.rightsBasis, basis: "public-domain" }
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

  it("derives the whole vocabulary from the compatibility table", () => {
    // One list, not two. A basis the table permits but a separate allowlist does
    // not would be refused as unrecognised even though it is permitted, and the
    // reverse would be recognised and then refused for every rights class.
    expect(RIGHTS_BASIS_KINDS).toEqual([
      "direct-license",
      "operator-owned-master",
      "partner-entitlement",
      "provider-contract",
      "public-domain-collection",
      "public-domain-determination",
      "user-owned-copy"
    ]);
    expect([...RIGHTS_BASIS_KINDS].sort()).toEqual([...RIGHTS_BASIS_KINDS]);
    for (const basis of RIGHTS_BASIS_KINDS) {
      expect(RIGHTS_BASIS_MEANING[basis]).toBeTruthy();
    }
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
        rightsBasis: {
          rights: "public-domain",
          basis: "public-domain-determination",
          reference: "pd-1928"
        }
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
        rightsBasis: {
          rights: "licensed",
          basis: "public-domain-determination",
          reference: "pd-1928"
        }
      })
    ).toBe("rights_basis_incoherent");

    // A contract permits USE; it does not transfer ownership.
    expect(
      reasonOf({
        ...valid,
        rights: "owned",
        rightsBasis: { rights: "owned", basis: "provider-contract", reference: "MSA-2026-0142" }
      })
    ).toBe("rights_basis_incoherent");

    // Public domain is a status of the WORK. Nobody grants it to us, so no
    // licence and no ownership claim can be what establishes it.
    expect(
      reasonOf({
        ...valid,
        rightsBasis: { ...valid.rightsBasis, basis: "direct-license" }
      })
    ).toBe("rights_basis_incoherent");
  });

  it("refuses custody as the basis for a licence, and says why", () => {
    /*
     * The specific confusion this vocabulary exists to prevent. A licensed film
     * cached in a user's local library is STILL licensed, and its basis is still
     * the licence or contract that permits it -- where the bytes are sitting is
     * not a legal position. Accepting `user-owned-copy` here would let "we have
     * a copy" stand in for "we are allowed to serve it".
     */
    const custodyAsLicence = {
      ...valid,
      rights: "licensed",
      rightsBasis: {
        rights: "licensed",
        basis: "user-owned-copy",
        reference: "cached in the household library"
      }
    };

    expect(reasonOf(custodyAsLicence)).toBe("rights_basis_incoherent");
    expect(detailOf(custodyAsLicence)).toContain("is not a legal basis");
    // And the honest alternative is available: media that genuinely is the
    // viewer's own is `owned`, evidenced by the copy they own.
    expect(
      reasonOf({
        ...valid,
        rights: "owned",
        rightsBasis: {
          rights: "owned",
          basis: "user-owned-copy",
          reference: "household library, disc rip of purchased copy"
        }
      })
    ).toBe("ok");
  });

  it("accepts exactly the combinations the compatibility table permits", () => {
    // The full matrix: 7 bases x 3 rights classes. Seven coherent pairings, and
    // fourteen refusals -- every one of which used to be unrepresentable rather
    // than checked, because there was only one basis per class to choose from.
    let accepted = 0;
    for (const rights of PLAYABLE_CONTENT_RIGHTS) {
      for (const basis of RIGHTS_BASIS_KINDS) {
        const permitted = RIGHTS_BASES_FOR_RIGHTS[rights].includes(basis);
        expect(
          reasonOf({ ...valid, rights, rightsBasis: { rights, basis, reference: "ref-1" } })
        ).toBe(permitted ? "ok" : "rights_basis_incoherent");
        if (permitted) accepted++;
      }
    }
    expect(accepted).toBe(7);
  });

  it("partitions the vocabulary, so no basis evidences two different classes", () => {
    // `RIGHTS_BASIS_KINDS` is derived by flattening the table through a Set, so
    // a basis listed under two rights classes would silently deduplicate and the
    // matrix above would still pass. Asserted directly instead.
    const counts = new Map<RightsBasisKind, number>();
    for (const rights of PLAYABLE_CONTENT_RIGHTS) {
      for (const basis of RIGHTS_BASES_FOR_RIGHTS[rights]) {
        counts.set(basis, (counts.get(basis) ?? 0) + 1);
      }
    }
    expect([...counts.values()]).toEqual(RIGHTS_BASIS_KINDS.map(() => 1));
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

  it("orders the accepted sources by id, not by the order they were configured", () => {
    // Nothing downstream may acquire a preference for whichever source the
    // operator happened to type first.
    const configured = [
      { ...valid, id: "zulu" },
      { ...valid, id: "alpha" },
      { ...valid, id: "mike" }
    ];

    expect(defineStremioSources(configured).sources.map((source) => source.id)).toEqual([
      "alpha",
      "mike",
      "zulu"
    ]);
    expect(defineStremioSources([...configured].reverse()).sources).toEqual(
      defineStremioSources(configured).sources
    );
  });

  it("orders two entries that share an id and a manifest URL by their rights and basis", () => {
    /*
     * The fixture the old comparator could not order. It compared id then
     * manifest URL and nothing else, so these two returned 0 -- and
     * `Array.prototype.sort` is stable, which means the tie resolved to the
     * operator's config order, the one thing this function promises to discard.
     * Nothing here enforces id uniqueness, so the tie is a configuration an
     * operator can actually write, and a downstream
     * `new Map(sources.map((source) => [source.id, source]))` would then resolve
     * "shared" as licensed or as owned depending on which line was typed first.
     */
    const licensed = {
      ...valid,
      id: "shared",
      rights: "licensed",
      rightsBasis: { rights: "licensed", basis: "direct-license", reference: "LIC-1" }
    };
    const owned = {
      ...valid,
      id: "shared",
      rights: "owned",
      rightsBasis: { rights: "owned", basis: "user-owned-copy", reference: "household copy" }
    };

    const forwards = defineStremioSources([licensed, owned]);
    const backwards = defineStremioSources([owned, licensed]);

    expect(forwards.sources).toHaveLength(2);
    expect(forwards.sources).toEqual(backwards.sources);
    expect(forwards.sources.map((source) => source.rights)).toEqual(["licensed", "owned"]);
  });

  it("orders two otherwise identical entries by display name, then by permission", () => {
    const base = { ...valid, id: "shared" };

    const named = defineStremioSources([
      { ...base, displayName: "Zulu" },
      { ...base, displayName: "Alpha" }
    ]);
    expect(named.sources.map((source) => source.displayName)).toEqual(["Alpha", "Zulu"]);
    expect(named.sources).toEqual(
      defineStremioSources([
        { ...base, displayName: "Alpha" },
        { ...base, displayName: "Zulu" }
      ]).sources
    );

    const flagged = defineStremioSources([
      { ...base, acceptNotWebReady: true },
      { ...base, acceptNotWebReady: false }
    ]);
    // Closed position first, so a human skimming the list does not read the more
    // permissive of two identical sources as the canonical one.
    expect(flagged.sources.map((source) => source.acceptNotWebReady)).toEqual([false, true]);
    expect(flagged.sources).toEqual(
      defineStremioSources([
        { ...base, acceptNotWebReady: false },
        { ...base, acceptNotWebReady: true }
      ]).sources
    );
  });
});
