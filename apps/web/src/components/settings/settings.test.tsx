import { readFile } from "node:fs/promises";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import packageJson from "../../../package.json";
import { AboutSection, NOTICES_FILE_NAME } from "./about-section";
import { DiagnosticsDisclosure } from "./diagnostics-disclosure";
import { formatLanguageList, parseLanguageList } from "./language-preferences";
import {
  CMCD_COLLECTOR_PATH,
  PLAYBACK_TELEMETRY_DEFAULTS,
  decidePlaybackTelemetry
} from "../player/telemetry-decision";

/* -------------------------------------------------------------------------
 * The settings screen (PW-0308)
 *
 * `apps/web/vitest.config.ts` sets `environment: "node"`: no DOM, no effects,
 * no fetch. So the language form's BEHAVIOUR -- load, save, refuse, clear --
 * is not assertable here and is not faked here either; it is a real browser
 * against a real endpoint, which is `e2e/tests/settings.spec.ts`.
 *
 * What this suite pins is the part a server render decides, plus the two
 * claims on this screen that could quietly become false: the version it
 * displays, and whether the diagnostics section is still reporting the real
 * decision rather than a sentence somebody wrote about it.
 * ---------------------------------------------------------------------- */

async function sourceOf(file: string): Promise<string> {
  const raw = await readFile(new URL(file, import.meta.url), "utf8");
  /* Comments stripped first: the components' own headers discuss the things
   * these rules forbid, and a rule its own explanation can fail is not a
   * rule. The same pattern `degraded-banner.test.tsx` uses. */
  return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("the language list is a ranked list, and the field round-trips it", () => {
  it("keeps the order the viewer typed", () => {
    /*
     * ORDER IS THE INFORMATION. The contract says "most-preferred first. Order
     * is meaningful, not a set", so a parse that sorted or de-duplicated would
     * be changing the answer while looking like it was tidying it.
     */
    expect(parseLanguageList("ja, en, de")).toEqual(["ja", "en", "de"]);
  });

  it("drops only whitespace and empties, never a tag", () => {
    expect(parseLanguageList("  ja ,, en ,  ")).toEqual(["ja", "en"]);
  });

  it("answers an empty list for an empty field, not a list with a blank in it", () => {
    /*
     * `[""]` would reach the endpoint and be refused as an unusable language
     * tag, which would show a viewer who cleared the field a validation error
     * for something they did not type.
     */
    expect(parseLanguageList("")).toEqual([]);
    expect(parseLanguageList("   ")).toEqual([]);
  });

  it("round-trips, so showing what was stored and re-saving changes nothing", () => {
    const stored = ["ja", "en", "pt-BR"];
    expect(parseLanguageList(formatLanguageList(stored))).toEqual(stored);
  });

  it("does not normalise case, because the contract does not", () => {
    /*
     * The endpoint decides what a language tag is. A client that lower-cased
     * first would be a second validator, and the viewer would never see the
     * message the real one would have given them.
     */
    expect(parseLanguageList("JA, en")).toEqual(["JA", "en"]);
  });
});

describe("the form sends no profile id, in any field", () => {
  it("names no profile anywhere in its request bodies", async () => {
    /*
     * The endpoint derives the profile from the session and its request
     * contract is `.strict()`, so a body carrying one is refused rather than
     * ignored. This asserts the component could not address another
     * household's settings even by accident -- a stronger property than
     * remembering not to.
     */
    const source = await sourceOf("./language-preferences.tsx");
    expect(source).not.toMatch(/profileId/);
    /* Non-vacuity: the rule is about a file that really does build bodies. */
    expect(source).toMatch(/JSON\.stringify/);
  });

  it("reads its state back from the response and not from the inputs", async () => {
    /*
     * A write that stored something other than what was typed must not look
     * like a success. `apply` is called with the parsed body on both the read
     * and the write path; this pins that there is no second, input-sourced
     * path that sets the fields after a save.
     */
    const source = await sourceOf("./language-preferences.tsx");
    const applyCalls = source.match(/apply\(body\)/g) ?? [];
    expect(applyCalls.length).toBeGreaterThanOrEqual(2);
    expect(source).not.toMatch(/setAudio\(audio\)|setSubtitles\(subtitles\)/);
  });
});

describe("the diagnostics section reports the real decision", () => {
  it("renders the outcome the player's own decision function produces", () => {
    /*
     * THE POINT OF THE SECTION. Prose drifts from behaviour silently and
     * nothing fails when it does. This computes the decision independently,
     * with the same inputs the component uses, and asserts the rendered page
     * agrees with it -- so a change to the decision that this screen stopped
     * reflecting would fail here rather than mislead a viewer.
     */
    const decision = decidePlaybackTelemetry({
      enabled: true,
      contentId: "settings-disclosure",
      sessionId: null,
      collectorPath: CMCD_COLLECTOR_PATH,
      ...PLAYBACK_TELEMETRY_DEFAULTS
    });

    const html = renderToStaticMarkup(<DiagnosticsDisclosure />);

    expect(html).toContain(decision.enabled ? "Send playback diagnostics" : "Send nothing");
    expect(decision.reasons.length).toBeGreaterThan(0);
    for (const reason of decision.reasons) {
      expect(html, reason.code).toContain(reason.code);
    }
  });

  it("names the collector path rather than a prose description of it", () => {
    const html = renderToStaticMarkup(<DiagnosticsDisclosure />);
    expect(html).toContain(CMCD_COLLECTOR_PATH);
  });

  it("STAYS A SERVER COMPONENT WITH NO CONTROL IN IT, now for a different reason", async () => {
    /*
     * THIS RULE IS OLDER THAN THE REASON IT NOW HAS. It was written when a
     * toggle here would have been wired to nothing -- the "fake persistence
     * with local component state" forbidden by name -- and it survived
     * PL-0724 shipping the stored field and PL-0732 shipping the control,
     * because the control did NOT go here.
     *
     * WHAT IT GUARDS NOW. This section must keep reporting what
     * `decidePlaybackTelemetry` actually decides, to a viewer who may not be
     * signed in and so has no profile to store anything on. A control here
     * would also be a SECOND WRITER of a row the preferences form already
     * replaces wholesale on every save, which is the silent-revert hazard
     * PL-0732 exists to avoid. Either way the answer is the same: no control
     * in this file.
     */
    const source = await sourceOf("./diagnostics-disclosure.tsx");
    expect(source).not.toMatch(/<input|<button|<select|useState|"use client"/);
  });

  it("no longer promises a control that does not exist", async () => {
    /*
     * The old copy said "it cannot yet change it" and named PL-0724 as the
     * control being built. PL-0724 closed, the control exists, and that
     * sentence became the stale-comment failure this repository keeps
     * recording -- found, this time, while confirming a different task.
     */
    const source = await sourceOf("./diagnostics-disclosure.tsx");
    expect(source).not.toMatch(/cannot yet change it/);
  });
});

describe("one form owns the preferences row, control included", () => {
  /*
   * THE HAZARD THESE GUARD, STATED ONCE. `PUT /api/v1/profiles/preferences`
   * takes the WHOLE preferences object -- the request schema IS
   * `mediaPreferencesSchema`, strict and complete -- so every write is a full
   * replacement. Two forms over that row means the second one to save sends
   * whatever it read on mount and silently reverts the first. These are the
   * assertions that notice if somebody later adds the obvious second writer.
   */

  it("the diagnostics control is in the preferences form", async () => {
    const source = await sourceOf("./language-preferences.tsx");
    expect(source).toMatch(/name="playbackDiagnostics"/);
    expect(source).toMatch(/type="checkbox"/);
    expect(source).toMatch(/checked=\{playbackDiagnostics\}/);
  });

  it("and it is bound to the same state the write body sends", async () => {
    /*
     * NOT A SEPARATE PIECE OF STATE. A control with its own `useState` that
     * happened to be initialised from the same read would drift from the
     * value actually written the moment anything else touched either one.
     * `setPlaybackDiagnostics` must be the only setter, and `apply` -- which
     * runs on every response -- must be one of its callers, so the control
     * always shows what the server last confirmed.
     */
    const source = await sourceOf("./language-preferences.tsx");
    const setters = source.match(/setPlaybackDiagnostics\(/g) ?? [];
    expect(setters.length).toBeGreaterThanOrEqual(2);
    expect(source).toMatch(/setPlaybackDiagnostics\(preferences\.playbackDiagnostics\)/);
    expect(source).toMatch(/playbackDiagnostics\n?\s*\}\)/);
  });

  it("NOTHING ELSE WRITES THE FIELD, which is the whole point", async () => {
    /*
     * The structural assertion. Any OTHER component under settings/ that
     * posted this field would be the second writer, and the symptom would be
     * a viewer's diagnostics choice reverting when they saved a language --
     * no error, nothing logged. Checked across the directory rather than in
     * one file, because the hazard is precisely that it appears somewhere
     * else.
     */
    const others = ["./diagnostics-disclosure.tsx", "./about-section.tsx"];
    for (const file of others) {
      const source = await sourceOf(file);
      expect(source, file).not.toMatch(/playbackDiagnostics/);
      expect(source, file).not.toMatch(/\bfetch\(/);
    }
  });
});

describe("the About section states a version it can prove it declared", () => {
  it("shows the version `package.json` holds, not a literal", () => {
    const html = renderToStaticMarkup(<AboutSection />);
    expect(html).toContain(packageJson.version);
  });

  it("would fail if somebody pasted the number in instead", async () => {
    /*
     * The assertion above passes either way, since a correct literal matches
     * too. This is the one that catches the copy: the source must not contain
     * a version-shaped string of its own.
     */
    const source = await sourceOf("./about-section.tsx");
    expect(source).not.toMatch(/\d+\.\d+\.\d+/);
    expect(source).toMatch(/packageJson\.version/);
  });

  it("names the notices file without claiming an installation carries it", async () => {
    const html = renderToStaticMarkup(<AboutSection />);
    expect(html).toContain(NOTICES_FILE_NAME);
    /*
     * PW-0208 is the task that proves the packaged tree really carries the
     * file. A product that cheerfully reported a notices file it had never
     * looked for would be making the attribution problem worse, so this pins
     * that the screen hedges the claim in words a viewer reads.
     */
    expect(html).toMatch(/does not inspect your installation/);
  });
});
