# Catalog metadata source

**There is no catalog metadata source. This document describes a seam, not a
solution.**

`docs/PRODUCT_SPEC.md` step 2 of the initial user journey is "browse/search
normalized metadata". Nothing in this repository ingests metadata. Every
discovery surface — the home rails, the search results, the title detail page —
is backed by `apps/web/src/lib/demo-catalog.ts`, a hardcoded array of six
fictional works. Each of the three used to import that array directly; all three
now go through the port below, so no shipped module reaches the fixtures without
passing the environment gate. That is a change in *plumbing*. It does not make
the fixtures a catalog, and nothing here ingests one.

PL-0301 and PL-0302 do not close this. They supply **stream candidates**: what a
title plays from, resolved at playback time by an authorized provider. A catalog
is the other half — what exists, what it is called, what it is about — and no
task in the current plan produces one.

What has been added is the interface a real metadata provider would implement,
and the wiring that lets one be dropped in without rewriting the surfaces. That
is all it is.

## The port

| File | Role |
| --- | --- |
| `apps/web/src/lib/catalog-source.ts` | The port. Types plus `selectDeclaredItems`. Imports contracts only; knows no implementation. |
| `apps/web/src/lib/demo-catalog.ts` | One implementation: the development fixtures, gated. |
| `apps/web/src/lib/catalog-source-registry.ts` | The only module that knows both. A real source lands here. |

```ts
interface CatalogMetadataSource {
  readonly sourceId: string;
  listRecords(): readonly CatalogMetadataRecord[] | Promise<readonly CatalogMetadataRecord[]>;
  findRecord(contentId: string): CatalogMetadataRecord | null | Promise<CatalogMetadataRecord | null>;
}

interface CatalogMetadataRecord {
  readonly item: CatalogItem;              // @liberty/contracts/domains/catalog
  readonly rights: CatalogRightsBasis | null;
}

interface CatalogRightsBasis {
  readonly category: ContentRights;        // @liberty/contracts/shared/rights
  readonly reference: string | null;       // opaque; never parsed
}
```

The port adds no vocabulary of its own: the work is a published `CatalogItem`
and the rights category is the shared `ContentRights` enum. `findRecord` answers
`null` for an id the source does not know and **throws** when it cannot answer at
all, so "does not exist" stays distinguishable from "could not be reached" — the
same split `TitleDetailSource` documents.

## What a real source must supply

1. **A `CatalogMetadataSource`**, returned from `resolveCatalogMetadataSource`.
2. **A rights basis per record, or `null`.** `null` means no basis has been
   established. It is never defaulted to something permissive, and `item.rights`
   is never read as a fallback: `catalogItemSchema` forces that field to hold one
   of three values whether or not anybody established it, so trusting it would
   convert "we have not checked" into "owned" for every work the source is quiet
   about. `selectDeclaredItems` refuses an undeclared record and says so.
3. **A basis that agrees with the item it describes.** An ingestion that maps a
   provider's rights field into `item.rights` and a register category into
   `rights.category` has two inputs; when they disagree neither is evidence, and
   the record publishes nothing (`rights_basis_contradicts_item`).
4. **A rights-basis reference that is an opaque internal identifier, or `null`.**
   Per `docs/CONTENT_RIGHTS.md`, the agreements themselves are not this
   repository's to carry. No counterparty, scope, term date, licence body or URL
   may appear in one. Nothing in the application parses or branches on it.
5. **Nothing that is a media address.** A catalog item says a work exists, never
   that it is playable. `e2e/tests/catalog.api.spec.ts` asserts that no key in a
   catalog response is an address and no value is an absolute URL.

## How the fixtures are kept out of a deployment

`demoCatalogSource` takes a `NonDeploymentEnvironment` — the nominal witness
declared in `apps/web/src/app/api/deployment-environment.ts` (private
constructor, private field). It cannot be constructed anywhere else, and the only
way to obtain one is `NonDeploymentEnvironment.classify()`, which answers `null`
for every `NODE_ENV` outside its allowlist. So the fixtures are not *withheld*
from a deployment; they are **unconstructible** in one, and deleting the check is
a compile error rather than a silent widening.

This is the same control PL-0703 applied to the playback fixtures, for a related
reason. The `owned` category on these six works is true — they are original works
written for this project — but the claim a deployment would be making is not
"these are owned", it is "this is the catalog". Serving invented titles from a
hosted build states them, to a reader, as the product's content.

