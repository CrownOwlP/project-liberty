import type { NormalizedContentId } from "@liberty/contracts/shared/ids";
import { deriveNormalizedContentId, type IdDerivationRefusal } from "./identity";
import type {
  AcceptedWork,
  CatalogMetadataProvider,
  ProviderFetchFailure,
  RawProviderRecord
} from "./provider";
import { ingestedWorkSchema, type WorkTombstone } from "./record";
import { checkRightsBasis, findMediaAddresses, type RightsRefusal } from "./safety";

/* -------------------------------------------------------------------------
 * One ingestion pass: fetch, page, validate, backfill, tombstone
 *
 * This is the thing `docs/CATALOG_SOURCE.md` says does not exist -- "Nothing
 * fetches, schedules, batches or backfills. There is no worker." It exists now,
 * it is driven by an injected `CatalogMetadataProvider`, and NO PROVIDER IS
 * WIRED (see `provider.ts` for why that is a licensing decision rather than an
 * unfinished edit). What is testable without one is everything: the paging, the
 * validation, the refusals, the backfill cursor and -- the part that actually
 * matters -- when a tombstone may and may not be minted.
 *
 * ==================================================================
 * THE CENTRAL RULE: A TOMBSTONE COMES ONLY FROM A COMPLETE FULL PASS
 * ==================================================================
 *
 * `docs/CATALOG_SOURCE.md` states the defect a tombstone fixes: a work that
 * vanishes from a source "simply stops appearing, which is indistinguishable
 * from a failed fetch". The fix is worse than the defect if it is applied to a
 * failed fetch -- the catalog would then DELETE its contents every time a
 * provider had a bad afternoon, and the deletion would look like a legitimate
 * withdrawal.
 *
 * So `runIngestionPass` withholds tombstones, by name, in every case where
 * absence is not evidence:
 *
 *   - `pass_failed` -- a page errored. The pass saw a prefix of the source.
 *   - `page_limit_reached` -- `maxPages` stopped an enumeration that had more to
 *     go. The cursor is returned so the next pass resumes; nothing is deleted on
 *     the strength of a truncated read.
 *   - `incremental_pass` -- `changedSince` was set, so the provider deliberately
 *     returned a SUBSET. Everything unchanged is absent from this pass and is
 *     absent for the best possible reason. This is the trap worth naming loudly:
 *     an incremental sync that tombstones what it did not see deletes the entire
 *     catalog except this morning's edits, and every individual step of it looks
 *     correct.
 *
 * The strong form -- the provider stating a deletion through `withdrawn` -- is
 * not subject to any of that. A source that says "this is gone" has given
 * evidence, and `withdrawn_by_source` is minted even from an incomplete pass.
 *
 * DETERMINISM AND TIME. `deps.now()` is called ONCE, at the start, and that one
 * instant is the `observedAt` of every record and tombstone in the pass. Calling
 * it per record would make two records from the same page disagree about when
 * they were seen, and would make the result unreproducible under test for no
 * gain in accuracy that anybody could use.
 * ---------------------------------------------------------------------- */

export type RecordRefusalReason =
  | IdDerivationRefusal
  | RightsRefusal
  | "record_failed_validation"
  | "media_address_in_catalog_payload"
  | "content_id_does_not_match_derived_id"
  | "duplicate_native_id_in_pass";

export interface RecordRefusal {
  readonly nativeId: string;
  readonly reason: RecordRefusalReason;
  readonly detail: string;
}

/**
 * Why a pass may not infer that a known work is gone.
 *
 * ABSENCE IS INFERRED FROM NOT SEEING SOMETHING, which is only evidence when
 * the pass looked everywhere. Each member names a way it did not.
 *
 * `resumed_pass` is PL-0313 and was the gap. A pass started from a cursor
 * reaches the end of the enumeration having deliberately never read the pages
 * before it, so every known id on the skipped prefix is unseen for a reason
 * that has nothing to do with the source. Before this member existed such a
 * pass reported `complete: true` and `reconcileTombstones` took that as licence
 * to tombstone the whole prefix -- a mass deletion reachable from ordinary
 * resume behaviour, and not self-healing, because the store releases a
 * tombstone only when a later COMPLETE pass accepts the work again.
 */
export type TombstoneWithholdReason =
  | "pass_failed"
  | "page_limit_reached"
  | "incremental_pass"
  | "resumed_pass";

export interface IngestionPassOptions {
  readonly pageSize: number;
  /**
   * How many pages one pass will read.
   *
   * A BOUND, NOT A TUNING KNOB. Without it, a provider that returns a cursor
   * pointing at itself -- by bug or by design -- keeps this loop running until
   * the process dies, and the loop is reading a third party's responses into
   * memory while it does. That is a denial of service reachable from a provider
   * response, which is the same class of risk `transport.ts` bounds a body for.
   */
  readonly maxPages: number;
  /** `null` starts at the beginning. Anything else resumes a previous pass. */
  readonly resumeCursor: string | null;
  readonly changedSince: string | null;
  /**
   * Every content id the store already holds FOR THIS SOURCE.
   *
   * Scoped to the source because a tombstone is a statement about one source's
   * catalog. Passing another source's ids would make a complete pass of provider
   * A tombstone everything provider B supplied, which is the multi-source
   * spelling of the same deletion bug the rule above exists to prevent.
   */
  readonly knownContentIds: readonly NormalizedContentId[];
}

