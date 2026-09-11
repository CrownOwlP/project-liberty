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

The registry has two accessors and one composition. `resolveCatalogMetadataSource`
answers the port as published — `listRecords` and `findRecord` may return a
promise, which is what a real provider needs.
`resolveSynchronousCatalogMetadataSource` answers the same question for a caller
that cannot await, returning a `SynchronousCatalogMetadataSource` or the same
named refusal; the first delegates to the second, so the environment gate is
classified once. Its one caller is the title surface (follow-up 5 below). It is
**not** a return to the deleted `readFixtureCatalogItems`: that function returned
`readonly CatalogItem[]` and answered `[]` on a deployment, collapsing "refused"
into "empty"; both accessors return a tagged resolution, and neither can answer
anything a caller could mistake for an empty catalog.

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

`demoCatalogSource` takes a `NonDeploymentEnvironment`, and that argument is one
half of the gate; the other half is the question the function asks of it, which
is the registry check described in the list below. The argument is **not** a
class and has no constructor of its own:
`apps/web/src/app/api/deployment-environment.ts` declares it as an alias of
`ClassifiedRuntime`, the branded value `@liberty/contracts/shared/runtime`
issues. The same identifier is also a `const` object in that file, but it is a
namespace and not a constructor: its one member, `classify()`, forwards to the
mint and adds nothing, including the argument it used to add. PL-0706 replaced an
earlier class-with-a-private-field arrangement, because a private field is a
compile-time nominality trick that a spread copy of a real instance walks
straight through. Three mechanisms make the value unwritable outside the
contracts module:

- **A brand nothing else can name.** The key is a module-private `unique symbol`
  that is never exported, so an object literal cannot carry it and no consumer
  can write one.
- **A registry of the values that module actually issued.** Each issued
  classification is recorded in a `WeakSet` keyed by object identity, and
  `isClassifiedRuntime` answers from it — which is how a cast or a spread copy,
  both of which type-check, is caught at runtime *by a consumer that asks*.
- **A mint that takes no argument.** `classifyRuntime()` reads
  `process.env.NODE_ENV` from the process it is running in, at call time, and
  answers `null` for every value outside the allowlist.
  `NonDeploymentEnvironment.classify()` is one line over it and adds nothing.

**Nothing on this path takes an environment name.**
`resolveCatalogMetadataSource` and `resolveSynchronousCatalogMetadataSource` each
take a `NonDeploymentEnvironment | null`, defaulting to `classify()`; so does
`getSearchResults`'s third parameter, and `findDemoTitleDetail`'s second. Every
one of them used to take a `nodeEnv` string and forward it to the mint, which
meant a hosted process could call any of them with `test` and be issued a
genuine, registered capability — and the demo catalog with it. There is nothing
left to name: a caller either forwards a capability it was given or passes
`null`, and a test reaches the refusing branch with `null` rather than with a
word. Name-by-name coverage of the allowlist moved to
`isNonDeploymentEnvironmentName`, a predicate that answers about a string and
issues, registers and grants nothing.

So the gate is not a runtime `if` that a later edit can drop. The only mint
answers `null` in a hosted process; every parameter on this path is typed to take
that capability or `null`, so there is no argument through which some other
answer could be introduced; and `demoCatalogSource`'s own parameter is
non-nullable, which makes deleting the `null` branch in the registry a compile
error rather than a silent widening. That is a statement about what a **caller**
can reach along this path. It is not a claim that the fixture source cannot be
built at all, and the list below is the exact boundary.

**What that establishes and what it does not**, stated exactly — and this
paragraph has been wrong twice, which is why it is now a list. It first said the
fixtures were **unconstructible** in a deployment while the accessors still let a
caller mint a capability by naming an environment, so the mechanism did not
support the claim. It was then corrected into a second false statement: that
`NonDeploymentEnvironment` is a class with a private constructor and a private
field, which describes the arrangement PL-0706 **removed** rather than the alias
that replaced it. Neither is restated here:

- **It binds a caller, not an edit.** A change to `demo-catalog.ts`, to
  `deployment-environment.ts`, or to `@liberty/contracts/shared/runtime` defeats
  it, and nothing in TypeScript can prevent that. What it prevents is the way
  this defect actually recurs — a call site that quietly stops consulting the
  gate, or one that hands a permission-granting factory a value it wrote itself.
