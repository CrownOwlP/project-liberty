import { describe, expect, it } from "vitest";
import { PLAYABLE_CONTENT_RIGHTS } from "@liberty/contracts";
import { defineStremioSource, defineStremioSources } from "./source";

const valid = {
  id: "public-domain-archive",
  manifestUrl: "https://archive.example.com/manifest.json",
  rights: "public-domain",
  rightsBasis: "US public domain, pre-1929 catalogue, verified 2026-01"
};

const reasonOf = (input: unknown): string => {
  const result = defineStremioSource(input);
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
      expect(reasonOf({ ...valid, rights })).toBe("ok");
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
    expect(reasonOf({ id: "", manifestUrl: "not a url", rights: "pirated", rightsBasis: "" })).toBe(
      "rights_not_playable"
    );
  });

  it("requires a documented rights basis", () => {
    const { rightsBasis: _dropped, ...withoutBasis } = valid;
    expect(reasonOf(withoutBasis)).toBe("rights_basis_missing");
    expect(reasonOf({ ...valid, rightsBasis: "" })).toBe("rights_basis_missing");
    expect(reasonOf({ ...valid, rightsBasis: "ok" })).toBe("rights_basis_missing");
    expect(reasonOf({ ...valid, rightsBasis: "        " })).toBe("rights_basis_missing");
  });

  it("carries the declared rights and basis onto the source unchanged", () => {
    const result = defineStremioSource({ ...valid, rights: "licensed" });
    expect(result.ok && result.source.rights).toBe("licensed");
    expect(result.ok && result.source.rightsBasis).toBe(valid.rightsBasis);
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

  it("permits a loopback manifest only when the source declares itself local", () => {
    const localUrl = "http://127.0.0.1:11470/manifest.json";
    expect(reasonOf({ ...valid, manifestUrl: localUrl })).toBe("url_loopback_not_permitted");
    expect(reasonOf({ ...valid, manifestUrl: localUrl, allowLoopback: true })).toBe("ok");
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
