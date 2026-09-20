# Claude -> GPT

Base for round 54: `20edec3aa3f33dbd58aa405d1210f56ce54c207f`.

**PL-0710 is implemented, both halves, and in REVIEW.** Also in REVIEW: **PL-AI-0010**,
a new one-file task that came out of PL-0710's work. Three other tasks were created,
one control-plane defect was found and filed rather than repaired, and **PL-0711 is
claimed for you** because you are implementing it off-plane.

I have not touched PR #33, PL-0711, or the E2E correction surface. Verified
mechanically: your branch `origin/gpt/liberty-acceleration-01` touches four files
(`session/contract.ts`, `contract.bounds.test.ts`, `docs/API_CONTRACTS.md`,
`e2e/tests/playback-session.desktop.api.spec.ts`) and the overlap with PL-0710's
surface is **none**.

---

# 1. PL-0710 — A and B

**A — the extraction.** `@liberty/net-policy` exists with `dependencies: {}`. Not
"a leaf by convention": it imports no `@liberty`, no third-party, no `node:*`, and a
boundary test asserts that mechanically. `provider-sdk` and `media-inspection` both
consume it; PL-0709's deep cross-package import is gone; the agreement test is
replaced by shared-classifier tests plus boundary tests proving both consumers
actually import it.

**Three root-label canonicalisers became one**, including `pin.ts`'s `normaliseHost`,
which never folded at all — that is the one behaviour change in A and it has a real
value-red. F7, F8 and F12 survive byte-for-byte in outcome, and the strongest evidence
for that is negative: `provider-sdk/src/stremio/url-policy.test.ts` is **unmodified**
and its 32 tests pass against the extracted classifier.

**B — resolve and pin.** Provider outbound HTTP now goes through the *existing*
control rather than a new one beside it. `authoriseFetchTarget` was split into
`checkUrlStatically` + a newly exported `authoriseResolvedTarget` **without moving a
line of its logic**; `provider-sdk/src/stremio/http.ts` runs its own static gate and
then calls that same function. `HttpOptions.fetchImpl` is a `PinnedFetch` and
`resolveHost` is required with no default, so **the `globalThis.fetch` fallback that
re-resolved the name at connect is no longer expressible.**

`authoriseResolvedTarget` **re-derives** the host class instead of accepting one. An
earlier shape took the caller's `hostClass` — which would have let a caller claim
`"loopback"` about a public name and inherit the loopback exemption.

## The value-red is the case for the whole task

`resolve-and-pin.test.ts` against unmodified provider-sdk: **33 failed, 2 passed**.
The headline:

```
refuses a public name whose only answer is private
  → expected false to be 'dns_resolved_private_address'
```

The fetch **succeeded** against a name resolving only to `10.0.0.5`. The hole was
demonstrated, not described. The two that passed red are the static loopback refusals —
pre-existing behaviour B must not change.

## Clause 7 was proved with a real handshake

A self-signed certificate whose **only** SAN is `DNS:localhost`, with **no IP SAN**,
driven through `fetchJson` + `nodePinnedFetch` pinned to `127.0.0.1`: **200**, server
observes `servername === "localhost"` and `Host: localhost:<port>`. And **the
counterfactual runs for real** beside it: the rejected design
(`https.request({hostname: "127.0.0.1"})`, same server, same certificate) asserts
`ERR_TLS_CERT_ALTNAME_INVALID`. Without that second assertion the first would pass
against a transport verifying nothing.

That block is `describe.skipIf(!opensslAvailable)` and **it ran here**. An
unconditional source-invariant test backs it up where openssl is absent. Committing a
private key was refused; adding a cert-generating dependency was refused.

## Mutation: eight planted, six killed outright, two survivors reported

| mutant | outcome |
|---|---|
| M5 — the rejected design: `hostname: addresses[0]`, drop `servername` | killed, 7 tests, incl. the real handshake |
| M1 classify only `addresses[0]` · M2 loopback always OK · M3 reuse hop 0's pin · M4 drop `lookup` · M6 ignore injected resolver · M7 ignore the source key | all killed |
| **M8 — pinned lookup answers any hostname** | killed by media-inspection (4); **survived the whole 275-test provider-sdk suite** |
| **Part A's `createPinnedLookup` null-guard survivor** | **still unkilled**; M8 does not re-close it |

M8 was judged defended-rather-than-covered — the only route to a mismatch is handing
hop N's pin to hop N+1, which is M3, and M3 dies at the provider level — and a
provider-level test was **not** manufactured for it. Part A's comment recording its own
survivor was left intact.

## One Part A assertion was reversed, deliberately

A asserted provider-sdk "does not declare `@liberty/media-inspection`, which would be
the other half of a cycle". B made that fail (`expected '0.1.0' to be undefined`). The
clause after the comma was the wrong part: that edge is half a cycle only if
media-inspection depends back, and A is what stopped it doing so. It was **replaced,
not deleted**, by three precise assertions — the edge exists; media-inspection does not
depend back, read out of *its* manifest; provider-sdk imports only the `./egress` and
`./pin` subpaths, never the barrel. The old wording is kept in a comment explaining the
reversal.

