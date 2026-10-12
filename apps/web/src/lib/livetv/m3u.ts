/* -------------------------------------------------------------------------
 * THE M3U/M3U8 PLAYLIST READER (Wave 132, Worker E — the parsing half of PL-0601's
 * presentation layer; acquisition stays PL-0602).
 *
 * WHAT A PLAYLIST IS, AND WHAT IT EMPHATICALLY IS NOT. An extended M3U file is a
 * list of display names, grouping hints and addresses. It carries no rights
 * basis, no provider identity and no evidence that anybody is authorized to
 * carry anything in it — which is exactly why `docs/CONTENT_RIGHTS.md` names
 * "scraping or resolving unauthorized streams" as forbidden and
 * `docs/LIVE_TV.md` says in its own words that inclusion in a third-party index
 * is not permission from anybody. So this module is a *text reader*. It produces
 * entries. Turning an entry into a `LiveChannel` requires an authorization
 * declaration from the licensed feed and happens in `./playlist-validation.ts`,
 * which is the only place a `LiveChannel` is minted and which routes through the
 * repository's existing rights gate (`PLAYABLE_CONTENT_RIGHTS`).
 *
 * IT NEVER FOLLOWS A URL. There is no import of `fetch`, no `node:http`, no
 * `node:fs`. A URL is a string here and stays a string; `m3u.test.ts` asserts
 * that by scanning this file's own source, because the fifth person to edit it
 * will be under time pressure and "just probe the stream to see if it's up" is
 * the obvious next feature and the exact defect class this boundary exists to
 * prevent.
 *
 * THE DEFECT CLASS REMOVED: THE THROWING PARSER. The ordinary way this is
 * written is a loop that `split(",")`s an `#EXTINF` line and indexes `[1]`,
 * which throws (or silently yields `undefined` interpolated into a UI) on the
 * first real-world playlist — a BOM, a CRLF, an attribute whose value contains a
 * comma, an `#EXTINF` with no URL after it. One malformed line then costs the
 * whole ingest. Every outcome below is RETURNED, with a line number, in
 * `diagnostics`. Partial success is the normal case for this format, and a
 * caller that must `catch` to find out is a caller that will eventually catch
 * and continue with a fabricated value — the same argument
 * `readXmltvTimestamp` makes in `@liberty/contracts/domains/live`.
 *
 * THE SECOND DEFECT CLASS REMOVED: THE UNBOUNDED READ. A playlist is remote
 * text. `MAX_PLAYLIST_CHARACTERS` and `MAX_PLAYLIST_LINES` bound the work before
 * it is done rather than after, and exceeding either is a diagnostic plus
 * `truncated: true`, never a partial result that looks complete.
 * ---------------------------------------------------------------------- */

/** Characters this reader will look at. Beyond it the input is truncated and said to be. */
export const MAX_PLAYLIST_CHARACTERS = 4_000_000;

/** Lines this reader will look at, so a file of newlines is bounded too. */
export const MAX_PLAYLIST_LINES = 200_000;

/**
 * Everything that can be wrong with a playlist, as a closed vocabulary.
 *
 * Closed rather than free text for the reason `./stream-errors.ts` repeats and
 * `@liberty/contracts/domains/failover` made first: an ingest that decides what
 * to do by matching a provider-authored string is one reword away from silently
 * changing behaviour. Each code below names a remedy that differs from its
 * neighbours'.
 *
 * Deliberately NOT here: a duplicate code. A duplicate is not a *parse* fact —
 * both lines parsed fine — it is an admission decision, and it is named per
 * rejected entry in `./playlist-validation.ts` where the rest of the admission
 * reasons live. Reporting it twice would give two places to disagree about what
 * counts as the same channel.
 */
