/* -------------------------------------------------------------------------
 * THE XMLTV EPG READER — a bounded, hand-written tokenizer (Wave 132, Worker E).
 *
 * WHY THERE IS NO XML LIBRARY HERE, AND WHY THAT IS A SECURITY DECISION RATHER
 * THAN A PACKAGING ONE. The defect class this module exists to remove by name is
 * **XXE — XML eXternal Entity expansion** — together with its sibling, the
 * billion-laughs entity-expansion denial of service. Both are reached through
 * the SAME grammar production: the internal DTD subset in a `<!DOCTYPE>`
 * declaration, where `<!ENTITY xxe SYSTEM "file:///etc/passwd">` turns a later
 * `&xxe;` in any text node into a file read on this server, and
 * `<!ENTITY a "&b;&b;...">` nested nine deep turns a 1 KB document into
 * gigabytes of string.
 *
 * A general XML parser has to decide what to do with those productions, and the
 * decision is a configuration flag somebody has to get right in every parser in
 * the tree, forever. This reader does not implement them at all: the FIRST
 * occurrence of `<!DOCTYPE`, `<!ENTITY`, `<!ELEMENT`, `<!ATTLIST` or
 * `<!NOTATION` aborts the whole read with a named refusal, before any text node
 * is produced. There is therefore no entity table, no resolver, no `SYSTEM`
 * handling and no recursion to bound — and no `node:fs`, no `fetch` and no
 * network import anywhere in this file, which `xmltv.test.ts` asserts by
 * scanning the source. Only the five predefined entities and numeric character
 * references are decoded, from a fixed table, non-recursively.
 *
 * THE SECOND DEFECT CLASS REMOVED: THE UNBOUNDED PARSE. An EPG is the largest
 * body of metadata in this system (see `docs/LIVE_TV.md`) and it arrives as
 * remote text. `MAX_EPG_CHARACTERS`, `MAX_ELEMENT_DEPTH` and `MAX_ELEMENTS`
 * bound the work *before* it is done. A document over the cap is REFUSED rather
 * than truncated, which is the opposite of `./m3u.ts`'s choice and deliberately
 * so: half a playlist is half a channel list, but half an XML document is a
 * schedule with an arbitrary unreported hole in it, and a grid with a silent
 * hole is worse than a grid that failed to load.
 *
 * THE THIRD DEFECT CLASS REMOVED: THE GUESSED TIME ZONE. Nothing in this module
 * interprets a timestamp. Every `start` and `stop` goes through
 * `readXmltvTimestamp` from `@liberty/contracts/domains/live`, which is the one
 * place in the repository a wire timestamp becomes a UTC instant and which
 * REFUSES an offset-less timestamp with its own reason rather than localising
 * it. Reimplementing the grammar here — and it is tempting, it is one regex —
 * would create a second normaliser that drifts from the contract's, and the
 * drift would be invisible until two surfaces disagreed about when a programme
 * starts. Non-whole-hour offsets (`+0530`, `-0330`) are therefore handled by
 * construction, because the contract handles them.
 *
 * WHAT THIS MODULE DOES NOT DO: it mints no `EpgListing` and no `LiveChannel`.
 * It produces wire-shaped records. `./epg-schedule.ts` assembles them into the
 * contract's `EpgSchedule`, and a channel only becomes a `LiveChannel` through
 * `./playlist-validation.ts`, which is where the rights gate is. A listings feed
 * cannot make a rights claim because there is nowhere in this module's output to
 * put one — the same structural argument `epgListingSchema` makes.
 * ---------------------------------------------------------------------- */
import {
  readXmltvTimestamp,
  type EpgInstant,
  type XmltvTimestampRefusal
} from "@liberty/contracts/domains/live";

/** Characters this reader will accept. Beyond it the document is refused, not truncated. */
export const MAX_EPG_CHARACTERS = 16_000_000;

/** Nesting this reader will accept. XMLTV's real depth is 3; 32 is generous and finite. */
export const MAX_ELEMENT_DEPTH = 32;

