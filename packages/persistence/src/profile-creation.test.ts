import { describe, expect, it } from "vitest";
import {
  MAX_DISPLAY_NAME_CODE_POINTS,
  MAX_PROFILES_PER_ACCOUNT,
  PROFILE_CREATION_CHECK_ORDER,
  isMintedProfileId,
  normalizeDisplayName,
  normalizeOptionalField,
  resolveProfileCreation
} from "./profile-creation";

/**
 * What a profile may be called, and how many there may be (PL-0402).
 *
 * The properties under test:
 *
 *   - BOUNDED. There is a ceiling, it is a number, and the boundary is asserted
 *     on both sides -- an off-by-one here ships a limit one larger than the one
 *     that was reviewed, silently.
 *   - UNKNOWN IS NOT A VALUE. A blank display name is refused rather than stored
 *     as `""` or as an invented "Profile 1"; a blank optional field becomes
 *     `null` rather than `""`. Both directions are asserted, because the defect
 *     is the same one and only its remedy differs.
 *   - CANONICAL. Two names that render identically are one name, so the
 *     `UNIQUE (user_id, display_name)` constraint means what its comment claims.
 *   - PRECEDENCE-STABLE. More than one rule can be broken at once and which is
 *     reported is a policy, not a statement-order artefact.
 *
 * The invisible characters below are written as escapes rather than pasted, for
 * the reason the module gives: a literal zero-width space in a test file is a
 * test nobody can read in a diff.
 */

const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);
const ZERO_WIDTH_JOINER = String.fromCodePoint(0x200d);
const NO_BREAK_SPACE = String.fromCodePoint(0x00a0);
const IDEOGRAPHIC_SPACE = String.fromCodePoint(0x3000);
const LEFT_TO_RIGHT_MARK = String.fromCodePoint(0x200e);
const COMBINING_ACUTE = String.fromCodePoint(0x0301);

const request = (over: Partial<Parameters<typeof resolveProfileCreation>[0]> = {}) => ({
  existingProfileCount: 0,
  displayName: "Dad",
  avatarKey: null,
  maxRating: null,
  ...over
});

describe("normalizeDisplayName", () => {
  it.each([
    { name: "empty", input: "" },
    { name: "spaces", input: "   " },
    { name: "a tab and a newline", input: "\t\n" },
    { name: "a no-break space", input: NO_BREAK_SPACE },
    { name: "an ideographic space", input: IDEOGRAPHIC_SPACE },
    // The one `.trim()` does not catch: U+200B is a format character, not
    // whitespace, so a name made of them survives every naive check and renders
    // as an unlabelled tile.
    { name: "zero-width spaces", input: `${ZERO_WIDTH_SPACE}${ZERO_WIDTH_SPACE}` },
    { name: "a left-to-right mark", input: LEFT_TO_RIGHT_MARK },
    { name: "joiners alone", input: `${ZERO_WIDTH_JOINER}${ZERO_WIDTH_JOINER}` },
    { name: "a mixture of invisibles", input: ` ${ZERO_WIDTH_SPACE}\t${ZERO_WIDTH_JOINER} ` }
  ])("returns null for a name that is only $name", ({ input }) => {
    // null, never "". The whole point is that the absence of a name is
    // representable as an absence rather than as a value that looks like one.
    expect(normalizeDisplayName(input)).toBeNull();
  });

  it("trims and collapses, so padding cannot produce a second indistinguishable name", () => {
    // This is the live defect the normaliser closes: UNIQUE (user_id,
    // display_name) is on the raw column, so "Dad" and "Dad " were two rows that
    // render the same on the only screen that shows them.
    expect(normalizeDisplayName("  Dad  ")).toBe("Dad");
    expect(normalizeDisplayName("Dad  Junior")).toBe("Dad Junior");
    expect(normalizeDisplayName(`Dad${NO_BREAK_SPACE}Junior`)).toBe("Dad Junior");
  });

  it("treats a control character as a separator, not as nothing", () => {
    // A newline pasted out of another application sits BETWEEN two words.
    // Deleting it -- which is what stripping every non-printing character would
    // do -- silently joins two words the account holder kept apart, and the
    // result is a name they never typed.
    expect(normalizeDisplayName("Dad\nJunior")).toBe("Dad Junior");
    expect(normalizeDisplayName("Dad\tJunior")).toBe("Dad Junior");
    // A zero-width character, by contrast, really does occupy no space and is
    // removed rather than turned into one.
    expect(normalizeDisplayName(`Dad${ZERO_WIDTH_SPACE}Junior`)).toBe("DadJunior");
  });

  it("normalises to NFC, so a combining accent and a precomposed character are one name", () => {
    const decomposed = `Ren${"e"}${COMBINING_ACUTE}`;
    const precomposed = "René";

    expect(normalizeDisplayName(decomposed)).toBe(normalizeDisplayName(precomposed));
    expect(normalizeDisplayName(decomposed)).toBe(precomposed);
  });

  it("keeps a joiner that is holding a name together", () => {
    // The exception in the filter. Stripping every format character would take a
    // family emoji apart into its component people, which is a rendering change
    // to a name the account holder chose.
    const family = `Us ${String.fromCodePoint(0x1f469)}${ZERO_WIDTH_JOINER}${String.fromCodePoint(0x1f467)}`;
    expect(normalizeDisplayName(family)).toBe(family);
  });

  it("leaves an ordinary name exactly as it was", () => {
    // The assertion that keeps the normaliser from being over-eager: the common
    // case must be a fixed point, or every existing name changes on the next write.
    expect(normalizeDisplayName("Dad")).toBe("Dad");
  });
});

