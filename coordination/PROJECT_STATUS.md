# Project Liberty - Project Status

> Generated 2026-09-16T01:23:54.554Z from the AI control plane.

**Overall completion:** 25/50 executable tasks (50%)

## Status summary

- **BACKLOG:** 9
- **READY:** 4
- **CLAIMED:** 0
- **IN_PROGRESS:** 2
- **REVIEW:** 4
- **BLOCKED:** 6
- **DONE:** 25
- **CANCELED:** 0

## Milestones / phases

- **M0 — AI Engineering System + Repository Foundation:** COMPLETE, 4/4 (100%)
- **M1 — Core Discovery Experience:** COMPLETE, 3/3 (100%)
- **M2 — Media Resolution + Provider Foundation:** IN_PROGRESS, 5/6 (83%)
- **M3 — Identity + Personal State:** NOT_STARTED, 0/4 (0%), 1 blocked
- **M4 — Playback Vertical Slice:** IN_PROGRESS, 0/6 (0%)
- **M5 — Live + Intelligence Boundaries:** NOT_STARTED, 0/2 (0%), 1 blocked
- **M6 — Shared-Agent Automation Bridge:** IN_PROGRESS, 1/3 (33%)
- **EXT — External Licensed Integrations:** BLOCKED, 0/2 (0%), 2 blocked
- **M7 — Windows Desktop Shell + Native Playback:** IN_PROGRESS, 1/4 (25%)

## Active work

- **PL-0501** [IN_PROGRESS] Playback session API — owner: claude-media
- **PL-0305** [IN_PROGRESS] A real catalog metadata source — owner: claude-backend
- **PL-0206** [REVIEW] Macrolanguage and extlang equivalence in the shared language matcher — owner: claude-media
- **PL-0902** [REVIEW] DRM capability on the candidate and playback-session contract — owner: claude-lead
- **PL-0903** [REVIEW] An engine-unavailable reason that can say libmpv did not load — owner: claude-frontend
- **PL-0904** [REVIEW] Playback errors carry an origin, so a native failure is not a Shaka number — owner: claude-frontend

## Dispatch classification

- **READY_AND_EXECUTABLE:** 4
- **READY_BUT_EXTERNAL:** 0
- **BLOCKED:** 6
- **BACKLOG (dependency-gated):** 9

## Recommended executable wave

No conflict-free executable tasks can be assigned with current agent capacity.

## Queued for external agents

No READY work is waiting on an external agent lane.

## Blockers

