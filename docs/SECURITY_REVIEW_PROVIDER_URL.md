# PL-0702 — Provider and URL security review

**Task** PL-0702 · **Lane** Security · **Owner** `claude-security` · **Review** `gpt-architect`
**Base** `97011e71008fe69445845debb879534895cdc754` (`codex/pl-ai-0001-repair`)
**Date** 2026-09-17

This is the findings register PL-0702's acceptance requires. It is organised by the
five named classes; within each class it states **what was examined and by what
method**, so that "no finding" can be told apart from "not looked for", and then
lists the findings with their dispositions.

**This round executed things.** The previous round's review record in
`docs/SECURITY.md` says in terms that "nothing was executed: no test, typecheck or
build was run for this review, so every claim below is from reading." That was an
honest limit and it is the one this round set out to remove. Every claim below is
labelled with the method behind it, and where the method is still *reading alone*
it says so in those words rather than borrowing credibility from the tests that
cover something else.

Findings from the previous round are `F1`–`F6`, `A1`–`A4` and `R1`–`R5`; they are
in `docs/SECURITY.md` and are not restated here except where this round re-checked
or changed them. This round's new findings continue the numbering at **F7**.

---

## Summary

| ID | Class | Severity | Disposition |
|----|-------|----------|-------------|
| **F7** | SSRF · allowlist enforcement | **High** | **RESOLVED** (red→green recorded) |
| **F8** | SSRF · allowlist enforcement | **Medium** | **RESOLVED** (red→green recorded) |
| **F9** | Secret exposure (reflection/log amplification) | **Low** | **RESOLVED** (red→green recorded) |
| **F10** | SSRF-adjacent · unbounded request body | Medium | **ACCEPTED-FOLLOW-UP** → PL-0707 |
| **F11** | Reflection (`R5`, now measured) | Low | **ACCEPTED-FOLLOW-UP** → PL-0708 |
| **F12** | Allowlist enforcement (fail-closed inconsistency) | Informational | **ACCEPTED-FOLLOW-UP** → PL-0709 |
| **A5** | SSRF (no port restriction) | Informational | **ACCEPTED** |
| **A6** | SSRF (bodyless size cap) | Informational | **ACCEPTED** |
| **A7** | SSRF (translation prefixes not exhaustive) | Low | **ACCEPTED** |
| **A1** | SSRF (host literal, not resolved address) | Medium | **ACCEPTED — carried, and now weaker** |

Nothing in this round fell into `OPEN-ESCALATED`: no finding here turns on a
credential, a licence, a budget or an irreversible production change, which are
reserved to the human commander by `control/policies.json` `escalation.humanOnly`.
The items that *would* have — anything needing a live provider credential, and the
desktop sidecar trust boundary — are listed under **Out of scope** and were not
dispositioned at all rather than being quietly accepted.

---

## Class 1 — SSRF

### What was examined

Every path in the surface by which an input can reach an outbound socket.

- `packages/provider-sdk/src/stremio/http.ts` — `fetchJson`, the **only** call to
  `fetch` anywhere in this repository's non-test code. Verified by search, not
  assumed: `grep -rn "fetch(" --include=*.ts apps/web/src packages/*/src` excluding
  tests returns exactly one hit, `client.ts:381`, which is the injection point that
  defaults to `globalThis.fetch` and is consumed only by `fetchJson`.
- `packages/provider-sdk/src/stremio/url-policy.ts` — `checkUrl` and `classifyHost`,
  the gate `fetchJson` consults before every hop and the mapper consults before
  publishing a stream URL.
- `packages/provider-sdk/src/stremio/client.ts` — how the manifest and `/stream`
  URLs are built (`encodeURIComponent` on both path segments, then re-checked by
  `fetchJson` regardless).
- `packages/provider-sdk/src/stremio/mapping.ts` — `mapStremioStream`, where an
  addon-supplied `stream.url` becomes a candidate.
- `packages/provider-sdk/src/fixture/provider.ts` — `LIBERTY_FIXTURE_MEDIA_ORIGIN`
  reaches `checkUrl` before it becomes a playable URI.
- `apps/web/src/app/api/v1/playback/session/issue-session.ts` — `checkUrl` on
  `source.uri` immediately before publication.
- `apps/web/src/app/api/v1/playback/session/authorized-candidates.ts` —
  `originIsLoopback`, which derives the `allowLoopback` flag from `classifyHost`.

### By what method

1. **Reading**, for the call-graph and the ordering claims above.
2. **A differential probe, executed.** A throwaway vitest file drove `checkUrl`
   over 29 hostile host spellings — trailing-dot FQDNs, percent- and case-folded
   names, IDN/punycode, decimal/octal/hex IPv4, IPv4-mapped and IPv4-compatible
   IPv6, NAT64, 6to4, IPv4-translated, userinfo, and non-default ports — and
   printed the verdict and the parsed hostname for each. This is what produced F7
   and F8; both are invisible to a reading pass, because the defect is a
   *difference between what `new URL()` returns and what the comparisons below it
   expect*, and reading the comparisons does not reveal it.
3. **A `fetchJson` probe, executed**, driving the real redirect loop with a fake
   `fetch` returning `302` to each hostile `Location` (see Class 3).
4. **Regression tests, kept**, in `packages/provider-sdk/src/stremio/url-policy.test.ts`
   and `apps/web/src/app/api/v1/playback/session/issue-session.test.ts`.

### Findings

---

#### F7 — A fully qualified hostname (trailing root label) bypassed the private-host allowlist *and* the loopback gate. **High. RESOLVED.**

**The defect.** `classifyHost` decides everything by comparing the hostname
`new URL()` produced against string literals: `=== "localhost"`,
`.endsWith(".localhost")`, and `.endsWith(suffix)` over `PRIVATE_HOST_SUFFIXES`
(`.local`, `.internal`, `.intranet`, `.lan`, `.corp`, `.private`, `.home.arpa`).

