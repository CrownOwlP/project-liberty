import type { NormalizedContentId } from "@liberty/contracts/shared/ids";
import { normalizedContentIdSchema } from "@liberty/contracts/shared/ids";

/* -------------------------------------------------------------------------
 * Identity and dedupe
 *
 * `docs/CATALOG_SOURCE.md` calls this "the single largest missing piece and it
 * is a design question, not a coding one". This module is the design decision,
 * written down, with the alternatives that were rejected and why -- so a
 * reviewer can disagree with the DECISION rather than reverse-engineer it from
 * the code.
 *
 * ================================================================
 * DECISION 1: a normalized content id is NAMESPACED BY ITS SOURCE.
 * ================================================================
 *
 * `deriveNormalizedContentId({ sourceId, nativeId })` answers
 * `<sourceId>-<nativeId>`, each half normalized to the shape
 * `normalizedContentIdSchema` demands. So the same work ingested from two
 * providers gets TWO ids, and they are made one work by an explicit link
 * (decision 2) rather than by having collided.
 *
 * WHY, when the obvious alternative is to normalize the title and hope. Because
 * an id is interpolated into `/title/<id>` and compared across catalog, playback
 * and progress. Two different works whose titles normalize alike -- and remakes,
 * translations and "Volume 2" make that common -- would become ONE id, and every
 * surface would then be confidently wrong about which work a user is watching.
 * A namespaced id cannot collide by accident: the failure mode moves from
 * "silently merged two works" to "listed one work twice", which is visible,
 * recoverable, and exactly what decision 2 addresses.
 *
 * WHAT IT COSTS, stated rather than discovered: ids are not portable between
 * sources. Dropping a provider changes the id of every work only it supplied,
 * and anything that stored one -- a bookmark, a progress row, a share link --
 * is now pointing at nothing. That is a real migration and it is the price of
 * not guessing.
 *
 * A HASH WAS REJECTED. `sha256(sourceId + nativeId)` is also collision-free and
 * is opaque, which sounds like an advantage until an operator has to debug a
 * wrong rail and no id in any log can be traced back to the record that produced
 * it. Legibility wins here; there is nothing secret in a provider's public
 * catalog id.
 *
 * ==========================================================================
 * DECISION 2: two records are the same work ONLY on a shared authority id.
 * ==========================================================================
 *
 * `resolveWorkIdentities` merges two records when, and only when, they cite the
 * same `(authority, id)` pair -- an identifier issued by somebody who is not
 * either provider. Title, year, runtime and director are NOT used, at any
 * confidence, in any combination.
 *
 * WHY SO STRICT. Fuzzy matching is a probability, and this is a rights surface:
 * merging two works merges their rights bases, so a wrong merge can attach a
 * cleared basis to a work nobody cleared. A false merge here is not a cosmetic
 * duplicate, it is a rights defect. Under-merging produces a visible duplicate
 * card, which is a product annoyance with an obvious remedy. The asymmetry is
 * not close.
 *
 * FUZZY MATCHING IS NOT FOREVER REFUSED -- it is refused HERE, in the path that
 * decides what a user may be shown. A scored suggester that proposes merges for
 * an operator to confirm is a fine thing to build; its output arrives as an
 * authority link like any other, through `crossRefs`, and this module never
 * learns it came from a guess.
 *
 * ============================================================
 * DECISION 3: which source wins is DECLARED, never discovered.
 * ============================================================
 *
 * A merge needs a canonical id and a primary record. `resolveWorkIdentities`
 * takes an explicit `precedence` list of source ids, and a record from a source
 * that is not on it is REFUSED (`source_precedence_not_declared`) rather than
 * appended at the end. Fail closed: "whichever arrived first" is an ordering
 * decided by page order and network timing, and a catalog whose canonical titles
 * change between runs is not reproducible.
 * ---------------------------------------------------------------------- */

/** A work as one source names it. */
export interface SourceWorkRef {
  readonly sourceId: string;
  readonly nativeId: string;
}

/**
 * An identifier issued by a third party that both providers happen to cite.
 *
 * `authority` is a short token for WHO issued it. It is compared for equality
 * and never resolved, fetched or parsed -- it is a namespace, not an address.
 */
export interface ExternalRef {
  readonly authority: string;
  readonly id: string;
}

export type IdDerivationRefusal =
  | "source_id_not_normalizable"
  | "native_id_not_normalizable"
  | "derived_id_not_a_normalized_content_id";

export type IdDerivation =
  | { readonly ok: true; readonly contentId: NormalizedContentId }
  | { readonly ok: false; readonly reason: IdDerivationRefusal };

/**
 * Folds one provider-native string into the id alphabet.
 *
 * WHAT IT DOES: lower-cases, replaces every run of characters outside `[a-z0-9]`
 * with a single hyphen, and trims hyphens from both ends. `tt0133093` survives
 * unchanged; `Q83495` becomes `q83495`; `The Matrix (1999)` becomes
 * `the-matrix-1999`.
 *
 * WHAT IT DOES NOT DO: transliterate. A wholly non-ASCII native id folds to the
 * empty string and is REFUSED rather than silently becoming `--` or a mojibake
 * slug. Refusing is the honest answer: a provider whose native ids are non-ASCII
 * needs a transliteration decision taken deliberately, not a lossy default
 * chosen here. This is why the function is nullable and every caller handles it.
 */
export function normalizeIdSegment(raw: string): string | null {
  const folded = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return folded.length === 0 ? null : folded;
}

/**
 * The one place a `normalizedContentId` is minted from a provider's id.
 *
 * The final `normalizedContentIdSchema.safeParse` is not belt-and-braces: it is
 * the check that keeps THIS function honest against the CONTRACT rather than
 * against its own regex. If the contract's pattern is ever tightened, this
 * refuses instead of emitting ids no route can carry, and the refusal is named.
 */
