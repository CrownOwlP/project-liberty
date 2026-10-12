/* -------------------------------------------------------------------------
 * TEST-ONLY ACCESS TO THE SYNTHETIC LIVE TV FIXTURES (Wave 132, Worker E).
 *
 * UNDER `testing/`, WHICH IS A STATED BOUNDARY AND NOT A NAMING HABIT. It
 * follows `packages/net-policy/src/testing/`: a module here is test support, it
 * reads from disk with `node:fs`, and NOTHING on the application's module graph
 * may import it. `live-page-data.test.ts` asserts that the Live TV surface and
 * `../feed-configuration.ts` import neither this file nor the fixture directory,
 * because the one way a synthetic channel list reaches a user is an import added
 * to make an empty screen less embarrassing.
 *
 * `media/fixtures/livetv/README.md` states what the fixtures are: invented
 * channels on `example.invalid` hosts, which RFC 6761 guarantees never resolve.
 * `../fixtures.test.ts` re-checks that mechanically on every run, so the claim
 * cannot rot.
 * ---------------------------------------------------------------------- */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** `apps/web/src/lib/livetv/testing` -> five levels up is the repository root. */
export const LIVETV_FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "..",
  "..",
  "media",
  "fixtures",
  "livetv"
);

export function readLiveTvFixture(name: string): string {
  return readFileSync(join(LIVETV_FIXTURE_DIR, name), "utf8");
}

export function liveTvFixtureNames(): readonly string[] {
  return readdirSync(LIVETV_FIXTURE_DIR).sort();
}

/**
 * A module's source with its comments removed.
 *
 * WHY THIS EXISTS. Several guards in this layer assert that a module does not
 * reach something — `localeCompare`, `Date.now`, `node:fs`, the fixture
 * directory. Written as a plain `toContain` over the raw file they fail on the
 * module's own header, because every one of those modules NAMES the thing it
 * refuses while explaining why. A guard that cannot survive its subject
 * documenting itself trains people to delete the documentation.
 *
 * Comment stripping is lexical and string-aware: a `//` inside a string
 * literal (`"https://..."`) must not start a comment, which is the one case a
 * naive regex gets wrong and the one case this codebase is full of.
 */
export function sourceWithoutComments(moduleUrl: URL): string {
  const source = readFileSync(moduleUrl, "utf8");
  let out = "";
  let index = 0;
  let quote: string | null = null;
  while (index < source.length) {
    const char = source[index] ?? "";
    const next = source[index + 1] ?? "";
    if (quote !== null) {
      out += char;
      if (char === "\\") {
        out += next;
        index += 2;
        continue;
      }
      if (char === quote) quote = null;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      out += char;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      const close = source.indexOf("*/", index + 2);
      index = close === -1 ? source.length : close + 2;
      continue;
    }
    if (char === "/" && next === "/") {
      const close = source.indexOf("\n", index + 2);
      index = close === -1 ? source.length : close;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}
