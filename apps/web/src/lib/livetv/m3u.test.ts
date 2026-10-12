/* -------------------------------------------------------------------------
 * The M3U reader's contract, asserted input by hostile input (Wave 132, Worker E).
 *
 * The parser is total and its outcome type is a result-with-diagnostics, so the
 * only way to know it is total is to feed it every malformation this format
 * actually arrives with and assert there is no throw and that the diagnostic
 * names the right thing. That is what this file is.
 * ---------------------------------------------------------------------- */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { diagnosticsOfCode, parseM3u } from "./m3u";
import { readLiveTvFixture } from "./testing/fixtures";

/**
 * Import specifiers only, not prose.
 *
 * The first version of the guard below scanned the whole file for `node:fs`,
 * which the module's own header NAMES while explaining that it does not use it —
 * so the guard failed on the comment that documents the property it checks.
 * Scanning the import specifiers is the check that was meant.
 */
function importedModules(sourcePath: URL): string[] {
  const source = readFileSync(sourcePath, "utf8");
  return [...source.matchAll(/^\s*import[^;]*?from\s+"([^"]+)"/gm)].map((match) => match[1] ?? "");
}

describe("the M3U reader never opens anything", () => {
  it("imports nothing at all, so it cannot reach a network or a disk", () => {
    /* A source scan, for the reason `route-authorization.test.ts` gives for its
     * own: a reviewer catches this once, and the guard catches it every time. */
    const url = new URL("./m3u.ts", import.meta.url);
    expect(importedModules(url)).toEqual([]);
    const source = readFileSync(url, "utf8");
    for (const forbidden of ["fetch(", "XMLHttpRequest", "require("]) {
      expect(source, `m3u.ts must not reach ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe("the shapes this format actually arrives in", () => {
  it("reads a well-formed playlist", () => {
    const playlist = parseM3u("#EXTM3U\n#EXTINF:-1 tvg-id=\"a.example\",Alpha\nhttps://edge.example.invalid/a\n");
    expect(playlist.entries).toHaveLength(1);
    const entry = playlist.entries[0];
    expect(entry?.displayName).toBe("Alpha");
    expect(entry?.tvgId).toBe("a.example");
    expect(entry?.durationSeconds).toBe(-1);
    expect(entry?.url).toBe("https://edge.example.invalid/a");
    expect(playlist.diagnostics).toEqual([]);
  });

  it("strips a UTF-8 BOM before looking for the header", () => {
    /* The single most common false "missing header": `"﻿#EXTM3U"` does not
     * start with `#EXTM3U`, and nothing says why. */
    const playlist = parseM3u("﻿#EXTM3U\n#EXTINF:-1,Alpha\nhttps://edge.example.invalid/a\n");
    expect(diagnosticsOfCode(playlist, "missing_extm3u_header")).toEqual([]);
    expect(playlist.entries).toHaveLength(1);
  });

  it("reads CRLF, bare LF and a mixture of the two", () => {
    const crlf = parseM3u("#EXTM3U\r\n#EXTINF:-1,Alpha\r\nhttps://edge.example.invalid/a\r\n");
    expect(crlf.entries[0]?.url).toBe("https://edge.example.invalid/a");
    const mixed = parseM3u("#EXTM3U\r\n#EXTINF:-1,Alpha\nhttps://edge.example.invalid/a\r\n");
    expect(mixed.entries[0]?.url).toBe("https://edge.example.invalid/a");
    /* A stray CR left on the end of a URL becomes part of the host. */
    expect(crlf.entries[0]?.url?.endsWith("\r")).toBe(false);
  });

  it("reads a file with no trailing newline", () => {
    const playlist = parseM3u("#EXTM3U\n#EXTINF:-1,Alpha\nhttps://edge.example.invalid/a");
    expect(playlist.entries).toHaveLength(1);
    expect(playlist.entries[0]?.url).toBe("https://edge.example.invalid/a");
  });

  it("reads #PLAYLIST and #EXTGRP", () => {
    const playlist = parseM3u(
      "#EXTM3U\n#PLAYLIST:Synthetic\n#EXTGRP:Sport\n#EXTINF:-1,Alpha\nhttps://edge.example.invalid/a\n"
    );
    expect(playlist.playlistName).toBe("Synthetic");
    expect(playlist.entries[0]?.groupTitle).toBe("Sport");
  });

  it("lets group-title outrank #EXTGRP, including when it is empty", () => {
    /* Positional state must never win over a per-entry fact; see the parser. */
    const playlist = parseM3u(
      '#EXTM3U\n#EXTGRP:Sport\n#EXTINF:-1 group-title="News",Alpha\nhttps://edge.example.invalid/a\n#EXTINF:-1 group-title="",Beta\nhttps://edge.example.invalid/b\n'
    );
    expect(playlist.entries[0]?.groupTitle).toBe("News");
    expect(playlist.entries[1]?.groupTitle).toBe("");
  });
});

describe("quoted attribute values", () => {
  it("keeps a comma inside a quoted value out of the name separator decision", () => {
    /* `split(",")` and `indexOf(",")` both cut inside the group name here, which
     * is how a phantom group appears in a channel list. */
    const playlist = parseM3u(
      '#EXTM3U\n#EXTINF:-1 group-title="News, Weather",Alpha Channel\nhttps://edge.example.invalid/a\n'
    );
    expect(playlist.entries[0]?.groupTitle).toBe("News, Weather");
    expect(playlist.entries[0]?.displayName).toBe("Alpha Channel");
  });

  it("unescapes an escaped quote and keeps an unknown escape verbatim", () => {
    const playlist = parseM3u(
      '#EXTM3U\n#EXTINF:-1 tvg-name="The \\"Quoted\\" One" group-title="AC\\DC",Alpha\nhttps://edge.example.invalid/a\n'
    );
    expect(playlist.entries[0]?.tvgName).toBe('The "Quoted" One');
    expect(playlist.entries[0]?.groupTitle).toBe("AC\\DC");
  });

  it("reports an attribute with no value and drops it rather than storing an empty string", () => {
    const playlist = parseM3u('#EXTM3U\n#EXTINF:-1 tvg-logo tvg-id="a.example",Alpha\nhttps://edge.example.invalid/a\n');
    expect(diagnosticsOfCode(playlist, "attribute_without_value")).toHaveLength(1);
    expect(playlist.entries[0]?.tvgLogo).toBeNull();
    expect(playlist.entries[0]?.tvgId).toBe("a.example");
    expect("tvg-logo" in playlist.entries[0]!.attributes).toBe(false);
  });

  it("reports an unterminated quote instead of guessing where it closed", () => {
    const playlist = parseM3u('#EXTM3U\n#EXTINF:-1 group-title="Oddities,Alpha\nhttps://edge.example.invalid/a\n');
    expect(diagnosticsOfCode(playlist, "unterminated_quoted_attribute")).toHaveLength(1);
    /* No separator survives an unterminated quote, so there is no name to read. */
    expect(playlist.entries[0]?.displayName).toBe("");
  });

  it("reads an unquoted attribute value", () => {
    const playlist = parseM3u("#EXTM3U\n#EXTINF:-1 tvg-id=a.example,Alpha\nhttps://edge.example.invalid/a\n");
    expect(playlist.entries[0]?.tvgId).toBe("a.example");
  });
});

describe("the malformations, each named rather than thrown", () => {
  it("reports a missing #EXTM3U header without discarding the entries", () => {
    const playlist = parseM3u("#EXTINF:-1,Alpha\nhttps://edge.example.invalid/a\n");
    expect(diagnosticsOfCode(playlist, "missing_extm3u_header")).toHaveLength(1);
    expect(playlist.entries).toHaveLength(1);
  });

  it("keeps an #EXTINF with no address as an entry whose url is null", () => {
    const playlist = parseM3u("#EXTM3U\n#EXTINF:-1,Alpha\n#EXTINF:-1,Beta\nhttps://edge.example.invalid/b\n");
    expect(diagnosticsOfCode(playlist, "entry_without_url")).toHaveLength(1);
    expect(playlist.entries).toHaveLength(2);
    expect(playlist.entries[0]?.url).toBeNull();
    expect(playlist.entries[1]?.url).toBe("https://edge.example.invalid/b");
  });

  it("reports a trailing #EXTINF at end of file, with or without a newline", () => {
    for (const text of ["#EXTM3U\n#EXTINF:-1,Alpha\n", "#EXTM3U\n#EXTINF:-1,Alpha"]) {
      const playlist = parseM3u(text);
      expect(diagnosticsOfCode(playlist, "entry_without_url")).toHaveLength(1);
      expect(playlist.entries[0]?.url).toBeNull();
    }
  });

  it("skips an address with no #EXTINF above it and says so", () => {
    const playlist = parseM3u("#EXTM3U\nhttps://edge.example.invalid/orphan\n");
    expect(diagnosticsOfCode(playlist, "url_without_extinf")).toHaveLength(1);
    expect(playlist.entries).toEqual([]);
  });

  it("reports a missing name separator and an empty name separately", () => {
    const noSeparator = parseM3u("#EXTM3U\n#EXTINF:-1\nhttps://edge.example.invalid/a\n");
    expect(diagnosticsOfCode(noSeparator, "extinf_without_name_separator")).toHaveLength(1);
    const emptyName = parseM3u("#EXTM3U\n#EXTINF:-1,\nhttps://edge.example.invalid/a\n");
    expect(diagnosticsOfCode(emptyName, "extinf_without_name_separator")).toEqual([]);
    expect(diagnosticsOfCode(emptyName, "empty_display_name")).toHaveLength(1);
  });

  it("reports an unreadable duration and keeps the entry", () => {
    const playlist = parseM3u("#EXTM3U\n#EXTINF:nonsense,Alpha\nhttps://edge.example.invalid/a\n");
    expect(diagnosticsOfCode(playlist, "unreadable_duration")).toHaveLength(1);
    expect(playlist.entries[0]?.durationSeconds).toBeNull();
    expect(playlist.entries[0]?.displayName).toBe("Alpha");
  });

  it("keeps duplicate entries rather than silently collapsing them", () => {
    /* Admission, not parsing, decides what a duplicate means — see
     * `playlist-validation.test.ts`. The reader must not pre-empt it. */
    const playlist = parseM3u(
      '#EXTM3U\n#EXTINF:-1 tvg-id="a.example",Alpha\nhttps://edge.example.invalid/a\n#EXTINF:-1 tvg-id="a.example",Alpha Again\nhttps://edge.example.invalid/a\n'
    );
    expect(playlist.entries).toHaveLength(2);
  });

  it("reports an unrecognised directive and keeps going", () => {
    const playlist = parseM3u(
      "#EXTM3U\n#KODIPROP:inputstream=x\n#EXTINF:-1,Alpha\nhttps://edge.example.invalid/a\n"
    );
    expect(diagnosticsOfCode(playlist, "unrecognised_directive")).toHaveLength(1);
    expect(playlist.entries).toHaveLength(1);
  });

  it("returns a result for every degenerate input rather than throwing", () => {
    for (const text of ["", "\n\n\n", "#", "#EXTM3U", "#EXTINF:", "#EXTINF:,", ",", "﻿", "#EXTINF:-1 =\"x\",A"]) {
      expect(() => parseM3u(text)).not.toThrow();
      const playlist = parseM3u(text);
      expect(Array.isArray(playlist.entries)).toBe(true);
      expect(Array.isArray(playlist.diagnostics)).toBe(true);
    }
  });
});

describe("the size caps", () => {
  it("truncates past the character cap and says it did", () => {
    const playlist = parseM3u("#EXTM3U\n#EXTINF:-1,Alpha\nhttps://edge.example.invalid/a\n", {
      maxCharacters: 20
    });
    expect(playlist.truncated).toBe(true);
    expect(diagnosticsOfCode(playlist, "size_cap_exceeded")).toHaveLength(1);
  });

  it("truncates past the line cap and says it did", () => {
    const text = `#EXTM3U\n${"#EXTINF:-1,A\nhttps://edge.example.invalid/a\n".repeat(50)}`;
    const playlist = parseM3u(text, { maxLines: 5 });
    expect(playlist.truncated).toBe(true);
    expect(playlist.entries.length).toBeLessThan(50);
  });
});

describe("the synthetic hostile fixture, end to end", () => {
  const playlist = parseM3u(readLiveTvFixture("hostile-synthetic.m3u"));

  it("reads it without throwing and finds the well-formed entries in it", () => {
    expect(playlist.playlistName).toBe("Synthetic Hostile Playlist (test input; not a channel list)");
    expect(playlist.entries.length).toBeGreaterThan(5);
    expect(playlist.entries.map((entry) => entry.displayName)).toContain("Aurora News One");
  });

  it("names every malformation the fixture was built to carry", () => {
    const present = new Set(playlist.diagnostics.map((diagnostic) => diagnostic.code));
    for (const code of [
      "attribute_without_value",
      "unreadable_duration",
      "unterminated_quoted_attribute",
      "entry_without_url",
      "url_without_extinf",
      "unrecognised_directive"
    ] as const) {
      expect(present, `the fixture should exercise ${code}`).toContain(code);
    }
    /* The BOM is handled, so the header is NOT reported missing. */
    expect(present.has("missing_extm3u_header")).toBe(false);
  });

  it("keeps the quoted-comma group intact", () => {
    const aurora = playlist.entries.find((entry) => entry.tvgId === "aurora.news.example");
    expect(aurora?.groupTitle).toBe("News, Weather");
  });

  it("never reports a diagnostic containing a whole address", () => {
    for (const diagnostic of playlist.diagnostics) {
      expect(diagnostic.detail).not.toContain("https://");
      expect(diagnostic.detail).not.toContain("example.invalid");
    }
  });
});
