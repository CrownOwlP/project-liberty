# Live TV — the normalization contract, and where the rights boundary sits

> PL-0601. The contract is `packages/contracts/src/domains/live.ts`, reachable as
> `@liberty/contracts/domains/live`. Read `docs/CONTENT_RIGHTS.md` first; this document is what
> that boundary looks like once it is expressed as types.

---

## The one-paragraph version

**A listing is not an entitlement.** An EPG is the largest, cheapest and least-verified body of
metadata in the system: a public grid describes thousands of broadcasts nobody has cleared, and a
schedule is routinely fetched for channels we do not carry. So rights travel with the **channel**,
which is the thing an authorization was actually established for, and the listing type has no field
capable of expressing playability. Getting a rights basis for a listing requires presenting the
channel it belongs to. This is enforced by the type, by a `.strict()` schema and by a compile-time
guard — not by a comment.

The contract normalizes XMLTV-shaped data. It **fetches nothing**, embeds **no channel list**, and
names **no feed URL**. Acquiring a schedule from an authorized provider is PL-0602 and lives behind
`@liberty/provider-sdk`.

---

## What the contract covers

| Type | XMLTV origin | What it carries |
| --- | --- | --- |
| `LiveChannel` | `<channel>` | identity, provider, display name, **the rights basis**, and descriptive metadata |
| `EpgListing` | `<programme>` | one scheduled broadcast: times, titles, categories, episode numbering |
| `EpgWindow` | — | the interval a schedule was requested for |
| `EpgSchedule` | one `<tv>` document, per channel | a channel's listings over a window, plus `generatedAt` |
| `EpgInstant` | `<programme start=…>` | an ISO-8601 **UTC** instant, exactly three fractional digits |

Plus three functions: `readXmltvTimestamp` (the only place a wire timestamp becomes an instant),
`rightsBasisForListing` (the only route from a listing to a rights basis), and `compareEpgListings`
/ `sortEpgListings` / `sortEpgSchedule` (the only ordering the contract implies).

## What it deliberately does not cover

- **Any stream, URL, manifest or playback candidate.** A channel says a broadcast exists and states
  the basis on which we may carry it. Producing a `StreamCandidate` is a provider-adapter job under
  `docs/CONTENT_RIGHTS.md`'s "prove authorization before returning candidates" rule — PL-0602.
- **A channel-level time zone.** Its absence is a decision, not an omission. It is the obvious field
  to reach for when a timestamp arrives without an offset, and reaching for it is exactly the
  inference this contract refuses. See below.
- **Regional availability, channel health, DVR/start-over flags, latency telemetry.** Listed under
  *Components* below as architecture; none of them is a normalization fact and each needs its own
  contract when the feature that consumes it exists. Pre-creating empty ones is how a package
  becomes a mutex.
- **HTTP route shapes.** `docs/API_CONTRACTS.md` gains live routes when a live route exists.
- **Listings falling inside the window, and non-overlapping listings.** Both are *not* enforced, on
  purpose. A programme that starts before the window and runs into it is the first row of every
  grid; clipping it would fabricate a start time and rejecting it would lose the row a viewer is
  currently watching. Simulcasts, corrected re-issues and regional opt-outs produce genuine overlap,
  and a contract that rejected them would push adapters into silently dropping one side.

---

## The rights boundary

**Rights are a property of the channel, and structurally cannot be a property of a listing.**

Three mechanisms, because one is not enough:

1. **The type has no such field.** `EpgListing` has no `rights`, `entitlement`, `streamUrl`,
   `playbackUrl`, `url`, `candidates`, `providerId` or `isPlayable`. There is nowhere to put the
   claim.
2. **`.strict()` rejects one that arrives anyway.** Zod's default is to *strip* an unknown key, so a
   feed sending `rights: "licensed"` would otherwise parse cleanly, lose the field, and leave nobody
   aware that a listings source had tried to make a rights claim. It is refused instead.
3. **A compile-time guard.** `EPG_LISTING_CARRIES_NO_PLAYABILITY` type-checks only while
   `keyof EpgListing` and `PLAYABILITY_BEARING_KEYS` are disjoint. The day somebody adds `rights` to
   the listing schema to make a screen easier to build, the **build** fails at the line where the
   rule is written down, next to the reasoning — not in a review that might not happen.