The WHATWG URL parser **normalises a trailing dot away from an IP literal and
keeps it on a domain**:

```
new URL("https://127.0.0.1./").hostname               === "127.0.0.1"
new URL("https://metadata.google.internal./").hostname === "metadata.google.internal."
new URL("https://localhost./").hostname                === "localhost."
```

The trailing dot is the DNS root label. It means "this name is fully qualified";
every resolver treats `metadata.google.internal.` and `metadata.google.internal`
as the same name. None of the comparisons in `classifyHost` did. Each dotted
spelling matched no IPv4 branch, no numeric branch, no loopback name and no private
suffix, and fell out of the bottom as **`"public"`** — the one answer that opens a
socket.

Measured against the pre-fix tree:

| URL | Pre-fix verdict |
|-----|-----------------|
| `https://metadata.google.internal./computeMetadata/v1/` | **ALLOWED** (`public`) |
| `https://vault.corp./v1/secret` | **ALLOWED** (`public`) |
| `https://nas.local./media.mp4` | **ALLOWED** (`public`) |
| `https://host.lan./`, `https://x.home.arpa./` | **ALLOWED** (`public`) |
| `https://localhost.:9200/_search` | **ALLOWED** (`public`) |

**Why the loopback row is the worst one.** For a private-suffix name, `"public"`
merely skips a refusal. For `localhost.`, `"public"` means the host **never reaches
the loopback branch at all** — so the two independently-owned permissions that
branch exists to demand (`allowLoopback` from the source, `localDeployment` from
the process) were *never consulted*. `url-policy.ts` argues at length that neither
owner may grant loopback alone; a trailing dot meant neither was asked. On a hosted
instance, `127.0.0.1` is the Liberty server's own admin, metrics and database
ports, which is precisely the exposure that design prevents.

**Reachability — this is not a latent classifier nit.** Three separate paths feed
`checkUrl` a host a third party chose: a `stream.url` an addon returns
(`mapping.ts`), a `Location:` header an addon sends (`http.ts`, every hop), and
`source.uri` at the moment of publication (`issue-session.ts`). Driving the real
session boundary against the pre-fix tree with `localDeployment: false` — the
hosted configuration — **all four hostile URIs were published to the client** as
`session.candidates[].uri`:

```
expected [ 'fqdn-corp', 'fqdn-loopback', 'fqdn-metadata', 'nat64', 'good' ]
      to deeply equal [ 'good' ]
```

That is the failure message from the regression test run against the pre-fix
source. It is also the reason this is filed under SSRF *and* under rights bypass:
the candidate reaching a client is the rights-bypass shape, and the server
following the same URL on a redirect is the SSRF shape.

**The fix.** `packages/provider-sdk/src/stremio/url-policy.ts` — `classifyHost`
strips the DNS root label **before any comparison runs**, via a new
`withoutRootLabel` helper. An empty label (`"."`, or `"nas.local.."`) is refused as
`unparseable` rather than repaired, for the same reason the file already refuses an
unbracketed IPv6 literal: repairing a broken input invents a name on the caller's
behalf.

Stripping is a **narrowing, not a widening**, and that is why it is done here while
the unbracketed-IPv6 precondition three lines below is *refused* instead. Removing
the root label can only move a host from `public` into `loopback` or `private`.
There is no name it admits that the parser did not already admit.

**Regression, and the red→green observation.**
`packages/provider-sdk/src/stremio/url-policy.test.ts` — four tests at the
classifier and four at the gate (including two redirect-target tests), plus
`apps/web/src/app/api/v1/playback/session/issue-session.test.ts` — one test at the
session boundary.

- **RED.** With the tests in place and `url-policy.ts` restored to its `HEAD`
  content (`git show HEAD:… > …`), `npx vitest run src/stremio/url-policy.test.ts`
  reported **7 failed | 25 passed (32)** — the 7 failures being exactly the new
  tests (F7's and F8's), and all 25 pre-existing tests still green, which is what
  makes the red attributable to the fix rather than to the edit.
  `expected 'public' to be 'private'`, `expected 'ok' to be 'url_private_address'`,
  `expected 'ok' to be 'url_loopback_not_permitted'`.
  The session-boundary test failed separately with **1 failed | 20 passed (21)** and
  the candidate-list message quoted above.
- **GREEN.** With the fix restored, `32 passed (32)` and `21 passed (21)`.

---

#### F8 — IPv6 translation prefixes carrying a private IPv4 address classified as public. **Medium. RESOLVED.**

**The defect.** `classifyIPv6` unwraps IPv4-mapped (`::ffff:a.b.c.d`) and
IPv4-compatible (`::a.b.c.d`) addresses and classifies the IPv4 address they carry
— the file is explicit that `[::ffff:a00:1]` must be caught by the same 10/8 rule
that catches `10.0.0.1`. It detects both by testing that the **first five groups are
zero**. Three standard prefixes embed an IPv4 address *without* that zero prefix,
matched none of the `fc00::/7`, `fe80::/10` or `ff00::/8` masks below, and came out
`"public"` while naming a private address:

| Spelling | Address it carries | Pre-fix verdict |
|----------|--------------------|-----------------|
| `[64:ff9b::a9fe:a9fe]` | 169.254.169.254 (cloud metadata) | **public** |
| `[64:ff9b::a00:1]` | 10.0.0.1 | **public** |
| `[2002:a00:1::]` | 10.0.0.1 (6to4) | **public** |
| `[::ffff:0:a00:1]` | 10.0.0.1 (IPv4-translated) | **public** |