describe("normalizeOptionalField", () => {
  it.each([null, "", "   ", "\t"])("turns %j into null", (input) => {
    // `avatarKey: ""` is a third state meaning the same thing as null and not
    // comparing equal to it, so `avatar_key IS NULL` stops finding the profiles
    // that have no avatar.
    expect(normalizeOptionalField(input)).toBeNull();
  });

  it("trims but does not otherwise rewrite an opaque key", () => {
    expect(normalizeOptionalField("  avatars/fox.png  ")).toBe("avatars/fox.png");
    // No NFC, no format stripping: this is a storage key, and silently changing
    // its bytes makes it fail to resolve for a reason nothing logs.
    expect(normalizeOptionalField(`avatars/${ZERO_WIDTH_SPACE}fox.png`)).toBe(
      `avatars/${ZERO_WIDTH_SPACE}fox.png`
    );
  });
});

describe("resolveProfileCreation", () => {
  it("accepts a profile below the ceiling and returns the normalised values", () => {
    const resolution = resolveProfileCreation(
      request({ displayName: "  Dad  ", avatarKey: "  ", maxRating: " PG " })
    );

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    // The resolver returns what will be WRITTEN. A validator that returned only
    // a boolean would leave the repository free to write the raw input.
    expect(resolution.displayName).toBe("Dad");
    expect(resolution.avatarKey).toBeNull();
    expect(resolution.maxRating).toBe("PG");
  });

  it("accepts the last profile below the ceiling and refuses the one after it", () => {
    const last = resolveProfileCreation(
      request({ existingProfileCount: MAX_PROFILES_PER_ACCOUNT - 1 })
    );
    const over = resolveProfileCreation(request({ existingProfileCount: MAX_PROFILES_PER_ACCOUNT }));

    // Both sides of the boundary, because `>` instead of `>=` ships a ceiling
    // one higher than the reviewed constant and no single-sided test notices.
    expect(last.ok).toBe(true);
    expect(over.ok).toBe(false);
    if (over.ok) return;
    expect(over.reason).toBe("profile_limit_reached");
    // The refusal says both numbers and what to do about it. "Limit reached"
    // alone leaves the account holder with no next action.
    expect(over.detail).toContain(String(MAX_PROFILES_PER_ACCOUNT));
    expect(over.detail).toContain("archive");
  });

  it("has a ceiling that is a number rather than an absence", () => {
    // `heartbeat.ts` ships an undecided `null` on purpose; this constant must
    // NOT, because an undecided ceiling is an open hole rather than a degraded
    // feature. The assertion is the difference between the two, written down.
    expect(Number.isSafeInteger(MAX_PROFILES_PER_ACCOUNT)).toBe(true);
    expect(MAX_PROFILES_PER_ACCOUNT).toBeGreaterThan(0);
  });

  it("refuses a whitespace-only display name rather than storing one", () => {
    const resolution = resolveProfileCreation(request({ displayName: "   " }));

    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.reason).toBe("display_name_is_blank");
    // The detail carries the escaped input, so "", "   " and a zero-width space
    // are three distinguishable lines in a log rather than three blanks.
    expect(resolution.detail).toContain('"   "');
  });

  it("counts the length in code points, not UTF-16 units", () => {
    // An astral character is two UTF-16 units. Counted that way, a name of
    // emoji is refused at half the stated limit -- a limit that is wrong only
    // for the users least likely to be believed when they report it.
    const emoji = String.fromCodePoint(0x1f603).repeat(MAX_DISPLAY_NAME_CODE_POINTS);
    expect(emoji.length).toBeGreaterThan(MAX_DISPLAY_NAME_CODE_POINTS);
    expect(resolveProfileCreation(request({ displayName: emoji })).ok).toBe(true);

    const tooLong = String.fromCodePoint(0x1f603).repeat(MAX_DISPLAY_NAME_CODE_POINTS + 1);
    const resolution = resolveProfileCreation(request({ displayName: tooLong }));
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.reason).toBe("display_name_too_long");
  });

  it("measures length after normalising, not before", () => {
    // A name padded past the limit with spaces that are about to be removed is
    // a legitimate name. Measuring the raw input refuses it for a reason the
    // account holder cannot see on their screen.
    const padded = `${" ".repeat(200)}Dad${" ".repeat(200)}`;
    const resolution = resolveProfileCreation(request({ displayName: padded }));

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.displayName).toBe("Dad");
  });

  it("reports the ceiling before the name when both are wrong", () => {
    // Precedence, stated: telling somebody at the limit that their name is blank
    // sends them to fix a field on a request that was never going to be accepted.
    const resolution = resolveProfileCreation(
      request({ existingProfileCount: MAX_PROFILES_PER_ACCOUNT, displayName: "   " })
    );

    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.reason).toBe("profile_limit_reached");
  });

  it("refuses in the published precedence order", () => {
    // Keeps PROFILE_CREATION_CHECK_ORDER honest as documentation rather than
    // letting it drift into decoration.
    const reasons = [
      resolveProfileCreation(
        request({ existingProfileCount: MAX_PROFILES_PER_ACCOUNT, displayName: "   " })
      ),
      resolveProfileCreation(request({ displayName: "" })),
      resolveProfileCreation(request({ displayName: "n".repeat(MAX_DISPLAY_NAME_CODE_POINTS + 1) }))
    ].map((resolution) => (resolution.ok ? "accepted" : resolution.reason));

    expect(reasons).toEqual([...PROFILE_CREATION_CHECK_ORDER]);
  });

  it("produces an identical resolution when called repeatedly with identical input", () => {
    // Determinism as a test rather than a comment: nothing here reads a clock, a
    // counter or a random source.
    const input = request({ displayName: "  Kids  ", avatarKey: "" });
    expect(resolveProfileCreation(input)).toEqual(resolveProfileCreation(input));
  });
});

