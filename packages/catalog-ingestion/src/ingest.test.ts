import { describe, expect, it } from "vitest";
import { runIngestionPass, type IngestionPassOptions } from "./ingest";
import type {
  CatalogMetadataProvider,
  ProviderCapabilities,
  ProviderPageRequest,
  ProviderPageResult,
  RawProviderRecord
} from "./provider";

const SOURCE = "example-source";
const NOW = Date.parse("2026-09-16T00:00:00.000Z");
const OBSERVED = "2026-09-16T00:00:00.000Z";

const CAPABILITIES: ProviderCapabilities = {
  providerSideSearch: false,
  incrementalSince: true,
  reportsDeletions: false,
  maxPageSize: 100
};

const rawWork = (nativeId: string, over: Record<string, unknown> = {}): unknown => ({
  contentId: `${SOURCE}-${nativeId}`,
  kind: "movie",
  titles: [{ locale: "en", value: `Work ${nativeId}` }],
  synopses: [],
  genres: [{ locale: "en", value: "Drama" }],
  releaseYear: 2024,
  runtimeMinutes: 100,
  episodeCount: null,
  availability: [{ territory: "WW", startsAt: null, endsAt: null }],
  artwork: [],
  rights: { category: "public-domain", reference: null },
  ...over
});

const record = (nativeId: string, over: Record<string, unknown> = {}): RawProviderRecord => ({
  nativeId,
  sourceRevision: null,
  crossRefs: [],
  raw: rawWork(nativeId, over)
});

interface ProviderScript {
  readonly pages: readonly ProviderPageResult[];
  readonly capabilities?: ProviderCapabilities;
}

const scriptedProvider = (
  script: ProviderScript
): { provider: CatalogMetadataProvider; requests: ProviderPageRequest[] } => {
  const requests: ProviderPageRequest[] = [];
  let index = 0;
  const provider: CatalogMetadataProvider = {
    sourceId: SOURCE,
    capabilities: script.capabilities ?? CAPABILITIES,
    fetchPage: (request) => {
      requests.push(request);
      const page = script.pages[index];
      index += 1;
      if (page === undefined) throw new Error("the pass asked for more pages than were scripted");
      return Promise.resolve(page);
    }
  };
  return { provider, requests };
};

const options = (over: Partial<IngestionPassOptions> = {}): IngestionPassOptions => ({
  pageSize: 50,
  maxPages: 10,
  resumeCursor: null,
  changedSince: null,
  knownContentIds: [],
  ...over
});

const deps = { now: () => NOW };

