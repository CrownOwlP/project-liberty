import { z } from "zod";

/* -------------------------------------------------------------------------
 * Shared vocabulary: content protection (PL-0902)
 *
 * A LEAF module. It imports nothing from this package and must keep importing
 * nothing from it, for the reason `./rights` states: every surface that has to
 * name a protection system reaches this file directly, so there is exactly one
 * key-system vocabulary and no path by which a second one comes into existence.
 *
 * WHAT THIS MODULE IS FOR, AND WHAT IT IS NOT.
 *
 * It exists so the right player is chosen before playback and so a refusal can
 * say WHY. `docs/DESKTOP_PLAYBACK.md` §4 records the constraint it serves: the
 * desktop build routes between an mpv adapter that has no Content Decryption
 * Module and cannot be given one, and a Shaka/EME adapter that has one, and
 * `PlayerAdapter.canPlay` must return a reasoned decision on BOTH branches
 * rather than a boolean guess. A reason trail that says `drm_required` without
 * naming a system is not debuggable, which is product invariant 4.
 *
 * IT ADDS NO DECRYPTION AND NO KEY HANDLING. There is no key, no key id, no
 * initialisation data, no licence request body, no certificate and no service
 * certificate anywhere below, and none may be added here: this vocabulary
 * DESCRIBES an encryption requirement so that a player which cannot satisfy it
 * refuses, which is the opposite of circumventing one (product invariant 2).
 * The only address it carries is a licence ACQUISITION endpoint -- the URL an
 * already-licensed CDM posts its own challenge to -- and carrying an address is
 * not holding a key.
 * ---------------------------------------------------------------------- */

/**
 * The key systems the platform can state.
 *
 * A CLOSED vocabulary rather than a free string, for the reason
 * `playbackFailureKindSchema` is closed: a value that arrives as prose cannot be
 * counted, grouped or alerted on, and `canPlay` would be matching on spellings
 * rather than on a vocabulary. It is also the enforcement point for the
 * normalization rule -- a provider's own spelling (`com.widevine.alpha`,
 * `com.microsoft.playready`, `DRM: WV`) is refused HERE, so the only place it
 * can be turned into a contract value is inside `@liberty/provider-sdk`, where
 * provider-specific behaviour is required to live (product invariant 3).
 *
 * `clearkey` is listed rather than left out. W3C Clear Key is a real EME key
 * system, so a Clear Key stream can be STATED accurately instead of being
 * flattened into `unknown`; it changes nothing about routing (it is still an
 * EME path, so the native adapter refuses it identically) and nothing about
 * this module (no key travels here -- `licenseUrl` is an address).
 */
export const keySystemSchema = z.enum(["widevine", "playready", "fairplay", "clearkey"]);
export type KeySystem = z.infer<typeof keySystemSchema>;

/**
 * Membership list, derived from the schema's own options.
 *
 * Derived rather than written out a second time, for the reason
 * `PLAYBACK_FAILURE_KINDS` gives: a literal copy can silently omit a member the
 * schema admits, and a key system nothing iterates over is a key system no
 * adapter declares support for.
 */
export const KEY_SYSTEMS: readonly KeySystem[] = keySystemSchema.options;

/**
 * Why a protection state is UNKNOWN. Closed, and each member sends a reader
 * somewhere different -- which is the whole justification for a reason rather
 * than a bare `unknown`.
 *
 *   - `provider_did_not_state` -- the source had no field to read. Fix the
 *     provider, or accept that this source cannot be routed to mpv.
 *   - `provider_value_unrecognised` -- the source DID state something and
 *     `@liberty/provider-sdk` could not normalize it to a `KeySystem`. Fix the
 *     normalizer. THIS IS THE IMPORTANT ONE: an unrecognised spelling must land
 *     here and not on `clear`, or an unmapped provider string becomes a claim
 *     that the stream is unencrypted.
 *   - `not_inspected` -- nothing has examined the manifest or container yet.
 *     Run inspection, or route to the adapter that has a CDM.
 */
export const protectionUnknownReasonSchema = z.enum([
  "provider_did_not_state",
  "provider_value_unrecognised",
  "not_inspected"
]);
export type ProtectionUnknownReason = z.infer<typeof protectionUnknownReasonSchema>;

export const PROTECTION_UNKNOWN_REASONS: readonly ProtectionUnknownReason[] =
  protectionUnknownReasonSchema.options;

/**
 * The licence ACQUISITION endpoint. An address, never a key.
 *
 * `https` only, and credentials in the authority are refused. Both are
 * deliberate tightenings rather than inherited defaults: a licence exchange over
 * `http` publishes the CDM's challenge and the server's response to the path,
 * and `https://user:pass@licence.example/` is the shape
 * `@liberty/provider-sdk`'s `checkUrl` already refuses before a media URL is
 * published. A licence endpoint is not a lesser URL than a media URL and must
 * not be held to a lesser standard.
 *
 * Parsed with `URL` rather than pattern-matched, because `https:/\/evil` and
 * other near-misses are exactly what a prefix test lets through.
 */
export const licenseUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return false;
    }
    return parsed.protocol === "https:" && parsed.username === "" && parsed.password === "";
  }, "must be an https URL with no embedded credentials");

