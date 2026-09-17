# Catalog metadata source

**A metadata source now stands behind the ingestion port, and it is Wikidata.
It does not yet stand behind the application's port. Read the scope section
before reading anything else in this document as wider than it is.**

`docs/PRODUCT_SPEC.md` step 2 of the initial user journey is "browse/search
normalized metadata". Until PL-0305r nothing in this repository ingested any:
every discovery surface — the home rails, the search results, the title detail
page — was backed by `apps/web/src/lib/demo-catalog.ts`, a hardcoded array of six
fictional works. All three surfaces reach the fixtures through the port below, so
no shipped module gets to them without passing the environment gate.

PL-0301 and PL-0302 do not close this. They supply **stream candidates**: what a
title plays from, resolved at playback time by an authorized provider. A catalog
is the other half — what exists, what it is called, what it is about.

**What exists now, stated precisely so neither half is overclaimed.**
`packages/catalog-ingestion` holds the ingestion machinery — identity and dedupe,
refresh and staleness, tombstones, cursor paging, provider-side search as a
declared capability, locale tags, availability windows, artwork with its own
licence, and the egress-bound transport — and `resolveCatalogMetadataProvider()`
now returns a real **Wikidata** provider behind the unchanged
`CatalogMetadataProvider` port. `apps/web` still does not consume it:
`resolveCatalogMetadataSource` still answers `no_metadata_source_configured`,
because the dependency edit that would connect them is in
`apps/web/package.json`, outside PL-0305's `allowedPaths`. So the ingestion side
is real and the browse side is unchanged, and
[the remaining edits](#what-has-happened-and-what-has-not) are named rather than
implied.

## The licensing decision, and exactly what it covers

**Decided by the human commander on 2026-09-17.** Recorded on PL-0305 as
`licensingDecision` and in `control/events.jsonl` as a `decision.licensing`
event. `control/policies.json` lists `Licensing` under `escalation.humanOnly`, so
this was not an engineering decision and was not self-certified by the
implementing agent.

> **Wikidata is the initial catalog metadata source**, because it requires no
> credential and keeps the provider seam replaceable.

**Transport of the decision, stated because it bears on how much weight it can
carry:** it was relayed by the commander in chat, inside `gpt-architect`'s
round-45 review text, and transcribed by `claude-lead`. It is authentic but **not
machine-attested**.

### What the decision does NOT cover

These are limits on the decision, not caveats about it. A reader of this document
alone must not come away with a wider reading than the commander gave.

1. **It is an initial source choice, not an exclusive or permanent source
   mandate** — in those words, at the reviewer's insistence. Nothing may assume
   Wikidata is the only source or bake its shape into the port. The code is built
   to that: `resolveCatalogMetadataProvider` is a registry over a frozen list of
   *licensed source names* that currently has one entry, the
   `CatalogMetadataProvider` port is byte-for-byte what it was before the adapter
   existed, and no module in the package other than the adapter itself mentions
   Wikidata.
2. **No credentialed source is authorized.** TMDB and anything else needing an
   API key remains a separate **Credentials** escalation. No key, no placeholder
   and no environment variable for one has been added — see
   [what has happened](#what-has-happened-and-what-has-not). Asking the resolver
   for `tmdb` answers `no_catalog_provider_licensed` by name, and a test asserts
   it: that is the tripwire that replaces the round-44 one.
3. **Nothing is decided about the EU/UK sui generis database right.** Whether
   bulk ingestion of a third party's catalog engages it is a question for
   counsel. It applies to Wikidata exactly as much as to any other candidate, and
   CC0 on the individual records does not answer it, because the database right
   is a right in the compilation rather than in its contents. **This is the
   largest open rights question on this path.**
4. **Only Wikidata's CC0 position on structured data in the main, property and
   lexeme namespaces was evidenced.** Text elsewhere is CC BY-SA. Nothing was
   evidenced about Commons, about MediaInfo entities, or about any other
   Wikimedia project.

### The obligation that follows: User-Agent

Wikidata's structured data is CC0, but **access is not unconditional**. The
Wikimedia User-Agent policy requires an informative agent string carrying contact
information, and forbids a client presenting a browser's string; a client that
ignores it may be **IP-blocked without notice**, and the block lands on the
operator's address rather than on a request.

`CatalogDocumentOptions.userAgent` is therefore **required with no default, and
must stay that way**. A default would be a string this package chose on an
operator's behalf, attached to their contact reputation. On top of that,
`createWikidataProvider` refuses to build at all over an agent string that
carries no contact token or that contains a browser token — two separate named
refusals, because the remedies are different — so a misconfigured deployment gets
*no provider* instead of an IP block.

### How the CC0 / CC BY-SA line is enforced rather than described

Four mechanical controls, all in
`packages/catalog-ingestion/src/wikidata-query.ts`, each with a test:

| Control | What it stops |
| --- | --- |
| `WIKIDATA_CC0_HOSTS`, a frozen two-host set, and a construction refusal when the operator's `EgressPolicy.allowedHosts` names **anything else** | A deployment whose catalog egress policy also reached `en.wikipedia.org` would be one query edit away from ingesting CC BY-SA article text. The provider refuses to exist over such a policy. |
| `CC0_ENTITY_ID_PATTERN`, admitting `Q`, `P` and `L` and nothing else | An `M`-id (Commons MediaInfo) reaching a query. MediaInfo captions are CC0 but the **files** they describe are separately licensed, and the decision evidenced neither. |
| No `SERVICE` clause in any built query, asserted by `containsServiceClause` | A SPARQL federated call reaching an endpoint whose licence is whatever that endpoint says. `wikibase:label` is the convenient one; labels are read with plain `rdfs:label` triples instead. |
| No request for `P18`, `P154`, `P3383`, sitelinks or article extracts | A Commons file or a Wikipedia extract entering a catalog record. Artwork in `record.ts` requires an **opaque asset reference and its own stated rights basis**, neither of which this adapter can mint, so it emits none. |

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
  state's phrase still has nothing behind it in a running build — and the
  selected source does not supply one.** Wikidata models no distribution window,
  so every record it produces carries `availability: []` and the fail-closed
  reading refuses all of them.
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
is a wiring change rather than a redesign. **It configured no provider when it
was written; PL-0305r wired one** — see
[the Wikidata provider](#pl-0305r-the-wikidata-provider). Everything in this
section is about the source-independent machinery, and none of it changed to
accommodate the adapter.

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
| `provider.ts` | The `CatalogMetadataProvider` port, its declared capabilities, the frozen list of licensed source names, and `resolveCatalogMetadataProvider()`. |
| `wikidata-query.ts` | Every request the Wikidata adapter may make, and the CC0 rules bounding them. |
| `wikidata.ts` | The Wikidata adapter: the only module in the package that names a source. |
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

- **No provider was configured** *at the time that section was written*. That is
  no longer true: PL-0305r wired the Wikidata adapter below, on the strength of
  the commander's Licensing decision. Everything else in this list still stands.
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

## PL-0305r: the Wikidata provider

Two modules, both in `packages/catalog-ingestion/src`:

| File | Role |
| --- | --- |
| `wikidata-query.ts` | Every request the adapter can make, and the rules that bound them: the frozen CC0 host set, the entity-id namespace pattern, the User-Agent checks, and the SPARQL template. Nothing here fetches. |
| `wikidata.ts` | Reading the two responses, projecting a row into a provider record, and the provider itself. |

### What it does

- **Enumerates the instances of one declared Wikidata class**, keyset-paged on
  the numeric part of the item id. The cursor is `?n > watermark ORDER BY ?n`,
  never an `OFFSET`: Wikidata is edited continuously, and an offset walk over a
  changing collection skips and repeats records. A QID's numeric part is
  immutable and monotonic, so an item created mid-pass sorts after everything
  already read.
- **One request per page.** The query packs the multi-valued, language-tagged
  columns with `GROUP_CONCAT` so a page is one row per work rather than one row
  per (work × genre × release date), and the client unpacks them. Separators are
  ASCII `US`/`RS` control characters, which cannot occur in a Wikidata label —
  `|` and `;` both do.
- **Searches through `wbsearchentities`**, then hydrates the returned ids through
  *the same* query the enumeration uses. Relevance order is the source's and is
  preserved exactly; the class constraint in the hydration query is what filters
  out non-films, which is not hypothetical — `wbsearchentities` ranks an **album**
  called "The Matrix" above the film.
- **Carries cross-references** as `{authority, id}` pairs: the Wikidata QID and
  any IMDb id (`P345`). `identity.ts` merges two sources' records only on a
  shared authority id, so those are what a second source would ever merge on.

### What it honestly cannot do

| Declared | Value | Why |
| --- | --- | --- |
| `providerSideSearch` | `true` | `wbsearchentities`, offset-continued, relevance-ordered by the source. Narrower than it sounds: it searches labels and aliases, not synopses. |
| `incrementalSince` | **`false`** | The Query Service's default graph does not expose a modification time — `schema:version` and `schema:dateModified` against the entity IRI bind nothing there (tried; empty result). They are on the Action API's `wbgetentities`, at a measured **~206 KB per entity**, so 50 entities is ~10 MB against a 4 MB body cap. The adapter does not pay that and does not claim the capability, so it must and does **ignore `changedSince` entirely**. |
| `reportsDeletions` | **`false`** | Deletions are visible through `list=logevents` — a different API, a different pagination model. `withdrawn` is always empty. |
| `maxPageSize` | `50` | The number the source itself uses (the Action API's anonymous batch limit); ~1.5 KB per row measured, so ~75 KB a page. |
| `sourceRevision` | **always `null`** | Same reason as `incrementalSince`. A consumer therefore cannot tell whether a record changed between passes. This is a real gap and it is the price of one cheap request per page. |

Two more it cannot do, and they matter more than the table:

- **It states no availability and no territory.** Wikidata does not model a
  distribution window, so every record carries `availability: []`. With
  `project.ts`'s fail-closed `unstatedAvailability: "refuse"`, that means **every
  record is refused at projection**. The home page's "in your region" still has
  nothing behind it.
- **It states no rights basis.** See below.

### Rights: a Wikidata record establishes none, and the default publishes nothing

A Wikidata item states that a film **exists**. It does not state that this
operator may show it. Those are different facts, and only the operator's own
rights register holds the second — so `rights` on every record the adapter builds
comes from an **injected register** and from nowhere else.

`WikidataRightsRegister` is **required with no default**, on exactly the argument
`userAgent` is: a default would be a rights position this package chose on an
operator's behalf. `noRightsBasisEstablished` is that position, available by
name, and it answers `null` for every work — at which point `checkRightsBasis` in
`safety.ts` refuses every record with `rights_basis_not_declared`.

**So a default composition of this provider against real Wikidata publishes
nothing, and that is the correct outcome rather than a bug.** The rights
machinery is in the path, applied to real records, and it fails closed on all of
them. A test asserts exactly that over three recorded real films.

`P6216` (copyright status) **is read and is not interpreted.** The register
receives the raw QIDs as opaque tokens; `Q19652` is never mapped to
`public-domain` here, because turning a crowd-edited statement into a rights
basis is a rights decision and the licensing decision does not cover it. An
operator who wants to rely on it writes that mapping in their own register, where
a rights reviewer can see it. In practice the property is **absent from all four
real films recorded as fixtures**.

### Why the pre-parse media-address scan finally earns its keep

`acceptRecord` in `ingest.ts` scans the raw payload with `findMediaAddresses`
*before* zod parses it, because zod strips unknown keys and a schema-first
pipeline would silently discard a `streamUrl`. Against fixtures that ordering is
a precaution. Against Wikidata it is a live control: **a label, description or
genre name is a field any logged-in person on the internet can edit.** A
vandalised title reading `https://cdn.example.test/x.m3u8` is an ordinary
non-empty string as far as `localizedTextSchema` is concerned and would be
published as a work's name. The scan refuses the record by name instead. This is
the first path in this repository where that scan has an untrusted writer behind
it, and there is a test built from a real response with one label replaced.

A related finding, kept because it is the kind of thing that is easy to get
backwards: an operator register answering with a rights reference that contains a
contract URL is refused as `media_address_in_catalog_payload`, **not** as
`rights_basis_reference_not_opaque` — the address scan runs first. Both refusals
are correct; the ordering is now pinned by a test rather than discovered.

### What real queries established, measured on 2026-09-17

Every number here came from a live request, not from documentation.

- **`Q11424` (film) has 349,426 instances.** Enumerating them is the real
  workload, and the shape of the query decides whether it is possible at all.
- **CirrusSearch cannot enumerate the class.** `list=search` with
  `haswbstatement:P31=Q11424` answers fast (0.9 s) but refuses beyond offset
  10,000: `cirrussearch-offset-too-large`, "Up to 10000 search results are
  supported". That rules it out as the enumeration mechanism and is why the
  adapter uses WDQS.
- **Ordered SPARQL enumeration cost depends on how far in the watermark sits.**
  32.8 s at watermark 0 over the whole class; 6.0 s at watermark 100,000,000;
  2.3 s for the adapter's actual page query at watermark 83,000; 0.6 s for a
  small class. The first page of a large class is the expensive one and it gets
  cheaper as the pass progresses. **`CATALOG_DOCUMENT_LIMITS.timeoutMs` of 10 s
  is not enough for the first page of a large class** — an operator must raise it
  for the enumeration, and WDQS's own ceiling is 60 s.
- **Rate limiting is real and not rare.** Researching this adapter drew HTTP 429
  from `www.wikidata.org` **twice within a few minutes** from a single address.
  The 429 body is **plain text, not JSON**, so a client that parsed before
  checking the status would report the source as malformed.
- **A hydration query for three searched ids returned one row**, because two of
  the three hits were not instances of the class. That is the filter working, and
  it is what the recorded fixture shows.
- **`GROUP_CONCAT` order is not stable.** The same item's genres came back in two
  different orders in two responses on the same day, which is why the adapter
  sorts the unpacked entries — two passes over an unchanged item must produce the
  same record or a diff between runs means nothing.

### What was committed as a fixture, and what was not

`packages/catalog-ingestion/src/__fixtures__/` holds **three JSON files, ~8.5 KB
total**, recorded from the live endpoints on 2026-09-17 using the URLs this
package's own builders produce. Their header module states every reduction:

- `wikidata-page.json` — one of four returned rows dropped; nothing inside the
  survivors touched.
- `wikidata-search.json` — five hits cut to three, `search-continue` adjusted to
  match. **Every field of each surviving hit kept, including `url` and
  `concepturi`** — the media-address-shaped fields — so a test can prove the
  adapter ignores them.
- `wikidata-hydration.json` — unchanged, one row.

**No bulk dataset was committed.** The class has 349,426 items and none of them
is in this repository. Three rows is what it takes to exercise the packing, the
deduplication, the class filter and the ordering.

### The live suite, and how it is kept out of the gate

`src/wikidata.live.test.ts` runs the shipped queries against the real service. It
is excluded from the default run by `packages/catalog-ingestion/vitest.config.ts`
and reachable only through `npm run test:live` in that package, which passes
`--mode live`. A positional path is **not** enough — vitest applies `exclude`
before a filter narrows the list, which was found by trying it.

It is out of the gate for two independent reasons: a CI fleet running it on every
push is a way to get an operator **IP-blocked**, which the User-Agent policy says
happens without notice; and a shared public endpoint is allowed to be slow, so a
gate that goes red because Wikidata is busy teaches a reader to ignore the gate.
It asserts **shape, not content** — that the query still parses, the columns still
come back named as expected, and a live record still carries no media address and
no rights basis — because how many genres `Q83495` has is whatever the last
editor decided.

## The rights position on a real source

**This section is the evidence the commander decided from, kept as it stood.**
The decision itself, and its scope limits, are at the top of this document under
[the licensing decision](#the-licensing-decision-and-exactly-what-it-covers);
this is the material that preceded it, retained rather than rewritten so a
reviewer can see what was and was not in front of the decision-maker. Wikidata
was selected on 2026-09-17. **TMDB and the other keyed candidates below were
not**, and `Credentials` remains under `escalation.humanOnly`.

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

**This is the selected source.** Access is unauthenticated, but not
unconditional. The Wikimedia User-Agent policy applies:

> "Scripts should use an informative User-Agent string with contact information,
> or they may be IP-blocked without notice."
> -- <https://meta.wikimedia.org/wiki/User-Agent_policy>

The same policy forbids a bot presenting a browser's User-Agent. This is why
`CatalogDocumentOptions.userAgent` is required with no default, and why
`createWikidataProvider` refuses to build over an agent string that lacks contact
information or carries a browser token.

**Rate limits and query timeouts were unverified when this paragraph was
written. They have since been measured rather than read**, and the numbers are in
[what real queries established](#what-real-queries-established-measured-on-2026-09-17):
HTTP 429 from the Action API twice within a few minutes from one address, a
CirrusSearch hard cap at 10,000 results, and SPARQL enumeration between 0.6 s and
32.8 s depending on the query shape and the watermark. The Wikidata Query Service
*documentation* is still not retrievable from this environment, so the published
policy limits remain unread; what is recorded is observed behaviour, which is
weaker evidence about the policy and stronger evidence about the service.

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

### What has happened, and what has not

1. **Done — a commander decision under `Licensing`.** 2026-09-17, naming
   Wikidata, with its scope limits recorded verbatim at the top of this document.
   **Counsel has *not* been asked about database rights on bulk ingestion**, and
   the decision says so explicitly. That question is open and is not an
   engineering one.
2. **Not needed, and not authorized.** Wikidata needs no credential, so no
   `Credentials` escalation was taken and none is implied. No environment
   variable has been introduced for a key and no placeholder exists anywhere in
   the package: a stub that looks like a real key makes an unconfigured build
   look configured. If a keyed source is ever wanted, note that `apps/web` reads
   dotenv from `apps/web/`, **not** the repository root — `docs/DEVELOPMENT.md`
   records this and it has cost debugging rounds before.
3. **Not done, and structurally impossible from this source — artwork.** Image
   rights are not the work's rights, `ArtworkRef` keeps them apart on purpose,
   and a Wikidata image is a Commons **file** with its own licence, routinely not
   free at all for a film poster. The adapter emits no artwork and cannot: an
   `ArtworkRef` needs an opaque asset reference from the operator's own store and
   a stated basis, and this adapter can mint neither.
4. **Done — an adapter implementing `CatalogMetadataProvider`**, constructed over
   `transport.ts` (the PL-0304 egress boundary, not a second fetcher). It refuses
   to build unless the operator's `EgressPolicy.allowedHosts` is exactly the two
   Wikidata endpoints.
5. **Not done — the `apps/web` dependency and the registry adapter.** This is the
   one remaining edit between an ingestion package with a real source and a
   browse surface with a real catalog, and it is two manifest lines plus a few
   lines in `catalog-source-registry.ts`. `apps/web/package.json` is outside
   PL-0305's `allowedPaths`, so it was not made. `ProjectedCatalogRecord` is
   deliberately structurally identical to the port's `CatalogMetadataRecord`, so
   the adapter is an assignment rather than a mapping when it can be written —
   and it will produce the compile error the registry already predicts, because a
   provider that does I/O is not assignable to
   `SynchronousCatalogMetadataSource`.
6. **Not done — a rights register.** Without one, the provider publishes nothing.
   That is the fail-closed outcome, not a defect, but it means "a real source is
   wired" and "a real catalog is servable" are still two different statements.
7. **Not done — a scheduler.** `planNextPassAt` says when the next pass is due;
   no process calls it, and nothing persists `AcceptedWork` or tombstones.
8. **Not done — `provider_rate_limited` is unreachable from this adapter.**
   `fetchManifestText` reports a non-2xx as `http_status` with the number only
   inside a human-readable detail string, so 429 cannot be distinguished from any
   other status without parsing English. The fix is upstream — the transport
   should carry the status as a field — and
   `packages/media-inspection` is outside PL-0305's `allowedPaths`. The safety
   consequence is nil (`ingest.ts` withholds tombstones on any page failure); the
   diagnostic consequence is that an operator cannot tell "slow down" from "your
   request is wrong".

The round-44 tripwire in `packages/catalog-ingestion/src/provider.test.ts` —
which asserted the resolver refused, and whose comment said it would fail "the
day somebody returns a configured provider, which is exactly when a rights review
needs to have happened" — **fired, and was inverted rather than deleted.** What
stands in its place is the tripwire that matters now: the licensed-source list is
frozen, contains only `wikidata`, cannot be widened at runtime, and licenses no
keyed source. That test fails the day somebody adds one, which is exactly when a
`Credentials` escalation must have happened.
