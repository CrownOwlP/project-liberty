import { describe, expect, it } from "vitest";
import {
  MAX_AVATAR_KEY_CODE_POINTS,
  MAX_DISPLAY_NAME_CODE_POINTS,
  MAX_PROFILES_PER_ACCOUNT,
  MAX_RATING_LABEL_CODE_POINTS,
  PROFILE_CREATION_CHECK_ORDER,
  PROFILE_CREATION_CONSTRAINT_REFUSALS,
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
    //
    // EXTENDED WITH TWO CASES on the audit that bounded `avatarKey` and
    // `maxRating`. The test walks the published order and needs one failing
    // input per entry, so growing the order grows this list -- the assertion
    // itself is unchanged and still fails if the order does not match.
    const reasons = [
      resolveProfileCreation(
        request({ existingProfileCount: MAX_PROFILES_PER_ACCOUNT, displayName: "   " })
      ),
      resolveProfileCreation(request({ displayName: "" })),
      resolveProfileCreation(request({ displayName: "n".repeat(MAX_DISPLAY_NAME_CODE_POINTS + 1) })),
      resolveProfileCreation(request({ avatarKey: "a".repeat(MAX_AVATAR_KEY_CODE_POINTS + 1) })),
      resolveProfileCreation(request({ maxRating: "R".repeat(MAX_RATING_LABEL_CODE_POINTS + 1) }))
    ].map((resolution) => (resolution.ok ? "accepted" : resolution.reason));

    expect(reasons).toEqual([...PROFILE_CREATION_CHECK_ORDER]);
  });

  it("reports the display name before either optional field", () => {
    // Precedence between the new checks and the old ones, asserted directly
    // rather than only as a by-product of the walk above: the required field the
    // account holder is looking at is the one worth naming first.
    const resolution = resolveProfileCreation(
      request({
        displayName: "   ",
        avatarKey: "a".repeat(MAX_AVATAR_KEY_CODE_POINTS + 1),
        maxRating: "R".repeat(MAX_RATING_LABEL_CODE_POINTS + 1)
      })
    );

    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.reason).toBe("display_name_is_blank");
  });

  it("reports the avatar key before the rating label", () => {
    const resolution = resolveProfileCreation(
      request({
        avatarKey: "a".repeat(MAX_AVATAR_KEY_CODE_POINTS + 1),
        maxRating: "R".repeat(MAX_RATING_LABEL_CODE_POINTS + 1)
      })
    );

    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.reason).toBe("avatar_key_too_long");
  });

  it("produces an identical resolution when called repeatedly with identical input", () => {
    // Determinism as a test rather than a comment: nothing here reads a clock, a
    // counter or a random source.
    const input = request({ displayName: "  Kids  ", avatarKey: "" });
    expect(resolveProfileCreation(input)).toEqual(resolveProfileCreation(input));
  });
});

