import { describe, expect, it } from "vitest";

import { avatarHue, avatarSeed, avatarStyle, profileInitial } from "./avatar";

const subject = (over: Partial<Parameters<typeof avatarHue>[0]> = {}) => ({
  id: "3f2a1b0c-0000-4000-8000-000000000001",
  displayName: "Sam",
  avatarKey: null,
  ...over
});

describe("avatarSeed", () => {
  it("hashes avatarKey when there is one", () => {
    expect(avatarSeed(subject({ avatarKey: "avatar-07" }))).toBe("avatar-07");
  });

  it("falls back to the id, never the display name", () => {
    const s = subject({ displayName: "Sam" });
    expect(avatarSeed(s)).toBe(s.id);
    expect(avatarSeed(s)).not.toBe("Sam");
  });

  it("does not change when the profile is renamed", () => {
    /*
     * The property the module exists for: a household aims at a tile by colour
     * without reading it, so renaming a profile must not move the colour.
     */
    const before = avatarHue(subject({ displayName: "Sam" }));
    const after = avatarHue(subject({ displayName: "Samantha" }));
    expect(after).toBe(before);
  });
});

describe("avatarHue", () => {
  it("is stable across calls", () => {
    expect(avatarHue(subject())).toBe(avatarHue(subject()));
  });

  it("is always a hue", () => {
    for (let index = 0; index < 500; index += 1) {
      const hue = avatarHue(subject({ avatarKey: `avatar-${String(index)}` }));
      expect(Number.isInteger(hue)).toBe(true);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });

  it("spreads a household across the wheel rather than collapsing", () => {
    /*
     * Not a quality claim about FNV -- it is four lines and makes none. This
     * asserts only that 500 distinct seeds do not land on a handful of hues,
     * which is what would make every tile in a household the same colour and
     * defeat the whole point of deriving one.
     */
    const hues = new Set(
      Array.from({ length: 500 }, (_, index) => avatarHue(subject({ avatarKey: `p-${String(index)}` })))
    );
    expect(hues.size).toBeGreaterThan(200);
  });

  it("does not throw on an empty seed", () => {
    expect(avatarHue(subject({ id: "", avatarKey: "" }))).toBe(0x811c9dc5 % 360);
  });
});

describe("avatarStyle", () => {
  it("emits only the hue, so the design system stays in CSS", () => {
    const style = avatarStyle(subject({ avatarKey: "avatar-07" }));
    expect(Object.keys(style)).toEqual(["--avatar-hue"]);
    expect(style["--avatar-hue"]).toBe(String(avatarHue(subject({ avatarKey: "avatar-07" }))));
  });
});

describe("profileInitial", () => {
  it("uppercases the first character", () => {
    expect(profileInitial("sam")).toBe("S");
  });

  it("trims before reading, so a padded name is not a blank tile", () => {
    expect(profileInitial("   ada")).toBe("A");
  });

  it("returns null for a name with nothing in it, rather than inventing a glyph", () => {
    expect(profileInitial("")).toBeNull();
    expect(profileInitial("   ")).toBeNull();
  });

  it("keeps an astral character whole", () => {
    /*
     * The defect this guards: `displayName[0]` on a name starting outside the
     * basic plane returns one half of a surrogate pair, which renders as a
     * replacement glyph. Both of these are a single grapheme.
     */
    expect(profileInitial("🐈 Cat")).toBe("🐈");
    expect(profileInitial("𝒜da")).toBe("𝒜".toLocaleUpperCase());
  });

  it("keeps a combining sequence with its base character", () => {
    expect(profileInitial("é́lodie")).toBe("é́".toLocaleUpperCase());
  });

  it("uses the name's own casing rules, not ours", () => {
    /*
     * `toLocaleUpperCase()` with NO argument. Passing our locale is how a
     * Turkish dotless i becomes an I; the assertion is that the module does
     * whatever the runtime default does and nothing locale-specific of its own.
     */
    expect(profileInitial("ırmak")).toBe("ı".toLocaleUpperCase());
  });
});

describe("purity", () => {
  it("reads no clock, no randomness, no environment and no network", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("./avatar.ts", import.meta.url), "utf8")
    );
    const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const forbidden of ["Date.", "Math.random", "process.env", "fetch(", "globalThis", "crypto."]) {
      expect(stripped).not.toContain(forbidden);
    }
    /* Non-vacuity: the stripped source is still the module. */
    expect(stripped).toContain("export function avatarHue");
    expect(stripped).toContain("Math.imul");
  });
});
