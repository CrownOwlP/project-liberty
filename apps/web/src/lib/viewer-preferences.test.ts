import { NO_MEDIA_PREFERENCES } from "@liberty/contracts/domains/preferences";
import { describe, expect, it } from "vitest";

import { loadMediaPreferences } from "./viewer-preferences";

/* -------------------------------------------------------------------------
 * WHAT THIS SUITE CAN HONESTLY ASSERT, AND WHAT IT LEAVES TO THE E2E
 *
 * `loadMediaPreferences` resolves the REAL environment -- the repository
 * adapter this deployment is configured with, the real identity system, the
 * real profile authorization -- exactly as `loadResumePosition` does, and for
 * the same reason: it is the thing a server render actually calls, and a
 * version of it with a store injected would be a different function from the
 * one that ships.
 *
 * So this suite does not fake a database to watch a stored row come back. It
 * asserts the property that holds in EVERY environment and is the one a
 * playback page depends on: a read that cannot be satisfied answers "nobody
 * has chosen" rather than throwing, and the value it answers with is the
 * neutral one. Under the unit environment there is no identity system
 * configured, so every call here takes a failure path -- which is precisely
 * the path worth pinning, because it is the one that runs when something is
 * wrong and the one a viewer must not notice.
 *
 * The success path -- a profile with a stored row getting its own languages
 * into the session request -- is proven where it can be proven for real: the
 * handler suite for the endpoint that writes the row, the watch-session suite
 * for what the page does with the answer, and the e2e against a real database.
 * ---------------------------------------------------------------------- */

describe("a viewer whose preferences cannot be read", () => {
  it("is reported as not having chosen, rather than as having chosen nothing", async () => {
    /*
     * THE DIRECTION IS THE WHOLE TEST. `stored: false` sends the watch page
     * down the "use the conservative default" branch; `stored: true` with
     * empty lists would send it down the "this viewer prefers no language"
     * branch. A failed read must land on the behaviour the product already
     * had, not on an opt-out the viewer never expressed.
     */
    const answer = await loadMediaPreferences(new Headers());

    expect(answer.stored).toBe(false);
    expect(answer.preferences).toEqual(NO_MEDIA_PREFERENCES);
  });

  it("does not throw on a header bag it cannot make sense of", async () => {
    /*
     * This runs inside the watch page's render. A page whose failure mode is a
     * stack trace is a page with no player on it, which is the trade this
     * loader refuses to make for a settings lookup.
     */
    const headers = new Headers({
      cookie: "liberty_session=not-a-session",
      "x-liberty-development-account": "",
      "x-not-yet-invented": "carried"
    });

    await expect(loadMediaPreferences(headers)).resolves.toMatchObject({ stored: false });
  });

  it("hands back a value a caller cannot mutate for the next caller", async () => {
    /*
     * Every failure answers the same shared constant. If it were mutable, one
     * caller pushing a language onto the list it was given would change what
     * every later render saw -- a cross-request leak through a module-level
     * object, which is the kind of bug that only appears under load.
     */
    const first = await loadMediaPreferences(new Headers());

    expect(() => {
      (first.preferences.preferredAudioLanguages as string[]).push("en");
    }).toThrow();

    const second = await loadMediaPreferences(new Headers());
    expect(second.preferences.preferredAudioLanguages).toEqual([]);
  });
});

/* =========================================================================
 * THE VERSIONED RECORD AND ITS MIGRATION (W132-F)
 *
 * THE CLAIM UNDER TEST IS TOTALITY, so the table below is hostile rather than
 * representative: `undefined`, primitives, an array, a function, a date, a
 * record from a build that no longer exists, and a record with every field of
 * the right name and the wrong type. The assertion for every one of them is the
 * same -- it returns, it returns something complete, and what it returns
 * satisfies the published contract. A suite that only fed it plausible objects
 * would be testing the happy path of a function whose entire purpose is the
 * unhappy one.
 * ====================================================================== */

import { mediaPreferencesSchema } from "@liberty/contracts/domains/preferences";