`64:ff9b::/96` is the NAT64 well-known prefix (RFC 6052 §2.1). On any network with
a NAT64 gateway — which is every IPv6-only network that still reaches IPv4 —
`[64:ff9b::a9fe:a9fe]` *is* 169.254.169.254, reached by a translation the sender
does not have to arrange. `2002::/16` is 6to4 (RFC 3056), deprecated by RFC 7526
and still forwarded by stacks that implemented it. `::ffff:0:0/96` is the
IPv4-translated form (RFC 2765 SIIT) — the mapped spelling with a zero group wedged
in, which is exactly why the zero-prefix test missed it.

Severity is Medium rather than High because exploitation needs a translating
gateway on the path, which F7's does not.

**The fix.** A new `embeddedIPv4` helper in `classifyIPv6` returns the IPv4 address
a translation prefix carries, and the result is handed to `classifyIPv4`. This is
**strictly correct rather than merely stricter**: a 6to4 address wrapping 8.8.8.8
still classifies `public`, because the same question is asked about the same
address. A test asserts that explicitly, so a later reader cannot mistake the
change for a ban on the prefixes.

**Not covered, and stated in the code so the list is not read as exhaustive:**
RFC 8215's local-use NAT64 prefixes (`64:ff9b:1::/48`), where the embedded address
sits at a different offset for each legal prefix length, and any network-specific
translation prefix an operator chooses. Both are decidable only with configuration
a pure function does not have. See **A7**.

**Regression, and the red→green observation.** Same file and same run as F7;
the two tests are `sees the IPv4 address inside a translation prefix` and
`does not over-reach: a translation prefix wrapping a public address stays public`.
Against the pre-fix source the first failed with `expected 'public' to be 'private'`
and the second **passed** — which is the useful half of the pair, because it shows
the fix did not buy its result by refusing the prefixes wholesale. The redirect
test `refuses a redirect into an IPv4 address wearing a translation prefix` failed
with `expected true to be false`. Green after the fix.

---

### Verified with no finding (SSRF)

Each of these was checked **by execution** via the differential probe and the
`fetchJson` probe, not by reading:

- Decimal, octal and hex IPv4 spellings (`2130706433`, `0177.0.0.1`, `0x7f.0.0.1`,
  `127.1`) are normalised by the parser and refused.
- IPv4-mapped and IPv4-compatible IPv6 are refused (`[::ffff:10.0.0.1]` →
  `url_private_address`).
- `fd00::/8`, `fe80::/10`, `::1`, `[::]`, `0.0.0.0`, CGNAT, multicast, reserved and
  the three TEST-NET ranges are refused.
- Percent-encoded and case-folded spellings (`foo%2elocal`, `FOO.LOCAL`) are folded
  by the parser *before* `classifyHost` sees them, and are refused.
- Userinfo (`https://good.example.com@evil.test/`) is refused as
  `url_credentials_present` before the host is classified.
- `magnet:`, `file:`, `data:`, `ftp:`, `ws:` are refused at both the policy and the
  mapping layer.
- Outbound requests carry `credentials: "omit"`; there is no ambient-credential
  path.
- `encodeURIComponent` on both `/stream` path segments, plus `isSafeSegment` as a
  second narrower fence, plus `fetchJson`'s unconditional re-check.

---

## Class 2 — Secret exposure

### What was examined

Whether a provider credential, a token, or an environment value can reach a
response body, a log line, a URL, a client bundle, or an error message.

- Every `process.env` read under the surface.
- Every string-building function that copies untrusted input into a `detail`,
  a `reason`, or an error: `describeError`, `describeOrigin`, `describeUnparseable`
  and `truncate` in `provider-sdk`; `describeThrown` in
  `apps/web/src/lib/db/request-context.ts` (read-only, out of surface);
  `issueReason`/`orderedRequestReasons` in `issue-session.ts`.
- The two routes that serialise raw Zod issues into a response body:
  `session/handler.ts` (500) and `resolve/handler.ts` (400).
- Client-bundle exposure.

### By what method

1. **Search, executed.** `grep -rn "process\.env" packages/provider-sdk/src apps/web/src/app/api`
   excluding tests returns exactly **two** live reads:
   `LIBERTY_FIXTURE_MEDIA_ORIGIN` (`authorized-candidates.ts:187`) and
   `LIBERTY_PLAYBACK_BACKEND_ORIGIN` (`playback-session-implementation.desktop.ts:210`).
   Neither is a credential; both are origins, and both are validated before use
   (the first through `checkUrl`, the second through a local `https`-only,
   no-userinfo check). Every other match is prose in a comment.
   `grep -rn "NEXT_PUBLIC" apps/web/src packages/*/src` returns **nothing**, so no
   value is marked for the client bundle at all.
2. **An executed probe of Zod's issue serialisation**, because the two routes above
   put `parsed.error.issues` straight into a response body and the question "does a
   Zod issue carry the value it rejected?" is a fact about the installed version,
   not something to reason about. Against **zod 4.4.3**, eight issue shapes were
   built with a secret-bearing input and the serialised issues searched for it:

   | Issue code | Echoes the input? |
   |---|---|
   | `unrecognized_keys` | **yes — the key NAMES** (not values) |
   | `invalid_type`, `invalid_value` (literal), `invalid_value` (enum), `too_small`, `custom` (refine), `invalid_union`, `invalid_format` (regex) | no |

   `input` is stripped from the finalised issue in every case tested. The two
   response schemas are plain `z.object`, not `.strict()`, so `unrecognized_keys`
   **cannot occur on the response path** — which is what makes the 500 body in
   `session/handler.ts` safe, and it is safe for a reason nobody had checked rather
   than by design.
3. **Reading**, for the redaction functions.
4. **An executed measurement** of the one place the `unrecognized_keys` echo does
   occur, which is F9.

### Findings

---

#### F9 — Refused request-field names were reflected verbatim and unbounded into the reason trail. **Low. RESOLVED.**

