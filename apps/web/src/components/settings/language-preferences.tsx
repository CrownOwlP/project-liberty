"use client";

import {
  MAX_PREFERRED_LANGUAGES,
  NO_MEDIA_PREFERENCES,
  type MediaPreferences
} from "@liberty/contracts/domains/preferences";
import { useCallback, useEffect, useId, useState } from "react";

import styles from "./settings.module.css";

/* -------------------------------------------------------------------------
 * The languages a viewer prefers, stored on their profile (PW-0308)
 *
 * ==========================================================================
 * IT WRITES TO THE REAL ENDPOINT, AND THAT IS THE POINT OF THE TASK
 * ==========================================================================
 *
 * gpt-architect's round-110 instruction for this screen is explicit: "Do not
 * fake persistence with local component state." Everything below goes through
 * `/api/v1/profiles/preferences`, which stores a row on the viewer's profile,
 * and the component shows what came back rather than what it sent.
 *
 * NO PROFILE ID IS SENT, IN ANY FIELD. The endpoint derives the profile from
 * the session, and the request contract is strict, so a body carrying one is
 * refused rather than ignored. This component could not address another
 * household's settings if it tried, which is a stronger property than
 * remembering not to.
 *
 * ==========================================================================
 * "NOT CHOSEN" AND "CHOSE NOTHING" ARE SHOWN DIFFERENTLY
 * ==========================================================================
 *
 * The API answers `stored`, and the screen uses it. A profile nobody has
 * configured says so and offers the defaults; a viewer who cleared both lists
 * sees that their choice is in force. Both have empty lists, so a screen that
 * read only the values would show them identically and would be quietly wrong
 * for the second viewer, who deliberately told the player not to prefer
 * anything.
 *
 * ==========================================================================
 * A TEXT FIELD OF TAGS, NOT A LIST OF CHECKBOXES
 * ==========================================================================
 *
 * ORDER IS THE INFORMATION in these lists -- the contract says "most-preferred
 * first. Order is meaningful, not a set" -- and a set of checkboxes cannot
 * express an order. A reorderable list is the better control and it is a
 * drag-and-drop interaction with its own keyboard story, which is a larger
 * piece of work than this task has room for; a comma-separated field expresses
 * order exactly, is operable from the keyboard with no new interaction model
 * at all, and is honest about the fact that the answer is a ranked list. If it
 * is replaced, the thing that must survive is the ordering.
 * ---------------------------------------------------------------------- */

/** What the endpoint answers. Narrow: only the parts this component reads. */
interface PreferencesEnvelope {
  readonly outcome: string;
  readonly stored?: boolean;
  readonly preferences?: MediaPreferences;
  readonly reasons?: readonly { readonly code: string; readonly detail: string }[];
}

type Phase =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly stored: boolean }
  | { readonly kind: "saving"; readonly stored: boolean }
  | { readonly kind: "refused"; readonly stored: boolean; readonly detail: string }
  | { readonly kind: "unavailable"; readonly detail: string };