**Consequences, stated rather than discovered later:**

- On a deployment, `loadHomeCatalog()` answers
  `{ status: "error", reason: "catalog_source_not_configured" }`. The home page
  renders its "We couldn't load the catalog" panel with that reason code. It is
  deliberately not `empty`, because that branch tells the reader "No titles are
  currently available in your region", which would be false.
- On a deployment, `GET /api/v1/catalog/home` answers **503** with
  `{ "error": "catalog_source_not_configured" }`. The route awaits
  `loadHomeCatalog()` and `app/api/v1/catalog/home/handler.ts` maps the reason
  onto a status; 503 is the same status the profile, progress and watchlist
  routes answer for `authentication_not_configured`, so one status means "this
  deployment is missing a dependency" across the app. It is **not** `{ rails: [] }`
  at 200 — `docs/API_CONTRACTS.md` reserves that for a *configured* catalog that
  genuinely surfaces nothing.
- On a deployment, `getSearchResults()` answers `null` and `loadSearchResults`
  reports the same `catalog_source_not_configured`. `/search` with no `q` still
  renders the idle panel, because a search that was never run cannot have been
  refused.
- On a deployment, `findDemoTitleDetail()` **throws**
  `CatalogMetadataSourceNotConfiguredError`. `loadTitleDetail` tests for it by
  `instanceof` and republishes its `reason`, so the title page renders its
  unavailable panel carrying `catalog_source_not_configured` rather than the
  loader's generic `title_source_unavailable`. It throws rather than answering
  `null` because `null` on that path already means not-found, and "no title has
  this id" and "this process has no catalog" have different remedies. The page
  stays HTTP 200 with `robots: index false`.
- `next dev` and vitest are unaffected: `development` and `test` are both on the
  allowlist.

## Follow-ups: what landed, and what has not

The first three items on the original list are **done**. They are recorded here
rather than deleted, because each one is why a surface looks the way it does now.

1. **Done — `apps/web/src/app/search/search.ts`.** `getSearchResults` no longer
   defaults `items` to `demoCatalog`; it is asynchronous and reads
   `resolveCatalogMetadataSource()`, returning `null` when nothing is configured
   so `loadSearchResults` can report a reason rather than "nothing matched".
2. **Done — `apps/web/src/app/title/demo-title-details.ts`.** Its lookup goes
   through `findRecord` and its episode scan through `listRecords`, both obtained
   from `demoCatalogSource` behind the `NonDeploymentEnvironment` witness. Because
   the module already spends `null` on not-found, a process with no source
   **throws** `CatalogMetadataSourceNotConfiguredError`, which `title-detail.ts`
   maps by `instanceof`.
3. **Done — `apps/web/src/app/api/v1/catalog/home/route.ts`.** It awaits
   `loadHomeCatalog()` and hands the result to a new `handler.ts`, which answers
   503 for both `catalog_source_not_configured` and `catalog_source_unavailable`
   and 500 for `catalog_response_failed_validation`. The synchronous
   `getHomeCatalog` existed only to serve that caller and has been **deleted**,
   together with `readFixtureCatalogItems` in the registry, which existed only to
   be its default argument. `resolveCatalogMetadataSource` is now the registry's
   only entry point, and its return type is correctly async-capable.

What remains is items 4 and 5. Item 6 has since closed and is kept, marked done,
for the reason the first three are kept: it is why several files outside this
lane read the way they do.

4. **`apps/web/src/lib/demo-catalog.ts` still exports the raw `demoCatalog`
   array**, and this is the one seam left in an otherwise total control. No
   shipped module imports it any more — only four test files do, and they need an
   independent name for the fixture set to assert against. But it is an ungated
   array in a module a deployment compiles, so a future production import would
   walk past the witness without a compile error. Removing it means giving those
   four suites another way to name the fixture set; the export's own comment
   states the trade rather than declaring it harmless.
5. **The title surface is still synchronous.** `findDemoTitleDetail` and
   `getTitleDetail` answer without awaiting, so a real provider — which does
   I/O — cannot land behind them. It lands in the registry, and this surface has
   to become asynchronous along with the loader above it, the same edit the home
   path has already made. `SynchronousCatalogMetadataSource` exists for exactly
   this caller and is what disappears when the edit lands.