**The defect.** `playbackSessionRequestSchema` is `.strict()`, so a body carrying an
unexpected property produces an `unrecognized_keys` issue, and `issueReason` built
its detail as `[...issue.keys].sort(compareCodePoint).join(", ")` — every key name
the client chose, at full length, with no cap on the count.

`PlaybackSessionReason.detail` is returned in the 400 body **and** carried into the
structured reason trail, and from there into logs and dashboards. Neither this
endpoint nor the envelope in front of it caps the request body (see **F10**), so
the result is a 1:1 amplifier a client can aim at our own log storage with one
request.

**Measured, against the pre-fix tree**, by driving `handlePlaybackSessionRequest`
with a real `Request`:

```
requestBytes=172     status=400 code=request_field_not_permitted detailChars=70
requestBytes=100162  status=400 code=request_field_not_permitted detailChars=100060
```

A single 100 KiB property name produced a 100,060-character `detail`.

This is **exactly the class F5 fixed on the outbound side**, where an
addon-chosen hostname is now capped at 64 characters before it reaches the same
trail. The inbound side had no equivalent. The finding is the asymmetry, not a new
threat: the two boundaries that copy a hostile string into a reason should agree
about how much of one they repeat, and now do.

Severity is Low, deliberately: this reflects a caller's own input back to that
caller, so it is log volume and not disclosure. It is recorded rather than waved
through because "it is only reflected to the attacker" stops being true the moment
the trail is shipped to a shared log sink, which is what the trail exists for.

**The fix.** `apps/web/src/app/api/v1/playback/session/issue-session.ts` — a new
`describeRefusedKeys` caps each name at 64 characters (matching `checkUrl`'s
hostname cap, so the two boundaries agree by construction rather than by
coincidence) and names at most 8, stating the count of the rest.

It **caps rather than redacts**, and that is the design constraint: an unrecognised
key is the one validation failure this endpoint treats as a *rights* event — a
client sending `uri` or `playbackUrl` to the session route is the thing
`request_field_not_permitted` exists to make visible — so a reason that refused to
say which field would make that event unreadable. The withheld count is stated
rather than silently dropped, so the message never understates what the request
contained.

**Regression, and the red→green observation.** Two tests in
`apps/web/src/app/api/v1/playback/session/issue-session.test.ts`. The first is
deliberately **two-sided** — an upper bound alone would be satisfied by dropping
the names entirely, which would destroy the diagnostic — so it asserts both
`detail.length < 300` and that `playbackUrl` is still named. The second asserts the
withheld count is truthful.

- **RED**, against `issue-session.ts` restored to `HEAD`:
  `2 failed | 21 passed (23)`,
  `→ expected 100073 to be less than 300` and
  `→ expected 'the request carries field(s) this end…' not to contain 'extra08'`.
- **GREEN**, with the fix: `23 passed`, and the whole session directory
  `5 passed (5) / 116 passed (116)`.

---

### Verified with no finding (secret exposure)

- **No provider credential exists in this system yet**, so there is nothing for a
  leak to carry. Every finding in this class is scoped to that fact, and none of it
  should be read as a decision that these paths are safe once one lands. Anything
  requiring a real credential is **out of scope** (PL-0302, PL-0602) and listed as
  such below.
- `describeError` (`http.ts`) names an error by `type` plus a runtime error code
  matched against `/^[A-Z][A-Z0-9_]{0,31}$/`, never by message — so a `fetch`
  implementation's URL-bearing message and `JSON.parse`'s document slice are both
  dropped. *Method: reading.*
- `describeOrigin` reduces a URL to its origin, dropping path, query and fragment.
  `describeUnparseable` names the scheme (capped at 16) and a character count,
  never the string. *Method: reading.*
- `describeThrown` (out of surface, read-only) publishes the thrown value's `name`
  only, with an explicit note that a driver error can carry connection details.
  *Method: reading.*
- The 500 body in `session/handler.ts` and `progress/handler.ts` cannot carry the
  validated object. *Method: the executed Zod probe above.* This is the one claim
  in this class that reading would have got wrong in either direction.
- No `NEXT_PUBLIC_*` value exists. *Method: search.*

---

## Class 3 — Redirect handling

### What was examined

`fetchJson` in `packages/provider-sdk/src/stremio/http.ts` — the only redirect-
following code in the repository — and `decidePlaybackSession` in
`playback-session-implementation.desktop.ts`, which is the other place a redirect
could be followed.

### By what method

**Executed.** A throwaway vitest file drove the real `fetchJson` loop with an
injected `fetch` that answers `302` with a chosen `Location`, and printed the
outcome for each. This exercises the actual hop loop — the `REDIRECT_STATUSES`
test, the `Location` read, the base-relative resolution, the re-check, and the hop
counter — rather than the gate in isolation.

| `Location:` | Outcome |
|---|---|
| `https://metadata.google.internal./v1/` | `url_private_address` |
| `https://localhost.:9200/_search` | `url_loopback_not_permitted` |
| `https://[64:ff9b::a9fe:a9fe]/meta` | `url_private_address` |
| `http://169.254.169.254/` | `url_private_address` |
| `file:///etc/passwd` | `url_scheme_not_http` |
| `https://user:pw@evil.test/` | `url_credentials_present` |
| `/relative/path` (public base) | followed, then `too_many_redirects` |
| self-referential chain | `too_many_redirects` |

The first three rows are **post-fix**; against the pre-fix tree the first two were
followed, which is F7 reaching the network rather than merely reaching a candidate
list. Two of these are kept as permanent regressions in `url-policy.test.ts`.

### Findings

**None new.** The redirect design is sound and the execution confirms it:
`redirect: "manual"`, every hop re-validated through the same `checkUrl`, a
relative `Location` resolved against the URL that *issued* it (so it cannot be
misread as a bare hostname), the chain capped at `DEFAULT_MAX_REDIRECTS = 2`, and
the whole operation — redirects and body read included — under one `AbortController`
deadline rather than a per-request timeout that three redirects would defeat.