/** Elements this reader will accept, so a deep-but-shallow document is bounded too. */
export const MAX_ELEMENTS = 2_000_000;

/**
 * Why a whole document was refused. A refusal is about the DOCUMENT; a
 * diagnostic is about one record inside an otherwise readable document.
 *
 * The distinction is the one `docs/LIVE_TV.md` draws about dropped listings: one
 * unreadable programme should cost that programme, and a document we refused to
 * parse at all should cost the refresh and say so loudly.
 */
export const XMLTV_REFUSALS = [
  /** THE XXE CLASS. A DTD or entity declaration of any kind. Never parsed, never resolved. */
  "doctype_or_entity_declaration",
  "input_exceeds_size_cap",
  "element_depth_exceeded",
  "element_count_exceeded",
  /** `<` with no matching `>`, an unterminated comment, or an unterminated CDATA section. */
  "unterminated_markup",
  /** A close tag that does not match the open element. The document is not well-formed. */
  "mismatched_close_tag",
  /** No `<tv>` element. Readable XML, but not an XMLTV document. */
  "not_an_xmltv_document"
] as const;
export type XmltvRefusal = (typeof XMLTV_REFUSALS)[number];

export const XMLTV_DIAGNOSTIC_CODES = [
  "channel_without_id",
  "channel_without_display_name",
  "duplicate_channel_id",
  "programme_without_channel_attribute",
  "programme_without_start_attribute",
  "programme_start_refused",
  "programme_stop_refused",
  "programme_without_title",
  "episode_num_system_not_read",
  "unreadable_episode_num",
  "unknown_entity_reference",
  /** A `<programme channel="x">` where no `<channel id="x">` was declared. */
  "programme_for_undeclared_channel"
] as const;
export type XmltvDiagnosticCode = (typeof XMLTV_DIAGNOSTIC_CODES)[number];

export interface XmltvDiagnostic {
  readonly code: XmltvDiagnosticCode;
  /** 1-based line of the element this is about. */
  readonly line: number;
  readonly detail: string;
  /**
   * The contract's own refusal reason, when this diagnostic came from a
   * timestamp. Required-and-nullable rather than optional, so "this was not a
   * timestamp problem" and "nobody filled this in" stay distinguishable — the
   * rule `epgListingSchema` sets for every descriptive field.
   */
  readonly timestampRefusal: XmltvTimestampRefusal | null;
}

/** A `<channel>`, as the wire stated it. No rights field exists to be set. */
export interface XmltvChannel {
  /** XMLTV `id`, verbatim — `BBCOne.uk` shape, dots and case preserved. */
  readonly sourceChannelId: string;
  /** The FIRST `<display-name>`, which is the primary one. `null` = none stated. */
  readonly displayName: string | null;
  /** Every `<display-name>` in document order, so a later caller can pick differently. */
  readonly displayNames: readonly string[];
  /** `<icon src>`. `null` = not stated. Not fetched, not validated as reachable. */
  readonly iconUrl: string | null;
  readonly line: number;
}

/** A `<programme>`, normalised to UTC instants and nothing else. */
export interface XmltvProgramme {
  /** The `channel` attribute, verbatim. The join key back to `XmltvChannel`. */
  readonly sourceChannelId: string;
  readonly startsAt: EpgInstant;
  /** `null` = the feed stated no `stop`, or stated one we refused. NEVER inferred. */
  readonly endsAt: EpgInstant | null;
  readonly title: string;
  readonly episodeTitle: string | null;
  readonly description: string | null;
  /** `null` = no `<category>` element. `[]` is unreachable from this reader and that is fine. */
  readonly categories: readonly string[] | null;
  readonly seasonNumber: number | null;
  readonly episodeNumber: number | null;
  /** XMLTV presence elements. `null` = the feed emitted neither, which is not `false`. */
  readonly isNew: boolean | null;
  readonly isPreviouslyShown: boolean | null;
  readonly line: number;
}

