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

**PL-0305 added the other half of the design and still did not add a provider.**
`packages/catalog-ingestion` now holds the ingestion machinery -- identity and
dedupe, refresh and staleness, tombstones, paging, provider-side search as a
declared capability, locale tags, availability windows, artwork with its own
licence, and the egress-bound transport -- driven by a `CatalogMetadataProvider`
port with nothing behind it. `resolveCatalogMetadataProvider()` answers
`not-configured` unconditionally, because choosing a source is a **Licensing**
decision and keying it is a **Credentials** one, and `control/policies.json`
reserves both to the human commander. Two sections at the foot of this document
are the record: [the ingestion package](#pl-0305-the-ingestion-package) and
[the rights position](#the-rights-position-on-a-real-source), the second of
which is the evidence the commander would decide from.

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
straight through. Four mechanisms make the value unwritable outside the
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
- **An allowlist that is frozen, and a comparison that borrows nothing.** Taking
  the argument away moved the authority into the array the argument-free mint
  consults, and that array was exported as `readonly string[]` — a compile-time
  claim over an ordinary mutable one. A consumer could cast it, append
  `production`, and then be issued a genuine capability from a genuine
  production process. It is now `Object.freeze`d, so the write throws; and
  `isNonDeploymentEnvironmentName` walks it by index rather than calling
  `Array.prototype.includes`, which is a writable property of an object every
  module can reach and would otherwise be a second door onto the same answer.

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
that replaced it. Neither is restated here.

It was then **incomplete** in the way it promises not to be, which is the third
correction and the one worth reading closely. The list said it binds a caller
rather than an edit, and enumerated what an edit could still do — but casting the
exported allowlist and appending `production` was a *caller* action reachable
along this very path, not an edit to any of the modules named below, and it does
not appear anywhere in the list as it stood. Freezing the array closed it; the
bullet above records the mechanism, and this paragraph records that the boundary
statement had a hole in it rather than pretending the mechanism was always there.

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

- **Ingestion. PARTLY CLOSED BY PL-0305, and the remaining part is the
  provider.** `packages/catalog-ingestion` has the pass: `runIngestionPass`
  pages a provider by cursor, clamps to the provider's declared maximum page
  size, resumes from a backfill cursor, bounds itself with `maxPages`, validates
  every record and reports a named refusal for each one it drops.
  `planNextPassAt` schedules the next pass with capped exponential backoff.
  What none of it has is a provider to run against -- see the two sections
  below. `docs/ARCHITECTURE.md` still lists "metadata ingestion worker" as an
  extraction candidate: the package is a library, and nothing schedules it in a
  process yet.
- **Refresh and staleness. CLOSED IN THE PACKAGE, NOT YET IN THE PORT.**
  Every ingested record carries an `observedAt`, `assessFreshness` grades it
  `fresh`/`stale`/`expired` against a two-bound `StalenessPolicy`, and
  `projectCatalogAnswer` dates a whole set by its OLDEST record -- a rail is as
  current as its stalest row. `CatalogMetadataSource` in `apps/web` still
  returns bare records with no age, because the port cannot import the
  package's freshness vocabulary yet (see the ingestion section below) and a
  second spelling of it inside `apps/web` is not worth the drift.
- **Identity and dedupe. DECIDED BY PL-0305.** The three decisions are written
  out in the header of `packages/catalog-ingestion/src/identity.ts`, with the
  alternatives each one rejected: (1) a normalized id is NAMESPACED BY ITS
  SOURCE, so two providers cannot collide by accident and the failure mode is a
  visible duplicate rather than a silent merge; (2) two records are the same
  work ONLY on a shared third-party authority identifier -- never on title,
  year or runtime at any confidence, because a wrong merge merges two rights
  bases and is a rights defect rather than a cosmetic one; (3) which source is
  canonical is DECLARED in a precedence list, and a record from an undeclared
  source is refused rather than ranked last. The cost of (1) is stated there
  too: ids are not portable between sources, so dropping a provider is a
  migration. Disagreeing with these is a review of the decision, which is the
  point of writing them down.
- **Deletion. CLOSED IN THE PACKAGE.** `WorkTombstone` distinguishes a
  withdrawal from an absence, and `runIngestionPass` mints one ONLY from a
  complete successful full pass, or from an explicit `withdrawn` list off a
  provider that declared `reportsDeletions`. It withholds tombstones by name in
  the three cases where absence is not evidence -- `pass_failed`,
  `page_limit_reached` and `incremental_pass` -- and a record that was SEEN and
  then refused is spared, because failing validation is not the same as being
  withdrawn. The third of those is the trap worth naming: an incremental sync
  that tombstones what it did not see deletes the whole catalog except this
  morning's edits, and every step of the reasoning looks correct.
- **Provider-side search. ANSWERED AS A CONTRACT IN THE PACKAGE; `apps/web` is
  unchanged.** `ProviderCapabilities.providerSideSearch` is a declaration, not a
  probe, and `requireProviderSideSearch` refuses by name rather than falling
  back to listing a source in full. Ownership is settled: paging is always the
  provider's and is always by cursor, never by offset; relevance ranking belongs
  to whoever ran the query, so a provider's result order is never re-sorted
  here, and the platform ranks only when it searched its own store.
  `searchCatalog` in `apps/web` still filters an in-memory array of six
  fixtures, because there is no store behind it.
- **Paging. ANSWERED AT THE PROVIDER BOUNDARY, NOT AT THE PORT.**
  `fetchPage` is cursor-based and `listRecords` on the `apps/web` port still
  returns everything. The port's shape is not a shape a real catalog can use and
  that has not changed; what has changed is that the ingestion side no longer
  assumes it can enumerate a source in one call.
- **Artwork and image rights. MODELLED, AND DELIBERATELY NOT DELIVERED.**
  `ArtworkRef` carries a `role`, an OPAQUE `assetRef` -- never a URL, so a
  provider's image CDN link has nowhere to go -- and a REQUIRED rights basis of
  its own, separate from the work's. Required rather than nullable because the
  risk is asymmetric: an undeclared work is refused and nothing is published,
  whereas an undeclared image that reached a page is a copy of somebody's file
  served from our origin. `project.ts` then DROPS artwork on the way to
  `CatalogItem`, which still carries no image field and where
  `catalog-card.tsx` still renders a decorative gradient -- so images are
  ingested and not delivered. That is the "or they do not arrive" half of
  PL-0305's acceptance criterion, made structural. Delivering them needs an
  image-rights agreement, which is a separate Licensing decision from the
  metadata one.
- **Localization. CLOSED IN THE PACKAGE, NOT IN THE PORT.** An ingested work
  holds locale-tagged sets for title, genre and synopsis, and `selectLocalized`
  collapses them at the READ -- exact locale match across the whole preference
  list first, then primary-subtag match -- refusing rather than falling back to
  whichever language the source listed first. `CatalogItem` still holds one
  untagged string for each, which is correct for a card and is why the choice
  happens at projection time with the reader's preferences in hand.
- **Availability windows and territory. MODELLED IN THE PACKAGE; the empty
  state's phrase still has nothing behind it in a running build.**
  `AvailabilityWindow` carries an ISO 3166-1 territory (or `WW`), and open-ended
  start and end dates where `null` means OPEN and NO WINDOW AT ALL means
  unstated -- two different facts that a nullable-both-ends window would
  conflate. `projectToCatalogRecord` evaluates them, and how to read an unstated
  availability is the CALLER's decision (`refuse` or `treat_as_worldwide`) with
  no default, because both readings are defensible and burying one in a default
  argument would hide a rights choice.
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

## PL-0305: the ingestion package

`packages/catalog-ingestion` (`@liberty/catalog-ingestion`) is the half of a
real catalog source that needed no external access, built so the half that does
is a wiring change rather than a redesign. **It configures no provider**, which
is the subject of the next section.

It is a package rather than a folder in `apps/web` for the reason
`@liberty/media-inspection` is: this is scheduled cross-provider I/O against
infrastructure nobody here administers, and a rail renders what it is given
while this decides what exists. Being outside the app is also what lets it
import `isOpaqueRightsReference` from `@liberty/provider-sdk` and finally APPLY
the opaque-rights-reference rule on a catalog path. The objection recorded
further up this document -- that the SDK publishes one root entry point, so a
browse surface importing the predicate pulls the fixture provider, the health
scoring and the Stremio vocabulary into the bundle of every page that renders a
card -- is a bundle cost, and a server-side ingestion package does not pay it.
`apps/web` still does not import it, and restating the pattern there is still
refused.

| Module | What it decides |
| --- | --- |
| `record.ts` | The ingestion vocabulary: locale-tagged text, availability windows, artwork with its own basis, tombstones, provenance. Zod schemas, because this is the parse boundary for untrusted I/O. |
| `identity.ts` | Id derivation and dedupe. The three decisions, and what each one rejected. |
| `freshness.ts` | `observedAt`, a two-bound staleness policy, and capped backoff. |
| `provider.ts` | The `CatalogMetadataProvider` port, its declared capabilities, and `resolveCatalogMetadataProvider()` -- which answers `not-configured`. |
| `safety.ts` | `findMediaAddresses` and `checkRightsBasis`. The two checks that make this a rights boundary. |
| `ingest.ts` | One pass: paging, backfill, per-record refusals, and the tombstone rule. |
| `project.ts` | Collapse to `CatalogItem` for one reader: locale, territory, and the age of the answer. |
| `transport.ts` | The ONLY network path, and it is PL-0304's, not a new one. |

### How catalog metadata stays separate from playback resolution

Three mechanisms, stated because a single assertion is not evidence:

1. **The vocabulary has no field for an address.** There is no url, uri, src,
   href, manifest or stream anywhere in `record.ts`, and artwork is an opaque
   `assetRef` rather than a link. Nothing here *can* say where to fetch a work.
2. **The raw payload is scanned before it is parsed.** `findMediaAddresses` runs
   on the provider's untouched response, and it runs FIRST -- before zod, which
   silently strips unknown keys. A schema parse first would discard a
   `streamUrl` and leave the record looking clean, so the provider sending one
   would never be noticed. It refuses on the KEY as well as the value, because a
   key that is empty today is populated tomorrow. It catches
   protocol-relative (`//host/x`) and bare-host (`host/x`) references, which
   `new URL()` does not.
3. **The projection emits `CatalogItem`, which has no image or stream field**,
   and drops artwork rather than mapping it. `e2e/tests/catalog.api.spec.ts`
   already asserts that no key in a catalog response is an address and no value
   is an absolute URL; nothing in this package can make that assertion fail.

Playback resolution remains where it was: `@liberty/provider-sdk` adapters, the
playback-session boundary, and invariant 1's rights check before ranking.
Nothing in this package is reachable from it.

### How network access goes through the existing egress boundary

`transport.ts` is forty lines over `fetchManifestText` from
`@liberty/media-inspection` and adds one thing: a `JSON.parse`. It writes no
allowlist, no DNS logic, no redirect policy and no size cap of its own, so the
four controls PL-0304 took several review rounds to settle are the ones a
catalog fetch gets:

- a fail-closed host allowlist (an empty one fetches nothing);
- every resolved address classified before the socket, with the survivors
  carried forward as a `PinnedTarget` so the name is never resolved twice;
- a body metered incrementally rather than trusted from `Content-Length`;
- every redirect hop re-authorised against the same policy, inside one deadline.

`transport.test.ts` asserts the composition rather than re-testing the gate: each
negative case checks BOTH the refusal reason AND that the transport was never
reached, which is the assertion a wrapper that called `fetch` and checked the
allowlist afterwards would fail.

The function's name is about its first caller, not its contents -- its own header
describes it as fetching "ONE document, of bounded size, within one deadline,
over a redirect chain", and there is nothing manifest-specific in it. A second
copy for catalogs would be a second SSRF filter to keep in agreement with the
first, and the one nobody updates is the one that decides.

`userAgent` is **required with no default**, because several candidate sources
make it a condition of access rather than a courtesy, and a default would be a
string this package chose on an operator's behalf.

### What PL-0305 did NOT do, and why

- **No provider is configured.** See the next section. This is the whole point.
- **`apps/web` does not import this package, and cannot yet.** Declaring the
  dependency means editing `apps/web/package.json`, which is outside PL-0305's
  `allowedPaths`; and adding any new workspace package needs two entries in
  `package-lock.json`, which is outside it too. So the adapter that turns
  projected records into a `CatalogMetadataSource` -- a few lines in
  `catalog-source-registry.ts` -- is not written. `ProjectedCatalogRecord` is
  deliberately **structurally identical** to the port's `CatalogMetadataRecord`,
  both spelled in published contract types and neither importing the other, so
  that adapter is an assignment rather than a mapping when it can be written.
- **Nothing schedules a pass.** `planNextPassAt` says when the next one is due;
  no process calls it. There is no worker, no queue and no store -- ingestion
  produces `AcceptedWork` and tombstones and hands them back, and where they are
  persisted is the next task's question.
- **The port still has no age, no paging and no tombstone.** Those need the
  dependency above.
- **`@liberty/media-inspection` has no `./http` subpath**, so importing its
  barrel pulls `hls.ts` and with it `m3u8-parser`, whose ambient declaration
  lives in that package's own source tree. `packages/catalog-ingestion/tsconfig.json`
  names that declaration file to keep the build honest. The real fix is a subpath
  export on that package's manifest, which is outside this task's paths.
- **The contract still cannot express undeclared rights.** `catalogItemSchema.rights`
  is non-nullable, so `project.ts` has to put SOME category on an item whose basis
  is null while keeping `record.rights` null. The item's field is not read by
  anything that gates; the deeper fix is still a `packages/contracts` change with
  its own review.

## The rights position on a real source

**No metadata source has been selected, and selecting one is not an engineering
decision.** `control/policies.json` puts `Licensing` and `Credentials` under
`escalation.humanOnly`. PL-0305's own task record says the same. What follows is
the evidence a commander would decide from, and what was and was not verified.

### How this evidence was gathered, and its limits

Each primary source below was fetched on **2026-09-16** and is quoted. Three
limits, stated rather than left to be discovered:

1. **Terms change.** A quotation dated today is not a licence position next
   quarter. Any decision here should re-read the primary document at the time it
   is taken.
2. **One canonical document could not be read.** TMDB's own API terms page
   (`themoviedb.org/api-terms-of-use`) is disallowed by that site's robots.txt
   and was not retrieved; what is quoted for TMDB is its developer FAQ, which is
   a summary published by the same party and is not the contract.
3. **This is not legal advice, and one question in particular is not an
   engineering question.** Bare facts -- a title, a year, a runtime -- are
   generally not copyrightable in the United States, but a COMPILATION of them
   can attract the EU/UK sui generis database right independently of copyright.
   Whether bulk ingestion of a third party's catalog engages that right is a
   question for counsel, not for this document, and it applies to every
   candidate below including the CC0 one.

### Candidates

**Wikidata** -- the only candidate that needs no credential and whose data
carries an explicit public-domain dedication.

> "All structured data in the main, property and lexeme namespaces is made
> available under the Creative Commons CC0 License."
> -- <https://www.wikidata.org/wiki/Wikidata:Licensing>

The same page records that text in OTHER namespaces is CC BY-SA, so the
distinction matters: the structured statements about a film are CC0; prose is
not. CC0 imposes no attribution condition. Coverage of film and television is
broad but uneven, and it is community-maintained rather than editorial, so
quality is a product question rather than a rights one.

Access is unauthenticated, but not unconditional. The Wikimedia User-Agent
policy applies:

> "Scripts should use an informative User-Agent string with contact information,
> or they may be IP-blocked without notice."
> -- <https://meta.wikimedia.org/wiki/User-Agent_policy>

The same policy forbids a bot presenting a browser's User-Agent. This is why
`CatalogDocumentOptions.userAgent` is required with no default. Rate limits and
query timeouts on the public SPARQL endpoint were **not** verified here -- the
Wikidata Query Service documentation was not retrievable from this environment
-- and should be read before any pass is scheduled against it.

**TMDB** -- the richest film/TV metadata source, and the one that needs both
escalation categories.

> "You can apply for an API key by clicking the 'API' link from the left hand
> sidebar within your account settings page."
>
> "Our API is free to use for non-commercial purposes as long as you attribute
> TMDB as the source of the data and/or images."
>
> "If you are interested in obtaining a license to use our API and/or our
> data/images for commercial purposes, please contact [sales]."
> -- <https://developer.themoviedb.org/docs/faq> (the FAQ; see limit 2 above)

Attribution is a required, specific string ("This product uses the TMDB API but
is not endorsed or certified by TMDB") in an about or credits surface. So TMDB
is a **Credentials** escalation (an API key) AND a **Licensing** one (whether
Project Liberty is commercial, which is not a question this repository can
answer about itself). Its images are covered by the same terms, which is a
second and separate reason artwork is modelled but not delivered.

**Other keyed aggregators** (OMDb, JustWatch, Gracenote and similar) were **not
assessed**. They are named here so their absence is legible as "not researched"
rather than "ruled out".

### What would have to happen

1. A commander decision under **Licensing**, naming the source and recording
   what its terms permit for this product's actual commercial posture, and
   whether counsel has been asked about database rights on bulk ingestion.
2. If the source is keyed, a **Credentials** escalation. No environment variable
   has been introduced for one and no placeholder exists anywhere in this
   package: a stub that looks like a real key makes an unconfigured build look
   configured. Note that `apps/web` reads dotenv from `apps/web/`, **not** the
   repository root -- `docs/DEVELOPMENT.md` records this and it has cost
   debugging rounds before.
3. A separate decision for **artwork**, if images are wanted. Image rights are
   not the work's rights, and `ArtworkRef` keeps them apart on purpose.
4. An adapter implementing `CatalogMetadataProvider`, constructed over
   `transport.ts`, plus an entry in the operator's `EgressPolicy.allowedHosts`
   -- without which it fetches nothing, by design.
5. The `apps/web` dependency and the registry adapter described above.

Until (1), `resolveCatalogMetadataProvider()` answers `not-configured` with the
reason `no_catalog_provider_licensed`, and
`packages/catalog-ingestion/src/provider.test.ts` asserts it does. That test is a
tripwire, not a claim that the refusal is permanent: it fails the day somebody
returns a configured provider, which is exactly when a rights review needs to
have happened.