The desktop forwarding implementation sets `redirect: "error"`, which is the
correct choice there and stronger than following: it forwards `cookie` and
`authorization` headers, and a followed redirect is how those reach a host the
operator did not configure.

**What F7 and F8 mean for this class, stated plainly:** the redirect *machinery*
was never the defect. It re-validated every hop exactly as designed, and then
consulted a classifier that returned the wrong answer. A review that had looked at
the redirect loop alone would have passed this class, correctly, and missed both
findings. That is the argument for the differential probe in Class 1.

---

## Class 4 — Allowlist enforcement

### What was examined

Whether the URL/host allowlist is enforced on **every** path that fetches or
publishes, and whether it is enforced **after** any normalisation that could change
the host.

- The three feeds into `checkUrl`: configured manifest URL (`source.ts`), every
  redirect target (`http.ts`), every addon-returned stream URL (`mapping.ts`).
- The publication-time check in `issue-session.ts`.
- `originIsLoopback` in `authorized-candidates.ts`.
- The out-of-surface second gate: `hostOnAllowlist` and `checkUrlStatically` in
  `packages/media-inspection/src/egress.ts`.

### By what method

1. **Reading**, to establish that every feed reaches the gate — there is no
   `fetch` that bypasses `fetchJson`, and `fetchJson` re-checks `rawUrl` itself
   rather than trusting its callers.
2. **Executed**, for the normalisation-ordering question, which is the one this
   class is really about and the one that produced **F7**.

### Findings

**F7 and F8 are findings of this class as much as of Class 1**, and this is where
the "after normalization" half of the question earns its place in the acceptance
criteria. The enforcement was present on every path. The *normalisation* was the
problem: `new URL()` produced a hostname whose spelling the comparisons did not
anticipate, and every gate on every path consulted the same wrong answer. An
allowlist checked in six places against a host string the parser spells differently
than the list does is an allowlist checked zero times.

The fix is placed accordingly — in `classifyHost`, ahead of every comparison — so
all six call sites are corrected at once and none of them can drift.

---

#### F12 — `hostOnAllowlist` does not fold the root label. **Informational. ACCEPTED-FOLLOW-UP → PL-0709.**

`packages/media-inspection/src/egress.ts:387`. `hostOnAllowlist` case-folds and
trims but compares the hostname as given, so `cdn.example.com.` does not match an
entry of `cdn.example.com`, and does not match a suffix entry of `.example.com`
either.

**This fails CLOSED and is not a bypass** — the dotted spelling is *refused*, not
admitted — which is why it is Informational rather than a finding of the same
severity as F7. It is recorded because it is the same root-label inconsistency
seen from the other side, and because a reader who fixes F7 and assumes the whole
repository now folds the root label would be wrong.

- **File and line:** `packages/media-inspection/src/egress.ts:387`.
- **Why it matters:** two spellings of one host get two answers from one allowlist.
  Today that costs an availability edge case; if this function is ever reused
  anywhere the result is an *admission* rather than a refusal, it becomes F7.
- **Why not fixed here:** `packages/media-inspection` is outside PL-0702's
  `allowedPaths`, and PL-0206 holds an adjacent surface in REVIEW. Writing there
  would corrupt another task's review.
- **Owner:** whichever task owns `packages/media-inspection/**`. Needs a
  control-plane task; none currently covers it.

### Verified with no finding (allowlist enforcement)

- `checkUrlStatically` (out of surface) makes **no host decision of its own** — it
  delegates entirely to an injected `HostClassifier`. Where `provider-sdk`'s
  `classifyHost` is the injected value, F7 and F8 are fixed there transitively by
  this round's change. *Stated precisely because it is easy to overclaim:* a search
  for `classifyHost` outside `provider-sdk` shows the port is supplied by **test
  files only** today. There is no production wiring of the media-inspection egress
  gate yet, so "fixed transitively" describes the wiring that will exist, not one
  that does. *Method: search plus reading.*
- The protocol allowlist is consulted rather than decorative: `https:` only,
  `http:` only for a literal loopback host, refused at both the policy and the
  mapping layer. *Method: the executed differential probe.*
- A source configuration cannot grant itself `localDeployment`; `defineStremioSource`
  refuses the key loudly rather than ignoring it. *Method: reading, plus the
  existing suite.*


- **Deferral accepted by `gpt-architect`**, round 46, at
  `bbfaa5a997e6ee146271f26e5b2546b7e67e47d2`.
  - **Follow-up task:** **PL-0709** — *Egress host classification folds the DNS root
    label*. Surface `packages/media-inspection/**`.
  - **Why not fixed here:** `packages/media-inspection` is outside PL-0702's surface,
    and PL-0206 held that area in review while this work ran.
  - **Residual risk until PL-0709 lands:** **none of the bypass kind.** This path fails
    **closed** — the dotted spelling is refused, not admitted — so the exposure is a
    legitimate host being rejected, not a hostile one being reached. The real risk is
    second-order and is why it was filed at all: two classifiers that disagree about
    what a host is will eventually be reconciled by someone copying the wrong one.
    PL-0709 therefore requires a shared table of hostile spellings that both must
    agree on, so the next divergence fails a test instead of waiting for a review.

---

## Class 5 — Rights bypass

### What was examined

Whether playback resolution can be reached without the authorization decision, and
whether an unauthorized candidate can reach a client.

- `issue-session.ts` — the gate order: shape → resolution → **rights** → identity →
  eligibility → transport.
- `source.ts` — `defineStremioSource`, the rights declaration and its coherence
  check against `RIGHTS_BASES_FOR_RIGHTS`.