export interface XmltvDocument {
  readonly channels: readonly XmltvChannel[];
  readonly programmes: readonly XmltvProgramme[];
  readonly diagnostics: readonly XmltvDiagnostic[];
  /** `<tv generator-info-name>`, if stated. Descriptive only. */
  readonly generatorName: string | null;
}

export type XmltvParseResult =
  | { readonly ok: true; readonly document: XmltvDocument }
  | { readonly ok: false; readonly refusal: XmltvRefusal; readonly detail: string };

export interface XmltvParseLimits {
  readonly maxCharacters?: number;
  readonly maxDepth?: number;
  readonly maxElements?: number;
}

/** The five predefined entities. The ONLY named entities this reader knows. */
const PREDEFINED_ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'"
});

interface DecodedText {
  readonly text: string;
  readonly unknownEntities: readonly string[];
}

/**
 * Decode text, non-recursively, from a fixed table.
 *
 * NON-RECURSIVE IS THE POINT. The billion-laughs amplification needs an entity
 * whose replacement text contains entities that are then expanded again. This
 * function makes exactly one pass and never looks at its own output, so the
 * output is bounded by the input length regardless of content — and since
 * declarations are refused outright there is no table for an attacker to add to
 * in the first place. Two independent reasons, because one would be a
 * configuration away from not holding.
 *
 * An UNKNOWN entity is left verbatim and reported. Dropping it would silently
 * corrupt a title, and throwing would cost a whole grid for one bad character.
 */
function decodeText(raw: string): DecodedText {
  if (!raw.includes("&")) return { text: raw, unknownEntities: [] };

  let out = "";
  const unknown: string[] = [];
  let index = 0;
  while (index < raw.length) {
    const char = raw[index] ?? "";
    if (char !== "&") {
      out += char;
      index += 1;
      continue;
    }
    const semicolon = raw.indexOf(";", index + 1);
    /* A bare `&` or one with no terminator within a short bound is literal text. */
    if (semicolon === -1 || semicolon - index > 12) {
      out += char;
      index += 1;
      continue;
    }
    const body = raw.slice(index + 1, semicolon);
    if (body.startsWith("#")) {
      const isHex = body[1] === "x" || body[1] === "X";
      const digits = isHex ? body.slice(2) : body.slice(1);
      const valid = isHex ? /^[0-9a-fA-F]+$/.test(digits) : /^[0-9]+$/.test(digits);
      const code = valid ? Number.parseInt(digits, isHex ? 16 : 10) : Number.NaN;
      if (valid && Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        out += String.fromCodePoint(code);
        index = semicolon + 1;
        continue;
      }
      unknown.push(`&${body};`);
      out += `&${body};`;
      index = semicolon + 1;
      continue;
    }
    const replacement = PREDEFINED_ENTITIES[body];
    if (replacement !== undefined) {
      out += replacement;
      index = semicolon + 1;
      continue;
    }
    /*
     * A named entity this reader does not know. Under a general parser this is
     * where a declared — possibly external — entity would be expanded. Here it is
     * the end of the road: kept as text, reported, never resolved.
     */
    unknown.push(`&${body};`);
    out += `&${body};`;
    index = semicolon + 1;
  }
  return { text: out, unknownEntities: unknown };
}

type Attributes = Readonly<Record<string, string>>;

interface ParsedTag {
  readonly name: string;
  readonly attributes: Attributes;
  readonly selfClosing: boolean;
  readonly unknownEntities: readonly string[];
}

/**
 * Read a start tag's name and attributes.
 *
 * Quote-aware for the same reason `./m3u.ts`'s attribute scan is: an attribute
 * value may contain `>` (`title="5 > 4"`), and a tokenizer that found the end of
 * a tag with `indexOf(">")` would cut the tag in half on exactly the documents
 * that matter. The caller finds the tag end with the same quote awareness; this
 * function is given the inside of the tag.
 */