export const M3U_DIAGNOSTIC_CODES = [
  /** No `#EXTM3U` on the first content line. Reported, not fatal: plain-URL playlists exist. */
  "missing_extm3u_header",
  /** `#EXTINF:` whose remainder has no comma, so no display name can be read. */
  "extinf_without_name_separator",
  /** The duration field is not a number. The entry survives with `durationSeconds: null`. */
  "unreadable_duration",
  /** An attribute name with no `=`. The attribute is dropped; the entry survives. */
  "attribute_without_value",
  /** A quoted attribute value with no closing quote before end of line. */
  "unterminated_quoted_attribute",
  /** An `#EXTINF` whose next content line is another directive or end-of-file. */
  "entry_without_url",
  /** A bare address with no preceding `#EXTINF`. Skipped: nothing names it. */
  "url_without_extinf",
  /** `#EXTINF` present, display name empty after trimming. The entry survives, unnamed. */
  "empty_display_name",
  /** A `#`-prefixed line this reader has no meaning for. Ignored, and said to be. */
  "unrecognised_directive",
  /** `MAX_PLAYLIST_CHARACTERS` or `MAX_PLAYLIST_LINES` reached. */
  "size_cap_exceeded"
] as const;
export type M3uDiagnosticCode = (typeof M3U_DIAGNOSTIC_CODES)[number];

export interface M3uDiagnostic {
  readonly code: M3uDiagnosticCode;
  /** 1-based, counted on the input as given, so it matches what an operator sees in an editor. */
  readonly line: number;
  /**
   * What was wrong, for a log. NEVER the whole line: a playlist line can carry a
   * query-string credential, and a diagnostic is the thing most likely to be
   * copied into a ticket. `./stream-errors.ts` makes the same point at length.
   */
  readonly detail: string;
}

/**
 * One parsed entry. Required-and-nullable throughout, never optional.
 *
 * The same rule `@liberty/contracts/domains/live` sets out: `.optional()` makes
 * "the playlist did not say" indistinguishable from "nobody thought about this
 * field", and a default fabricates. A playlist that states no `group-title` has
 * `groupTitle: null`, which is NOT the same as the group named `""`.
 */
export interface M3uEntry {
  /** 1-based line of the `#EXTINF`, or of the address for a bare-URL entry. */
  readonly line: number;
  /**
   * Seconds, as stated. `-1` is the format's "unbounded", which a live channel
   * always is, and it is kept as `-1` rather than mapped to `null`: the feed
   * stated it, and `null` here means the feed stated nothing readable.
   */
  readonly durationSeconds: number | null;
  /** The text after the separating comma, trimmed. `""` when the feed left it empty. */
  readonly displayName: string;
  /** Attribute names lower-cased; values exactly as quoted, unescaped once. */
  readonly attributes: Readonly<Record<string, string>>;
  readonly tvgId: string | null;
  readonly tvgName: string | null;
  readonly tvgLogo: string | null;
  /** `group-title` if stated, else the nearest preceding `#EXTGRP`, else `null`. */
  readonly groupTitle: string | null;
  /** `null` = the playlist named this entry and then gave no address for it. */
  readonly url: string | null;
}

export interface M3uPlaylist {
  /** `#PLAYLIST:` if the file stated one. Never inferred from a filename. */
  readonly playlistName: string | null;
  readonly entries: readonly M3uEntry[];
  readonly diagnostics: readonly M3uDiagnostic[];
  /** True when a size cap stopped the read. The entries present are still real. */
  readonly truncated: boolean;
}

export interface M3uParseLimits {
  readonly maxCharacters?: number;
  readonly maxLines?: number;
}

/**
 * Split into lines, total against every line ending this format arrives with.
 *
 * BOM first: a UTF-8 BOM in front of `#EXTM3U` is the single most common reason
 * a playlist reader reports "missing header" for a perfectly good file, because
 * `"﻿#EXTM3U".startsWith("#EXTM3U")` is false and nothing says why.
 *
 * CR handling is by stripping a trailing CR from each line rather than by
 * splitting on `\r\n`, so a file with mixed endings — which is what you get when
 * two tools have appended to the same playlist — reads correctly instead of
 * leaving a stray CR on the end of a URL, where it becomes part of the host.
 */
