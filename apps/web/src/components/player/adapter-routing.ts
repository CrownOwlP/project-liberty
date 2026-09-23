/* -------------------------------------------------------------------------
 * Which engine plays a candidate, decided BEFORE playback (PW-0203).
 *
 * `docs/ARCHITECTURE.md` already states the invariant: "Which engine plays a
 * candidate is decided before playback, with a reason recorded on both
 * branches." This is that decision.
 *
 * PURE AND DETERMINISTIC, on the rule ADR-003 and ADR-005 apply to ranking. No
 * clock, no I/O, no ambient state, no randomness. A routing decision must be
 * reconstructible from a bug report: "why did this play natively" has to be
 * answerable months later from the candidate alone.
 *
 * IT INVENTS NO SECOND OPINION ABOUT PROTECTION. The protection state is read
 * from the candidate the session published -- PL-0902 put `protection` on
 * `playbackSessionCandidateSchema` -- and `requiresContentDecryptionModule` in
 * `@liberty/contracts` is what interprets it. Two opinions about whether a
 * candidate is encrypted would eventually disagree, and the reason trail would
 * then explain a decision nobody made.
 *
 * ---------------------------------------------------------------------------
 * THE DRM RULE IS A RIGHTS PROPERTY, NOT A CAPABILITY DETAIL
 * ---------------------------------------------------------------------------
 * mpv has no Content Decryption Module. A native path that ATTEMPTED a
 * protected candidate would either fail confusingly or, worse, succeed on
 * something that was not actually protected after all — and a fallback from the
 * native engine to the web one on decrypt failure would be a system that keeps
 * trying until something plays, which is the shape of `docs/CONTENT_RIGHTS.md`'s
 * forbidden "fallback logic whose purpose is to evade provider enforcement".
 *
 * So the native adapter REFUSES, structurally, with `drm_required_no_cdm`, and
 * never degrades. That is why this module carries a rights-review gate.
 *
 * AND `unknown` COUNTS AS PROTECTED. `requiresContentDecryptionModule` is
 * written as `state !== "clear"` precisely so that anything which is not a
 * positive assertion of clearness needs a CDM. The opposite reading — unknown is
 * probably fine, try mpv — is the invariant-2 incident §4 names.
 * ---------------------------------------------------------------------- */

import {
  describeContentProtection,
  requiresContentDecryptionModule
} from "@liberty/contracts/shared/drm";

import {
  accept,
  refuse,
  type CanPlayDecision,
  type PlayerAdapterId,
  type PlayerCandidate
} from "./player-adapter";

/**
 * What an adapter can do, as a fact about the adapter rather than a branch in
 * this function.
 *
 * `canDecryptProtectedContent` is the only capability this module needs today,
 * and it is a DECLARATION rather than an `id === "web-shaka"` test: the routing
 * rule is "the engine with a CDM takes protected content", and writing it as an
 * identity comparison would silently route wrongly the day a third engine exists
 * or the day the web engine is built without EME.
 */
export interface AdapterCapabilityDeclaration {
  readonly id: PlayerAdapterId;
  readonly canDecryptProtectedContent: boolean;
}

/** The web engine: Shaka with EME. The DRM path on BOTH build targets. */
export const WEB_SHAKA_CAPABILITIES: AdapterCapabilityDeclaration = {
  id: "web-shaka",
  canDecryptProtectedContent: true
};

/** libmpv. No CDM, and that is a fact about mpv rather than a configuration. */
export const NATIVE_MPV_CAPABILITIES: AdapterCapabilityDeclaration = {
  id: "native-mpv",
  canDecryptProtectedContent: false
};

/**
 * One adapter's answer for one candidate, on the protection axis only.
 *
 * DELIBERATELY NARROW. Container, codec, protocol and bitrate refusals are the
 * adapter's own to make -- it is the thing that knows what it was built with --
 * and `PlayerRefusalCode` carries codes for all of them. This function answers
 * the one question that must NOT be left to an engine's own judgement, because
 * getting it wrong is a rights incident rather than a playback failure.
 */
export function protectionDecisionFor(
  adapter: AdapterCapabilityDeclaration,
  candidate: PlayerCandidate
): CanPlayDecision {
  const described = describeContentProtection(candidate.protection);
  if (!requiresContentDecryptionModule(candidate.protection)) {
    return accept(
      adapter.id,
      candidate.compatibility,
      `content protection is ${described}, so no decryption module is required`
    );
  }
  if (!adapter.canDecryptProtectedContent) {
    return refuse(
      adapter.id,
      "drm_required_no_cdm",
      `content protection is ${described} and ${adapter.id} has no content decryption module; this candidate is not attempted`
    );
  }
  return accept(
    adapter.id,
    candidate.compatibility,
    `content protection is ${described} and ${adapter.id} has a content decryption module`
  );
}

export interface RoutingOutcome {
  /** The adapter that will play it, or `null` when every adapter refused. */
  readonly adapterId: PlayerAdapterId | null;
  /**
   * EVERY adapter's answer, in the order they were offered — including the ones
   * that accepted after the winner.
   *
   * The whole trail rather than the winning line, because invariant 4 asks for a
   * reason trail "sufficient to debug candidate selection", and "the native
   * adapter refused this one" is the fact an operator needs when a desktop
   * session is unexpectedly running on Shaka.
   */
  readonly decisions: readonly CanPlayDecision[];
}

/**
 * Route one candidate across the adapters available on this build.
 *
 * FIRST ACCEPTANCE WINS, and the order is the caller's. The caller states
 * preference; this function does not re-sort, for the same reason
 * `playback-machine.ts` never re-sorts the candidate list: a second opinion
 * about preference here could disagree with the one the ranking already
 * published.
 */
export function routeCandidate(
  candidate: PlayerCandidate,
  adapters: readonly AdapterCapabilityDeclaration[]
): RoutingOutcome {
  const decisions: CanPlayDecision[] = [];
  let winner: PlayerAdapterId | null = null;
  for (const adapter of adapters) {
    const decision = protectionDecisionFor(adapter, candidate);
    decisions.push(decision);
    if (decision.playable && winner === null) winner = decision.adapterId;
  }
  return { adapterId: winner, decisions };
}

/**
 * The adapters a DESKTOP build offers, in preference order.
 *
 * Native first, because the whole reason the native engine exists is that it
 * composites and decodes better; web second, because it is the only one with a
 * CDM. A protected candidate therefore lands on Shaka by the native engine
 * REFUSING it, not by this list being reordered for it — which keeps the refusal
 * in the trail where an operator can see it.
 */
export const DESKTOP_ADAPTER_PREFERENCE: readonly AdapterCapabilityDeclaration[] = [
  NATIVE_MPV_CAPABILITIES,
  WEB_SHAKA_CAPABILITIES
];

/** The adapters a WEB build offers. There is one, and there cannot be a second. */
export const WEB_ADAPTER_PREFERENCE: readonly AdapterCapabilityDeclaration[] = [
  WEB_SHAKA_CAPABILITIES
];