- **PL-0205** Unknown media metadata semantics: Provenance invalid, per gpt-architect at 98d18154655dbaaa6678ef261743f9971f106293, which declined to record either APPROVED or CHANGES_REQUESTED on the ground that a verdict bound to a false range is worth less than no verdict. The merits were read separately and found approvable; they carry forward. implementationBaseSha is 18ce47244b1da0c83fe092351f51e71892bd6c84, derived mechanically as the first parent of the first commit touching packages/contracts/src/shared/media-facts.ts. The derivation was honest and the answer is false: that file was CREATED by PL-AI-0006's module split, which moved declarations out of packages/contracts/src/index.ts and states that schema behaviour did not change, so the parent tree of that creation already contained required-and-nullable codecs, height and bitrate, MediaFact, MEDIA_FACTS, unknownMediaFacts and CompatibilityConfidence. The recorded range therefore opens AFTER the implementation it claims to cover. The true lower bound is cf2a4583e120151bf16e90d8eb41842cd7329c83, the parent of 4091a2b65b8f187ccb87a04790272007dabd39ea, whose tree still has mandatory non-null media facts. This cannot be repaired in place, on the rule PL-0703 established: reconciliation refuses a task that already records a base, release is unreachable from REVIEW and preserves the base regardless, and hand-editing a published provenance figure is the move PL-0703 was blocked for. Preserved as audit history and superseded by PL-0207, which reconciles from cf2a4583, narrows the media-engine wildcard to the five files this task actually wrote, and carries the acceptance wording the reviewer ruled in favour of. TRANSCRIBED BY CLAUDE from the ChatGPT review session; the GitHub write integration returns 403.
- **PL-0302** First production provider: Requires a confirmed licensed API/provider and credentials
- **PL-0401** Auth integration decision: Provenance invalid plus three merits blockers, per gpt-architect at 64b631d5a034fc884da185dc6b3a0cb7df6e608e, which recorded neither architecture-review nor security-review. Same incomplete-probe defect as PL-0601: ENABLED_AUTH_CAPABILITIES and WITHHELD_AUTH_PLUGIN_FAMILIES correctly located the code introduction while missing earlier task implementation on another declared write path, because docs/DATA_MODEL.md did not exist at 56b343 and was created in bbe68ed8, before the recorded base fc1ea4d54c9e7d2b2f6d9aa71a977abdc3bcb400, already identifying itself as covering this task's auth boundary and already selecting Better Auth 1.7.1. The true lower bound is 56b3435418f222f557ce957e7d5de3827da107b7. THREE MERITS BLOCKERS CARRY TO THE SUCCESSOR. First, ProfileScope is forgeable and it is the PL-0706 defect in a second place: the brand is type-only and mintProfileScope returns an ordinary object via cast, so a holder of a genuine scope can spread it with a replacement profileId and keep the branded type without the explicit cast ADR-007 calls the only forgery route, while persistence trusts scope.profileId directly -- a cross-profile data-access bypass. Second, better-auth and its Drizzle adapter are pinned at 1.7.1 while upstream supports only the current 1.7.4 from 2026-09-10; the reviewer noted this proves the exact-pin policy working rather than failing, and required that the hand-written migration be reconciled against the reviewed version first, because 1.7.3 restored the 1.6 account core schema while the migration still carries an issuer column and an issuer plus account_id uniqueness rule. Third, ADR-007 states obsolete control-plane routing. Preserved as audit history and superseded by PL-0405. TRANSCRIBED BY CLAUDE from the ChatGPT review session; the GitHub write integration returns 403.
- **PL-0601** Channel and EPG contracts: Provenance invalid, per gpt-architect at 64b631d5a034fc884da185dc6b3a0cb7df6e608e, which recorded neither architecture-review nor rights-review because a verdict bound to a false range is worth less than no verdict. The merits were read and found approvable and carry forward. implementationBaseSha is 33588cdce6de6a21c19a0f4725cc87b199deaa50, proven with two behaviour witnesses, liveChannelSchema and epgListingSchema, located by content pickaxe. Five checks passed and the answer is still false, because THE WITNESSES PROVED THE SCHEMA BOUNDARY AND NOT THE TASK BOUNDARY: docs/LIVE_TV.md is an allowedPath and part of the stated implementation, and its PL-0601 rewrite -- the commit replacing the original eleven-line Live TV note with the normalization-and-rights document -- landed at bbe68ed8d16f864c87309ceb1c089495deb89766, an ancestor of the recorded base. The base tree therefore already contained part of the implementation, and the published one-commit three-file window excluded task work it claimed to cover. The true lower bound is 56b3435418f222f557ce957e7d5de3827da107b7, the parent of bbe68ed8, while docs/LIVE_TV.md remains a write surface. This cannot be repaired in place on the rule PL-0703 established. Preserved as audit history and superseded by PL-0603. TRANSCRIBED BY CLAUDE from the ChatGPT review session; the GitHub write integration returns 403.
- **PL-0602** Live provider integration: Requires licensed live feed/provider access
- **PL-0703** Corrective: production rights-invariant breach in the watch route: Provenance invalid, per gpt-architect at 5b59c6c2. implementationBaseSha is f6c4b942ebbd02fd3fa9ed8f74fde4fc603affc2, recorded by an ordinary start, which opens the review range AFTER part of the implementation already existed: the first incident repair at 9933a55 sits before it, so the recorded range excludes half the implementation it claims to cover. The reviewer verified this cannot be repaired in place -- release is unavailable from REVIEW and deliberately preserves an existing base, and reconciliation refuses any task that already records one, because reconciliation establishes a base rather than revising one. This record is preserved as audit history rather than rewritten. Superseded by PL-0706, which reconciles from cf98b977b3c7c0113928bb9cc4d7fb6d02e802bd. The reviewer also refused both security-review and rights-review on the merits at that head: two fixture providers and two runtime allowlists coexisted, recreating the two-copy arrangement this corrective exists to remove.

## Agent capacity

- **gpt-architect:** 0/6 active (external lane; not locally executable)
- **claude-lead:** 1/2 active
- **claude-frontend:** 2/2 active
- **claude-backend:** 1/2 active
- **claude-media:** 2/2 active
- **claude-test:** 0/1 active
- **claude-security:** 0/1 active
- **claude-infra:** 0/1 active
- **human-commander:** 0/99 active (external lane; not locally executable)
