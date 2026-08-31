/* -------------------------------------------------------------------------
 * The registry's own invariants (PL-0503)
 *
 * `cmcd-collect.test.ts` already asserts what the collector DOES with a
 * classification. This file asserts the classification itself, because that is
 * where the leak control actually lives: the collector's redaction and the
 * player's `includeKeys` are two consumers of one table, and both of them are
 * only as strong as the table's refusal to let a key be born "safe".
 *
 * TWO OF THESE TESTS READ THIS PACKAGE'S SOURCE, deliberately, in the idiom
 * `apps/web/.../diagnostics/av-continuity.test.ts` uses for its prohibited-API
 * scan. A type is checked by `tsc`, which runs as its own gate and can be made
 * to pass again by re-adding a default — the scan is what makes re-adding one a
 * failing test rather than a quiet regression, and it states in the failure
 * message why the default is the leak.
 * ---------------------------------------------------------------------- */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CMCD_V2_CLIENT_SAFE_KEYS,
  CMCD_V2_KEYS,
  CMCD_V2_URL_BEARING_KEYS,
  cmcdKeySpec
} from "./cmcd-keys";

const SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "cmcd-keys.ts"), "utf8");

/**
 * The source with its comments removed.
 *
 * Load-bearing rather than tidy: the file header EXPLAINS the removed default by
 * quoting it, so a scan of the raw text for `sensitivity: CmcdSensitivity =`
 * would find the sentence describing the fix and fail. Deleting the explanation
 * to make the test pass would delete the reason the rule exists, which is the
 * wrong side of that trade.
 */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/[^\n]*$/gm, "");

/**
 * Every `<key>: spec(...)` line of the registry literal, key and arguments.
 *
 * Split on newlines and trimmed rather than matched with a `$`-anchored regex,
 * because this repository is checked out with CRLF on Windows and a trailing
 * `\r` would make the anchor fail — producing an empty match set and a scan that
 * passes by finding nothing, which is the worst way for a security test to fail.
 * The line COUNT is asserted against the registry below for the same reason: a
 * scan that matched nothing would otherwise satisfy every per-line assertion.
 */
const REGISTRY_LINES: readonly (readonly [string, string])[] = SOURCE.split("\n")
  .map((line) => /^ {2}([a-z]+): spec\((.*)\),?$/.exec(line.replace(/\r$/, "")))
  .filter((match): match is RegExpExecArray => match !== null)
  .map((match) => [match[1] ?? "", match[2] ?? ""] as const);

describe("a key cannot be born safe", () => {
  it("declares no default for `sensitivity`, because the default would be the permissive answer", () => {
    /*
     * THIS IS THE DEFECT THIS FILE WAS WRITTEN FOR. `spec()` shipped with
     * `sensitivity: CmcdSensitivity = "safe"`, so the header's claim that an
     * unclassified key is a compile error was false, and the next CTA-5004-B
     * key would have entered `CMCD_V2_CLIENT_SAFE_KEYS` without anyone
     * deciding that it should.
     */
    expect(CODE).toContain("sensitivity: CmcdSensitivity,");
    expect(CODE).not.toMatch(/sensitivity: CmcdSensitivity\s*=/);
  });

  it("names a sensitivity at every entry in the registry literal", () => {
    // The type already forces this; the scan is what survives someone
    // reinstating a default and making the type stop forcing it.
    expect(REGISTRY_LINES.length).toBe(Object.keys(CMCD_V2_KEYS).length);
    for (const [key, args] of REGISTRY_LINES) {
      expect(args, key).toMatch(/^"[a-z-]+", "(safe|url-bearing)"/);
    }
  });

  it("classifies every registry entry as exactly one of the two sensitivities", () => {
    for (const [key, keySpec] of Object.entries(CMCD_V2_KEYS)) {
      expect(["safe", "url-bearing"], key).toContain(keySpec.sensitivity);
    }
  });
});

describe("the two client lists partition the registry", () => {
  it("puts every key in exactly one list, whatever the registry grows into", () => {
    // Asserted as a partition rather than as "url, nor and h are excluded",
    // which is a claim about today's registry and would keep passing after a
    // new URL-bearing key was added and misclassified.
    const registry = Object.keys(CMCD_V2_KEYS).sort();
    expect([...CMCD_V2_CLIENT_SAFE_KEYS, ...CMCD_V2_URL_BEARING_KEYS].sort()).toEqual(registry);
    for (const key of CMCD_V2_CLIENT_SAFE_KEYS) {
      expect(CMCD_V2_URL_BEARING_KEYS, key).not.toContain(key);
    }
  });

  it("keeps the URL-bearing list non-empty, so the partition test cannot pass vacuously", () => {
    expect(CMCD_V2_URL_BEARING_KEYS.length).toBeGreaterThan(0);
    for (const key of CMCD_V2_URL_BEARING_KEYS) {
      expect(cmcdKeySpec(key)?.sensitivity, key).toBe("url-bearing");
    }
  });

  it("keeps the safe list non-empty, because an empty includeKeys means ALL keys to Shaka", () => {
    /*
     * NOT A TAUTOLOGY. `CmcdManager.toReporterConfig_` in shaka-player 5.2.6
     * substitutes `allKeysForVersion_(2)` — every request, response and event
     * key, `url` and `nor` among them — when `includeKeys` is empty. So the
     * failure mode of a filter that removed everything is not silence, it is
     * the full vocabulary on the wire.
     */
    expect(CMCD_V2_CLIENT_SAFE_KEYS.length).toBeGreaterThan(0);
  });

  it("is sorted, so a consumer's configuration depends on content and not declaration order", () => {
    expect([...CMCD_V2_URL_BEARING_KEYS]).toEqual([...CMCD_V2_URL_BEARING_KEYS].sort());
  });
});

describe("units are asserted only where CTA-5004-B is unambiguous", () => {
  it("gives the wall-clock key its own unit so it cannot be read as a duration", () => {
    expect(cmcdKeySpec("ts")?.unit).toBe("epoch-ms");
    expect(cmcdKeySpec("msd")?.unit).toBe("ms");
  });

  it("leaves a key whose unit the specification does not define unlabelled", () => {
    // A wrong label is believed; an absent one is read as "do not assume".
    for (const key of ["ab", "bsa", "lab", "lb", "pb", "tab", "tbl", "tpb"]) {
      expect(cmcdKeySpec(key)?.unit, key).toBeNull();
    }
  });
});