# 2. PL-AI-0010, and a correction to round 52's "flake"

Round 52 recorded one unexplained failure in `stream-candidate.property.test.ts` that I
could not reproduce across ten seeds. **It was not seed-dependent.** PL-0710's part A hit
it 2-of-2 at turbo's default concurrency and characterised it: 2 cores, default
concurrency 10, the new package taking the graph from 18 test tasks to 20, and that test
measured at 5.4s and 7.4s under the graph against a **1.76s standalone cost for the whole
31-test file** and vitest's 5000ms default. `--concurrency=4` passed; 19 tasks at default
passed.

`packages/contracts` had **no `vitest.config.ts` at all**. PL-AI-0010 adds one with an
explicit `testTimeout` and the derivation written down. Nothing about the property was
weakened — run count, generators and assertions untouched.

**How far that evidence goes, because it matters:** I ran the red direction myself and
**it did not reproduce** — same tree, config removed, exit 0. So this is **not** a
demonstrated red-to-green repair. It is headroom for a suite measured to be running at
about a third of the budget it was held to. Round 52's failure is *best explained* by
this and is **not thereby proven to be it**; that item stays open.

# 3. A control-plane defect, filed rather than repaired — PL-AI-0009

`ai:release` does **not** clear `implementationBaseSha`. PL-0710 was started at
`33195d5`, released with nothing written, re-claimed at HEAD `20edec3` — and `start`
reported *"started from 33195d5"*, preserving the stale base. CLAUDE.md says the range
validator refuses a base either wider or narrower.

I did **not** hand-repair it. PL-0703 was blocked for editing a published provenance
figure and that rule holds here. **Read PL-0710's window with this in mind:** the harm is
bounded and stated — `20edec3` touches only `control/` and `coordination/` and **nothing**
under PL-0710's surface, so `base..HEAD` is one commit wider in count and identical in
reviewed-surface content.

# 4. Also created

- **PL-0308 / PL-0309 / PL-0310** — the PL-0305 follow-ups (see round 53).
- **PL-AI-0009** — the release/base defect above.
- **PL-AI-0010** — the contracts timeout, in REVIEW.

# 5. Residuals B refused to close

- **R6: provider-sdk still has no operator host allowlist** (media-inspection's
  `EgressPolicy` has one). Deriving one from the source URL would silently change
  redirect behaviour; requiring one is a product decision about source configuration.
  The agent refused to invent it. Recorded in `docs/SECURITY.md`.
- **`docs/SECURITY_REVIEW_PROVIDER_URL.md` is now stale and is not on PL-0710's
  surface.** Its register still reads `A1 … ACCEPTED — carried, and now weaker` and says
  R1 has no owner. **A1 is retired and R1 is closed** as of this change; `docs/SECURITY.md`
  records both plus the new R6. Someone with that path must reconcile the register —
  it needs a task or an owner.
- **`media-inspection/src/testing/fixtures.ts`'s `testClassifyHost`** is a fourth crude
  near-copy and already diverges from the real classifier. It is now *named as an
  exemption* in the boundary test rather than silently skipped. Replaceable now that
  net-policy is importable, but it changes what a dozen composition suites exercise.
- **No composition root wires the Stremio adapter yet** — `createStremioProvider` has no
  caller outside its own package. PL-0302 supplies `nodePinnedFetch` and a real resolver.

# 6. Gates

| command | exit | result |
|---|---|---|
| `npx turbo run typecheck --force` | 0 | 11/11 |
| `npx turbo run test --force` | 0 | 20/20, 0 cached, **2617 passed, 1 skipped** (base 2441/18 tasks) |
| `npx turbo run lint --force` | 0 | 11/11 |
| `npx turbo run build --force` | 0 | 11/11 |
| `npm run test:scripts` | 0 | 38 + 67 + 16 + 35 |
| `npm run repo:validate` | 0 | passed |
| `npm ci --dry-run` | 0 | manifests and lock agree |
| `npm run ai:validate` | 0 | 63 tasks, 9 agents |

`security-review` and `rights-review` on PL-0710 are deliberately unrecorded. They are
yours.

---

# 7. Same round, after PL-0710: PL-0308 and PL-0310

Both implemented and in REVIEW. Machine gates recorded; their judgement gates are
yours. Neither touches your branch's four files.

## PL-0308 — and it corrected me

**The gap is closed in code.** `apps/web/src/lib/server-bootstrap.ts` is the production
composition root: it builds `nodePinnedFetch` (PL-0710's transport, via the new `./http`
subpath), composes the runtime beside it, and calls `registerCatalogIngestionRuntime`.
`LIBERTY_CATALOG_SOURCE_ID` is the only signal that switches a source on; a half-set
environment gets `declaration-refused` listing every missing variable at once and
registers nothing.

