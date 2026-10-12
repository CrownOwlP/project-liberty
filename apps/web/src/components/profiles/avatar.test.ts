import { describe, expect, it, vi } from "vitest";

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

/* =========================================================================
 * THE MODERN-API GUARDS (W132-F)
 *
 * ==========================================================================
 * WHY THIS BLOCK EXISTS AT ALL
 * ==========================================================================
 *
 * This module's header used to say the fallback "exists FOR THE TYPE rather
 * than for a known runtime". That sentence is the defect: it is how a fallback
 * comes to be written, left unexecuted, and found to be broken only when a
 * household hits it. The old fallback was `trimmed.slice(0, 1)`, which returns
 * a LONE HIGH SURROGATE for exactly the astral names the segmenter was added to
 * handle -- so the degraded path reproduced the bug the good path fixed, and no
 * test had ever run it.
 *
 * The runtime that makes this real is the PACKAGED DESKTOP BUILD. It renders in
 * WebView2, whose version is whatever Edge runtime the host Windows machine
 * carries -- not something this repository pins, and not something the Next.js
 * compiler can reach, because `Intl.Segmenter` is a BUILT-IN rather than
 * syntax: there is nothing to transpile and no polyfill is injected. A build is
 * green and the feature is missing at the only moment it is used.
 *
 * So the degraded paths are EXECUTED here, by taking the API away.
 * `vi.stubGlobal` is not used: `Intl` is read as a global binding inside the
 * function, and what has to be simulated is the property being ABSENT from the
 * real `Intl` -- which is what a trimmed ICU build looks like.
 * ====================================================================== */

type SegmenterSlot = { Segmenter?: unknown };

/**
 * Run `body` with `Intl.Segmenter` replaced, and always put it back.
 *
 * The restore is in a `finally` so a failing assertion cannot leak a broken
 * `Intl` into every later test in this process -- which would turn one red test
 * into a file of unrelated ones and hide the real failure.
 */
function withSegmenter<T>(replacement: unknown, body: () => T): T {
  const slot = Intl as unknown as SegmenterSlot;
  const original = slot.Segmenter;
  try {
    if (replacement === undefined) delete slot.Segmenter;
    else slot.Segmenter = replacement;
    return body();
  } finally {
    slot.Segmenter = original;
  }
}

describe("profileInitial survives a runtime without Intl.Segmenter", () => {
  it("still answers an initial when the API is missing entirely", () => {
    withSegmenter(undefined, () => {
      expect(profileInitial("Sam")).toBe("S");
    });
  });

  it("KEEPS AN ASTRAL CHARACTER WHOLE ON THE FALLBACK PATH", () => {
    /*
     * THE ASSERTION THE OLD FALLBACK FAILED. `"🎬".slice(0, 1)` is an unpaired
     * high surrogate, which every renderer draws as U+FFFD -- a replacement
     * glyph on precisely the names the segmenter exists for. The fallback is
     * now code-point aware, so the degraded answer is the real character.
     */
    withSegmenter(undefined, () => {
      const initial = profileInitial("🎬 Movie Night");
      expect(initial).toBe("🎬");
      expect(initial).not.toContain("�");
      /* Two code units, one code point: a complete character, not half of one. */
      expect(initial).toHaveLength(2);
    });
  });

  it("never answers a lone surrogate for any astral name", () => {
    withSegmenter(undefined, () => {
      for (const name of ["🎬x", "𝐀lice", "👨‍👩‍👧 Family", "🇯🇵 Japan"]) {
        const initial = profileInitial(name);
        expect(initial, name).not.toBeNull();
        const first = (initial as string).charCodeAt(0);
        /* If the first unit is a high surrogate, a low surrogate must follow. */
        if (first >= 0xd800 && first <= 0xdbff) {
          expect((initial as string).length, name).toBeGreaterThanOrEqual(2);
          const second = (initial as string).charCodeAt(1);
          expect(second, name).toBeGreaterThanOrEqual(0xdc00);
          expect(second, name).toBeLessThanOrEqual(0xdfff);
        }
      }
    });
  });

  it("survives a Segmenter whose constructor throws", () => {
    /* A trimmed ICU that exposes the class and rejects `granularity:
     * "grapheme"`. The old code called `new Segmenter(...)` unguarded, so this
     * was a TypeError inside a React render: a blank screen in exchange for one
     * letter on a tile. */
    withSegmenter(
      class {
        constructor() {
          throw new TypeError("granularity not supported");
        }
      },
      () => {
        expect(profileInitial("Sam")).toBe("S");
      }
    );
  });

  it("survives a Segmenter whose segments are not iterable", () => {
    /*
     * THE SHARPEST OF THE THREE, and the one the original guard did not
     * consider. `const [first] = ...segment(name)` DESTRUCTURES, and
     * destructuring requires `Symbol.iterator`. An implementation that exposes
     * `Segmenter` without an iterable `Segments` throws from a line that looks
     * like it is only reading a value.
     */
    withSegmenter(
      class {
        segment() {
          return { containing: () => undefined };
        }
      },
      () => {
        expect(profileInitial("Sam")).toBe("S");
      }
    );
  });

  it("falls back rather than answering null when a segment is empty or not a string", () => {
    /* A non-conforming implementation that yields a junk segment must not make
     * this function report "this name has no initial" for a name that plainly
     * has one. */
    withSegmenter(
      class {
        *segment() {
          yield { segment: "" };
        }
      },
      () => {
        expect(profileInitial("Sam")).toBe("S");
      }
    );
    withSegmenter(
      class {
        *segment() {
          yield { segment: 7 };
        }
      },
      () => {
        expect(profileInitial("Sam")).toBe("S");
      }
    );
  });

  it("still returns null for a name with nothing in it, with or without the API", () => {
    /* The one case where `null` IS the answer: there is no character to draw,
     * and this function does not invent a "?" that would then be somebody's
     * initial. */
    withSegmenter(undefined, () => {
      expect(profileInitial("   ")).toBeNull();
      expect(profileInitial("")).toBeNull();
    });
  });

  it("nothing in this module touches a modern API at evaluation time", async () => {
    /*
     * A FEATURE TEST AT MODULE SCOPE WOULD TAKE DOWN EVERY SCREEN THAT IMPORTS
     * THIS FILE rather than one initial. The rule is that every decision about
     * runtime capability is inside a function body -- asserted here by
     * importing the module fresh with the API removed, which is what a packaged
     * build on an old WebView2 does on first paint.
     */
    vi.resetModules();
    const loaded = await withSegmenter(undefined, async () => {
      const fresh = await import("./avatar");
      return fresh.profileInitial("Sam");
    });
    expect(loaded).toBe("S");
  });
});