- **`demoCatalogSource` consults the registry.** It calls `isClassifiedRuntime`
  as its first action — before it reads `nodeEnv` or anything else off the
  argument, the ordering `createFixtureProvider` documents — and **throws** when
  the contracts module did not issue that exact object. So the two forgeries a
  compile-time brand cannot stop are refused at runtime rather than yielding the
  fixtures: an `as unknown as NonDeploymentEnvironment`, and a spread copy of a
  real classification, which carries the brand and needs no cast at all.
  `apps/web/src/lib/catalog-source-registry.test.ts` exercises both. The same
  check, in the same position, is in `selectRepository` and
  `createInMemoryRepository` in `apps/web/src/lib/db/` — the first of those
  passes `null` through, because `null` is what a deployment is given and not a
  forgery — in `developmentAccount` in `apps/web/src/lib/session/account.ts`,
  and in `createFixtureProvider` in `@liberty/provider-sdk`. *This entry used to
  record the gap as open and the edit as unmade, which was true when it was
  written.* What the check adds is only this: it asks about an OBJECT, so it
  binds a caller that manufactures a capability. It says nothing about the three
  items around it — an edit, a rewritten environment, or a development build
  that is genuinely one.
- **Code running inside the deployment that rewrites its own environment**
  defeats it: assigning `process.env.NODE_ENV` before the call changes what the
  mint observes, because what it observes is the process. That is a statement
  executing in the deployment, with the same reach as an edit and the same
  visibility in a diff. It is not something a caller can do *through* this path,
  which is the boundary PL-0706 moved.
- **A hosted build that exports `NODE_ENV=development` and runs `next dev`** is
  indistinguishable from a laptop, because it *is* a development build. No
  string test closes that; the control for it is not shipping one.

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
   from `resolveSynchronousCatalogMetadataSource`. Because the module already
   spends `null` on not-found, a process with no source **throws**
   `CatalogMetadataSourceNotConfiguredError`, which `title-detail.ts` maps by
   `instanceof`. It imports no implementation and classifies no environment: the
   first version of this migration reached `demoCatalogSource` and called
   `NonDeploymentEnvironment.classify` itself, which made a second module that
   knew both the port and an implementation and contradicted the rule stated at
   the top of this document. The witness is still what guards the fixtures; it is
   now presented in the registry, once, for every discovery surface.
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
   path has already made. `SynchronousCatalogMetadataSource` and
   `resolveSynchronousCatalogMetadataSource` exist for exactly this caller and are
   what disappear when the edit lands.

   The narrow accessor does not postpone that edit; it is what forces it into
   view. A source that does I/O is not assignable to
   `SynchronousCatalogMetadataSource`, so the day one is configured the compile
   error is in the registry, in the one file that composes sources. Whoever makes
   that edit then chooses on purpose between finishing the async migration and
   giving the refusal a second reason — a source is configured, and it cannot
   answer without awaiting. Neither is written today, because neither is true
   today.
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
- **The rights reference's shape is unenforced on the catalog path.** The rule
  itself is no longer homeless: `isOpaqueRightsReference`,
  `OPAQUE_RIGHTS_REFERENCE_PATTERN` and `MAX_RIGHTS_REFERENCE_LENGTH` are
  exported from `@liberty/provider-sdk`'s root — that export is the stable
  address; the file behind it is `packages/provider-sdk/src/fixture/rights.ts`
  today — and the copy that used to sit in
  `apps/web/src/app/api/v1/playback/session/authorized-candidates.ts` is gone —
  that module consumes the SDK and states no pattern of its own. *This document
  and `catalog-source.ts` both used to say the predicate was owned by
  `authorized-candidates.ts` and that the fix was to move it to a leaf module.
  Both statements were false by the time they were read; the move had already
  happened.* What is still true is that **the port does not apply the rule**, so a
  catalog rights reference can be any string. Two things stand in the way, and
  neither is the old one:
  - `@liberty/provider-sdk` publishes a single entry point (`"exports":
    "./src/index.ts"`, no subpaths), so importing the predicate pulls the SDK's
    root index — fixture provider, health scoring, Stremio vocabulary — into the
    module graph of every surface that renders a card. A subpath export would
    remove the objection; that is an edit to a package manifest. It is *not* true,
    as the older note claimed, that this would pull `@liberty/media-engine`: the
    SDK depends on `@liberty/contracts` and `zod` only.
  - Applying it is a behaviour change, not a tidy-up. Records would start being
    refused for the shape of an identifier nothing reads, which needs a third
    `CatalogRecordRefusalReason` and a rights decision about whether an
    unparseable reference should withhold a work from browse at all.

  Restating the pattern inside `apps/web` stays refused either way: a second
  spelling of a rights rule is the defect the SDK's own comment exists to prevent.
- **Episodes.** They are not catalog entities here; `demo-title-details.ts`
  generates them from a series' `episodeCount`. A real source states them, and
  where they live is an open question.
