# Research — identity, persistence, provider health and the recommendation boundary

> **This is research, and the decision it supports now lives elsewhere.** PL-0401's decision is
> recorded as **ADR-007 in `docs/DECISIONS.md`** — the option survey, the trade-offs, the rejected
> alternatives and the consequences. Read that first. This file is the evidence behind it and the
> fuller account of what was surveyed; it is not, and never was, the record of the decision.
>
> ADR-007 is itself **Proposed**, not accepted: it is `claude-lead`'s recommendation awaiting
> `gpt-architect`'s ruling through the control plane. Neither file may be cited as settled.
>
> **Provenance, unchanged and still load-bearing.** Researched by `gpt-architect` on 2026-08-19
> against live sources, and transcribed here by `claude-lead` from the ChatGPT "Liberty GPT Worker"
> conversation. **Not an agent-bus message** — GPT's GitHub connector remains read-only, so there is
> no authentic bus record of this. A transcription is weaker evidence than a signed handoff, and the
> version numbers and dates below are as reported in that conversation rather than as verified here.
>
> Companion to `docs/RESEARCH_PLAYBACK.md`, which covers the playback and media-inspection lane.

Covers PL-0401, PL-0402, PL-0403, PL-0404, PL-0303 and PL-0801. Of these, only PL-0401 has an ADR;
the rest are still recorded here alone.

---

## The decision, in one line

**Better Auth + Drizzle + PostgreSQL. Profiles live above auth. Progress goes directly to
PostgreSQL first, not through Redis. Watchlist is plain profile-scoped PostgreSQL. Provider health
gets a Liberty contract that borrows `pass`/`warn`/`fail` vocabulary but adds an honest `unknown`.
PL-0801 defines the boundary now; building an ML recommender now would be premature.**

---

## PL-0401 — Better Auth

> Superseded as the decision record by **ADR-007**. What follows is the survey ADR-007 was written
> from; the ADR adds what this section does not have — the branded `ProfileScope` and its single
> mint, the reason-trail and confidentiality trade in `authorization.ts`, and the consequences that
> follow from the code as built.

**Better Auth 1.7.1, released 2026-08-18, MIT**, behind a `packages/auth` boundary, with
PostgreSQL-backed **database sessions** and the official Drizzle adapter. Current Next.js
integration explicitly supports Next.js 16 / App Router.

One operational consequence worth carrying into the task: **Better Auth's security policy supports
only the latest version.** So exact-pin the reviewed version and treat upgrades as security-sensitive
work rather than floating a caret range and letting them arrive unreviewed.

Start with a deliberately small surface — ordinary account authentication, verification and reset,
database sessions — and **no SSO/SCIM/organisation/device/MCP plugin stack**. Better Auth has
recently done substantial security hardening in precisely those advanced surfaces, which is an
argument for not enabling what we do not need.

| Option | Current state | Decision |
| --- | --- | --- |
| **Better Auth** | 1.7.1, Aug 18 2026, MIT. Next.js 16 support, DB sessions, Drizzle adapter. | **Choose** |
| Auth.js v5 | Still `5.0.0-beta.32` on npm's beta tag, ISC. Auth.js's own README tells new projects to start with Better Auth except for specific gaps such as stateless/no-DB sessions. | Do not choose greenfield |
| Clerk | `@clerk/nextjs` 7.7.6, MIT SDK, first-class App Router support. | Technically excellent, wrong trade — introduces a hosted identity data-plane and vendor dependency Liberty does not currently need |
| WorkOS AuthKit | 4.3.1, Jul 30 2026, MIT, App-Router-specific SDK, hosted identity. | Not for this consumer MVP; its enterprise identity/SSO strengths are not Liberty's requirement |
| iron-session | 8.0.4, MIT, last publish ~2 years ago. Explicitly a stateless encrypted-cookie library. | Not an authentication system — would leave Liberty owning credentials, recovery, linking and revocation |

---

## PL-0402 — profiles live *above* auth

