# Claude → gpt-architect — round 89

**Two tasks are in REVIEW from this round.** PW-0302 at `9af012e` (artwork), and
PW-0401 at `8e8c3bf` (the authenticated playback backend). PW-0102 is untouched
and still in REVIEW at `d4997f2`, per your instruction.

- PW-0302: `typecheck`, `unit` recorded PASS. Open: `architecture-review`,
  `security-review`, `rights-review`.
- PW-0401: `typecheck`, `unit`, `e2e` recorded PASS. Open:
  `architecture-review`, `security-review`.

Board: **73/99 (74%)**, BACKLOG 16 / READY 5 / REVIEW 3 / BLOCKED 2 / DONE 73 /
SUPERSEDED 4. Nothing about that number changed this round: neither task is DONE.

**PW-0305 was skipped deliberately and the board records why** — see §6. It is
the only remaining dispatchable task, and it is waiting on PW-0302's review
rather than on anything I could do about it.

**The branch is not pushed.** `git push` to `CrownOwlP/project-liberty` is
refused 403 by this container's git proxy ("not in this session's authorized
repository set"), exactly as in rounds 81–88. Commits `9af012e`, `52f47d2` and
`8e8c3bf` sit on the local branch; the bundle is the delivery path.

---

## 0. Two disclosures, first

**An accidental control-plane event.** I ran
`ai-control-plane.mjs event --help` to read the subcommand's usage. `event`
takes its first positional as the event TYPE and has no help flag, so it
recorded an event of type `--help` with an empty message at
`2026-09-27T01:53:01.271Z`. **I left it in the log** and wrote a
`control_plane.operator_error` event immediately after saying exactly what it is
and why it was not deleted: a log that gets edited when the mistake is small is
not evidence when the mistake is large. It carries no taskId, no agent and no
claim.

**One unreproduced test transient.** The first `npm run test` of this round
reported `@liberty/web#test` failed while printing no failing assertion. Two
later runs — one of them `turbo run test --force` with an empty cache — both
passed 1152/1152 at exit 0. I could not reproduce it and it left nothing in the
log to fix, so the `unit` gate evidence records it as an unreproduced transient
rather than pretending it did not happen. My best guess is memory pressure under
turbo's parallelism, which is the same class of thing that SIGKILLed the suite in
round 8x before `target/` was excluded from fixture copies; I have not proved it.

**I cannot see PW-0102's Windows CI from here.** `gh` is not installed in this
container and there is no other path to the run's logs. So PW-0102 is exactly
where you left it: REVIEW, `build` FAIL, unchanged since `d4997f2`. If that job
has finished, its result is yours to read.

---

## 1. PW-0302 — what the acceptance asked, and what each clause got

### The surface was extended first, then taken

Recorded as `task.definition_changed` **before any file was written**, the
procedure you required for PW-0102 in round 88. The declared four paths could
declare a vocabulary and configure an image loader; they could not contain the
vocabulary (contracts keeps leaf vocabularies in `src/shared`, and a domain
module declaring one would be the second `rights.ts`), the boundary (a route
handler), the rendering site (the only poster in browse is a div in
`catalog-card.tsx`), the adoption requirement (`artworkRefSchema` lives in
`catalog-ingestion`), or any artwork data at all. Ten entries added, each derived
from a named clause, conflicts checked in both directions per entry — every
overlap is a task in a terminal state or PL-0302/PL-0602, both BLOCKED on the
provider access this task does not have. **Two entries were declined**:
`app/globals.css`, which PW-0310 holds and which the repository's own CSS-module
precedent makes unnecessary, and `title-hero.tsx`, which is named below as not
done rather than smuggled in. **Two entries came back out at the end** because
they went unused.

### The vocabulary: `packages/contracts/src/shared/artwork.ts`

A leaf beside `rights` and `ids`. `role`, `assetRef`, `width`, `height`,
`rights`. **There is no url, uri, src, href or origin field in it**, and a test
asserts that absence over the module's own source with a non-vacuity check,
because that module's prose names all five words in order to forbid them.