import {
  DEFAULT_PLAYBACK_RATE,
  DEFAULT_VIEWER_PREFERENCES,
  MAX_PLAYBACK_RATE,
  MIN_PLAYBACK_RATE,
  VIEWER_PREFERENCES_VERSION,
  migrateViewerPreferences,
  recordFromStored,
  serialiseViewerPreferences
} from "./viewer-preferences";

const HOSTILE_INPUTS: readonly [string, unknown][] = [
  ["undefined", undefined],
  ["null", null],
  ["a number", 42],
  ["NaN", Number.NaN],
  ["a string", "preferences"],
  ["the empty string", ""],
  ["true", true],
  ["an empty array", []],
  ["an array of objects", [{ subtitleMode: "off" }]],
  ["a function", () => "nope"],
  ["a Date", new Date(0)],
  ["a symbol-keyed object", { [Symbol("x")]: 1 }],
  ["every field of the wrong type", {
    version: "one",
    media: {
      preferredAudioLanguages: "en",
      preferredSubtitleLanguages: 7,
      subtitleMode: 3,
      hearingImpaired: "yes",
      playbackDiagnostics: "no"
    },
    playbackRate: "1.5x"
  }],
  ["a record from a build that no longer exists", {
    version: 0,
    audioLanguage: "ja",
    captions: "forced",
    speed: 2
  }],
  ["a record from the FUTURE", {
    version: 9999,
    media: { preferredAudioLanguages: ["ja"], subtitleMode: "off" },
    playbackRate: 1.5,
    fieldNobodyHasWrittenYet: { nested: true }
  }],
  ["a prototype-polluting shape", JSON.parse('{"__proto__":{"polluted":true},"playbackRate":1}')],
  ["Object.create(null)", Object.create(null) as unknown]
];

describe("migrateViewerPreferences is total", () => {
  for (const [label, input] of HOSTILE_INPUTS) {
    it(`does not throw and returns a complete record for ${label}`, () => {
      const record = migrateViewerPreferences(input);

      /* COMPLETE: every declared field present and of the declared type. */
      expect(typeof record.version).toBe("number");
      expect(typeof record.playbackRate).toBe("number");
      expect(Number.isFinite(record.playbackRate)).toBe(true);

      /* VALID: the contract itself is the judge, not this test's opinion. */
      expect(mediaPreferencesSchema.safeParse(record.media).success, label).toBe(true);
    });
  }

  it("never widens what a viewer may play, because it carries no such field", () => {
    /*
     * The contract's rule, asserted structurally: "A PREFERENCE IS A STATEMENT
     * ABOUT TASTE, NOT A CLAIM ABOUT ENTITLEMENT." A `maxRating` in a stored
     * record would be a client-supplied rating override, so an input carrying
     * one must not produce an output carrying one.
     */
    const record = migrateViewerPreferences({
      version: 1,
      maxRating: null,
      allowInsecureSources: true,
      entitlements: ["everything"],
      media: { preferredAudioLanguages: ["en"] }
    });

    const keys = Object.keys(serialiseViewerPreferences(record));
    expect(keys.sort()).toEqual(["media", "playbackRate", "version"]);
    expect(JSON.stringify(record)).not.toContain("maxRating");
    expect(JSON.stringify(record)).not.toContain("allowInsecureSources");
  });
});