export interface IngestionPassDependencies {
  readonly now: () => number;
}

export interface IngestionPassResult {
  readonly sourceId: string;
  readonly observedAt: string;
  readonly accepted: readonly AcceptedWork[];
  readonly refused: readonly RecordRefusal[];
  readonly pagesFetched: number;
  /** `null` means the source was enumerated to its end. */
  readonly nextCursor: string | null;
  /** True only when this pass read the whole source successfully and in full. */
  readonly complete: boolean;
  readonly failure: { readonly reason: ProviderFetchFailure; readonly detail: string } | null;
  readonly tombstones: readonly WorkTombstone[];
  readonly tombstonesWithheld: TombstoneWithholdReason | null;
}

/**
 * Validates and accepts one provider record, or says why not.
 *
 * ORDER MATTERS AND IS DELIBERATE. The media-address scan runs on the RAW
 * payload FIRST, before `ingestedWorkSchema` gets a chance to strip the offending
 * field. Zod drops unknown keys by default, so a schema parse would quietly
 * discard a `streamUrl` and the record would then look clean -- which means the
 * provider sending one would never be noticed, and nobody would learn that the
 * ingestion path was one `.passthrough()` away from carrying it.
 */
function acceptRecord(
  sourceId: string,
  observedAt: string,
  record: RawProviderRecord,
  derivedContentId: NormalizedContentId
): { readonly ok: true; readonly work: AcceptedWork } | { readonly ok: false; readonly refusal: RecordRefusal } {
  const refuse = (reason: RecordRefusalReason, detail: string) => ({
    ok: false as const,
    refusal: { nativeId: record.nativeId, reason, detail }
  });

  const addresses = findMediaAddresses(record.raw);
  if (addresses.length > 0) {
    const where = addresses.map((finding) => `${finding.path} (${finding.kind})`).join(", ");
    return refuse("media_address_in_catalog_payload", where);
  }

  const parsed = ingestedWorkSchema.safeParse(record.raw);
  if (!parsed.success) {
    // The issue PATHS are reported and the messages are not: a zod message can
    // include a received value, and the received value here is a third party's
    // payload. A path tells an operator which field to look at without copying
    // the field's contents into a log.
    const paths = parsed.error.issues.map((issue) => issue.path.join(".") || "(root)").join(", ");
    return refuse("record_failed_validation", `invalid at: ${paths}`);
  }

  if (parsed.data.contentId !== derivedContentId) {
    // The adapter is expected to derive the id with `deriveNormalizedContentId`.
    // Verifying rather than overwriting is the point: an adapter that invented
    // an id is an adapter whose ids are not namespaced by source, and silently
    // replacing it would hide that from whoever wrote it.
    return refuse(
      "content_id_does_not_match_derived_id",
      `record says ${parsed.data.contentId}, derivation says ${derivedContentId}`
    );
  }

  const rights = checkRightsBasis(parsed.data);
  if (!rights.ok) return refuse(rights.reason, `content id ${parsed.data.contentId}`);

  return {
    ok: true,
    work: {
      work: parsed.data,
      ref: { sourceId, nativeId: record.nativeId },
      crossRefs: record.crossRefs,
      observedAt,
      sourceRevision: record.sourceRevision
    }
  };
}

/**
 * Which known ids a pass proved are gone.
 *
 * Exported because it is the rule worth testing on its own, separately from the
 * paging around it: the decision "may this pass delete things" is the one with
 * consequences, and burying it inside the loop would leave it only testable
 * through a provider double.
 */
export function reconcileTombstones(
  sourceId: string,
  observedAt: string,
  knownContentIds: readonly NormalizedContentId[],
  seenContentIds: ReadonlySet<string>,
  withheld: TombstoneWithholdReason | null
): readonly WorkTombstone[] {
  if (withheld !== null) return [];
  return knownContentIds
    .filter((contentId) => !seenContentIds.has(contentId))
    .map((contentId) => ({
      contentId,
      sourceId,
      observedAt,
      reason: "absent_from_complete_sync" as const
    }));
}