**My surface correction was wrong and the implementer proved it rather than complying.**
I had moved `instrumentation.ts` to `apps/web/` believing Next reads it from the app
root. It replayed Next 16.3.1's own `findPagesDir`/`getFilesInDir` and showed
`rootDir = path.join(pagesDir || appDir, '..')` resolves to **`apps/web/src`** for a
`src/app` project — so a file at the app root is never loaded — and **refused to write
the file at my declared path**, on the ground that a file Next never loads sitting where
the wiring appears to be is worse than no file. I restored `apps/web/src/instrumentation.ts`
on that evidence, which is the bar the commander set this round for touching a removed
path. `next.config.ts` and `docs/DEPLOYMENT.md` came back **out** as proved unnecessary:
Next 16.3.1 deprecates `experimental.instrumentationHook` with *"instrumentation.js is
available by default"*, and the operator note belongs in `docs/CATALOG_SOURCE.md`.

**One thing I reverted on purpose.** The agent added `@liberty/media-inspection` to
`apps/web/package.json` — correctly: the app imports it for `nodePinnedFetch` and does
not declare it, the import resolves through the root workspace symlink, and **no gate
catches that**. But `package-lock.json`'s `packages["apps/web"]` map lacks the edge, and
**`package-lock.json` is reserved by PL-0710, which is in REVIEW**. I would not mutate a
reviewed surface, and I would not ship a manifest that disagrees with a lockfile I may
not touch — a *new* inconsistency in a tree under review is worse than the pre-existing
undeclared import. So the manifest line was reverted and both halves are **PL-0311**,
which must land them in one commit. `npm ci --dry-run` is 0 either way; npm's tolerance
of an existing link node is not a contract.

`.env.example` needs the eight `LIBERTY_CATALOG_*` variables and is held by **PL-AI-0008**,
in REVIEW since round 47. `docs/CATALOG_SOURCE.md` now tells an operator that the env
contract does not list them yet and why, so reading `.env.example` alone does not mislead.

## PL-0310 — the four states reach the user

`loadHomeCatalog` reads `describeCatalog` through `requireCatalogDescription` and carries
a cause beside the payload. A source implementing no `describeCatalog` still loads, with
the cause recorded as unstated rather than guessed.

**The withheld reasons never leave the loader** — `answer.withheld` is discarded, and a
test asserts the serialized result contains none of `rights_basis_not_declared`,
`availability_not_stated`, `Q42`, `Q7`. The copy for that case says titles exist, says
nothing is wrong with the reader's account, and then says **explicitly that nobody can
say whether they will become available** — because nobody has committed to obtaining
those rights. Every softer phrasing reinstates that commitment.

It also **deleted** *"No titles are currently available in your region"*, which asserted a
cause nothing on the home path establishes, and flagged that as a judgement call rather
than slipping it in.

Two guards beyond the ask: records that all fail `selectDeclaredItems` report
`no_records_usable`, not `catalog_empty`, because works exist; and `catalog_empty` from an
incomplete answer is downgraded to `cause_not_stated`, because a prefix cannot support
"there is nothing there".

**Not covered, and said so:** no test renders `page.tsx` — `apps/web` has no React testing
library and vitest runs `environment: "node"` with no `.test.tsx` anywhere. The copy
guarantee is enforced one level in, at the loader. The does-not-promise property is a
judgement published for you.

**API behaviour is deliberately unchanged**: both causes still serve `{rails: [], generatedAt}`
at 200. Giving the withheld case its own status is an `API_CONTRACTS.md` change — invariant
5, and that file is currently yours.

## Two now-false statements corrected rather than left

PL-0310 made two comments false, both in PL-0308's surface, and I corrected them inside
PL-0308 rather than leaving them for a reader: `catalog-source-registry.ts`'s "does not
yet ... collapses 2 into 4", and `docs/CATALOG_SOURCE.md` item 11's "Not done". Both now
say what is true, and the registry comment records that the old text *was* true when
written and why it could not be fixed then.

## Also corrected in the control plane

`apps/web/src/lib/catalog-ingestion-source.ts` added to PL-0310's `reviewDependencies` —
`requireCatalogDescription`, which the acceptance names by name, lives there and the
declaration omitted it, so the approval would have fingerprinted a surface missing the
accessor the task turns on.

## Gates after the whole wave

| command | exit | result |
|---|---|---|
| `npx turbo run typecheck --force` | 0 | 11/11 |
| `npx turbo run test --force` | 0 | 20/20, 0 cached, **2642 passed, 1 skipped** |
| `npx turbo run lint --force` | 0 | 11/11 |
| `npx turbo run build --force` | 0 | 11/11 |
| `npm run test:scripts` | 0 | 38 + 67 + 16 + 35 |
| `npm run repo:validate` | 0 | passed |
| `npm ci --dry-run` | 0 | |
| `npm run ai:validate` | 0 | 64 tasks, 9 agents |

Baseline at the start of this session was 2441 over 18 tasks. **+201 tests, +2 tasks.**

## LAST-MILE queue

Nothing this round needed owner credentials, Windows-local interaction, billing or
external authorization. The only owner-only item remains pushing these bundles.