- `mapping.ts` — `mapStremioStream`'s rights re-check and its refusal of
  `proxyHeaders`, `infoHash`, `sources`, `magnet:`, `ytId` and `externalUrl`.
- `resolve/handler.ts` — the client-supplied-candidate scaffold and its 404 gate.
- `authorized-candidates.ts` — `NonDeploymentEnvironment` as a construction
  capability rather than a boolean.
- The request contract: whether any field can become a URL.

### By what method

1. **Executed**, against the resolve scaffold, driving `handlePlaybackResolveRequest`
   with real `Request` objects:

   | Payload | Status | Echoes the smuggled URL? |
   |---|---|---|
   | hosted (`available: false`) | **404** `route_not_available` | — |
   | clean candidate | 200 | no |
   | `uri` added **inside** a candidate | 200 | **no** — Zod strips it |
   | `uri` added at the **top level** | 200 | **no** |
   | candidate with `rights: "unlicensed"` | **400** — refused at the schema, never ranked | no |
   | 101 candidates | **413** `too_many_candidates` | — |

   This confirms by execution what `e2e/tests/rights-boundary.api.spec.ts` asserts
   from outside the process, and it closes the specific gap `R5` identified in that
   spec: `R5` observed that the e2e test smuggles its URL into an *extra key*, which
   Zod strips, so it passes without exercising a field that would echo one. The
   probe above tried both placements and neither is echoed.

2. **Executed**, against the session boundary: the F7 regression test drives
   `issuePlaybackSession` with hostile `source.uri` values and asserts the
   response is `granted` with the good candidate **and** that each bad one is
   dropped with its specific reason. Asserting a `granted` response rather than an
   `unavailable` one is deliberate: a gate that refused everything would also make
   an assertion about absence pass.

3. **Reading**, for the gate *ordering* argument — that rights precede identity, and
   that step 3 is separate from `rankStreamCandidates`'s own rights check so an
   unrightsed candidate is never handed to the engine at all. The existing suites
   (`issue-session.test.ts`, `issue-session.property.test.ts`) cover this; this
   round did not add to them.

### Findings

---

#### F7, again — an unauthorized candidate DID reach the client. **Cross-filed.**

Recorded under Class 1 with its fix and its red→green observation. It is
cross-filed here because the pre-fix failure message is a rights-bypass observation
in its own right: against the pre-fix tree the session endpoint published
`metadata.google.internal.`, `vault.corp.`, `localhost.:9200` and a NAT64 metadata
address to the client as playable `session.candidates[].uri` values. The transport
gate is the last gate before a URI becomes something a player fetches, and it was
answering `ok`.

---

#### F11 — The resolve scaffold reflects caller-supplied candidate strings verbatim, unbounded. **Low. ACCEPTED-FOLLOW-UP → PL-0708.**

This is the previous round's **R5**, re-checked and now **measured** rather than
inferred. `streamCandidateSchema.id` and `.providerId` are `z.string().min(1)` with
no upper bound and no charset restriction, and `rankStreamCandidates` copies the
whole candidate into `ranked[].candidate` and the id into `rejected[].candidateId`.

Measured: a request carrying one candidate with a **1,000,000-character `id`**
produced a **2,002,555-byte response** — a 2× amplification, because the id appears
in both the ranked entry and the reason trail.

- **File and line:** `packages/contracts/src/domains/playback.ts:233–237`
  (`playbackResolveRequestSchema`) and the `streamCandidateSchema` it references.
- **Why it matters:** an unbounded attacker-chosen string landing in a reason
  trail, and from there in logs. Same class as F5 and F9, and the last member of it
  still open.
- **Severity Low** because the route answers **404 in a hosted deployment** (F2's
  gate, confirmed by the probe above) and confers no rights on anything real.
- **Why not fixed here:** `packages/contracts` is outside PL-0702's `allowedPaths`.
  The bound belongs on the schema, beside F3's `.max()` on `candidates`, not on a
  third route-level pre-check.
- **Owner:** whichever task owns `packages/contracts/**`. Still needs a
  control-plane task; the previous round recorded it as an open follow-up and
  nothing has picked it up.


- **Deferral accepted by `gpt-architect`**, round 46, at
  `bbfaa5a997e6ee146271f26e5b2546b7e67e47d2`.
  - **Follow-up task:** **PL-0708** — *Stream candidate fields carry length bounds*.
    Surface `packages/contracts/src/domains/playback.ts`.
  - **Why not fixed here:** the bound belongs in `streamCandidateSchema`, in
    `packages/contracts`, which PL-0702 does not own and which is reserved by tasks in
    review. Capping at the route instead would have put the bound one route away from
    being forgotten, and would have left the contract still accepting the value.
  - **Residual risk until PL-0708 lands:** measured 2× amplification — a
    1,000,000-character `id` produced a 2,002,555-byte response — reaching logs through
    the reason trail. Bounded in practice today by F10's absence being the larger
    quantity: whoever can send a huge candidate can already send a huge body, so
    PL-0707 caps the outer envelope and PL-0708 caps the inner field. **Neither
    substitutes for the other**, because a body under the envelope cap can still carry
    one very long id.

---

#### F10 — The production-reachable session route reads an unbounded request body. **Medium. ACCEPTED-FOLLOW-UP → PL-0707.**

`decidePlaybackSession` calls `await request.json()` with no size check
(`apps/web/src/app/api/v1/playback/session/playback-session-implementation.ts:76`),
and `handler.ts` in front of it adds none. The **development-only** resolve scaffold
beside it enforces `MAX_REQUEST_BYTES = 1_048_576` from `content-length`
(`resolve/handler.ts:161`); the route that actually ships in a hosted deployment
enforces nothing. That asymmetry is the finding — the cap is on the endpoint that
cannot be reached in production and absent from the one that can.

