import {
  CMCD_COLLECTOR_PATH,
  PLAYBACK_TELEMETRY_DEFAULTS,
  decidePlaybackTelemetry
} from "../player/telemetry-decision";

import styles from "./settings.module.css";

/* -------------------------------------------------------------------------
 * What this build would send, and why (PW-0308)
 *
 * ==========================================================================
 * IT ASKS THE REAL DECISION RATHER THAN DESCRIBING IT
 * ==========================================================================
 *
 * PW-0308's acceptance says `telemetry-decision.ts` "already reports WHY
 * telemetry is off, and that reasoning belongs in front of the viewer instead
 * of in a details element in the player". So this component CALLS
 * `decidePlaybackTelemetry` with the same collector path and the same defaults
 * the player passes, and renders what comes back.
 *
 * A PARAGRAPH SAYING "we may collect playback diagnostics" WOULD HAVE BEEN
 * EASIER AND WOULD BE THE WRONG THING. Prose drifts from behaviour silently
 * and nothing fails when it does; this cannot drift, because it is the
 * function the player uses. If somebody changes the decision, this screen
 * changes with it.
 *
 * ==========================================================================
 * IT STILL IS NOT THE SWITCH, AND NOW THAT IS A LAYOUT FACT RATHER THAN A
 * MISSING FEATURE
 * ==========================================================================
 *
 * WHAT THIS BLOCK USED TO SAY, kept because the reasoning is why the control
 * took two tasks to arrive: "`player-surface.tsx` passes `enabled: true` as a
 * LITERAL, and nothing stores a viewer's answer. A toggle here would
 * therefore be a control wired to nothing ... which is exactly the 'fake
 * persistence with local component state' gpt-architect's round-110
 * instruction forbids by name." PL-0724 then shipped the stored field and the
 * player consuming it -- and left the product with a setting no viewer could
 * reach, which PL-0732 found while confirming that it persisted.
 *
 * THE CONTROL IS IN THE PREFERENCES FORM, NOT HERE, and that is deliberate:
 * this endpoint replaces the WHOLE preferences object on every write, so a
 * second form over the same row would silently revert the setting whenever
 * somebody saved a language. One form owns the row. The reasoning is written
 * out at the control itself.
 *
 * THIS SECTION KEEPS THE JOB IT WAS APPROVED FOR: reporting what
 * `decidePlaybackTelemetry` ACTUALLY decides, from the function rather than
 * from prose about it, to a viewer who may not be signed in and therefore has
 * no profile to store anything on.
 *
 * ==========================================================================
 * SERVER-RENDERED, AND THAT MATTERS HERE
 * ==========================================================================
 *
 * No "use client". `decidePlaybackTelemetry` is pure and takes no browser
 * fact except a session id, which is deliberately not minted here -- the
 * session id is per playback and this screen is not playing anything. Passing
 * `null` makes the decision say so, in its own words, which is a truthful
 * answer about a page that is not a player rather than a pretend one.
 * ---------------------------------------------------------------------- */

/** How a reason code reads to somebody who is not holding the source. */
const PLAIN: Record<string, string> = {
  cmcd_configured: "Playback diagnostics are configured and would be sent.",
  telemetry_disabled: "Playback diagnostics are switched off.",
  session_id_unavailable:
    "No diagnostics session identifier could be created, so nothing would be sent.",
  session_id_not_transmittable:
    "The session identifier could not be sent safely, so nothing would be sent.",
  content_id_not_transmittable:
    "The title identifier could not be sent safely, so nothing would be sent.",
  collector_path_not_first_party:
    "Diagnostics would have gone somewhere other than this application, so nothing is sent.",
  client_key_allowlist_empty: "No diagnostics fields are allowed to be sent, so nothing is sent."
};

export function DiagnosticsDisclosure() {
  /*
   * THE SAME INPUTS THE PLAYER USES, with one honest difference: no session
   * id, because this page is not a playback session. The decision turns that
   * into a stated reason rather than a guess.
   */
  const decision = decidePlaybackTelemetry({
    enabled: true,
    contentId: "settings-disclosure",
    sessionId: null,
    collectorPath: CMCD_COLLECTOR_PATH,
    ...PLAYBACK_TELEMETRY_DEFAULTS
  });

  return (
    <section className="section" aria-labelledby="settings-diagnostics">
      <h2 id="settings-diagnostics">Diagnostics</h2>
      <p>
        Project Liberty can report how playback is going — how long a stream took to start,
        which quality it settled on — so that problems can be diagnosed. It is sent to this
        application and nowhere else; the check that enforces that is the same one described
        below.
      </p>

      <dl className={styles.facts}>
        <dt>Where it would go</dt>
        <dd>
          <code>{CMCD_COLLECTOR_PATH}</code> on this site
        </dd>
        <dt>What this build would do</dt>
        <dd>{decision.enabled ? "Send playback diagnostics" : "Send nothing"}</dd>
      </dl>

      {/*
        THE REASONS, FROM THE DECISION ITSELF. Not a summary of them: the codes
        and the details are what `decidePlaybackTelemetry` produced, so this
        list is accurate by construction rather than by maintenance.
      */}
      <ul className={styles.reasons}>
        {decision.reasons.map((reason) => (
          <li key={reason.code}>
            {PLAIN[reason.code] ?? reason.detail}{" "}
            <span className={styles.reasonCode}>({reason.code})</span>
          </li>
        ))}
      </ul>

      <p className={styles.hint}>
        The switch is above, under Languages — one form writes all of your preferences, so
        saving one of them cannot quietly change another. Turning it off stops diagnostics
        being sent. Leaving it on does not force anything: this section reports what the
        build would actually do, and the checks listed here still decide.
      </p>
    </section>
  );
}