describe("runIngestionPass", () => {
  it("pages until the provider stops issuing a cursor", async () => {
    const { provider, requests } = scriptedProvider({
      pages: [
        { ok: true, records: [record("a")], nextCursor: "c1", withdrawn: [] },
        { ok: true, records: [record("b")], nextCursor: null, withdrawn: [] }
      ]
    });

    const result = await runIngestionPass(provider, options(), deps);

    expect(requests.map((request) => request.cursor)).toEqual([null, "c1"]);
    expect(result.pagesFetched).toBe(2);
    expect(result.accepted.map((entry) => entry.work.contentId)).toEqual([
      "example-source-a",
      "example-source-b"
    ]);
    expect(result.complete).toBe(true);
    expect(result.nextCursor).toBeNull();
    expect(result.observedAt).toBe(OBSERVED);
  });

  it("resumes from a cursor a previous pass returned", async () => {
    const { provider, requests } = scriptedProvider({
      pages: [{ ok: true, records: [record("c")], nextCursor: null, withdrawn: [] }]
    });
    await runIngestionPass(provider, options({ resumeCursor: "c9" }), deps);
    expect(requests[0]?.cursor).toBe("c9");
  });

  /*
   * WHAT THIS CATCHES: an unbounded loop driven by a provider response. A cursor
   * that points at itself -- by bug or by design -- would otherwise run until
   * the process dies, reading a third party's bodies into memory the whole time.
   * The pass must stop, must say it is incomplete, and must hand back the cursor
   * so the next pass resumes rather than restarts.
   */
  it("stops at maxPages and reports the pass as incomplete with a resumable cursor", async () => {
    const { provider } = scriptedProvider({
      pages: [
        { ok: true, records: [record("a")], nextCursor: "loop", withdrawn: [] },
        { ok: true, records: [record("b")], nextCursor: "loop", withdrawn: [] }
      ]
    });

    const result = await runIngestionPass(provider, options({ maxPages: 2 }), deps);

    expect(result.pagesFetched).toBe(2);
    expect(result.complete).toBe(false);
    expect(result.nextCursor).toBe("loop");
    expect(result.tombstonesWithheld).toBe("page_limit_reached");
  });

  it("clamps the page size to what the provider says it will serve", async () => {
    const { provider, requests } = scriptedProvider({
      pages: [{ ok: true, records: [], nextCursor: null, withdrawn: [] }],
      capabilities: { ...CAPABILITIES, maxPageSize: 25 }
    });
    await runIngestionPass(provider, options({ pageSize: 500 }), deps);
    expect(requests[0]?.pageSize).toBe(25);
  });

  /* ---------------------------------------------------------------
   * Tombstones. The three withholding rules are the reason this file
   * exists; each one, applied wrongly, deletes a catalog.
   * --------------------------------------------------------------- */

  it("tombstones a known work that a complete pass did not see", async () => {
    const { provider } = scriptedProvider({
      pages: [{ ok: true, records: [record("a")], nextCursor: null, withdrawn: [] }]
    });

    const result = await runIngestionPass(
      provider,
      options({ knownContentIds: ["example-source-a", "example-source-gone"] }),
      deps
    );

    expect(result.tombstonesWithheld).toBeNull();
    expect(result.tombstones).toEqual([
      {
        contentId: "example-source-gone",
        sourceId: SOURCE,
        observedAt: OBSERVED,
        reason: "absent_from_complete_sync"
      }
    ]);
  });

  /*
   * WHAT THIS CATCHES: the worst available bug on this path. A pass whose second
   * page errored saw a prefix of the source, so everything it did not reach is
   * absent for a reason that is not evidence of anything. Tombstoning on it
   * deletes the catalog every time the provider has a bad afternoon, and the
   * deletion is indistinguishable from a legitimate withdrawal.
   */
  it("withholds tombstones when a page failed", async () => {
    const { provider } = scriptedProvider({
      pages: [
        { ok: true, records: [record("a")], nextCursor: "c1", withdrawn: [] },
        { ok: false, reason: "provider_unreachable", detail: "connection reset" }
      ]
    });

    const result = await runIngestionPass(
      provider,
      options({ knownContentIds: ["example-source-a", "example-source-b"] }),
      deps
    );

    expect(result.failure).toEqual({ reason: "provider_unreachable", detail: "connection reset" });
    expect(result.complete).toBe(false);
    expect(result.tombstonesWithheld).toBe("pass_failed");
    expect(result.tombstones).toEqual([]);
    // The records it DID read are still accepted: a partial read is still a read.
    expect(result.accepted).toHaveLength(1);
  });

  /*
   * WHAT THIS CATCHES: the subtle one. An incremental pass asks for what CHANGED,
   * so the provider deliberately returns a subset and everything unchanged is
   * absent for the best possible reason. Inferring deletion from it would delete
   * the whole catalog except this morning's edits, and every individual step of
   * the reasoning looks correct.
   */
  it("withholds tombstones from an incremental pass, however complete it was", async () => {
    const { provider } = scriptedProvider({
      pages: [{ ok: true, records: [record("a")], nextCursor: null, withdrawn: [] }]
    });

    const result = await runIngestionPass(
      provider,
      options({
        changedSince: "2026-09-15T00:00:00.000Z",
        knownContentIds: ["example-source-a", "example-source-unchanged"]
      }),
      deps
    );

    expect(result.tombstonesWithheld).toBe("incremental_pass");
    expect(result.tombstones).toEqual([]);
    expect(result.complete).toBe(false);
  });

  /*
   * WHAT THIS CATCHES: a provider deleting from our catalog through a field it
   * never declared support for. `withdrawn` is only honoured when
   * `reportsDeletions` is true; the capability is the declaration, and honouring
   * an undeclared one makes the declaration decorative.
   */
  it("ignores withdrawals from a provider that does not declare reportsDeletions", async () => {
    const { provider } = scriptedProvider({
      pages: [{ ok: true, records: [], nextCursor: null, withdrawn: ["a"] }]
    });
    const result = await runIngestionPass(provider, options(), deps);
    expect(result.tombstones).toEqual([]);
  });

  it("mints a withdrawal tombstone even from an incomplete pass, because the source said so", async () => {
    const { provider } = scriptedProvider({
      pages: [{ ok: true, records: [], nextCursor: "more", withdrawn: ["a"] }],
      capabilities: { ...CAPABILITIES, reportsDeletions: true }
    });

    const result = await runIngestionPass(provider, options({ maxPages: 1 }), deps);

    expect(result.tombstonesWithheld).toBe("page_limit_reached");
    expect(result.tombstones).toEqual([
      {
        contentId: "example-source-a",
        sourceId: SOURCE,
        observedAt: OBSERVED,
        reason: "withdrawn_by_source"
      }
    ]);
  });

  /* ---------------------------------------------------------------
   * Per-record refusals.
   * --------------------------------------------------------------- */

  /*
   * WHAT THIS CATCHES: the ordering defect. Zod strips unknown keys, so a schema
   * parse BEFORE the address scan would silently discard `streamUrl` and the
   * record would look clean -- meaning a provider sending media addresses in a
   * catalog payload would never be noticed at all.
   */
  it("refuses a record carrying a media address, scanning the raw payload before the schema strips it", async () => {
    const { provider } = scriptedProvider({
      pages: [
        {
          ok: true,
          records: [record("a", { streamUrl: "https://cdn.example.test/a/master.m3u8" })],
          nextCursor: null,
          withdrawn: []
        }
      ]
    });

    const result = await runIngestionPass(provider, options(), deps);

    expect(result.accepted).toEqual([]);
    expect(result.refused[0]?.reason).toBe("media_address_in_catalog_payload");
    expect(result.refused[0]?.detail).toContain("streamUrl");
  });

  it("refuses a record whose source declared no rights basis", async () => {
    const { provider } = scriptedProvider({
      pages: [
        { ok: true, records: [record("a", { rights: null })], nextCursor: null, withdrawn: [] }
      ]
    });
    const result = await runIngestionPass(provider, options(), deps);
    expect(result.accepted).toEqual([]);
    expect(result.refused[0]?.reason).toBe("rights_basis_not_declared");
  });

  /*
   * WHAT THIS CATCHES: an adapter inventing its own ids. Derivation is namespaced
   * by source precisely so two providers cannot collide; an adapter that skipped
   * it would reintroduce that collision, and overwriting the id silently would
   * hide the mistake from whoever wrote the adapter.
   */
  it("refuses a record whose id was not derived the way this package derives ids", async () => {
    const { provider } = scriptedProvider({
      pages: [
        {
          ok: true,
          records: [record("a", { contentId: "some-other-id" })],
          nextCursor: null,
          withdrawn: []
        }
      ]
    });
    const result = await runIngestionPass(provider, options(), deps);
    expect(result.refused[0]?.reason).toBe("content_id_does_not_match_derived_id");
  });

  it("refuses a record that does not satisfy the ingestion schema, naming the field and not its value", async () => {
    const { provider } = scriptedProvider({
      pages: [
        {
          ok: true,
          records: [record("a", { releaseYear: "nineteen ninety nine" })],
          nextCursor: null,
          withdrawn: []
        }
      ]
    });

    const result = await runIngestionPass(provider, options(), deps);

    expect(result.refused[0]?.reason).toBe("record_failed_validation");
    expect(result.refused[0]?.detail).toContain("releaseYear");
    expect(result.refused[0]?.detail).not.toContain("nineteen");
  });

  /*
   * WHAT THIS CATCHES: a provider cursor bug being absorbed silently. A repeated
   * record would otherwise be counted twice by anything that aggregates, and
   * quietly deduplicating it hides the provider defect that caused it.
   */
  it("refuses a native id the provider returned twice in one pass", async () => {
    const { provider } = scriptedProvider({
      pages: [
        { ok: true, records: [record("a")], nextCursor: "c1", withdrawn: [] },
        { ok: true, records: [record("a")], nextCursor: null, withdrawn: [] }
      ]
    });

    const result = await runIngestionPass(provider, options(), deps);

    expect(result.accepted).toHaveLength(1);
    expect(result.refused[0]?.reason).toBe("duplicate_native_id_in_pass");
  });

  /*
   * WHAT THIS CATCHES: a refused record being treated as absent. A record the
   * pass SAW and rejected is not a record the source withdrew, so tombstoning it
   * would delete a work for failing validation -- which is a remedy for the
   * wrong problem and loses the evidence that the provider sent something bad.
   */
  it("does not tombstone a known work that was seen and refused", async () => {
    const { provider } = scriptedProvider({
      pages: [
        { ok: true, records: [record("a", { rights: null })], nextCursor: null, withdrawn: [] }
      ]
    });

    const result = await runIngestionPass(
      provider,
      options({ knownContentIds: ["example-source-a"] }),
      deps
    );

    expect(result.refused).toHaveLength(1);
    expect(result.tombstonesWithheld).toBeNull();
    expect(result.tombstones).toEqual([]);
  });

  /*
   * WHAT THIS CATCHES: the distinction the test above rests on being collapsed.
   * A pass that saw and refused `a`, and did not see `gone` at all, must produce
   * exactly one tombstone. An implementation that populated the seen-set from
   * ACCEPTED records would tombstone both; one that populated it from the known
   * set would tombstone neither.
   */
  it("tombstones what it did not see while sparing what it refused, in one pass", async () => {
    const { provider } = scriptedProvider({
      pages: [
        { ok: true, records: [record("a", { rights: null })], nextCursor: null, withdrawn: [] }
      ]
    });

    const result = await runIngestionPass(
      provider,
      options({ knownContentIds: ["example-source-a", "example-source-gone"] }),
      deps
    );

    expect(result.tombstones.map((tombstone) => tombstone.contentId)).toEqual([
      "example-source-gone"
    ]);
  });
});