It is also what makes F9 an amplifier rather than a bounded nuisance: F9's cap
bounds what is *reflected*, not what is *read*.

- **Files:** `apps/web/src/app/api/v1/playback/session/playback-session-implementation.ts:76`
  (web target), `…/playback-session-implementation.desktop.ts:254` (desktop target,
  `request.text()`), `…/handler.ts` (the shared envelope, which is where a cap
  belongs so both targets get it).
- **Why it is OPEN rather than RESOLVED, and this is the part worth reviewing.**
  The files above are all *inside* PL-0702's `allowedPaths`, and I could have
  written a cap into `handler.ts` today. I did not, because **refusing an oversized
  body requires a response this endpoint's contract cannot express.** The response
  union is `granted | denied | unavailable`, every branch carries `reasons`, and
  `playbackSessionReasonCodeSchema` has no code meaning "too large". Adding one
  means changing `contract.ts` *and* `docs/API_CONTRACTS.md`, and
  `docs/API_CONTRACTS.md` is **not** in this task's `allowedPaths`. Invariant 5 says
  API behaviour matches that document *or the contract changes intentionally
  first* — so shipping a new status from this route while the document still
  describes the old set would be the invariant violation, not the fix.
  Forcing it into an existing code (`request_malformed`) would be worse: it would
  report a size refusal as a shape refusal, in the one trail that exists to explain
  decisions accurately.
- **Owner:** a task holding `apps/web/src/app/api/v1/playback/session/**` **and**
  `docs/API_CONTRACTS.md` together. No such task exists. **Needs a control-plane
  task** — and it should own both paths at once, for the same reason the previous
  round gave for not deleting the resolve scaffold piecemeal.
- **Interim mitigation, stated so the gap is not overstated:** F9 bounds the
  largest *reflection* a big body can buy, and any deployment behind a proxy with
  a body limit is covered by that limit. Neither is a control this repository owns.


- **Deferral accepted by `gpt-architect`**, round 46, reviewing PL-0702 at
  `bbfaa5a997e6ee146271f26e5b2546b7e67e47d2`. The reviewer's direction was to create
  the follow-up task rather than absorb the work into PL-0702, and explicitly *not*
  to mark this RESOLVED.
  - **Follow-up task:** **PL-0707** — *Playback session route refuses an oversized
    request body*. Surface `apps/web/src/app/api/**` **and** `docs/API_CONTRACTS.md`,
    which is the pairing PL-0702 could not hold and is the whole reason this is a
    separate task.
  - **Why not fixed here:** a size refusal needs a reason code the contract does not
    have. Adding one changes API behaviour, and invariant 5 requires
    `docs/API_CONTRACTS.md` to change with it; that path was outside PL-0702's
    surface. Reusing `request_malformed` was rejected as worse than leaving it open —
    it would report a size refusal as a shape refusal in the one trail that exists to
    explain decisions accurately.
  - **Residual risk until PL-0707 lands:** a hosted deployment will buffer an
    arbitrarily large body on the production session route before any validation runs.
    Memory, not confidentiality: no attacker-controlled value crosses a trust boundary
    from this. It is reachable without authentication, so treat it as an availability
    exposure and not a latent SSRF.

---

### Verified with no finding (rights bypass)

- **No request field on the session route can become a URL.** The request is
  `{ contentId, capabilities }`, both `.strict()`, and `contentId` is
  `normalizedContentIdSchema` rather than a free string. The server resolves; the
  client names. *Method: reading plus the executed smuggling probe on the sibling
  route.*
- Rights are settled **before** identity, eligibility, scoring and transport, and
  an unrightsed candidate is never handed to the ranking engine at all. *Method:
  reading; the existing `issue-session` suites cover it and this round added
  nothing here.*
- Rights are operator-declared per source, re-checked at the source gate
  (`defineStremioSource`), at the provider constructor and at the mapper, and are
  never read or inferred from anything an addon returns. `proxyHeaders` is refused
  loudly as an access control this adapter will not work around. *Method: reading.*
- The fixture provider cannot be constructed in a deployment: it requires a
  `NonDeploymentEnvironment` capability, branded with a `unique symbol` private to
  `@liberty/contracts/shared/runtime` and checked against an issuance registry, so
  a cast or a spread copy is refused at runtime. *Method: reading.*
- The resolve scaffold answers **404** in a hosted deployment. *Method: executed.*

---

## Accepted risks

All four below are accepted by **`claude-security`**, the implementing agent for
PL-0702, and each is reversible. **None touches credentials, licensing, budget or an
irreversible production change** — those are reserved to the human commander by
`control/policies.json` `escalation.humanOnly`, and nothing in this round fell into
them. `A1`–`A4` from the previous round remain in `docs/SECURITY.md`; only `A1` is
restated here, because F7 and F8 changed what it means.

**A1 — the outbound URL policy validates the host LITERAL, not the resolved
address. Medium. ACCEPTED, carried forward, and now weaker than when it was
written.**
A public name with a private `A` record, and a name that answers differently
between check and connect (DNS rebinding), both still pass. *Residual risk:* full
SSRF into the operator's network for any attacker who controls a DNS name the
adapter is pointed at. *Condition of acceptance, unchanged:* it holds only while
this is a controlled adapter aimed at a small set of operator-fixed endpoints
reviewable at configuration time. **What F7 and F8 change:** they are the second and
third demonstrations that host-*string* checking is a brittle control — the first
was the unbracketed-IPv6 precondition (F1). Three defects of the same shape in one
function is evidence about the approach, not about the author. *Why it is still
accepted rather than escalated:* the remedy (`authoriseFetchTarget` in
`@liberty/media-inspection`, which resolves the name and classifies every answer)
exists in this repository and is not adopted by this adapter, and adopting it is a
change to `provider-sdk`'s dependency graph that is a task of its own, not a line
in a review. **R1 now has an owner: `gpt-architect` directed in round 46 that
resolve-and-pin adoption be filed as a dedicated P0 task and made a prerequisite of
PL-0302, first production provider, on the ground that host-literal checking is not
sufficient once real production provider and network access arrives. That task is
**PL-0710** — *Provider outbound HTTP resolves, classifies and pins its destination*.
It does not block PL-0502 or local fixture playback. The paragraph below is preserved
as it was written, before the task existed.** R1 in `docs/SECURITY.md` records that this work has no owner and
needs a control-plane task. That remains the single most important open item on
this surface, and it is now more urgent than it was this morning.**

