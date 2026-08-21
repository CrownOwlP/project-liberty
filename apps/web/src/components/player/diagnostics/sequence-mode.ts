/* -------------------------------------------------------------------------
 * `sequenceMode: false`, asserted rather than assumed
 *
 * In MSE SEGMENTS mode the browser uses the `tfdt`/`trun` timestamps carried in
 * each fMP4 segment, which is what makes audio and video land on the same
 * timeline. In SEQUENCE mode those timestamps are discarded and each appended
 * segment is placed immediately after the previous one, so any per-track
 * difference in segment duration accumulates as real, growing misalignment —
 * the one mechanism in this whole area that produces genuine drift AND is
 * visible from our own configuration.
 *
 * WHY IT IS CHECKED AT RUNTIME RATHER THAN TRUSTED. `sequenceMode: false` is
 * already the shipped default in shaka-player 5.2.6 for DASH and HLS alike, and
 * `PlaybackController.BASELINE_ENGINE_CONFIG` already states it explicitly. But
 * Shaka's own JSDoc for `manifest.hls.sequenceMode` still claims the HLS
 * default is `true` — the documentation and the shipped default disagree — and
 * there are current reports of drift appearing after an upgrade in players that
 * never wrote it down. So an UNSTATED value is reported as a fired proxy, not
 * as a pass: relying on a default that its own documentation contradicts is
 * precisely the risk this proxy exists to surface.
 *
 * This is the only arm of PL-0504 that reads our configuration rather than the
 * stream, and it is the only one whose firing points at something we can fix
 * directly.
 *
 * Nothing here reads a clock, and nothing here writes configuration.
 * ---------------------------------------------------------------------- */

import type { EngineConfig } from "../engine";
import {
  avReason,
  AV_PROXY_METRICS,
  type AvContinuityReason,
  type AvProxyObservation
} from "./av-continuity";
import { readRecord } from "./readers";

/** The manifest families Shaka exposes a `sequenceMode` switch for. */
const MANIFEST_KINDS = ["dash", "hls"] as const;
type ManifestKind = (typeof MANIFEST_KINDS)[number];

type SequenceModeState = "false" | "true" | "unstated";

function readSequenceMode(config: EngineConfig, kind: ManifestKind): SequenceModeState {
  const manifest = readRecord(readRecord(config)?.manifest);
  const value = readRecord(manifest?.[kind])?.sequenceMode;
  if (value === false) return "false";
  if (value === true) return "true";
  return "unstated";
}

export interface SequenceModeObservation extends AvProxyObservation {
  readonly metric: typeof AV_PROXY_METRICS.sequenceModeAssertion;
  readonly evidenceSource: "engine-configuration";
}

/**
 * Assert segments mode over an EFFECTIVE configuration.
 *
 * Give it the configuration the player is actually running with — the merged
 * result, not one fragment of it. A fragment that simply does not mention
 * `manifest` will read as `unstated` for both families and fire, which is the
 * correct answer about that fragment and the wrong answer about the session.
 *
 * Deterministic: the two manifest families are always evaluated in the same
 * order, so the reason trail is byte-identical for identical configuration.
 */
export function assertSegmentsMode(
  config: EngineConfig | null | undefined
): SequenceModeObservation {
  const reasons: AvContinuityReason[] = [];
  let fired = false;

  for (const kind of MANIFEST_KINDS) {
    const state: SequenceModeState =
      config === null || config === undefined ? "unstated" : readSequenceMode(config, kind);

    if (state === "true") {
      fired = true;
      reasons.push(
        avReason(
          "sequence_mode_enabled",
          `manifest.${kind}.sequenceMode is true. Segment timestamps are discarded and segments ` +
            "are appended back to back, so any per-track difference in segment duration " +
            "accumulates as real misalignment."
        )
      );
      continue;
    }

    if (state === "unstated") {
      fired = true;
      reasons.push(
        avReason(
          "sequence_mode_unstated",
          `manifest.${kind}.sequenceMode is not stated, so the session inherits whichever ` +
            "default the installed shaka-player ships. That default is currently false, but " +
            `Shaka's own JSDoc for manifest.hls.sequenceMode claims true, so the documented and ` +
            "shipped behaviour disagree and an unstated value is not a safe one."
        )
      );
      continue;
    }

    reasons.push(
      avReason(
        "sequence_mode_asserted_false",
        `manifest.${kind}.sequenceMode is explicitly false, so MSE segments mode is in force and ` +
          "fMP4 tfdt/trun timestamps place each track on its own correct timeline."
      )
    );
  }

  reasons.push(
    avReason(
      "proxy_not_measurement",
      "This proxy reports a configuration risk. It is not evidence that any particular playback " +
        "session was or was not misaligned, and it carries no offset."
    )
  );

  return {
    evidenceBasis: "proxy",
    metric: AV_PROXY_METRICS.sequenceModeAssertion,
    evidenceSource: "engine-configuration",
    proxyFired: fired,
    magnitude: null,
    reasons
  };
}