/** `"ja, en"` -> `["ja", "en"]`, preserving order and dropping only blanks. */
export function parseLanguageList(raw: string): string[] {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** `["ja", "en"]` -> `"ja, en"`. The inverse, so a round trip is lossless. */
export function formatLanguageList(languages: readonly string[]): string {
  return languages.join(", ");
}

export function LanguagePreferences() {
  const audioFieldId = useId();
  const subtitleFieldId = useId();
  const modeFieldId = useId();
  const hearingFieldId = useId();

  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [audio, setAudio] = useState("");
  const [subtitles, setSubtitles] = useState("");
  const [mode, setMode] = useState<MediaPreferences["subtitleMode"]>("auto");
  const [hearingImpaired, setHearingImpaired] = useState(false);

  const apply = useCallback((body: PreferencesEnvelope) => {
    const preferences = body.preferences ?? NO_MEDIA_PREFERENCES;
    setAudio(formatLanguageList(preferences.preferredAudioLanguages));
    setSubtitles(formatLanguageList(preferences.preferredSubtitleLanguages));
    setMode(preferences.subtitleMode);
    setHearingImpaired(preferences.hearingImpaired);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/v1/profiles/preferences", {
          headers: { accept: "application/json" }
        });
        const body = (await response.json()) as PreferencesEnvelope;
        if (cancelled) return;
        if (body.outcome === "read") {
          apply(body);
          setPhase({ kind: "ready", stored: body.stored === true });
          return;
        }
        setPhase({
          kind: "unavailable",
          detail: body.reasons?.[0]?.detail ?? "this deployment could not read your settings"
        });
      } catch {
        if (!cancelled) {
          setPhase({ kind: "unavailable", detail: "your settings could not be reached" });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apply]);

  const save = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    const stored = "stored" in phase ? phase.stored : false;
    setPhase({ kind: "saving", stored });
    try {
      const response = await fetch("/api/v1/profiles/preferences", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          preferredAudioLanguages: parseLanguageList(audio),
          preferredSubtitleLanguages: parseLanguageList(subtitles),
          subtitleMode: mode,
          hearingImpaired
        })
      });
      const body = (await response.json()) as PreferencesEnvelope;
      if (body.outcome === "written") {
        /*
         * APPLIED FROM THE RESPONSE, not from what was typed. The endpoint
         * reports what the database has; showing the input instead would make
         * a write that silently stored something else look like a success.
         */
        apply(body);
        setPhase({ kind: "ready", stored: true });
        return;
      }
      setPhase({
        kind: body.outcome === "refused" ? "refused" : "unavailable",
        stored,
        detail: body.reasons?.[0]?.detail ?? "your settings were not saved"
      } as Phase);
    } catch {
      setPhase({ kind: "unavailable", detail: "your settings were not saved" });
    }
  };

  const reset = async (): Promise<void> => {
    const stored = "stored" in phase ? phase.stored : false;
    setPhase({ kind: "saving", stored });
    try {
      const response = await fetch("/api/v1/profiles/preferences", { method: "DELETE" });
      const body = (await response.json()) as PreferencesEnvelope;
      if (body.outcome === "forgotten") {
        apply(body);
        setPhase({ kind: "ready", stored: false });
        return;
      }
      setPhase({
        kind: "refused",
        stored,
        detail: body.reasons?.[0]?.detail ?? "your settings were not cleared"
      });
    } catch {
      setPhase({ kind: "unavailable", detail: "your settings were not cleared" });
    }
  };

  if (phase.kind === "unavailable") {
    return (
      <section className="section" aria-labelledby="settings-languages">
        <h2 id="settings-languages">Languages</h2>
        <p className={styles.notice}>{phase.detail}</p>
      </section>
    );
  }

  const busy = phase.kind === "loading" || phase.kind === "saving";

  return (
    <section className="section" aria-labelledby="settings-languages">
      <h2 id="settings-languages">Languages</h2>
      <p>
        {phase.kind === "loading"
          ? "Reading your settings…"
          : phase.stored
            ? "These are your choices. They are stored on this profile, not on your household."
            : "You have not chosen yet, so playback uses whatever each title offers."}
      </p>

      <form onSubmit={save} className={styles.form}>
        <div className={styles.field}>
          <label htmlFor={audioFieldId}>Preferred audio languages</label>
          <input
            id={audioFieldId}
            name="preferredAudioLanguages"
            value={audio}
            onChange={(event) => setAudio(event.target.value)}
            disabled={busy}
            aria-describedby={`${audioFieldId}-hint`}
            autoComplete="off"
          />
          <p id={`${audioFieldId}-hint`} className={styles.hint}>
            Most preferred first, separated by commas — for example <code>ja, en</code>. Up to{" "}
            {MAX_PREFERRED_LANGUAGES}. Leave it empty to tell playback not to prefer any
            language.
          </p>
        </div>

        <div className={styles.field}>
          <label htmlFor={subtitleFieldId}>Preferred subtitle languages</label>
          <input
            id={subtitleFieldId}
            name="preferredSubtitleLanguages"
            value={subtitles}
            onChange={(event) => setSubtitles(event.target.value)}
            disabled={busy}
            aria-describedby={`${subtitleFieldId}-hint`}
            autoComplete="off"
          />
          <p id={`${subtitleFieldId}-hint`} className={styles.hint}>
            The order matters here too: the first one that a title actually carries is the one
            you get.
          </p>
        </div>

        <div className={styles.field}>
          <label htmlFor={modeFieldId}>Subtitles</label>
          <select
            id={modeFieldId}
            name="subtitleMode"
            value={mode}
            disabled={busy}
            onChange={(event) =>
              setMode(event.target.value === "off" ? "off" : "auto")
            }
          >
            <option value="auto">Show when they are needed</option>
            <option value="off">Off</option>
          </select>
        </div>

        <div className={styles.field}>
          <label htmlFor={hearingFieldId} className={styles.checkboxLabel}>
            <input
              id={hearingFieldId}
              name="hearingImpaired"
              type="checkbox"
              checked={hearingImpaired}
              disabled={busy}
              onChange={(event) => setHearingImpaired(event.target.checked)}
            />
            Prefer subtitles for the deaf and hard of hearing
          </label>
          <p className={styles.hint}>
            These carry speaker names and sound description. This chooses WHICH subtitles you
            get, not whether subtitles appear.
          </p>
        </div>

        {phase.kind === "refused" ? (
          <p className={styles.notice} role="alert">
            {phase.detail}
          </p>
        ) : null}

        <div className={styles.actions}>
          <button type="submit" disabled={busy}>
            {phase.kind === "saving" ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            onClick={() => void reset()}
            disabled={busy || !("stored" in phase && phase.stored)}
          >
            Clear my choices
          </button>
        </div>
        <p className={styles.hint}>
          Clearing is not the same as leaving the lists empty. Empty lists tell playback not to
          prefer any language; clearing makes this profile one that has not chosen.
        </p>
      </form>
    </section>
  );
}