function toLines(text: string): string[] {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return withoutBom.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

/** The five entities a quoted value may carry an escape for, plus the backslash form. */
function unescapeAttributeValue(raw: string): string {
  let out = "";
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === "\\" && index + 1 < raw.length) {
      const next = raw[index + 1];
      /*
       * Only `\"` and `\\` are honoured. An unknown escape is kept VERBATIM,
       * backslash included, rather than having the backslash swallowed: a
       * channel named `AC\DC` must not become `ACDC`, and a reader that eats
       * every backslash corrupts quietly.
       */
      if (next === '"' || next === "\\") {
        out += next;
        index += 1;
        continue;
      }
    }
    out += char;
  }
  return out;
}

interface AttributeScan {
  readonly attributes: Record<string, string>;
  readonly nameStart: number;
  readonly diagnostics: readonly { code: M3uDiagnosticCode; detail: string }[];
}

/**
 * Scan `duration attrs,Display Name` after `#EXTINF:`.
 *
 * ONE PASS, QUOTE-AWARE, AND THAT IS THE WHOLE POINT. The separator between the
 * attributes and the display name is the first comma *outside* a quoted value.
 * `split(",")` and `indexOf(",")` both get this wrong on the real line
 *
 *   #EXTINF:-1 group-title="News, Weather",Example Alpha
 *
 * by cutting inside the group name — which is how a channel ends up in a group
 * called `News` and a second phantom group called ` Weather"` appears in the UI.
 * Scanning with a quote flag is the only version that is right for every input,
 * and it costs the same.
 */
function scanAttributes(body: string): AttributeScan {
  const attributes: Record<string, string> = {};
  const diagnostics: { code: M3uDiagnosticCode; detail: string }[] = [];

  let index = 0;
  /* `-1` means "no separating comma was found", which is a different fact from
   * "the name is empty" and has to stay distinguishable from it. */
  let nameStart = -1;

  /* The duration token: everything up to the first space or the separating comma. */
  while (index < body.length && body[index] !== " " && body[index] !== "\t" && body[index] !== ",") {
    index += 1;
  }

  while (index < body.length) {
    const char = body[index];
    if (char === ",") {
      nameStart = index + 1;
      break;
    }
    if (char === " " || char === "\t") {
      index += 1;
      continue;
    }

    /* An attribute name runs to `=`, to the separating comma, or to whitespace. */
    let cursor = index;
    while (
      cursor < body.length &&
      body[cursor] !== "=" &&
      body[cursor] !== "," &&
      body[cursor] !== " " &&
      body[cursor] !== "\t"
    ) {
      cursor += 1;
    }
    const name = body.slice(index, cursor).toLowerCase();

    if (cursor >= body.length || body[cursor] !== "=") {
      /*
       * `tvg-id` with no `=`. The attribute is DROPPED rather than recorded as
       * `""`: an empty string is a value the feed could legitimately send, and
       * conflating the two would make a malformed line indistinguishable from a
       * deliberately blank one.
       */
      if (name !== "") {
        diagnostics.push({
          code: "attribute_without_value",
          detail: `attribute ${name} has no value`
        });
      }
      index = cursor;
      if (index < body.length && body[index] === ",") continue;
      index += 1;
      continue;
    }

    cursor += 1; /* past the `=` */
    if (body[cursor] === '"') {
      cursor += 1;
      let value = "";
      let closed = false;
      while (cursor < body.length) {
        const valueChar = body[cursor];
        if (valueChar === "\\" && cursor + 1 < body.length) {
          value += valueChar;
          value += body[cursor + 1];
          cursor += 2;
          continue;
        }
        if (valueChar === '"') {
          closed = true;
          cursor += 1;
          break;
        }
        value += valueChar;
        cursor += 1;
      }
      if (!closed) {
        /*
         * An unterminated quote means every comma to the end of the line is
         * inside a string, so there is no separator left and no display name to
         * find. Reported, the attribute kept with what there was, and the name
         * left empty — rather than guessing where the quote should have been.
         */
        diagnostics.push({
          code: "unterminated_quoted_attribute",
          detail: `attribute ${name} opens a quote that never closes`
        });
      }
      if (name !== "") attributes[name] = unescapeAttributeValue(value);
      index = cursor;
      continue;
    }

    /* Unquoted value: to whitespace or to the separating comma. */
    let end = cursor;
    while (end < body.length && body[end] !== " " && body[end] !== "\t" && body[end] !== ",") {
      end += 1;
    }
    if (name !== "") attributes[name] = body.slice(cursor, end);
    index = end;
  }

  return { attributes, nameStart, diagnostics };
}