/**
 * WHAT A CANDIDATE SAYS ABOUT ITS CONTENT PROTECTION. Three states, not two, and
 * not a boolean.
 *
 * A boolean `isDrm` answers the routing question and nothing else. The adapter
 * also has to say WHICH system it could not satisfy, and a trail that reports
 * `drm_required` with no system named sends nobody anywhere -- invariant 4 asks
 * for a trail sufficient to DEBUG candidate selection, and "something was
 * encrypted" is not that.
 *
 * THE THIRD STATE IS THE POINT.
 *
 *   - `clear` is an ASSERTION that the stream is unencrypted. Somebody looked.
 *   - `unknown` is an assertion that nobody established it. It carries no key
 *     system because there is none to carry, and it MUST NOT read as `clear`.
 *   - `protected` names the system, and the licence endpoint where the boundary
 *     that produced the candidate knows one.
 *
 * `unknown` is a MEMBER OF THE UNION rather than an absent field, which is the
 * same required-and-nullable discipline `domains/playback.ts` states for the
 * four media facts and `./catalog` states for `runtimeMinutes`: an omitted key
 * is indistinguishable from a producer that predates the field, so unknown has
 * to be ASSERTED and cannot be achieved by silence. It is spelled as a variant
 * rather than as `ContentProtection | null` because `null` in this position
 * would have to mean "we do not know", while every reader's reflex for a null
 * DRM field is "there is no DRM" -- and `docs/DESKTOP_PLAYBACK.md` §4 names
 * getting that backwards as the one way this design produces an invariant-2
 * incident. A `state` that must be spelled out has no reflex reading.
 *
 * EVERY VARIANT IS `.strict()`. zod's default is to STRIP an unknown key, so
 * without it `{ state: "protected", keySystem: "widevine", key: "..." }` would
 * parse cleanly, drop the key silently and report success. An unexpected key on
 * a protection descriptor is evidence about the producer -- quite possibly that
 * somebody is trying to move key material through the contract -- and it must
 * surface as a parse failure rather than be discarded. This is `domains/live.ts`'s
 * argument for `.strict()`, applied where it matters most.
 */
export const contentProtectionSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("clear")
    })
    .strict(),
  z
    .object({
      state: z.literal("unknown"),
      why: protectionUnknownReasonSchema
    })
    .strict(),
  z
    .object({
      state: z.literal("protected"),
      keySystem: keySystemSchema,
      /**
       * `null` = the boundary that produced this candidate does not know the
       * licence endpoint. Required-and-nullable, never optional and never `""`:
       * "we could not state one" and "nobody taught this producer to send one"
       * are different claims, and routing is decidable without it either way --
       * `canPlay` needs the SYSTEM, the endpoint is what a load needs.
       */
      licenseUrl: licenseUrlSchema.nullable()
    })
    .strict()
]);

export type ContentProtection = z.infer<typeof contentProtectionSchema>;

/**
 * The safe default a producer reaches for when it has nothing to say.
 *
 * Exported as a constant so that "I do not know" is a one-token import and
 * `{ state: "clear" }` is the thing somebody has to type deliberately. The
 * cheapest spelling should be the safe one.
 */
export const PROTECTION_NOT_STATED: ContentProtection = {
  state: "unknown",
  why: "provider_did_not_state"
};

/**
 * Whether playing this candidate requires a Content Decryption Module.
 *
 * TRUE FOR `unknown` AS WELL AS `protected`, and that is the whole safety
 * property of this module. An unestablished encryption state routes to the
 * adapter that HAS a CDM if one turns out to be needed; the mpv adapter refuses
 * it under `drm_required_no_cdm` with a reason that says the state was unstated
 * rather than positive. The opposite reading -- unknown is probably fine, try
 * mpv -- is the invariant-2 incident `docs/DESKTOP_PLAYBACK.md` §4 names.
 *
 * WRITTEN AS `!== "clear"` ON PURPOSE. Spelled as
 * `state === "protected" || state === "unknown"` a fourth state added later
 * would default to NOT needing a CDM, and the failure would be a silent
 * attempt rather than a compile error or a refusal. Phrased this way, anything
 * that is not an assertion of clearness needs a CDM until somebody argues
 * otherwise in this function.
 */
export function requiresContentDecryptionModule(protection: ContentProtection): boolean {
  return protection.state !== "clear";
}

/**
 * The key system to name in a refusal, or `null` when there is none to name.
 *
 * `null` for `unknown` is not a gap: there genuinely is no system, and inventing
 * a likely one would be the same fabrication the media-fact sentinels were
 * rejected for. A refusal about an `unknown` candidate names the STATE and its
 * reason instead -- see `describeContentProtection`.
 */
export function protectionKeySystem(protection: ContentProtection): KeySystem | null {
  return protection.state === "protected" ? protection.keySystem : null;
}

/**
 * The one spelling of a protection state that goes in a reason trail.
 *
 * A canonical token rather than a sentence, and shared rather than composed at
 * each call site, for the reason `unknownMediaFacts` is shared: two adapters
 * each formatting their own refusal would eventually publish two spellings of
 * the same fact, and the disagreement surfaces as two reason trails that appear
 * to describe different events. `CanPlayDecision.reason` is free text around
 * this token; the token itself is stable.
 *
 * NEVER INCLUDES THE LICENCE URL. A reason trail is logged, and a licence
 * endpoint can carry a per-session token in its query string -- the same
 * argument `PlayerError.message` makes for carrying no signed query strings.
 */
export function describeContentProtection(protection: ContentProtection): string {
  switch (protection.state) {
    case "clear":
      return "clear";
    case "unknown":
      return `unknown:${protection.why}`;
    case "protected":
      return `protected:${protection.keySystem}`;
  }
}