**A5 — no port restriction on a public host. Informational. ACCEPTED.**
`checkUrl` admits any port on an admitted host. *Reason:* the host is the control;
a port allowlist would refuse legitimate CDN and addon deployments on non-443
ports while stopping nothing, since an attacker who controls an admitted host
controls its ports too. *Residual risk:* an admitted host can be probed on any
port over TLS. Bounded by the host decision, which is the decision that matters.

**A6 — `readBounded`'s bodyless path measures the size after reading. Informational.
ACCEPTED.**
When `response.body` is absent, `http.ts` calls `await response.text()` and *then*
compares the size to the cap, so the cap is reported rather than enforced.
*Reason:* Node 18+ `undici` supplies a body stream for every response that has one,
so this path is reached by test doubles and by 204/304 responses, not by a hostile
addon. The streaming meter above it is the actual control and it is enforced.
*Residual risk:* an exotic `fetch` implementation without `body` would make the cap
advisory. Already documented at the call site; noted here so the acceptance is
attributable.

**A7 — the translation-prefix list added by F8 is not exhaustive. Low. ACCEPTED.**
RFC 8215 local-use NAT64 prefixes (`64:ff9b:1::/48`) and any network-specific
translation prefix an operator configures are not decoded. *Reason:* the embedded
address sits at a different offset for each of the five legal prefix lengths, and
which prefix a network uses is configuration a pure function does not have.
Guessing an offset would produce confident wrong answers, which is worse than a
stated gap. *Residual risk:* on a network using a local-use NAT64 prefix, a private
IPv4 address can still be spelled as an IPv6 literal that classifies `public`.
*The real remedy is A1's:* resolve-and-pin classifies the address the resolver
returns rather than a spelling of one, and is immune to this whole family. Recorded
in the code at the site of the fix so the list is not read as complete.

---

## Out of scope — listed, not silently skipped

- **Anything requiring a real licensed provider or live credentials** —
  **PL-0302**, **PL-0602**. No provider credential exists in this system today, so
  the secret-exposure class above is scoped to a system with nothing to leak. When
  a credential lands, the whole class needs re-running: in particular
  `IDENTITY_HEADERS` forwarding in the desktop implementation, and any signing key
  that would make a playback URL a bearer token.
- **The desktop sidecar trust boundary** — ruled on in **PL-0901**, reviewed under
  **PL-0501**, and recorded in `docs/DESKTOP_PLAYBACK.md` §8. Not re-litigated.
  Observed in passing and **not dispositioned**: `backendOrigin` in
  `playback-session-implementation.desktop.ts` requires `https:` and no userinfo
  but does not classify the host, and `await response.json()` on the backend's
  answer is unbounded. Both sit inside the boundary §8 already ruled on, and both
  belong to whoever revisits that ruling.
- **`packages/media-engine`** — stream-candidate ranking, held by **PL-0206**,
  currently in REVIEW. Not read for findings and not written to.
- **Authentication and authorization on API routes** — none exists yet (`R4`).
  Every finding above is scoped to a system with no identity layer, and nothing
  here should be read as a decision that these routes are safe left anonymous.
- **Rate limiting** — `docs/SECURITY.md` lists it as a control and it is
  unimplemented (`R2`). Its home is request middleware, outside this task's
  `allowedPaths`.

---

## What changed in this round

| File | Change |
|---|---|
| `packages/provider-sdk/src/stremio/url-policy.ts` | F7: `withoutRootLabel`, applied ahead of every comparison in `classifyHost`. F8: `embeddedIPv4`, consulted in `classifyIPv6`. |
| `packages/provider-sdk/src/stremio/url-policy.test.ts` | +8 tests (4 classifier, 4 gate/redirect). |
| `apps/web/src/app/api/v1/playback/session/issue-session.ts` | F9: `describeRefusedKeys`, replacing the unbounded `join`. |
| `apps/web/src/app/api/v1/playback/session/issue-session.test.ts` | +3 tests (1 transport boundary, 2 reflection bound). |
| `docs/SECURITY.md` | Review record updated to point here and to carry F7–F12. |
| `docs/SECURITY_REVIEW_PROVIDER_URL.md` | This register. |

No behaviour outside the three defects changed. No route was added or removed, no
contract was altered, no dependency was added, and nothing in
`packages/media-engine`, `packages/contracts`, `packages/media-inspection`,
`apps/web/src/app/watch` or `e2e/` was touched.

## Repository verification

Run from the repository root, `--force` on both so a cached pass cannot stand in
for this tree.

| Command | Exit | Result |
|---|---|---|
| `npx turbo run typecheck --force` | **0** | 10/10 tasks, 0 cached |
| `npx turbo run test --force` | **0** | 118 files, **2329 passed, 1 skipped** |

Baseline at `97011e71`, before this round's changes: typecheck **0**, test **0**,
118 files, **2318 passed, 1 skipped**. The delta is **+11**, which is exactly the
11 regression tests listed above: `@liberty/provider-sdk` 213 → 221, `@liberty/web`
813 → 816.

`ai:gate` was **not** run by this agent. Gate results for `security-review` and
`rights-review` are the lead's to record, per the task briefing and invariant 8.