function readDuration(body: string): { seconds: number | null; readable: boolean } {
  let end = 0;
  while (end < body.length && body[end] !== " " && body[end] !== "\t" && body[end] !== ",") {
    end += 1;
  }
  const token = body.slice(0, end).trim();
  if (token === "") return { seconds: null, readable: false };
  const value = Number(token);
  if (!Number.isFinite(value)) return { seconds: null, readable: false };
  return { seconds: value, readable: true };
}

/**
 * Parse an extended M3U playlist. Never throws, never opens a socket.
 *
 * Total by construction: every branch below either produces an entry or pushes a
 * diagnostic, and the two are independent — a playlist can be 90% readable and
 * this says which 10% was not.
 */
export function parseM3u(text: string, limits: M3uParseLimits = {}): M3uPlaylist {
  const maxCharacters = limits.maxCharacters ?? MAX_PLAYLIST_CHARACTERS;
  const maxLines = limits.maxLines ?? MAX_PLAYLIST_LINES;

  const diagnostics: M3uDiagnostic[] = [];
  const entries: M3uEntry[] = [];
  let truncated = false;

  let source = text;
  if (source.length > maxCharacters) {
    source = source.slice(0, maxCharacters);
    truncated = true;
    diagnostics.push({
      code: "size_cap_exceeded",
      line: 0,
      detail: `input longer than ${maxCharacters} characters; read was truncated`
    });
  }

  let lines = toLines(source);
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    if (!truncated) {
      diagnostics.push({
        code: "size_cap_exceeded",
        line: 0,
        detail: `input longer than ${maxLines} lines; read was truncated`
      });
    }
    truncated = true;
  }

  let playlistName: string | null = null;
  let currentGroup: string | null = null;
  let sawHeader = false;
  let sawContent = false;

  /** The `#EXTINF` waiting for an address. Pending state is what makes the no-URL case nameable. */
  let pending: Omit<M3uEntry, "url"> | null = null;

  const flushPendingWithoutUrl = (): void => {
    if (pending === null) return;
    diagnostics.push({
      code: "entry_without_url",
      line: pending.line,
      detail: `#EXTINF at line ${pending.line} is followed by no address`
    });
    entries.push({ ...pending, url: null });
    pending = null;
  };

  for (let offset = 0; offset < lines.length; offset += 1) {
    const lineNumber = offset + 1;
    const raw = lines[offset] ?? "";
    const line = raw.trim();
    if (line === "") continue;

    if (line.startsWith("#")) {
      if (!sawContent) {
        sawContent = true;
        if (line.toUpperCase().startsWith("#EXTM3U")) {
          sawHeader = true;
          continue;
        }
      }

      const upper = line.toUpperCase();
      if (upper.startsWith("#EXTM3U")) {
        /* A second header. Harmless, and not worth a vocabulary entry of its own. */
        sawHeader = true;
        continue;
      }
      if (upper.startsWith("#PLAYLIST:")) {
        const stated = line.slice("#PLAYLIST:".length).trim();
        playlistName = stated === "" ? null : stated;
        continue;
      }
      if (upper.startsWith("#EXTGRP:")) {
        const stated = line.slice("#EXTGRP:".length).trim();
        currentGroup = stated === "" ? null : stated;
        continue;
      }
      if (upper.startsWith("#EXTINF:")) {
        /*
         * Two `#EXTINF` lines in a row: the first named a channel and never got
         * an address. Flushed as a no-URL entry rather than overwritten, so the
         * playlist's own mistake is visible instead of the channel vanishing.
         */
        flushPendingWithoutUrl();

        const body = line.slice("#EXTINF:".length);
        const duration = readDuration(body);
        if (!duration.readable) {
          diagnostics.push({
            code: "unreadable_duration",
            line: lineNumber,
            detail: "the duration field is not a number"
          });
        }

        const scan = scanAttributes(body);
        for (const entry of scan.diagnostics) {
          diagnostics.push({ code: entry.code, line: lineNumber, detail: entry.detail });
        }

        if (scan.nameStart < 0) {
          diagnostics.push({
            code: "extinf_without_name_separator",
            line: lineNumber,
            detail: "no comma separates the attributes from the display name"
          });
        }

        const displayName = scan.nameStart < 0 ? "" : body.slice(scan.nameStart).trim();
        if (displayName === "") {
          diagnostics.push({
            code: "empty_display_name",
            line: lineNumber,
            detail: "the entry states no display name"
          });
        }

        const attributes = scan.attributes;
        const groupAttribute = attributes["group-title"];
        pending = {
          line: lineNumber,
          durationSeconds: duration.seconds,
          displayName,
          attributes: Object.freeze({ ...attributes }),
          tvgId: attributes["tvg-id"] ?? null,
          tvgName: attributes["tvg-name"] ?? null,
          tvgLogo: attributes["tvg-logo"] ?? null,
          /*
           * `group-title` outranks `#EXTGRP`, and an EMPTY `group-title` still
           * outranks it. The attribute is per-entry and the directive is
           * positional state; letting the positional one win would make a
           * channel's group depend on how far up the file the last `#EXTGRP`
           * was, which is the order-dependence this repository keeps hitting.
           */
          groupTitle: groupAttribute !== undefined ? groupAttribute : currentGroup
        };
        continue;
      }

      /*
       * Everything else beginning with `#`. The format's comment form and its
       * directive form are the same syntax, so an unrecognised directive and a
       * human comment are indistinguishable — both are ignored, and both are
       * reported at `unrecognised_directive` so an operator can see that a
       * `#KODIPROP` or an `#EXTVLCOPT` was dropped rather than honoured.
       */
      diagnostics.push({
        code: "unrecognised_directive",
        line: lineNumber,
        detail: `ignored directive or comment (${line.slice(0, 24).split(":")[0] ?? "#"})`
      });
      continue;
    }

    sawContent = true;

    /*
     * A content line that is not a directive is an address. It is NOT validated
     * here and it is NOT resolved: `./playlist-validation.ts` decides whether an
     * address is admissible against the authorized feed's declared origins, and
     * nothing in this module opens anything.
     */
    if (pending === null) {
      diagnostics.push({
        code: "url_without_extinf",
        line: lineNumber,
        detail: "an address with no preceding #EXTINF; nothing names it"
      });
      continue;
    }
    entries.push({ ...pending, url: line });
    pending = null;
  }

  /* End of file with an `#EXTINF` still waiting. The missing-trailing-newline case. */
  flushPendingWithoutUrl();

  if (!sawHeader) {
    diagnostics.push({
      code: "missing_extm3u_header",
      line: 1,
      detail: "the first content line is not #EXTM3U"
    });
  }

  return { playlistName, entries, diagnostics, truncated };
}

/** Diagnostics of one code. Here so no caller writes the filter a fourth time. */
export function diagnosticsOfCode(
  playlist: M3uPlaylist,
  code: M3uDiagnosticCode
): readonly M3uDiagnostic[] {
  return playlist.diagnostics.filter((diagnostic) => diagnostic.code === code);
}