describe("recovery is field-by-field, not all-or-nothing", () => {
  it("keeps the good languages when one tag is unusable", () => {
    /*
     * THE POINT OF THE DESIGN. A single `safeParse` would answer the neutral
     * record here and the viewer would lose a ranking they spent time on
     * because of one bad entry written by an older build.
     */
    const record = migrateViewerPreferences({
      version: 1,
      media: {
        preferredAudioLanguages: ["ja", "not a language tag", "pt-BR", 7, null, "en"],
        preferredSubtitleLanguages: ["en"],
        subtitleMode: "auto",
        hearingImpaired: false,
        playbackDiagnostics: true
      },
      playbackRate: 1
    });

    expect(record.media.preferredAudioLanguages).toEqual(["ja", "pt-BR", "en"]);
    expect(record.media.preferredSubtitleLanguages).toEqual(["en"]);
  });

  it("keeps the order the viewer ranked and never sorts", () => {
    const record = migrateViewerPreferences({
      media: { preferredAudioLanguages: ["pt-BR", "ja", "en", "de"] }
    });
    expect(record.media.preferredAudioLanguages).toEqual(["pt-BR", "ja", "en", "de"]);
  });

  it("drops a repeated tag and keeps the first, more-preferred mention", () => {
    const record = migrateViewerPreferences({
      media: { preferredAudioLanguages: ["ja", "EN", "en", "ja"] }
    });
    expect(record.media.preferredAudioLanguages).toEqual(["ja", "EN"]);
  });

  it("truncates an over-long list to the most preferred rather than discarding it", () => {
    const nine = ["aa", "ab", "ac", "ad", "ae", "af", "ag", "ah", "ai"];
    const record = migrateViewerPreferences({
      media: { preferredAudioLanguages: nine }
    });
    expect(record.media.preferredAudioLanguages).toEqual(nine.slice(0, 8));
  });

  it("replaces an unknown subtitle mode rather than passing it to a policy", () => {
    /* `subtitlePolicySchema` branches on this value and has no arm for a third
     * one, so an unknown mode must not survive the read. */
    expect(migrateViewerPreferences({ media: { subtitleMode: "on" } }).media.subtitleMode).toBe(
      "auto"
    );
    expect(migrateViewerPreferences({ media: { subtitleMode: "off" } }).media.subtitleMode).toBe(
      "off"
    );
  });

  it("keeps a diagnostics opt-out and does not invent one", () => {
    /*
     * THE ASYMMETRY IS THE WHOLE RULE. `playbackDiagnostics` is the one field
     * whose neutral value is `true`, so an ABSENT value must come back `true`
     * -- `=== true` would silently revoke consent for every record written
     * before the field existed -- while a stored `false` is a viewer's choice
     * and must survive.
     */
    expect(migrateViewerPreferences({ media: {} }).media.playbackDiagnostics).toBe(true);
    expect(
      migrateViewerPreferences({ media: { playbackDiagnostics: false } }).media.playbackDiagnostics
    ).toBe(false);
    /* A damaged non-boolean is not an opt-out. */
    expect(
      migrateViewerPreferences({ media: { playbackDiagnostics: "false" } }).media
        .playbackDiagnostics
    ).toBe(true);
  });

  it("reads a bare media object as well as an envelope", () => {
    /* What `readMediaPreferences` returns today has no envelope around it. */
    const record = migrateViewerPreferences({
      preferredAudioLanguages: ["ja"],
      preferredSubtitleLanguages: [],
      subtitleMode: "off",
      hearingImpaired: true,
      playbackDiagnostics: false
    });
    expect(record.media.preferredAudioLanguages).toEqual(["ja"]);
    expect(record.media.subtitleMode).toBe("off");
    expect(record.media.hearingImpaired).toBe(true);
    expect(record.media.playbackDiagnostics).toBe(false);
  });

  it("carries an unknown version forward rather than refusing the record", () => {
    const record = migrateViewerPreferences({
      version: 9999,
      media: { preferredAudioLanguages: ["ja"] }
    });
    expect(record.version).toBe(9999);
    expect(record.media.preferredAudioLanguages).toEqual(["ja"]);
  });

  it("stamps this build's version on a record that carries none", () => {
    expect(migrateViewerPreferences({ media: {} }).version).toBe(VIEWER_PREFERENCES_VERSION);
  });
});