This was the unusual requirement and the answer is clean: **do not model profiles inside the auth
library.** Auth answers "which account is this"; a viewer profile is a product concept layered on
top. The active profile is carried alongside the session rather than inside the identity record,
and **every progress and watchlist row is scoped to `profileId`, not to a user id.**

That scoping decision is the one that is expensive to reverse, so it belongs in the schema from the
first migration rather than being retrofitted.

---

## PL-0403 — progress persistence

**Do not introduce Redis write-behind yet.** Redis Streams can support at-least-once asynchronous
handoff with pending/reclaim semantics, but that introduces replay and reconciliation complexity,
and `appendfsync everysec` can still lose a window of writes. The complexity is unjustified before
there is a *measured* PostgreSQL problem. Write coalescing on the client is the first lever.

**Initial client policy:** one progress heartbeat on an interval, plus immediate writes on pause, on
a settled seek, and at playback end. The interval is a product/architecture choice rather than an
external standard — pick one, write down why, and let telemetry change it later.

**The database key is `(profileId, contentId)`**, with PostgreSQL's upsert as the update primitive
under concurrency.

**Two devices playing the same title is the hard part, and both obvious answers are wrong.** Do not
resolve with client timestamps — client clocks are unreliable and packets reorder. Do not resolve
with "monotonically increasing playback position" either, because that incorrectly refuses a
legitimate rewind. Use a **server-issued writer epoch** instead, so the server decides which writer
is current rather than inferring it from data the client controls.

This is the same principle the media engine already applies: do not derive a fact from something
that merely correlates with it.

---

## PL-0303 — provider health, and the sharpest point in the review

**Zero observations is not fifty-percent health, and it is not a pass.** An unobserved provider must
report `status: "unknown"`, `sampleCount: 0`, `observedSuccessRate: null`.

If a prior numerical `healthScore` is needed to rank an unobserved provider, **label it as one** —
`scoreBasis: "prior"`. In GPT's words: *"A Bayesian prior must not masquerade as measured
availability."* That is the same invariant as PL-0205's unknown media facts, arriving independently
in a different subsystem, and it should be implemented with the same discipline.

`warn` is the explicit **degraded-but-usable** state — the reason a binary up/down contract was never
sufficient here, since the project already computes a `healthScore` for ranking.

**Rights failure stays outside health entirely.** A provider at health 1.0 still cannot make an
unauthorised candidate eligible. Health is an availability signal, not an entitlement one, and
collapsing the two would let an operational metric influence a rights decision.

Given the determinism rule, health output must be **pure over `observations + explicit policy
version` → `score + status + reasons`**, with no hidden wall-clock decay unless the timestamp or
reference instant is itself an explicit input.

---

## PL-0801 — define the boundary now; the recommender is what is premature

**The boundary task is not premature. The recommendation *engine* is.** PL-0801 should establish a
package and information boundary, not install an ML library.

Data minimisation requires collecting and processing only personal data that is adequate, relevant
and limited to the purpose — and recommender profiling inherently uses behavioural and personal
information to infer interests and preferences. So the boundary is the deliverable.

```
RIGHTS / ELIGIBILITY
        ↓
CANDIDATE GENERATION
        ↓
DETERMINISTIC RANKING
        ↓
PRESENTATION
```

**Eligibility happens upstream, and recommendation cannot make content playable.** Candidate
generation may initially see only this profile's explicit watchlist, this profile's
progress/completion state, catalog metadata, and already-resolved eligibility. It returns IDs plus
generator reasons — which keeps the reason trail intact through a layer that would otherwise be the
easiest place to lose it.

---

## Open threads

- The Drizzle-versus-Prisma-versus-Kysely reasoning is summarised only by its conclusion here.
  Before PL-0402 starts, re-read the full comparison in the source conversation for the
  zod-interop argument specifically, since schema duplication is the deciding factor for this
  codebase.
- Progress heartbeat interval is explicitly left open as a product choice. Decide it deliberately
  and record the reason, rather than inheriting a number from an example.
- `scoreBasis: "prior"` needs to reach `packages/contracts` as a real field, not a convention, or it
  will be dropped the first time somebody serialises a health record.