`LiveChannel.rights` is **required and non-nullable**, which differs from `TitleDetail`'s nullable
`titleRightsBasisSchema` and the difference is deliberate. A title detail is reachable by direct id
for anything the metadata layer knows about, including a work nobody has cleared, so it must be able
to say "no basis declared". A channel is not reachable that way: it exists in this system only
because a provider is authorized to deliver it. A channel with no basis is not an unknown channel,
it is a channel we must not have — and that state now has no representation.

`providerId` sits beside `rights` because a rights basis is not a property of a broadcast in the
abstract; it is a property of the arrangement with the party delivering it. The same channel from
two providers is two records with two independently established bases, so one provider's licence
cannot speak for another's feed.

---

## The iptv-org position

**Reuse the tooling. Never the site list as permission.**

`iptv-org/epg` is a project for downloading and generating EPG data. Its XMLTV grammar handling and
its normalization ideas are genuinely useful and this contract reuses them — the timestamp grammar
in `XMLTV_TIMESTAMP_PATTERN` is XMLTV's, and the field mapping below is the conventional one.

Its large public site list is **not** an entitlement source and is deliberately absent from this
repository. Inclusion in a third-party index is not permission from anybody, and treating it as
permission would be exactly the "scraping or resolving unauthorized streams" that
`docs/CONTENT_RIGHTS.md` forbids. Run that tooling, if at all, **only against sources Project
Liberty is independently authorized to query**.

The preferred shape is that Liberty consumes **provider-supplied or provider-authorized XMLTV** and
keeps the normalization contract its own. That is why this module exists as a contract rather than
as a dependency.

---

## The XMLTV mapping

| XMLTV | Contract | Note |
| --- | --- | --- |
| `<channel id="BBCOne.uk">` | `LiveChannel.sourceChannelId` | kept verbatim, so the join back to `<programme channel=…>` is exact |
| — | `LiveChannel.id` | our `normalizedContentId`. XMLTV ids carry dots and mixed case; ours are interpolated into routes |
| `<display-name>` | `LiveChannel.displayName` | first/primary name only |
| `<icon src=…>` | `LiveChannel.logoUrl` | `null` = not stated |
| `<programme start=…>` | `EpgListing.startsAt` | via `readXmltvTimestamp` |
| `<programme stop=…>` | `EpgListing.endsAt` | **nullable**; XMLTV makes `stop` optional |
| `<title>` | `EpgListing.title` | required, non-empty |
| `<sub-title>` | `EpgListing.episodeTitle` | `null` = not stated |
| `<desc>` | `EpgListing.description` | `null` = not stated |
| `<category>` × n | `EpgListing.categories` | `null` = not stated, `[]` = stated and empty |
| `<episode-num>` | `EpgListing.seasonNumber` / `episodeNumber` | positive integers or `null`; nothing is derived from the other |
| `<new/>`, `<previously-shown/>` | `EpgListing.isNew`, `isPreviouslyShown` | **tri-state**; see below |
| — | `EpgListing.id` | minted by the adapter; XMLTV gives a programme no identity |

**Unknown stays unknown.** Every descriptive field above is *required and nullable* — `null` must be
asserted, and an omitted key is refused. `.optional()` would make "we do not know" indistinguishable
from "nobody told me to send this", which is the same argument `packages/contracts/src/domains/playback.ts`
makes at length for the four media facts. A default would be worse: it fabricates.

**XMLTV writes `<new/>` and `<previously-shown/>` as presence, and absence is not `false`.** Most
feeds never emit either element for any programme, so reading absence as "this is a repeat" would
label an entire grid from a fact nobody stated. Three states; the UI decides what to render for the
third.

**A missing `stop` is not inferred from the next listing's start.** That is the classic EPG
normalizer bug and it fails twice over: the gap to the next entry is only the duration if the grid
is gapless — grids have gaps, off-air blocks and overlapping regional variants — and the inference
makes the parsed value depend on the order the entries were processed in, so the same feed
normalizes differently depending on how it was chunked.

---

## Time, and why an offset-less timestamp is refused

XMLTV writes `20260824193000 +0100`: local wall time, then an explicit UTC offset. **The offset is
what makes the first half mean anything, and real feeds routinely omit it.**

