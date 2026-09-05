import { describe, expect, it } from "vitest";
import type { CatalogItem, MovieCatalogItem } from "@liberty/contracts/domains/catalog";
import type { CatalogMetadataRecord, CatalogRightsBasis } from "./catalog-source";
import { selectDeclaredItems } from "./catalog-source";
import { isSurfaceable } from "./catalog";

const movie = (
  over: Partial<Omit<MovieCatalogItem, "kind">> & { id: string }
): MovieCatalogItem => ({
  title: "Untitled",
  rights: "owned",
  genre: "Drama",
  releaseYear: 2024,
  runtimeMinutes: 100,
  episodeCount: null,
  ...over,
  kind: "movie"
});

const OWNED: CatalogRightsBasis = { category: "owned", reference: null };

const record = (item: CatalogItem, rights: CatalogRightsBasis | null): CatalogMetadataRecord => ({
  item,
  rights
});

describe("selectDeclaredItems", () => {
  it("keeps a record whose declared basis matches the item it describes", () => {
    const item = movie({ id: "aurora-fall" });
    const selection = selectDeclaredItems([record(item, OWNED)]);

    expect(selection.items).toEqual([item]);
    expect(selection.refused).toEqual([]);
  });

  /*
   * THE CENTRAL RULE: unknown is `null`, and `null` is never quietly replaced by
   * something permissive.
   *
   * Note what the item itself says. `catalogItemSchema` forces `rights` to hold
   * one of three values whether or not anybody established a basis, so this
   * record's item claims `owned` while its source claims nothing. Reading the
   * item as a fallback would look reasonable and would convert every work a
   * source is quiet about into a cleared one -- which is the discovery-layer
   * shape of the fabricated rights basis PL-0703 removed from playback.
   */
  it("refuses a record whose source declared no basis, and does not read the item instead", () => {
    const item = movie({ id: "undeclared", rights: "owned" });
    const selection = selectDeclaredItems([record(item, null)]);

    expect(selection.items).toEqual([]);
    expect(selection.refused).toEqual([
      { contentId: "undeclared", reason: "rights_basis_not_declared" }
    ]);
  });

  /*
   * A source with two inputs -- a provider's own rights field mapped into the
   * item, and a register category mapped into the basis -- can disagree with
   * itself. When it does, neither answer is evidence, so the record publishes
   * nothing and says which of the two problems this is.
   */
  it("refuses a record whose declared basis contradicts the published item", () => {
    const selection = selectDeclaredItems([
      record(movie({ id: "mismatch", rights: "licensed" }), OWNED)
    ]);

    expect(selection.items).toEqual([]);
    expect(selection.refused).toEqual([
      { contentId: "mismatch", reason: "rights_basis_contradicts_item" }
    ]);
  });

  /*
   * Not a summary count and not a shorter list: one refusal per refused record,
   * each naming the work. A rail that is two items short is a support question,
   * and the answer has to survive to whoever is reading it.
   */
  it("reports every refusal individually, in input order, alongside what it kept", () => {
    const kept = movie({ id: "kept" });
    const alsoKept = movie({ id: "also-kept" });

    const selection = selectDeclaredItems([
      record(movie({ id: "silent" }), null),
      record(kept, OWNED),
      record(movie({ id: "contradictory", rights: "public-domain" }), OWNED),
      record(alsoKept, OWNED)
    ]);

    expect(selection.items).toEqual([kept, alsoKept]);
    expect(selection.refused).toEqual([
      { contentId: "silent", reason: "rights_basis_not_declared" },
      { contentId: "contradictory", reason: "rights_basis_contradicts_item" }
    ]);
  });

  /*
   * NOTHING BRANCHES ON THE REFERENCE. It names a record in the operator's own
   * rights register and means nothing here; an implementation that started
   * reading it -- requiring one, refusing one, deriving anything from its text --
   * would have turned an opaque identifier into a rights decision taken by a
   * string parser. Two records that differ only in that field must be treated
   * identically.
   */
  it("treats the opaque register reference as carried data, not as an input", () => {
    const withReference = selectDeclaredItems([
      record(movie({ id: "referenced" }), { category: "owned", reference: "lty-ref-000001" })
    ]);
    const withoutReference = selectDeclaredItems([
      record(movie({ id: "referenced" }), { category: "owned", reference: null })
    ]);

    expect(withReference).toEqual(withoutReference);
    expect(withReference.items.length).toBe(1);
  });

  /*
   * THE ALLOWLIST IS NOT CHECKED HERE, AND THAT IS DELIBERATE. `isSurfaceable`
   * is the one rights gate and it runs on every item on the way onto a rail and
   * into a search result; a second copy beside the metadata port would be a
   * second place to review whenever the vocabulary changes. This asserts the
   * division of labour rather than assuming it: a category off the allowlist is
   * consistent, so it passes selection, and is then refused by the gate.
   *
   * `as never` because the value is outside the published vocabulary by
   * construction -- the same escape `catalog.test.ts` uses to reach this state.
   */
  it("leaves the rights allowlist to isSurfaceable", () => {
    const offAllowlist = movie({ id: "off-allowlist", rights: "unlicensed" as never });
    const selection = selectDeclaredItems([
      record(offAllowlist, { category: "unlicensed" as never, reference: null })
    ]);

    expect(selection.items).toEqual([offAllowlist]);
    expect(selection.refused).toEqual([]);
    expect(isSurfaceable(offAllowlist)).toBe(false);
  });

  it("answers an empty catalog with no items and no refusals", () => {
    expect(selectDeclaredItems([])).toEqual({ items: [], refused: [] });
  });

  it("does not mutate the records it was given", () => {
    const records: readonly CatalogMetadataRecord[] = [
      record(movie({ id: "a" }), OWNED),
      record(movie({ id: "b" }), null)
    ];
    const before = JSON.stringify(records);

    selectDeclaredItems(records);

    expect(JSON.stringify(records)).toBe(before);
  });
});