/**
 * PL-0313: a resumed pass may not infer absence.
 *
 * THE HAZARD THESE PIN, in one sentence: `complete` used to mean "this
 * invocation reached the end of the enumeration", and a pass that STARTED from
 * a cursor reaches that end having deliberately never looked at the pages
 * before it -- so every known id living on a skipped page was unseen, was
 * inferred withdrawn, and was tombstoned. Under the store's release rule a
 * tombstone is lifted only by a later complete pass that accepts the work
 * again, so the damage is not self-healing on the next pass.
 *
 * WHY THE FIX IS A WITHHOLD REASON AND NOT A NEW FIELD. `nextCursor === null`
 * already publishes "the enumeration ended"; a second field saying the same
 * thing would need a rule about which one a caller should believe. What was
 * missing is not a fact about the cursor, it is whether this pass is a basis
 * for inferring absence -- which is exactly what `tombstonesWithheld` already
 * answers for a failed, incremental or truncated pass. A resumed pass is a
 * fourth member of that set and nothing more.
 *
 * ORDERING: `resumed_pass` is reported ahead of `page_limit_reached` when both
 * are true. A resumed pass that also ran out of page budget has two reasons it
 * cannot infer absence, and the resume is the more fundamental one -- the
 * prefix was skipped BY CHOICE rather than by budget, and raising the budget
 * would not fix it.
 */