describe("the playback rate can never reach a media element as an unusable number", () => {
  /*
   * `HTMLMediaElement.playbackRate` throws for an unsupported value and stalls
   * for `0`. Every one of these is a value a damaged or hostile record can
   * hold, and the start of playback is the worst place to find out.
   */
  const cases: readonly [unknown, number][] = [
    [0, MIN_PLAYBACK_RATE],
    [-1, MIN_PLAYBACK_RATE],
    [-0, MIN_PLAYBACK_RATE],
    [0.01, MIN_PLAYBACK_RATE],
    [1e9, MAX_PLAYBACK_RATE],
    /*
     * AN INFINITY IS NOT AN EXTREME PREFERENCE, IT IS A DAMAGED VALUE, so it
     * lands on the default rather than on a bound. The distinction matters:
     * clamping `Infinity` to 4 would assert that this viewer asked for
     * quadruple speed, and a finite `1e9` is at least a number somebody or
     * something computed. `Number.isFinite` draws exactly that line and is
     * tested before any comparison, because `NaN` fails every comparison and
     * would otherwise fall through whichever branch was written last.
     */
    [Number.POSITIVE_INFINITY, DEFAULT_PLAYBACK_RATE],
    [Number.NEGATIVE_INFINITY, DEFAULT_PLAYBACK_RATE],
    [Number.NaN, DEFAULT_PLAYBACK_RATE],
    ["1.5", DEFAULT_PLAYBACK_RATE],
    [null, DEFAULT_PLAYBACK_RATE],
    [undefined, DEFAULT_PLAYBACK_RATE],
    [1.5, 1.5],
    [1.75, 1.75],
    [MIN_PLAYBACK_RATE, MIN_PLAYBACK_RATE],
    [MAX_PLAYBACK_RATE, MAX_PLAYBACK_RATE]
  ];

  for (const [input, expected] of cases) {
    it(`maps ${String(input)} to ${String(expected)}`, () => {
      expect(migrateViewerPreferences({ playbackRate: input }).playbackRate).toBe(expected);
    });
  }

  it("keeps a rate that is in range but not on the control's ladder", () => {
    /* A household that set 1.9 in a build with a finer ladder said something
     * real; a later build narrowing its own menu is not a reason to overwrite
     * it. */
    expect(migrateViewerPreferences({ playbackRate: 1.9 }).playbackRate).toBe(1.9);
  });
});

describe("the record is serialisable and the default is immutable", () => {
  it("round-trips through JSON without loss", () => {
    const record = migrateViewerPreferences({
      version: 1,
      media: {
        preferredAudioLanguages: ["ja", "en"],
        preferredSubtitleLanguages: ["en"],
        subtitleMode: "off",
        hearingImpaired: true,
        playbackDiagnostics: false
      },
      playbackRate: 1.5
    });

    const again = migrateViewerPreferences(
      JSON.parse(JSON.stringify(serialiseViewerPreferences(record)))
    );
    expect(again).toEqual(record);
  });

  it("serialises the declared fields and nothing a caller attached", () => {
    const record = {
      ...migrateViewerPreferences({ media: {} }),
      smuggled: "value"
    } as unknown as Parameters<typeof serialiseViewerPreferences>[0];
    expect(Object.keys(serialiseViewerPreferences(record)).sort()).toEqual([
      "media",
      "playbackRate",
      "version"
    ]);
  });

  it("copies the arrays, so a caller cannot mutate what was serialised", () => {
    const record = migrateViewerPreferences({ media: { preferredAudioLanguages: ["ja"] } });
    const serialised = serialiseViewerPreferences(record) as {
      media: { preferredAudioLanguages: string[] };
    };
    serialised.media.preferredAudioLanguages.push("en");
    expect(record.media.preferredAudioLanguages).toEqual(["ja"]);
  });

  it("the default record cannot be edited for the next caller", () => {
    /* The same cross-request-leak property the suite above pins for
     * `NOT_CHOSEN`: a shared frozen constant, not a shared mutable one. */
    expect(() => {
      (DEFAULT_VIEWER_PREFERENCES as { playbackRate: number }).playbackRate = 2;
    }).toThrow();
    expect(DEFAULT_VIEWER_PREFERENCES.playbackRate).toBe(DEFAULT_PLAYBACK_RATE);
  });

  it("recordFromStored keeps the values and drops no distinction", () => {
    /*
     * `stored` IS NOT IN THE RECORD, ON PURPOSE. "Never chosen" and "chose
     * nothing" is a distinction the settings screen needs and a player does
     * not, so it stays on the read result and is handed over separately. This
     * pins that the bridge does not quietly flatten it in.
     */
    const record = recordFromStored({
      stored: true,
      preferences: {
        preferredAudioLanguages: ["ja"],
        preferredSubtitleLanguages: [],
        subtitleMode: "off",
        hearingImpaired: false,
        playbackDiagnostics: true
      }
    });
    expect(record.media.preferredAudioLanguages).toEqual(["ja"]);
    expect(record.playbackRate).toBe(DEFAULT_PLAYBACK_RATE);
    expect("stored" in record).toBe(false);
  });
});
