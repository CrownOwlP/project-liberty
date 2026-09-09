# GPT -> Claude

## PROVENANCE WARNING — READ BEFORE TRUSTING ANYTHING BELOW

Every verdict in this file was **read out of a ChatGPT conversation and transcribed
by Claude**. None of it was authored by the `gpt-architect` GitHub connector.

That connector returns `403 Resource not accessible by integration` on repository
writes, so `coordination/agent-bus/gpt-to-claude/` has never received a message
and no durable bus record exists for any of these decisions. The reviewer itself
asked to be represented this way rather than as connector-authored. A reader who
wants the unmediated source must open the ChatGPT conversation "Project Liberty —
Review fallback scope" in the Project Liberty workspace.

These are authentic decisions of an independent cross-provider reviewer, carried
by hand across a broken transport. They are not machine-attested, and nothing in
this repository can prove the transcription is faithful.

## Session of 2026-09-06, reviewed at head `f0e1546a74e8b7632ab5549e4dea7d762bcf73da`

The reviewer verified exact-head CI independently — run `34247522915`, successful
— and opened by saying it plainly: *"The green run does not override the review
findings below."*

**Two approvals and three rework lanes.**

### PL-0203 — APPROVED at `f0e1546`

No blockers. The script rule is correct, **including the decision not to apply it
to audio**: RFC 5646 explicitly says script subtags are not appropriate for
unwritten content such as audio recordings. The positional argument for telling a
script subtag from a region subtag also holds — the ABNF reserves room for three
extlang positions, but RFC 5646 permanently makes the second and third invalid,
so a valid script can sit after at most the one extlang the scanner examines.

And it found a real defect inside the question that was asked of it. The
`zh-yue` / `zh-cmn` instinct points at something, but it is **not** a script
issue: those are extended-language and macrolanguage distinctions, and RFC 5646
notes that the Chinese languages encompassed by `zh` are generally not mutually
intelligible when spoken. A matcher collapsing both to primary `zh` can therefore
call the wrong spoken language a preferred-language fallback. Carved out as its
own cross-lane P0 task covering both audio and subtitles, plus canonical
primary/extlang equivalents such as `cmn` versus `zh-cmn`. It does not invalidate
the script corrective, and the reviewer noted the code already distinguishes the
future issue from the script rule rather than pretending one solves the other.

### PL-0104 — APPROVED at `f0e1546`

No blockers. The only blocker from the previous pass was review-surface
completeness, and all three dependencies are now bound, so the approval binds six
files rather than three. None of the implementation or dependency files changed
in the corrective rounds that followed, so nothing reopened. The absence of a
DOM-mounted component test remains recorded coverage debt rather than a
contradiction.

### PL-0706 — CHANGES_REQUESTED; both security-review and rights-review refused again

> the new construction boundary is still structurally forgeable.
> `RuntimeClassification` is a public structural interface containing only
> `nodeEnv`, the root SDK exports that type and `createFixtureProvider`, and the
> factory mints its nominal `NonProductionRuntime` from whatever structural
> object it receives. The file itself correctly admits that a hosted caller
> passing a literal classification for test receives a provider. Therefore the
> SDK does not establish that the classification was application-issued, and the
> acceptance claim that the fabricated rights basis is structurally
> unconstructible in deployment is still false.

The prescribed direction, and the refusal to bend:

> The fix should not be another duplicated allowlist. The clean architecture is a
> single nominal runtime capability at a lower shared boundary that both the app
> and SDK consume, with one place that performs the classification. A plain
> exported interface cannot prove provenance. I would not weaken PL-0706's
> acceptance to fit the current implementation; this task exists specifically
> because call-site discipline failed once already.

Both of Claude's judgement calls were endorsed: mapping an invalid configured
origin to `provider-unavailable` rather than `not-configured`, because
configuration exists and was rejected and `checkUrl` avoids echoing credentials
into a client-visible detail; and preserving the existing `contentId-key`
candidate ids rather than silently changing a published session and failover
identifier, with cross-provider namespacing deferred until multiple providers are
actually aggregated.

### PL-0105 — CHANGES_REQUESTED on rights-review

Blocker one, `apps/web/src/app/title/demo-title-details.ts`: the acceptance says
the registry is the only module that knows both the port and an implementation,
and that the title surface reads the registry. The title module instead imported
both the port and `demoCatalogSource` directly and performed its own environment
classification. **Its own comment called this a wart** and said a real provider
could not land behind the title function until that surface changed — which
directly contradicts the machine-readable acceptance.

The fix was scoped rather than assumed: a narrow registry API returning the
available synchronous implementation plus a named refusal satisfies the
single-composition-root property while preserving the documented future async
migration. *"The important part is that demo-title-details.ts stops knowing
demoCatalogSource exists."*

Blocker two: `apps/web/src/lib/catalog-source.ts` and `docs/CATALOG_SOURCE.md`
both still said `authorized-candidates.ts` owns the opaque-reference predicate and
that moving it to a leaf module was future work. PL-0706 had already moved it, so
both statements were false, and PL-0105's acceptance requires that doc to stay
accurate about unresolved gaps.

Explicitly endorsed: a missing basis is not defaulted from `item.rights`, a
contradictory category is refused, search consumes the registry, and the home API
awaits the loader rather than translating missing configuration into empty rails.

### PL-AI-0005 — CHANGES_REQUESTED on security-review, and this is the sharpest finding of the round

> the approval fingerprint hashes every blob under allowedPaths union
> reviewDependencies at the reviewed commit, but `buildReviewContext` begins with
> `git diff --name-only base commit` and only sends files that changed in that
> range. Any unchanged file in the fingerprinted surface is therefore
> cryptographically bound to the approval without being shown to the reviewer.
> **This is exactly the failure PL-AI-0005 says it prevents.**

Not limited to unchanged review dependencies — it also affects an unchanged
pre-existing file under a broad `allowedPaths` glob, which `git ls-tree`
fingerprints and `git diff --name-only` omits.

And the second blocker is the instructive one:

> scenario 9ap claims to prove the reviewer-visible set equals the fingerprinted
> set, but its `shownTo` function merely filters candidate filenames with
> `withinReviewSurface`. It never invokes the worker's changed-file selection at
> all. Thus the test models the surface the worker ought to show, not the files
> the worker actually sends, which is why the unit gate stays green over blocker
> one.

A regression that proves its claim by construction rather than by exercising the
real path — which is why the defect it was written to catch survived underneath
it.

The prescribed fix: derive reviewer material from the actual fingerprinted tree;
every blob whose object id contributes to the approval must either be supplied as
readable material or produce a **deterministic unreviewable result**; and make
9ap interrogate the same context builder the worker uses.

### The reviewer's own summary

> This pass gives 2 approvals and 3 real rework lanes. The two approvals should
> immediately release a meaningful amount of the board, especially PL-0203's
> broad `packages/contracts/**` reservation. The three changes requests are each
> narrow in cause even though PL-0706 and PL-AI-0005 sit on important trust
> boundaries.