`readXmltvTimestamp` refuses an offset-less timestamp with its own reason, `missing_offset`,
distinct from `malformed_timestamp` and `impossible_calendar_date` because the three have three
different remedies: chase the provider, fix the ingest, distrust the generator.

It is refused rather than localised because every available zone is a guess:

- **the server's zone** — the worst option and the usual one. It makes the normalized schedule a
  function of which machine ran the ingest, so the same feed yields different instants in CI, in a
  container and on a developer's laptop. Non-determinism injected at the boundary, invisible until
  two of them disagree in production.
- **the viewer's zone** — shifts the broadcaster's grid by the viewer's travel, so a programme
  changes time when the user gets on a plane.
- **the channel's country** — not a fact the contract has (`countryCode` is itself nullable), not
  unique for countries spanning several zones, and not the same thing as the zone the *feed* was
  written in.

A guessed offset is worse than a dropped listing in the specific way that matters: it is wrong by a
whole number of hours, it is wrong silently, and around a DST transition it is wrong twice a year in
a way that looks like a provider outage. A dropped listing leaves a visible hole in the grid, and a
hole is a bug report.

A refusal is **returned, not thrown** — one unparseable timestamp in a twelve-hour grid should cost
that listing, not the ingest, and a caller that has to `catch` to find out is a caller that will
eventually catch and continue with a fabricated value.

**Instants are fixed-width on purpose.** `EpgInstant` requires exactly three fractional digits, which
fixes the width at 24 characters, and at fixed width code-point order *is* chronological order —
which is what makes the comparator below a real total order rather than a sort that happens to work.
With variable precision it silently is not: `"…:00Z"` and `"…:00.5Z"` differ by half a second, but
`.` (U+002E) sorts before `Z` (U+005A), so the shorter spelling compares as *later*. `toISOString()`
already emits precisely this form.

---

## Determinism

**Any ordering the contract implies is total, and a schedule is stable under permutation of its
input.** `compareEpgListings` uses three keys, each a strict tiebreak on the last:

1. `startsAt`, by code point — chronological, because the width is fixed. Not `Date.parse` (which
   re-derives a number the string already determines) and not `localeCompare` (which would make the
   order a function of the machine's environment).
2. `endsAt`, with **`null` sorting last**. The placement is arbitrary and therefore has to be
   *stated*; an unstated one is a coin flip each implementation makes separately. Last, because a
   listing with no known end is the least specific claim about the slot.
3. `id`, by code point — the key that makes the order total.

`EpgSchedule` requires listing ids to be **distinct**, and that refinement is the precondition for
(3). Without it, two simulcast entries sharing a start and an end are incomparable,
`Array.prototype.sort`'s tie handling decides between them, and the result is a function of input
order — the defect class this repository has now hit six times.

`EpgSchedule` also requires every listing to name **that schedule's own channel**, so a schedule
that mixes channels cannot exist and no caller can read an entry against the wrong channel's rights.

`sortEpgSchedule` exists so the ordering is applied in one place. A grid that sorts in the component,
a route handler that sorts in the handler and a cache that stores unsorted are three implementations
of the same rule, and they will disagree about `null` end times first.

---

## Components (architecture, unchanged)

Live TV is supported only for licensed/authorized channel feeds.

- channel catalog normalization — **PL-0601, this contract**;
- EPG ingestion — **PL-0601 defines the shape; PL-0602 acquires it**;
- provider health and regional availability;
- playback candidate resolution;
- start-over/DVR capability flags where rights permit;
- failover among authorized feeds;
- latency telemetry.

## Data freshness

EPG and channel-health jobs should be asynchronous. The web request path reads normalized state and
performs only lightweight authorization/resolution.

---

## Packaging note

`@liberty/contracts` declares a **wildcard** subpath export (`"./domains/*"` →
`"./src/domains/*.ts"`), so `@liberty/contracts/domains/live` resolves the moment the file exists.
Adding this contract required **no change to `package.json` and no change to the root barrel**. That
is deliberate: `src/index.ts` is a compatibility barrel, not the authoritative public surface, and a
new domain contract that had to be appended to it would make the barrel the new global mutex that
`packages/contracts/**` path ownership used to be.