function parseTag(inner: string): ParsedTag {
  let index = 0;
  let selfClosing = false;
  let body = inner;
  if (body.endsWith("/")) {
    selfClosing = true;
    body = body.slice(0, -1);
  }

  while (index < body.length && !/\s/.test(body[index] ?? "")) index += 1;
  const name = body.slice(0, index).toLowerCase();

  const attributes: Record<string, string> = {};
  const unknownEntities: string[] = [];
  while (index < body.length) {
    while (index < body.length && /\s/.test(body[index] ?? "")) index += 1;
    if (index >= body.length) break;
    let cursor = index;
    while (cursor < body.length && body[cursor] !== "=" && !/\s/.test(body[cursor] ?? "")) {
      cursor += 1;
    }
    const attributeName = body.slice(index, cursor).toLowerCase();
    if (cursor >= body.length || body[cursor] !== "=") {
      /* A valueless attribute. XMLTV has none; recorded as `""` is wrong, so it is dropped. */
      index = cursor + 1;
      continue;
    }
    cursor += 1;
    const quote = body[cursor];
    let value = "";
    if (quote === '"' || quote === "'") {
      cursor += 1;
      const close = body.indexOf(quote, cursor);
      if (close === -1) {
        value = body.slice(cursor);
        cursor = body.length;
      } else {
        value = body.slice(cursor, close);
        cursor = close + 1;
      }
    } else {
      let end = cursor;
      while (end < body.length && !/\s/.test(body[end] ?? "")) end += 1;
      value = body.slice(cursor, end);
      cursor = end;
    }
    const decoded = decodeText(value);
    if (attributeName !== "") attributes[attributeName] = decoded.text;
    unknownEntities.push(...decoded.unknownEntities);
    index = cursor;
  }

  return { name, attributes, selfClosing, unknownEntities };
}

/** Where the tag starting at `from` ends, quote-aware. `-1` when it never does. */
function findTagEnd(source: string, from: number): number {
  let quote: string | null = null;
  for (let index = from; index < source.length; index += 1) {
    const char = source[index];
    if (quote !== null) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ">") return index;
  }
  return -1;
}

/** The internal builder for one `<programme>`; frozen into an `XmltvProgramme` at its close. */
interface ProgrammeDraft {
  readonly line: number;
  readonly attributes: Attributes;
  titles: string[];
  subTitles: string[];
  descriptions: string[];
  categories: string[];
  episodeNums: { readonly system: string; readonly values: string[] }[];
  isNew: boolean | null;
  isPreviouslyShown: boolean | null;
}

interface ChannelDraft {
  readonly line: number;
  readonly attributes: Attributes;
  displayNames: string[];
  iconUrl: string | null;
}

/** `season.episode.part`, zero-based, each part optionally a range. XMLTV's `xmltv_ns`. */
function readXmltvNsEpisodeNum(value: string): {
  readonly seasonNumber: number | null;
  readonly episodeNumber: number | null;
  readonly readable: boolean;
} {
  const parts = value.split(".");
  if (parts.length < 2) return { seasonNumber: null, episodeNumber: null, readable: false };

  const readPart = (part: string | undefined): number | null => {
    if (part === undefined) return null;
    /* `3/8` means "episode 3 of 8"; only the ordinal is a fact about this programme. */
    const ordinal = (part.split("/")[0] ?? "").trim();
    if (ordinal === "") return null;
    if (!/^\d+$/.test(ordinal)) return null;
    const zeroBased = Number(ordinal);
    /*
     * Zero-based on the wire, one-based in the contract (`positive()`). The
     * conversion is stated here and nowhere else; doing it at a render site is
     * how a UI ends up showing "S0 E0" for a pilot.
     */
    return zeroBased + 1;
  };

  const season = readPart(parts[0]);
  const episode = readPart(parts[1]);
  if (season === null && episode === null) {
    return { seasonNumber: null, episodeNumber: null, readable: false };
  }
  return { seasonNumber: season, episodeNumber: episode, readable: true };
}

/**
 * Parse an XMLTV document, or refuse it with a reason.
 *
 * Total: every path returns. The only `throw` reachable from here would be a
 * bug, and there is no `try` anywhere in the module to hide one.
 */