`ARTWORK_ASSET_REF_PATTERN` is the old ingestion pattern, moved. What it excludes
is the contract: no `:` so no scheme, no `/` or `\` so no host and no path, no
`.` so no traversal and no filename, no `%` so nothing that decodes into those
later, no uppercase so two references cannot collide on a case-insensitive
filesystem — which is most Windows installs of this product. The useful
consequence is that **concatenating a reference onto the store directory is
confined to that directory as a property of the character class**, not as a check
somebody performs. Twelve real spellings of an image address are asserted
refused, including two `data:` URLs and the protocol-relative form, which are the
cases a "must not start with http" check lets through.

### Adoption, and the one place the two vocabularies differ

`packages/catalog-ingestion/src/record.ts` now **imports** `artworkRoleSchema`
and `artworkAssetRefSchema` rather than spelling them. Nothing it accepts
changed. What it does **not** adopt is `artworkReferenceSchema`, because the
compositions genuinely differ in one field: the ingestion record carries
`ingestedRightsBasisSchema` — category **and** the opaque pointer into the
operator's rights register — while the browse schema carries
`contentRightsSchema` alone. The register handle is internal bookkeeping and the
browse payload already carries only the category for the work itself; publishing
it for the image would make artwork the one field through which a client learns
about the register. **Both modules state the divergence and why**, so neither can
be changed believing the other agreed.

`project.ts` still drops artwork on the way to `CatalogItem`. It is outside this
surface, and I am naming it rather than reaching for it: **ingested artwork is
still ingested and not delivered.** The fixtures are what fill the field today.

### `artwork` is optional, and I want you to push on this

It is the one field in these two shapes that is **not** "required and explicitly
nullable", which is this repository's stated rule and one I have defended in
three previous rounds. The argument for the exception: ten modules construct a
`CatalogItem` today — the demo fixtures, the Wikidata adapter, the Stremio addon
shape, the recommendation views, the ingestion projection and five test suites —
and **not one has an artwork concept.** A required key hands every one of them
the same non-choice: write `artwork: null`, which asserts "this source looked and
found none", or `artwork: []`, which asserts it more strongly. Both are claims
those producers cannot support. **A required key whose only honest value is a
fabrication is the defect the required-nullable rule exists to prevent, arriving
through the front door.** The three states are real and each has a producer that
means it: absent (states nothing), `[]` (knows, and there is none), non-empty.
`typecheck` passing with none of those ten producers edited is the compatibility
claim, checked rather than asserted.

If you disagree, the alternative is a repo-wide edit whose entire content is
`artwork: null` in ten modules, and I would rather you rule on that than have me
choose it.

### The boundary: `GET /api/v1/artwork/{assetRef}`

**It is not a proxy and cannot quietly become one.** It holds no HTTP client,
constructs no URL and knows no host: it reads one file from one operator
directory named by `LIBERTY_ARTWORK_STORE`, which must be absolute. So
`docs/SECURITY.md`'s "never proxy arbitrary client-provided URLs" is **satisfied
by absence rather than by a check** — there is no address for a caller to
influence. A source rule asserts the module contains no `fetch(`, no `new URL`
and no `http(s)://` literal, so the next person who adds "just a small upstream
fetch" fails a test rather than passing review.

**I deliberately did not build the upstream-CDN case.** There is no licensed
provider; building the transport allowlist, fetch client, redirect policy and
upstream failure vocabulary would be machinery for a boundary nothing can cross,
and it is the moment "no arbitrary URL proxy" stops being a property and becomes
a rule somebody maintains. The module states that **when a real provider arrives
the honest shape is a second store kind behind this same boundary, with its own
allowlist and its own review — not a URL field on a payload.** If you want the
remote case designed now, say so; I have not pretended it is out of scope, only
that it is unbuildable honestly today.

**The content type is read from the file's header bytes, not from its
extension.** A `.png` holding JPEG bytes is served as `image/jpeg`, because that
response is true and a naming mistake should not break a page. A file holding
something that is not one of four raster formats is **refused**, which is what
keeps an SVG, an HTML document or an executable unservable from this origin
whatever it was named. **SVG is not on the allowlist**: it is a document, it can
carry script, and serving one here would be stored XSS on the product's own
domain.

**A store holding two files for one reference is reported, not resolved.** Both
silent resolutions are wrong in a way nobody notices — a fixed extension order
serves AVIF to a browser that cannot decode it, and `Accept`-based selection
makes this a content negotiator with a cache-key problem.

**The size cap refuses from `stat`, before any bytes are read.** The test proves
the ordering by making the fake's `read()` throw if it is reached.

**Authorization — please rule on this explicitly.** It is *operator*-authorized:
only references whose bytes an operator placed in the store resolve. It is
**not** user-authorized, and I chose that rather than omitted it. Artwork
illustrates catalog metadata, `GET /api/v1/catalog/home` requires no session, and
a poster behind a gate the payload naming it does not have would produce a
signed-out browse page of broken images while protecting nothing — the metadata
was already served. The rule is written as a **relationship, not a constant**:
*this endpoint is exactly as open as the catalog surface that names its
references*, it inherits a session requirement in the same change if that surface
gains one, and an unguessable reference is explicitly not treated as protection
in the meantime. If you want it behind PW-0403's session today, that is a small
change and I would rather make it on your ruling than argue the point into the
code.

Eight refusal codes, 400/404/500/503, each with a human-readable `detail`, and
**never an empty body** — an image endpoint is where that rule is most tempting
to break, because the `<img>` will not read the body. The body is for the
operator with `curl` trying to find out why the posters are gradients. Assets
cache (`public, max-age=3600`); refusals never do. **That cache header is the one
documented exception to `docs/API_CONTRACTS.md`'s blanket `no-store`, and the
doc now records it as an exception rather than leaving the contract false.**

### The UI, and which of the two the acceptance asked about

You asked whether the "only the controlled origin" property is structural or a
maintained check. **It is structural, and there is a stated invariant beside it.**

Structural: no payload in this product has a field that can carry an image
address, and the single function that turns a reference into a URL —
`artworkPathFor`, which lives beside the handler that serves it — returns a
**relative** path with no scheme and no authority. Two independent reasons an
arbitrary host is unreachable.

Stated invariant: `images.remotePatterns` is `[]` and `images.localPatterns` is
narrowed from the framework default of *every path on this origin* to this
boundary's prefix with `search: ""`, plus `dangerouslyAllowSVG: false`. That
covers `next/image`, **which this task does not use** — and that is the reason to
set it: it is the obvious thing for the next person to reach for, and its
defaults are permissive in exactly those two directions. Asserted for **both**
build targets, because a guard present only in the web build would be absent from
the one that ships on Windows.

`PosterArtwork` replaces the card's gradient div with **the same div plus an
image**, so the global `.poster` class and its `:nth-child` hues stay on the
wrapper and the gradient sits **behind** the image. An image that has not arrived
— or that 404s because the store does not hold it — leaves the designed fallback
showing, and `alt=""` is what stops a broken-image icon appearing over it. The
absent case renders byte-for-byte what every card rendered before this round, so
**a checkout with no artwork store is the previous design intact, not a degraded
version of this one.**

A plain `img`, not `next/image`, argued in the module: the optimizer adds a
refetch, a re-encode and a native `sharp` dependency **inside the desktop
standalone build** to buy layout stability the reference's own dimensions already
provide, and a boundary whose whole argument is that it does not fetch things
should not acquire a component that fetches things. The ESLint rule is disabled
at the element with that reason, not repo-wide; I verified the directive is
neither vacuous (removing it reports the rule) nor stale
(`--report-unused-disable-directives` reports nothing with it in place).

The poster stays `aria-hidden` and stays out of the link. `catalog-card.tsx` now
records that as a **decision** rather than a description, because it used to be
trivially true and an image is the sort of thing people reflexively give an
`alt`: an `alt` here would repeat the title that is already the link's accessible
name, or describe artwork nobody has described.

---

## 2. Evidence from a running server, not only from unit tests

Built with `next build` and served with `next start`, plus a `next dev` instance
for the fixture-gated catalog:

- `GET /api/v1/artwork/aurora-fall-poster` → **200**, `content-type: image/png`,
  `content-length: 25060`, `cache-control: public, max-age=3600`,
  `x-content-type-options: nosniff`,
  `content-security-policy: default-src 'none'; sandbox`,
  `cross-origin-resource-policy: same-origin`. `cmp` against the file on disk:
  **identical**. `file`: `PNG image data, 400 x 600` — matching the `width` and
  `height` the reference declares.
- `no-such-poster` → **404** `artwork_not_found`. `..%2f..%2fetc%2fpasswd`,
  `Aurora`, `a.b` → **400** `artwork_reference_malformed`. A literal `../../../../etc/passwd`
  never reaches the handler at all. `POST` → **405**.
- A server with the variable unset → **503** `artwork_store_not_configured`,
  `cache-control: no-store`, naming the variable. A server with it set to a
  relative path → **503** `artwork_store_not_absolute`.
- `GET /api/v1/catalog/home` carries
  `"artwork":[{"role":"poster","assetRef":"deep-current-poster","width":400,"height":600,"rights":"owned"}]`
  — **an opaque reference, no URL anywhere in the payload.**
- The home page renders
  `<img class="…" src="/api/v1/artwork/deep-current-poster" alt="" width="400" height="600" loading="lazy" decoding="async"/>`
  inside `class="poster …frame"`.
- The image optimizer: `?url=https%3A%2F%2Fexample.com%2Fa.png` → **400**;
  `?url=%2Fapi%2Fv1%2Fcatalog%2Fhome` → **400**;
  `?url=%2Fapi%2Fv1%2Fartwork%2Fdeep-current-poster` → **200**.

---

## 3. The fixtures, stated plainly

`apps/web/fixtures/artwork/` holds six PNGs and the committed script that
generates them. They are two-colour gradients whose hue is a hash of their own
asset reference: no photograph, no typography, no logo, no likeness. Their README
says, in those words, that **they are not this product's artwork and nothing may
present them as such** — Liberty has no licensed artwork provider and this
directory does not change that. They exist so the path can be exercised end to
end on a machine with no provider instead of being typed and never run. The six
works are original to this repository and the images are generated by a program
in it, so the `owned` basis with a `null` register reference is true of both.

If you would rather this repository ship no image bytes at all, say so and I will
remove them; the contract, the boundary and the component all stand without them,
and the cost is that every observation in §2 becomes unreproducible.

---

## 4. What I did not do, named rather than left to be found

- **The title page's hero does not render artwork.** `TitleDetail` carries the
  field. The hero has no poster slot, so rendering there is a `.hero` layout
  change in `app/globals.css` — held by PW-0310 — plus `title.module.css` and its
  style test. Follow-up, and I would rather it be PW-0310's or a new task's than
  a reason to take a file I declined for good reasons.
- **`project.ts` does not project artwork.** Ingested artwork is still dropped.
- **`episode-list.tsx`'s posters are still gradients.** Episode summaries carry
  no artwork field.
- **No `backdrop` or `still` is rendered anywhere.** The roles exist in the
  vocabulary because the role is what a surface selects on; only `poster` has a
  surface today.

---

## 5. PW-0401 — the authenticated playback backend

**`apps/backend` exists as a service.** §8's forwarder has existed since
PL-0501; the thing it forwarded *to* existed only as
`e2e/src/backend-stub.mjs`.

### Two steps, and the order is the security property

Authenticate the caller **from headers alone** — the body is still an unconsumed
stream — then hand the **untouched** request to the application's own
`handlePlaybackSessionRequest`. So the acceptance's *"a refusal that does not
leak whether a content id exists"* is not a thing that was written carefully; it
is a thing that cannot happen, because at the moment the refusal is produced no
content id has been read. `request.bodyUsed` is asserted `false`, and the 401 is
asserted **byte-identical** across a real id, an invented id, a malformed id, a
body with no id, a non-JSON string and an empty body.

Authentication is `resolveRequestAccount` — the same function the profile,
progress and watchlist routes use — **imported, not reimplemented**, so this
service and the application agree about who a caller is because they run the
same code against the same database. Statuses are
`request-context.ts`'s: 401 / 503 / 400, not new ones.

### FORK 1 — I import the decision from `@liberty/web`, and you should rule on it

The acceptance requires the contract byte for byte, and `backend-stub.mjs`
already argues the general case in its own header: a counterparty that
reimplemented the decision *"would be a second opinion about it"*. So there must
be **one** implementation. Today it lives in
`apps/web/src/app/api/v1/playback/session/`, and this service reaches it through
a narrow `exports` subpath on `@liberty/web`. That makes the equivalence
**structural** — `session-endpoint.test.ts` asserts the success path returns the
decision's own `Response` **object**, which is "byte for byte" as an identity
check rather than a comparison.

**The correct home for that decision is a package of its own, and PW-0401 is the
second caller — normally the exact event that triggers the extraction. I did not
take it, for a security reason rather than an effort one.**

`apps/web/src/app/api/v1/playback/build-target.test.ts` is what proves §8's
central property. **Its walker follows relative specifiers only** — a
non-relative specifier is recorded as a package name and not walked into.
Extracting the resolver behind `@liberty/playback-resolution` would put
`@liberty/provider-sdk` and `@liberty/media-engine` on the far side of a boundary
that walker does not cross. The desktop assertion would still pass, **for the
wrong reason**, and the suite's own non-vacuity assertion — that the *web* graph
**does** reach those two, which exists precisely so a walker that resolved
nothing cannot look like an absence — would fail or have to be weakened. Turning
a real absence into an unobserved one, in the guard for the §8 ruling, is not a
price I will pay for tidier layering inside a backend task.

The honest prerequisite is **teaching that walker to follow workspace
packages**, which would make the guard *stronger* than it is today (it currently
cannot see inside any package boundary). That belongs to whoever owns the guard.
If you rule for the extraction, this service changes by three import specifiers
and nothing else.

What it costs meanwhile, stated: a service depending on the web application's
package is a layering inversion. `apps/web/package.json` gains **only** an
`exports` map — no script, no dependency, no source file.

### FORK 2 — a signed-out desktop viewer cannot be told they are signed out

`playbackSessionReasonCodeSchema` is a **closed** vocabulary with no
authentication member, and the status in that contract is derived from the
**outcome** alone, so there is no shape in it that means 401. The forwarder
validates every backend body against that schema and turns anything else into an
honest `unavailable`.

So this service's refusal bodies are deliberately **not** contract members —
they reach an operator with `curl` and a log, never a parsing client — and the
cost is real: a signed-out desktop viewer sees "unavailable" rather than "sign
in".

**I did not fix it here.** Invariant 5 says the contract changes intentionally
first, and that change is `contract.ts` + the status derivation +
`docs/API_CONTRACTS.md` together — a surface far wider than `apps/backend/**`,
and one whose bodies the cross-target suite compares byte for byte. It is
*exactly* the change you approved deliberately in PW-0403 for the
request-context vocabulary, where the ruling was **"do not collapse these
states"**. I am proposing it as a task rather than making it unilaterally from a
task that does not own the contract.

### Witnessed against a real PostgreSQL, not only in unit tests

PostgreSQL 16 initdb'd in this container on port 5433 and migrated with the
repository's own `0000_profile_scoped_identity.sql`. A witness account created
and signed in through `apps/web`'s own `/api/auth/sign-in/email` on an
independent production server; that cookie then used against the backend running
as a **separate process** in `NODE_ENV=production`:

- no cookie → **401** `not_authenticated`
- that cookie → `{"outcome":"unavailable","reasons":[{"code":"provider_not_configured",…}]}` at
  **503** — the acceptance's *"deployable and testable WITHOUT a licensed
  provider"*, in the contract's own shape
- `DELETE FROM session`, same cookie → **401 on the very next request** —
  PL-0401's database sessions and the declined `cookieCache` holding on this
  side of the boundary
- a forged cookie → 401, byte-identical to the first
- a forged `x-liberty-development-account` against the deployment → never an
  identity
- the 401 body identical across `aurora-fall`, `invented-title`, `zzz`
- separately, in a development runtime: a real **granted** session for
  `aurora-fall` with three ranked candidates and the full reason trail — the
  application's own decision, running here

It **refuses to start** with no transport stated, because the forwarder refuses
any non-`https` origin and an absent certificate quietly meaning cleartext would
ship a viewer's session cookie across a network in the clear. It **does** start
with no identity store and no provider, which the acceptance requires.

### What PW-0401 did not do

- **The e2e harness is not rewired onto this service.** The desktop specs
  witness that the forwarder forwarded by reading the stub's `/__requests`
  ledger of every request it received, headers included — and a production
  backend must not have that ledger. Pointing the harness here is not a
  configuration change; it needs a different way to witness forwarding, and
  `e2e/**` is outside this task's paths. The `e2e` gate is therefore regression
  evidence (61/12 production, 70/3 development, **unchanged** from rounds 82–89),
  which is the right evidence for the one edit outside a new workspace: adding
  an `exports` field to a package that had none is exactly the change that can
  silently break resolution for everything importing it.
- **No provider was added.** There is none to add; PL-0302 stays separate.

### One defect the tests found rather than confirmed

`Number("1e3")` is 1000 and `Number("0x10")` is 16, both integers in range — so
the first `LIBERTY_BACKEND_PORT` parser would have listened on a port the
operator did not type. It now requires decimal digits.

---

## 6. PW-0305 is skipped, and the board records why

Three of its four REQUIRED clauses are reachable from its declared surface plus
`app/page.tsx`. The fourth — *"a progress indicator on cards for partially
watched titles"* — names the **cards**, and the only card in the browse surface
is `catalog-card.tsx`, **which PW-0302 holds and which is in REVIEW awaiting
you**.

What I did **not** do about it: build a second card component under
`components/continue-watching/**` with its own progress bar (two hand-maintained
renderings of one thing, which is the defect `demo-catalog.ts` derives its rails
to avoid); widen PW-0305 into a file an active task holds; or `release` PW-0302
to free the file, which discards gate results and would destroy this round's
recorded evidence to save a sequencing wait.

**PW-0305 becomes dispatchable the moment PW-0302 leaves REVIEW in either
direction.** If you would rather the indicator live only on the
continue-watching rail's own cards — a defensible reading of that clause — say
so and the dependency disappears.

---

## 7. Where the board stands

Every remaining task is waiting on one of the three reviews or on a lane whose
capacity those reviews hold. PW-0305 is blocked on PW-0302 (§6). PW-0312,
PW-0304 and PW-0309 are all `claude-frontend`, whose capacity PW-0302 occupies
while it sits in REVIEW. PW-0104 now overlaps PW-0401 on
`apps/web/package.json`. PL-0302 and PL-0602 remain BLOCKED on licensed provider
and live-feed access.

So the useful things to send back, in the order that unblocks the most:

1. **PW-0302** — approve or send back. Either frees `catalog-card.tsx` and the
   frontend lane.
2. **PW-0401's two forks** — ruling on the layering inversion and on whether the
   playback reason vocabulary gains an authentication member.
3. **PW-0102** — its Windows job's result, which I cannot read from here.

Three follow-ups are proposed rather than taken, and none of them is work I have
started:

- **Teach `build-target.test.ts`'s walker to follow workspace packages**, which
  is the prerequisite for extracting the playback decision into a package and
  would make the §8 guard stronger than it is today.
- **Add an authentication member to the playback reason vocabulary**, the same
  change PW-0403 made for request-context, so a signed-out desktop viewer can be
  told to sign in.
- **Render artwork on the title hero**, which needs `app/globals.css` and so
  belongs with PW-0310 or a task of its own.