describe("the optional fields are bounded too", () => {
  /**
   * The asymmetry this closes.
   *
   * `MAX_DISPLAY_NAME_CODE_POINTS` existed because `text` is unbounded and the
   * writer is authenticated. Both of those are equally true of `avatar_key` and
   * `max_rating`, which were only trimmed -- so a cap on one column of three was
   * not a bound on the row, and nothing in the module said why the other two
   * differed. They do not differ.
   *
   * The two cases share one table below, with a builder each. It is annotated
   * rather than inferred, and a builder rather than a computed key, because
   * `{ [field]: value }` with a union-typed key infers a string index signature,
   * which stops being assignable to the request shape the moment one of that
   * shape's fields is not a string -- and `existingProfileCount` is a number.
   */
  const optionalFields: readonly {
    readonly field: string;
    readonly limit: number;
    readonly reason: string;
    readonly build: (value: string) => Partial<Parameters<typeof resolveProfileCreation>[0]>;
  }[] = [
    {
      field: "avatarKey",
      limit: MAX_AVATAR_KEY_CODE_POINTS,
      reason: "avatar_key_too_long",
      build: (value) => ({ avatarKey: value })
    },
    {
      field: "maxRating",
      limit: MAX_RATING_LABEL_CODE_POINTS,
      reason: "max_rating_too_long",
      build: (value) => ({ maxRating: value })
    }
  ];

  it.each(optionalFields)(
    "accepts $field at the limit and refuses it one past",
    ({ limit, reason, build }) => {
      // Both sides of the boundary, for the reason the ceiling test gives: a `>=`
      // where a `>` belongs refuses a legitimate value at the stated limit, and
      // no single-sided test notices.
      const atLimit = resolveProfileCreation(request(build("x".repeat(limit))));
      const pastLimit = resolveProfileCreation(request(build("x".repeat(limit + 1))));

      expect(atLimit.ok).toBe(true);
      expect(pastLimit.ok).toBe(false);
      if (pastLimit.ok) return;
      expect(pastLimit.reason).toBe(reason);
    }
  );

  it.each(optionalFields)("never echoes an over-long $field into its own refusal", ({ limit, build }) => {
    // The refusal is about a field being enormous; putting the field IN the
    // refusal moves the same unbounded string from the database into the log
    // aggregator. The detail carries the two numbers instead.
    const enormous = "x".repeat(limit + 500);
    const resolution = resolveProfileCreation(request(build(enormous)));

    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.detail).not.toContain(enormous);
    expect(resolution.detail).toContain(String(limit + 500));
    expect(resolution.detail).toContain(String(limit));
  });

  it("counts the optional fields in code points as well, not UTF-16 units", () => {
    // The same argument as the display name, one field over: an astral
    // character is two UTF-16 units, so counting them halves the stated limit
    // for anybody whose value contains one.
    const astral = String.fromCodePoint(0x1f603).repeat(MAX_RATING_LABEL_CODE_POINTS);
    expect(astral.length).toBeGreaterThan(MAX_RATING_LABEL_CODE_POINTS);
    expect(resolveProfileCreation(request({ maxRating: astral })).ok).toBe(true);
  });

  it("measures after trimming, so surrounding whitespace cannot exceed the limit", () => {
    // The value judged has to be the value stored, or the resolver is measuring
    // something the repository will not write.
    const padded = `${" ".repeat(MAX_RATING_LABEL_CODE_POINTS)}PG${" ".repeat(MAX_RATING_LABEL_CODE_POINTS)}`;
    const resolution = resolveProfileCreation(request({ maxRating: padded }));

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.maxRating).toBe("PG");
  });

  it("still turns a blank optional field into null rather than measuring it", () => {
    // The bound must not have displaced the "unknown is not a value" rule that
    // was already here.
    const resolution = resolveProfileCreation(request({ avatarKey: "   ", maxRating: "" }));

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.avatarKey).toBeNull();
    expect(resolution.maxRating).toBeNull();
  });
});

describe("the refusal vocabulary", () => {
  it("is the resolver's order plus the refusals only the database can reach", () => {
    // Two lists rather than one, because a collision is not decidable from the
    // facts `resolveProfileCreation` is given. Folding
    // `display_name_already_used` into PROFILE_CREATION_CHECK_ORDER would claim
    // a precedence between checks that never run in the same place.
    expect([...PROFILE_CREATION_CONSTRAINT_REFUSALS]).toEqual(["display_name_already_used"]);
    for (const constraintReason of PROFILE_CREATION_CONSTRAINT_REFUSALS) {
      expect([...PROFILE_CREATION_CHECK_ORDER]).not.toContain(constraintReason);
    }
  });

  it("never lets the pure resolver emit a reason only the database can decide", () => {
    // Stated negatively, which is the version that catches the regression: a
    // read-then-write duplicate check added to this module would have to reach
    // for `display_name_already_used`, and this is where that shows up. Every
    // refusal `resolveProfileCreation` can produce must come from its own
    // published order.
    const resolutions = [
      resolveProfileCreation(request({ existingProfileCount: MAX_PROFILES_PER_ACCOUNT })),
      resolveProfileCreation(request({ displayName: "   " })),
      resolveProfileCreation(request({ displayName: "n".repeat(MAX_DISPLAY_NAME_CODE_POINTS + 1) })),
      resolveProfileCreation(request({ avatarKey: "a".repeat(MAX_AVATAR_KEY_CODE_POINTS + 1) })),
      resolveProfileCreation(request({ maxRating: "R".repeat(MAX_RATING_LABEL_CODE_POINTS + 1) }))
    ];

    for (const resolution of resolutions) {
      expect(resolution.ok).toBe(false);
      if (resolution.ok) continue;
      expect([...PROFILE_CREATION_CHECK_ORDER]).toContain(resolution.reason);
    }
  });

  it("accepts a name that would collide, because collisions are not its question", () => {
    // The resolver is given a count and three strings. Whether another row
    // already holds this name is not among them, and inventing an answer here
    // is the read-then-write race `createProfile` explains at `insertProfileRow`.
    expect(resolveProfileCreation(request({ displayName: "Dad" })).ok).toBe(true);
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