6. **Done — `docs/E2E.md` and the e2e harness have caught up.** This item
   recorded four surfaces outside this lane that still described the
   pre-migration behaviour. All four have since been corrected, checked one at a
   time rather than assumed closed as a group:
   - `docs/E2E.md`'s per-surface list states the `503` /
     `catalog_source_not_configured` refusal, records `{ rails: [] }` at 200 as
     what the route *used to* serve via the synchronous `getHomeCatalog`, and
     reserves that 200 for a configured catalog that genuinely surfaces nothing.
   - `e2e/src/env.ts` no longer cites `readFixtureCatalogItems`. It records the
     citation as removed and says why: the function was deleted from the
     registry together with `getHomeCatalog`, and the harness never depended on
     either.
   - `e2e/tests/search.spec.ts` no longer blames a `demoCatalog` import. It
     branches on the mode and requires the refusal panel for every non-empty
     query on a hosted build, with the idle panel still reached for no `q`.
   - `e2e/tests/critical-journey.spec.ts` has the mode split: the test is now
     "which title the title route can serve is decided by the build, and both
     are asserted", and it asserts **200** with the unavailable panel on a
     deployment. The old comment's prediction of a 404 there is recorded as
     wrong rather than deleted — the refusal is an `error`, not a `not-found`,
     so `notFound()` is never reached and the page answers 200 with
     `robots: index false`.

   `e2e/tests/catalog.api.spec.ts`, which this item already listed as done, is
   unchanged in that respect: it has the mode split and asserts the 503.

## What this does not solve

Named so nobody reads a port as a product.

- **Ingestion.** Nothing fetches, schedules, batches or backfills. There is no
  worker; `docs/ARCHITECTURE.md` lists "metadata ingestion worker" as an
  extraction candidate and it remains one.
- **Refresh and staleness.** No TTL, no cache, no invalidation, no `updatedAt`.
  `listRecords` is asked and answers; how old the answer is, nobody records.
- **Identity and dedupe.** `normalizedContentIdSchema` says what an id looks
  like. Nothing says how a provider's native id becomes one, or what happens when
  two providers describe the same work. This is the single largest missing piece
  and it is a design question, not a coding one.
- **Deletion.** No tombstones. A work that vanishes from a source simply stops
  appearing, which is indistinguishable from a failed fetch.
- **Provider-side search.** `searchCatalog` filters an in-memory array. The port
  has no search capability, so a source of any real size would have to be listed
  in full and filtered locally. Adding one is a contract question (ranking,
  paging, and who owns relevance), which is why it was not invented here.
- **Paging.** `listRecords` returns everything. That is fine for six fixtures and
  is not a shape a catalog of real size can use.
- **Artwork and image rights.** `CatalogItem` carries no image field at all —
  `catalog-card.tsx` renders a decorative gradient. Artwork carries its own
  licensing, separate from the work's, and nothing here addresses it.
- **Localization.** `title`, `genre` and `synopsis` are single strings with no
  language tag. There is no locale in the port and no way for a source to offer
  one work under two languages.
- **Availability windows and territory.** No start/end dates, no region. The
  home page's empty state already says "in your region", which today is a phrase
  with nothing behind it.
- **The catalog contract has no undeclared-rights state.** `titleRightsBasisSchema`
  is nullable; `catalogItemSchema.rights` is not. So a source that knows of a work
  but not its rights cannot express it as a `CatalogItem` at all, and the port
  works around it by making the *basis* the nullable half. The deeper fix is a
  contract change in `packages/contracts` and needs its own review.
- **The rights reference's shape is unenforced.**
  `apps/web/src/app/api/v1/playback/session/authorized-candidates.ts` owns
  `OPAQUE_RIGHTS_REFERENCE_PATTERN`, which mechanically excludes prose, URLs and
  addresses. The port does not apply it: importing that module would pull
  `@liberty/media-engine` and `@liberty/provider-sdk` into the module graph of
  every surface that renders a card, and restating the pattern would put a second
  spelling of a rights rule in the repository. The fix is to move the predicate
  into a leaf module both sides can reach.
- **Episodes.** They are not catalog entities here; `demo-title-details.ts`
  generates them from a series' `episodeCount`. A real source states them, and
  where they live is an open question.