describe("a resumed pass is not a complete observation of the source", () => {
  it("withholds tombstones when it started from a cursor, even reaching the end", async () => {
    const { provider } = scriptedProvider({
      pages: [{ ok: true, records: [record("b")], nextCursor: null, withdrawn: [] }]
    });

    const result = await runIngestionPass(
      provider,
      options({
        resumeCursor: "page-2",
        // `a` lives on the page this pass deliberately skipped. Before PL-0313
        // it was tombstoned by a pass that never looked for it.
        knownContentIds: [`${SOURCE}-a`, `${SOURCE}-b`]
      }),
      { now: () => NOW }
    );

    expect(result.tombstonesWithheld).toBe("resumed_pass");
    expect(result.complete).toBe(false);
    expect(result.tombstones).toEqual([]);
  });

  it("still reports the enumeration ended, because that is a different fact", async () => {
    const { provider } = scriptedProvider({
      pages: [{ ok: true, records: [record("b")], nextCursor: null, withdrawn: [] }]
    });

    const result = await runIngestionPass(
      provider,
      options({ resumeCursor: "page-2", knownContentIds: [] }),
      { now: () => NOW }
    );

    // Not a contradiction, and the pair is the whole point: the cursor is
    // exhausted, AND this pass is not a basis for inferring absence.
    expect(result.nextCursor).toBeNull();
    expect(result.complete).toBe(false);
  });

  it("names the resume rather than the page limit when both apply", async () => {
    const { provider } = scriptedProvider({
      pages: [{ ok: true, records: [record("b")], nextCursor: "page-3", withdrawn: [] }]
    });

    const result = await runIngestionPass(
      provider,
      options({ resumeCursor: "page-2", maxPages: 1, knownContentIds: [`${SOURCE}-a`] }),
      { now: () => NOW }
    );

    expect(result.tombstonesWithheld).toBe("resumed_pass");
    expect(result.tombstones).toEqual([]);
  });

  it("leaves an unresumed full pass able to infer absence, which is the point of the rule", async () => {
    const { provider } = scriptedProvider({
      pages: [{ ok: true, records: [record("b")], nextCursor: null, withdrawn: [] }]
    });

    const result = await runIngestionPass(
      provider,
      options({ resumeCursor: null, knownContentIds: [`${SOURCE}-a`, `${SOURCE}-b`] }),
      { now: () => NOW }
    );

    // The guard must not be so wide that it stops absence inference entirely:
    // a pass from the beginning that reached the end still tombstones `a`.
    expect(result.tombstonesWithheld).toBeNull();
    expect(result.complete).toBe(true);
    expect(result.tombstones).toEqual([
      { contentId: `${SOURCE}-a`, sourceId: SOURCE, observedAt: OBSERVED, reason: "absent_from_complete_sync" }
    ]);
  });
});