export function deriveNormalizedContentId(ref: SourceWorkRef): IdDerivation {
  const source = normalizeIdSegment(ref.sourceId);
  if (source === null) return { ok: false, reason: "source_id_not_normalizable" };

  const native = normalizeIdSegment(ref.nativeId);
  if (native === null) return { ok: false, reason: "native_id_not_normalizable" };

  const parsed = normalizedContentIdSchema.safeParse(`${source}-${native}`);
  if (!parsed.success) {
    return { ok: false, reason: "derived_id_not_a_normalized_content_id" };
  }
  return { ok: true, contentId: parsed.data };
}

/** A record offered for identity resolution. */
export interface IdentityCandidate {
  readonly contentId: NormalizedContentId;
  readonly ref: SourceWorkRef;
  /** Third-party identifiers this source cites for the work. May be empty. */
  readonly crossRefs: readonly ExternalRef[];
}

/**
 * One work, and every source record decided to be that work.
 *
 * `canonicalId` is the `contentId` of `primary`, restated so a consumer that
 * only needs the id does not have to know the structure. `mergedFrom` lists the
 * OTHER ids -- the ones a redirect would have to be written for.
 */
export interface WorkIdentity {
  readonly canonicalId: NormalizedContentId;
  readonly primary: IdentityCandidate;
  readonly members: readonly IdentityCandidate[];
  readonly mergedFrom: readonly NormalizedContentId[];
}

export interface IdentityRefusal {
  readonly contentId: NormalizedContentId;
  readonly reason: "source_precedence_not_declared";
}

export interface IdentityResolution {
  readonly identities: readonly WorkIdentity[];
  readonly refused: readonly IdentityRefusal[];
}

/**
 * The separator inside an authority-ref grouping key.
 *
 * A NUL rather than a colon, because an authority or an id that itself contained
 * the separator would otherwise let `a:bc` and `ab:c` produce the same key --
 * a cross-cluster merge caused by string formatting, which is exactly the
 * accidental merge decision 2 exists to prevent.
 */
const EXTERNAL_REF_KEY_SEPARATOR = " ";

/**
 * Groups candidates into works.
 *
 * DETERMINISTIC GIVEN THE SAME INPUTS, including the same input ORDER -- and
 * also across input orders, which is the stronger property and the one worth
 * stating. Grouping is by shared authority ref, which is order-independent; the
 * primary is chosen by `precedence` index then by `contentId`, both of which are
 * properties of the candidates rather than of the array; and the output is
 * sorted by `canonicalId`. So two ingestion passes that page a provider in
 * different orders produce the same catalog, which is what makes a diff between
 * two runs mean something.
 *
 * The grouping is a union-find over authority refs. Transitivity is intended and
 * is the reason it is union-find rather than pairwise: if A and B share an IMDb
 * id and B and C share a Wikidata id, all three are one work. That is also the
 * mechanism's sharpest edge -- ONE bad authority link merges two whole clusters
 * -- which is decision 2's real justification restated as a consequence.
 */
export function resolveWorkIdentities(
  candidates: readonly IdentityCandidate[],
  precedence: readonly string[]
): IdentityResolution {
  const refused: IdentityRefusal[] = [];
  const accepted: IdentityCandidate[] = [];

  for (const candidate of candidates) {
    if (!precedence.includes(candidate.ref.sourceId)) {
      refused.push({ contentId: candidate.contentId, reason: "source_precedence_not_declared" });
      continue;
    }
    accepted.push(candidate);
  }

  const parent = accepted.map((_unused, index) => index);
  const find = (index: number): number => {
    let root = index;
    for (;;) {
      const next = parent[root];
      if (next === undefined || next === root) break;
      root = next;
    }
    let walk = index;
    for (;;) {
      const next = parent[walk];
      if (next === undefined || next === walk) break;
      parent[walk] = root;
      walk = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };

  const byExternalRef = new Map<string, number>();
  accepted.forEach((candidate, index) => {
    for (const ref of candidate.crossRefs) {
      const key = `${ref.authority}${EXTERNAL_REF_KEY_SEPARATOR}${ref.id}`;
      const seen = byExternalRef.get(key);
      if (seen === undefined) {
        byExternalRef.set(key, index);
        continue;
      }
      union(seen, index);
    }
  });

  const groups = new Map<number, IdentityCandidate[]>();
  accepted.forEach((candidate, index) => {
    const root = find(index);
    const group = groups.get(root);
    if (group === undefined) {
      groups.set(root, [candidate]);
      return;
    }
    group.push(candidate);
  });

  const rank = (candidate: IdentityCandidate): number => precedence.indexOf(candidate.ref.sourceId);
  const byId = (left: string, right: string): number =>
    left < right ? -1 : left > right ? 1 : 0;

  const identities: WorkIdentity[] = [];
  for (const group of groups.values()) {
    const members = [...group].sort((left, right) => {
      const byRank = rank(left) - rank(right);
      return byRank === 0 ? byId(left.contentId, right.contentId) : byRank;
    });
    // `members[0]` rather than a non-null assertion: a group is only created by
    // pushing a candidate into it, so it is never empty, but
    // `noUncheckedIndexedAccess` is right to insist the compiler be shown that
    // rather than told it.
    const primary = members[0];
    if (primary === undefined) continue;
    identities.push({
      canonicalId: primary.contentId,
      primary,
      members,
      mergedFrom: members.slice(1).map((member) => member.contentId)
    });
  }

  identities.sort((left, right) => byId(left.canonicalId, right.canonicalId));

  return { identities, refused };
}