describe("isMintedProfileId", () => {
  it("accepts what crypto.randomUUID produces", () => {
    // Against the real generator rather than a hand-written sample, so the
    // pattern is checked against the thing `newProfileId` actually returns.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      expect(isMintedProfileId(crypto.randomUUID())).toBe(true);
    }
  });

  it.each([
    { name: "a sequential integer", value: "1" },
    { name: "a readable slug", value: "profile_adult" },
    { name: "an empty string", value: "" },
    { name: "a v1 UUID, which encodes a timestamp and is partly predictable", value: "2c5ea4c0-4067-11e9-8bad-9b1deb4d3b7d" },
    { name: "a nil UUID", value: "00000000-0000-0000-0000-000000000000" },
    { name: "an uppercase UUID, which is not the spelling we mint", value: "9F1B2C3D-4E5F-4A6B-8C7D-0E1F2A3B4C5D" },
    { name: "a UUID with a wrong variant nibble", value: "9f1b2c3d-4e5f-4a6b-0c7d-0e1f2a3b4c5d" },
    { name: "a UUID with trailing text", value: "9f1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d'--" }
  ])("rejects $name", ({ value }) => {
    // The version nibble is the load-bearing part. A v1 UUID is the same SHAPE
    // and is partially guessable, so a format-only check would call a
    // predictable id well-formed.
    expect(isMintedProfileId(value)).toBe(false);
  });
});