export function parseXmltv(text: string, limits: XmltvParseLimits = {}): XmltvParseResult {
  const maxCharacters = limits.maxCharacters ?? MAX_EPG_CHARACTERS;
  const maxDepth = limits.maxDepth ?? MAX_ELEMENT_DEPTH;
  const maxElements = limits.maxElements ?? MAX_ELEMENTS;

  if (text.length > maxCharacters) {
    return {
      ok: false,
      refusal: "input_exceeds_size_cap",
      detail: `document is ${text.length} characters; the cap is ${maxCharacters}`
    };
  }

  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const channels: XmltvChannel[] = [];
  const programmes: XmltvProgramme[] = [];
  const diagnostics: XmltvDiagnostic[] = [];
  const stack: string[] = [];
  let elementCount = 0;
  let sawTv = false;
  let generatorName: string | null = null;

  let channelDraft: ChannelDraft | null = null;
  let programmeDraft: ProgrammeDraft | null = null;
  /** Text being accumulated for the innermost leaf of interest, or `null`. */
  let textTarget: string[] | null = null;
  let textBuffer = "";

  let index = 0;
  let line = 1;

  const countLines = (chunk: string): void => {
    for (let at = 0; at < chunk.length; at += 1) if (chunk[at] === "\n") line += 1;
  };

  const note = (
    code: XmltvDiagnosticCode,
    at: number,
    detail: string,
    timestampRefusal: XmltvTimestampRefusal | null = null
  ): void => {
    diagnostics.push({ code, line: at, detail, timestampRefusal });
  };

  const reportUnknownEntities = (entities: readonly string[], at: number): void => {
    for (const entity of entities) {
      note("unknown_entity_reference", at, `kept verbatim and never resolved: ${entity}`);
    }
  };

  /**
   * Append an ordinary text run, DECODED AT THE POINT OF READING.
   *
   * Decoding here rather than once at the close tag is what keeps CDATA literal.
   * The first version buffered everything raw and decoded at the close, which
   * decoded the contents of a CDATA section too — so `<![CDATA[a &amp; b]]>`
   * came out as `a & b`, which is exactly the thing CDATA exists to prevent and
   * a silent corruption of any title that legitimately contains an ampersand
   * escape inside a CDATA block.
   */
  const appendDecodedText = (run: string, at: number): void => {
    if (textTarget === null) return;
    const decoded = decodeText(run);
    reportUnknownEntities(decoded.unknownEntities, at);
    textBuffer += decoded.text;
  };

  while (index < source.length) {
    const open = source.indexOf("<", index);
    if (open === -1) {
      appendDecodedText(source.slice(index), line);
      countLines(source.slice(index));
      break;
    }

    appendDecodedText(source.slice(index, open), line);
    countLines(source.slice(index, open));

    /* --- the declaration forms, every one of which is refused or skipped --- */
    if (source.startsWith("<!--", open)) {
      const close = source.indexOf("-->", open + 4);
      if (close === -1) {
        return { ok: false, refusal: "unterminated_markup", detail: `unterminated comment at line ${line}` };
      }
      countLines(source.slice(open, close + 3));
      index = close + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", open)) {
      const close = source.indexOf("]]>", open + 9);
      if (close === -1) {
        return { ok: false, refusal: "unterminated_markup", detail: `unterminated CDATA at line ${line}` };
      }
      /* CDATA is literal: no entity decoding, which is also no entity expansion. */
      if (textTarget !== null) textBuffer += source.slice(open + 9, close);
      countLines(source.slice(open, close + 3));
      index = close + 3;
      continue;
    }
    if (source.startsWith("<?", open)) {
      const close = source.indexOf("?>", open + 2);
      if (close === -1) {
        return { ok: false, refusal: "unterminated_markup", detail: `unterminated processing instruction at line ${line}` };
      }
      countLines(source.slice(open, close + 2));
      index = close + 2;
      continue;
    }
    if (source.startsWith("<!", open)) {
      /*
       * THE XXE REFUSAL, AND IT IS THE FIRST THING THAT HAPPENS TO A `<!`.
       *
       * `<!DOCTYPE`, `<!ENTITY`, `<!ELEMENT`, `<!ATTLIST`, `<!NOTATION` — the
       * whole DTD surface — is refused here without being read, which is why
       * there is no code below this line capable of resolving a `SYSTEM`
       * identifier or expanding a declared entity. It is refused rather than
       * skipped on purpose: a feed that ships a DTD is a feed whose generator we
       * do not understand, and silently discarding the declaration would leave a
       * document full of `&name;` references this reader then reports one by one
       * as unknown entities — a confusing symptom for a clear cause.
       */
      const upper = source.slice(open, open + 12).toUpperCase();
      return {
        ok: false,
        refusal: "doctype_or_entity_declaration",
        detail: `refused a declaration at line ${line} (${upper.replace(/[^A-Z!]/g, "")}); this reader implements no DTD, no entity table and no external-entity resolution`
      };
    }

    const isClose = source[open + 1] === "/";
    const tagEnd = findTagEnd(source, open + 1);
    if (tagEnd === -1) {
      return { ok: false, refusal: "unterminated_markup", detail: `unterminated tag at line ${line}` };
    }
    const tagLine = line;
    const inner = source.slice(open + (isClose ? 2 : 1), tagEnd).trim();
    countLines(source.slice(open, tagEnd + 1));
    index = tagEnd + 1;

    if (isClose) {
      const name = inner.toLowerCase();
      const top = stack[stack.length - 1];
      if (top !== name) {
        return {
          ok: false,
          refusal: "mismatched_close_tag",
          detail: `</${name}> at line ${tagLine} closes <${top ?? "nothing"}>`
        };
      }
      stack.pop();

      if (textTarget !== null) {
        /* Already decoded run by run; CDATA runs were appended literally. */
        const trimmed = textBuffer.trim();
        if (trimmed !== "") textTarget.push(trimmed);
        textTarget = null;
        textBuffer = "";
      }

      if (name === "channel" && channelDraft !== null) {
        const id = channelDraft.attributes["id"] ?? "";
        if (id === "") {
          note("channel_without_id", channelDraft.line, "a <channel> with no id cannot be joined to a programme");
        } else {
          if (channels.some((existing) => existing.sourceChannelId === id)) {
            note("duplicate_channel_id", channelDraft.line, `a second <channel> declares id ${id}; the first is kept`);
          } else {
            const primary = channelDraft.displayNames[0] ?? null;
            if (primary === null) {
              note("channel_without_display_name", channelDraft.line, `channel ${id} states no <display-name>`);
            }
            channels.push({
              sourceChannelId: id,
              displayName: primary,
              displayNames: Object.freeze([...channelDraft.displayNames]),
              iconUrl: channelDraft.iconUrl,
              line: channelDraft.line
            });
          }
        }
        channelDraft = null;
        continue;
      }

      if (name === "programme" && programmeDraft !== null) {
        const draft = programmeDraft;
        programmeDraft = null;

        const channelId = draft.attributes["channel"] ?? "";
        const start = draft.attributes["start"] ?? "";
        if (channelId === "") {
          note("programme_without_channel_attribute", draft.line, "a <programme> with no channel has no route to a rights basis and is dropped");
          continue;
        }
        if (start === "") {
          note("programme_without_start_attribute", draft.line, `a <programme> on ${channelId} states no start and is dropped`);
          continue;
        }
        const startReading = readXmltvTimestamp(start);
        if (!startReading.ok) {
          note(
            "programme_start_refused",
            draft.line,
            `start refused on ${channelId}; the listing is dropped rather than localised`,
            startReading.refusal
          );
          continue;
        }

        let endsAt: EpgInstant | null = null;
        const stop = draft.attributes["stop"];
        if (stop !== undefined && stop !== "") {
          const stopReading = readXmltvTimestamp(stop);
          if (stopReading.ok) {
            endsAt = stopReading.instant;
          } else {
            /*
             * A refused `stop` costs the END TIME, not the listing. `endsAt` stays
             * `null`, which `epgListingSchema` says means "the feed stated no end
             * time" and which `docs/LIVE_TV.md` forbids inferring from the next
             * listing's start. The diagnostic is what distinguishes "absent" from
             * "present and unreadable" for an operator.
             */
            note(
              "programme_stop_refused",
              draft.line,
              `stop refused on ${channelId}; the listing keeps a null end time rather than an inferred one`,
              stopReading.refusal
            );
          }
        }

        const title = draft.titles[0] ?? "";
        if (title === "") {
          note("programme_without_title", draft.line, `a <programme> on ${channelId} states no title and is dropped`);
          continue;
        }

        let seasonNumber: number | null = null;
        let episodeNumber: number | null = null;
        for (const episodeNum of draft.episodeNums) {
          const system = episodeNum.system.toLowerCase();
          if (system !== "xmltv_ns") {
            /*
             * `onscreen` and the dozen vendor systems are NOT read. They are free
             * text — "Ep 4", "S2, Ep 4", "401" — and deriving numbers from them is
             * guessing. `epgListingSchema` is explicit that nothing is derived
             * from the other field; an unread system is reported, not parsed.
             */
            note("episode_num_system_not_read", draft.line, `episode-num system ${system || "unstated"} is not read`);
            continue;
          }
          const read = readXmltvNsEpisodeNum(episodeNum.values[0] ?? "");
          if (!read.readable) {
            note("unreadable_episode_num", draft.line, "an xmltv_ns episode-num did not parse");
            continue;
          }
          seasonNumber = read.seasonNumber;
          episodeNumber = read.episodeNumber;
        }

        programmes.push({
          sourceChannelId: channelId,
          startsAt: startReading.instant,
          endsAt,
          title,
          episodeTitle: draft.subTitles[0] ?? null,
          description: draft.descriptions[0] ?? null,
          categories: draft.categories.length === 0 ? null : Object.freeze([...draft.categories]),
          seasonNumber,
          episodeNumber,
          isNew: draft.isNew,
          isPreviouslyShown: draft.isPreviouslyShown,
          line: draft.line
        });
        continue;
      }
      continue;
    }

    const tag = parseTag(inner);
    reportUnknownEntities(tag.unknownEntities, tagLine);
    elementCount += 1;
    if (elementCount > maxElements) {
      return {
        ok: false,
        refusal: "element_count_exceeded",
        detail: `more than ${maxElements} elements; the read was abandoned rather than truncated`
      };
    }

    if (!tag.selfClosing) {
      stack.push(tag.name);
      if (stack.length > maxDepth) {
        return {
          ok: false,
          refusal: "element_depth_exceeded",
          detail: `nesting deeper than ${maxDepth} at line ${tagLine}`
        };
      }
    }

    switch (tag.name) {
      case "tv": {
        sawTv = true;
        generatorName = tag.attributes["generator-info-name"] ?? null;
        break;
      }
      case "channel": {
        channelDraft = { line: tagLine, attributes: tag.attributes, displayNames: [], iconUrl: null };
        if (tag.selfClosing) {
          const id = tag.attributes["id"] ?? "";
          if (id === "") {
            note("channel_without_id", tagLine, "a <channel/> with no id cannot be joined to a programme");
          } else {
            note("channel_without_display_name", tagLine, `channel ${id} states no <display-name>`);
            channels.push({
              sourceChannelId: id,
              displayName: null,
              displayNames: Object.freeze([]),
              iconUrl: null,
              line: tagLine
            });
          }
          channelDraft = null;
        }
        break;
      }
      case "programme": {
        programmeDraft = {
          line: tagLine,
          attributes: tag.attributes,
          titles: [],
          subTitles: [],
          descriptions: [],
          categories: [],
          episodeNums: [],
          isNew: null,
          isPreviouslyShown: null
        };
        if (tag.selfClosing) {
          note("programme_without_title", tagLine, "a <programme/> carries no title and is dropped");
          programmeDraft = null;
        }
        break;
      }
      case "display-name": {
        if (channelDraft !== null && !tag.selfClosing) {
          textTarget = channelDraft.displayNames;
          textBuffer = "";
        }
        break;
      }
      case "icon": {
        /*
         * `src` is kept as a STRING and never fetched. A channel logo is the one
         * URL a listings feed legitimately carries, and it is still a URL this
         * process must not open on a server render.
         */
        if (channelDraft !== null) channelDraft.iconUrl = tag.attributes["src"] ?? channelDraft.iconUrl;
        break;
      }
      case "title": {
        if (programmeDraft !== null && !tag.selfClosing) {
          textTarget = programmeDraft.titles;
          textBuffer = "";
        }
        break;
      }
      case "sub-title": {
        if (programmeDraft !== null && !tag.selfClosing) {
          textTarget = programmeDraft.subTitles;
          textBuffer = "";
        }
        break;
      }
      case "desc": {
        if (programmeDraft !== null && !tag.selfClosing) {
          textTarget = programmeDraft.descriptions;
          textBuffer = "";
        }
        break;
      }
      case "category": {
        if (programmeDraft !== null && !tag.selfClosing) {
          textTarget = programmeDraft.categories;
          textBuffer = "";
        }
        break;
      }
      case "episode-num": {
        if (programmeDraft !== null) {
          const system = tag.attributes["system"] ?? "";
          if (tag.selfClosing) {
            note("unreadable_episode_num", tagLine, "an empty <episode-num/> states no numbering");
          } else {
            /*
             * The value arrives at the close tag, so the text target IS the
             * record's own array. Recorded as a (system, values) pair rather
             * than merged, so a programme carrying both `xmltv_ns` and
             * `onscreen` keeps which system said what — merging them is how a UI
             * ends up showing an on-screen string as a season number.
             */
            const values: string[] = [];
            programmeDraft.episodeNums.push({ system, values });
            textTarget = values;
            textBuffer = "";
          }
        }
        break;
      }
      case "new": {
        if (programmeDraft !== null) programmeDraft.isNew = true;
        break;
      }
      case "previously-shown": {
        if (programmeDraft !== null) programmeDraft.isPreviouslyShown = true;
        break;
      }
      default:
        break;
    }
  }

  if (stack.length > 0) {
    return {
      ok: false,
      refusal: "unterminated_markup",
      detail: `the document ends inside <${stack[stack.length - 1] ?? "?"}>`
    };
  }
  if (!sawTv) {
    return { ok: false, refusal: "not_an_xmltv_document", detail: "no <tv> element was found" };
  }

  /*
   * THE UNKNOWN-CHANNEL PASS, RUN AT THE END AND NOT INLINE.
   *
   * `<programme>` elements legitimately precede their `<channel>` declarations in
   * some generators' output, so a check made while parsing would report a
   * perfectly joinable programme as orphaned purely because of document order —
   * an order-dependence of exactly the family `docs/LIVE_TV.md` keeps naming. The
   * programme is KEPT: it is real metadata about a real broadcast, and
   * `./epg-schedule.ts` is what declines to put it in any channel's schedule,
   * because a schedule whose entries name a channel we hold no rights record for
   * is the one thing `rightsBasisForListing` exists to prevent.
   */
  const declared = new Set(channels.map((channel) => channel.sourceChannelId));
  const reported = new Set<string>();
  for (const programme of programmes) {
    if (declared.has(programme.sourceChannelId)) continue;
    if (reported.has(programme.sourceChannelId)) continue;
    reported.add(programme.sourceChannelId);
    note(
      "programme_for_undeclared_channel",
      programme.line,
      `listings name channel ${programme.sourceChannelId}, which this document does not declare; they join to no channel and therefore to no rights basis`
    );
  }

  return { ok: true, document: { channels, programmes, diagnostics, generatorName } };
}