export async function runIngestionPass(
  provider: CatalogMetadataProvider,
  options: IngestionPassOptions,
  deps: IngestionPassDependencies
): Promise<IngestionPassResult> {
  const observedAt = new Date(deps.now()).toISOString();
  const sourceId = provider.sourceId;
  // Clamped to what the provider says it will serve, rather than sent as asked.
  // A provider that silently caps an oversized request and one that errors on it
  // are both common, and the first makes a pass quietly slower per page than the
  // caller believes.
  const pageSize = Math.max(1, Math.min(options.pageSize, provider.capabilities.maxPageSize));

  const accepted: AcceptedWork[] = [];
  const refused: RecordRefusal[] = [];
  const seenContentIds = new Set<string>();
  const seenNativeIds = new Set<string>();
  const withdrawnNativeIds: string[] = [];

  let cursor = options.resumeCursor;
  let pagesFetched = 0;
  let failure: { reason: ProviderFetchFailure; detail: string } | null = null;
  let reachedEnd = false;

  while (pagesFetched < options.maxPages) {
    const page = await provider.fetchPage({
      cursor,
      pageSize,
      changedSince: options.changedSince
    });
    pagesFetched += 1;

    if (!page.ok) {
      failure = { reason: page.reason, detail: page.detail };
      break;
    }

    for (const record of page.records) {
      if (seenNativeIds.has(record.nativeId)) {
        // A provider repeating a record across pages is usually a cursor bug,
        // and accepting the repeat would let the same work be counted twice in
        // anything that aggregates. Refused rather than deduplicated silently,
        // so the provider's defect is visible in the pass result.
        refused.push({
          nativeId: record.nativeId,
          reason: "duplicate_native_id_in_pass",
          detail: "the provider returned this native id more than once in one pass"
        });
        continue;
      }
      seenNativeIds.add(record.nativeId);

      const derived = deriveNormalizedContentId({ sourceId, nativeId: record.nativeId });
      if (!derived.ok) {
        refused.push({
          nativeId: record.nativeId,
          reason: derived.reason,
          detail: `native id ${record.nativeId}`
        });
        continue;
      }

      /*
       * SEEN, NOT ACCEPTED, IS WHAT DEFEATS A TOMBSTONE -- and the distinction
       * is the reason the id is derived out here rather than inside
       * `acceptRecord`. A record the pass read and then REFUSED (bad rights, a
       * media address, a schema failure) is a record the source still lists. It
       * is absent from `accepted` for a reason that has nothing to do with the
       * source having withdrawn it, so tombstoning it would delete a work for
       * failing validation -- a remedy for the wrong problem, and one that
       * destroys the evidence that the provider sent something bad.
       */
      seenContentIds.add(derived.contentId);

      const outcome = acceptRecord(sourceId, observedAt, record, derived.contentId);
      if (!outcome.ok) {
        refused.push(outcome.refusal);
        continue;
      }
      accepted.push(outcome.work);
    }

    // A provider without `reportsDeletions` that sends withdrawals anyway is
    // ignored rather than trusted: the capability is the declaration, and
    // honouring an undeclared one would let a provider delete from our catalog
    // through a field it never said it implemented.
    if (provider.capabilities.reportsDeletions) {
      withdrawnNativeIds.push(...page.withdrawn);
    }

    cursor = page.nextCursor;
    if (cursor === null) {
      reachedEnd = true;
      break;
    }
  }

  /*
   * `complete` IS DERIVED FROM THIS, AND IT MEANS "THE WHOLE SOURCE WAS
   * OBSERVED", not "this invocation reached the end of the enumeration". The
   * two came apart at `resumeCursor` (PL-0313): a resumed pass can reach the
   * end having skipped everything before the cursor.
   *
   * ORDER IS REPORTING PRECEDENCE, not logic -- any one member withholds
   * tombstones on its own. A resumed pass that ALSO ran out of page budget has
   * two reasons it cannot infer absence, and `resumed_pass` is reported because
   * it is the more fundamental one: the prefix was skipped BY CHOICE, and
   * raising `maxPages` would not fix it.
   */
  const withheld: TombstoneWithholdReason | null =
    failure !== null
      ? "pass_failed"
      : options.changedSince !== null
        ? "incremental_pass"
        : options.resumeCursor !== null
          ? "resumed_pass"
          : !reachedEnd
            ? "page_limit_reached"
            : null;

  const inferred = reconcileTombstones(
    sourceId,
    observedAt,
    options.knownContentIds,
    seenContentIds,
    withheld
  );

  // Withdrawals are minted whatever `withheld` says, because they rest on the
  // provider's own statement rather than on this pass having seen everything.
  const declared: WorkTombstone[] = [];
  for (const nativeId of withdrawnNativeIds) {
    const derived = deriveNormalizedContentId({ sourceId, nativeId });
    if (!derived.ok) {
      refused.push({
        nativeId,
        reason: derived.reason,
        detail: "withdrawal names a native id that does not normalize"
      });
      continue;
    }
    declared.push({
      contentId: derived.contentId,
      sourceId,
      observedAt,
      reason: "withdrawn_by_source"
    });
  }

  return {
    sourceId,
    observedAt,
    accepted,
    refused,
    pagesFetched,
    /*
     * `nextCursor` AND `complete` ANSWER DIFFERENT QUESTIONS and a resumed pass
     * that ran to the end reports `null` here and `false` below. That is not a
     * contradiction: the cursor is exhausted, and this pass is still not a
     * basis for inferring absence.
     */
    nextCursor: reachedEnd ? null : cursor,
    complete: withheld === null,
    failure,
    tombstones: [...declared, ...inferred],
    tombstonesWithheld: withheld
  };
}
