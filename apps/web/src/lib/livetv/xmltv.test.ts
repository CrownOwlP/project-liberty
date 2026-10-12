/* -------------------------------------------------------------------------
 * The XMLTV reader's contract, with the XXE refusal first (Wave 132, Worker E).
 *
 * The first describe block is the one that matters: the reader must refuse a
 * DTD or entity declaration, and it must refuse it for every spelling, before
 * any text node exists. Everything after it is the ordinary grammar.
 * ---------------------------------------------------------------------- */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { readLiveTvFixture } from "./testing/fixtures";
import { MAX_ELEMENT_DEPTH, parseXmltv } from "./xmltv";

function ok(text: string) {
  const result = parseXmltv(text);
  if (!result.ok) throw new Error(`expected a parse, got refusal ${result.refusal}: ${result.detail}`);
  return result.document;
}

const wrap = (body: string): string => `<?xml version="1.0"?>\n<tv>${body}</tv>`;

describe("THE XXE CLASS: a declaration is refused, never resolved", () => {
  it("refuses every DTD and entity-declaration spelling", () => {
    for (const declaration of [
      '<!DOCTYPE tv [ <!ENTITY xxe SYSTEM "file:///synthetic/nothing"> ]>',
      '<!DOCTYPE tv SYSTEM "xmltv.dtd">',
      "<!DOCTYPE tv>",
      '<!ENTITY xxe SYSTEM "file:///synthetic/nothing">',
      "<!ELEMENT tv (channel*)>",
      '<!ATTLIST tv generator CDATA "x">',
      '<!NOTATION gif SYSTEM "image/gif">'
    ]) {
      const result = parseXmltv(`<?xml version="1.0"?>\n${declaration}\n<tv></tv>`);
      expect(result.ok, `${declaration} must be refused`).toBe(false);
      if (!result.ok) expect(result.refusal).toBe("doctype_or_entity_declaration");
    }
  });

  it("refuses the hostile fixture and therefore never reaches its &synthetic; reference", () => {
    const result = parseXmltv(readLiveTvFixture("hostile-doctype-epg.xml"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal).toBe("doctype_or_entity_declaration");
      expect(result.detail).toContain("no external-entity resolution");
    }
  });

  it("expands no entity it was not born knowing, so billion-laughs has no amplifier", () => {
    /* Even with the declaration hypothetically allowed, a `&lol;` reference is
     * kept verbatim: one pass, fixed table, never recursive. */
    const document = ok(
      wrap('<channel id="a"><display-name>&lol;&lol;&amp;</display-name></channel>')
    );
    expect(document.channels[0]?.displayName).toBe("&lol;&lol;&");
    expect(document.diagnostics.filter((d) => d.code === "unknown_entity_reference")).toHaveLength(2);
  });

  it("imports only the contract, so it has no route to a file or a socket", () => {
    const url = new URL("./xmltv.ts", import.meta.url);
    const source = readFileSync(url, "utf8");
    const imported = [...source.matchAll(/^\s*import[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
    expect(imported).toEqual(["@liberty/contracts/domains/live"]);
    for (const forbidden of ["fetch(", "XMLHttpRequest", "require("]) {
      expect(source, `xmltv.ts must not reach ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe("the bounds", () => {
  it("refuses an oversized document rather than truncating it", () => {
    const result = parseXmltv(wrap("<channel id=\"a\"/>"), { maxCharacters: 10 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal).toBe("input_exceeds_size_cap");
  });

  it("refuses nesting past the depth cap", () => {
    const deep = `${"<a>".repeat(MAX_ELEMENT_DEPTH + 4)}${"</a>".repeat(MAX_ELEMENT_DEPTH + 4)}`;
    const result = parseXmltv(`<tv>${deep}</tv>`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal).toBe("element_depth_exceeded");
  });

  it("refuses an element count past the cap", () => {
    const result = parseXmltv(wrap('<channel id="a"/>'.repeat(20)), { maxElements: 5 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal).toBe("element_count_exceeded");
  });

  it("refuses unterminated markup and a mismatched close tag by name", () => {
    for (const [text, refusal] of [
      ["<tv><channel id=\"a\"", "unterminated_markup"],
      ["<tv><!-- never closed", "unterminated_markup"],
      ["<tv><channel id=\"a\"><![CDATA[ never closed", "unterminated_markup"],
      ["<tv><channel id=\"a\"></programme></tv>", "mismatched_close_tag"],
      ["<tv><channel id=\"a\">", "unterminated_markup"]
    ] as const) {
      const result = parseXmltv(text);
      expect(result.ok, text).toBe(false);
      if (!result.ok) expect(result.refusal, text).toBe(refusal);
    }
  });

  it("refuses a document with no <tv> element", () => {
    const result = parseXmltv("<notxmltv></notxmltv>");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal).toBe("not_an_xmltv_document");
  });
});

describe("channels", () => {
  it("reads display names and an icon, keeping the first name as primary", () => {
    const document = ok(
      wrap(
        '<channel id="aurora.example"><display-name>Aurora One</display-name><display-name lang="en">Aurora</display-name><icon src="https://logos.example.invalid/a.png"/></channel>'
      )
    );
    const channel = document.channels[0];
    expect(channel?.sourceChannelId).toBe("aurora.example");
    expect(channel?.displayName).toBe("Aurora One");
    expect(channel?.displayNames).toEqual(["Aurora One", "Aurora"]);
    expect(channel?.iconUrl).toBe("https://logos.example.invalid/a.png");
  });

  it("reports a channel with no id and does not invent one", () => {
    const document = ok(wrap("<channel><display-name>Nameless</display-name></channel>"));
    expect(document.channels).toEqual([]);
    expect(document.diagnostics.map((d) => d.code)).toContain("channel_without_id");
  });

  it("keeps the first of two channels sharing an id and reports the second", () => {
    const document = ok(
      wrap(
        '<channel id="a"><display-name>First</display-name></channel><channel id="a"><display-name>Second</display-name></channel>'
      )
    );
    expect(document.channels).toHaveLength(1);
    expect(document.channels[0]?.displayName).toBe("First");
    expect(document.diagnostics.map((d) => d.code)).toContain("duplicate_channel_id");
  });
});

describe("programmes", () => {
  const schedule = (attributes: string, body = "<title>T</title>"): string =>
    wrap(`<channel id="a"><display-name>A</display-name></channel><programme channel="a" ${attributes}>${body}</programme>`);

  it("normalises start and stop to UTC instants through the contract", () => {
    const document = ok(schedule('start="20261012193000 +0100" stop="20261012203000 +0100"'));
    expect(document.programmes[0]?.startsAt).toBe("2026-10-12T18:30:00.000Z");
    expect(document.programmes[0]?.endsAt).toBe("2026-10-12T19:30:00.000Z");
  });

  it("handles offsets that are not whole hours, in both directions", () => {
    const plus = ok(schedule('start="20261012090000 +0530"'));
    expect(plus.programmes[0]?.startsAt).toBe("2026-10-12T03:30:00.000Z");
    const minus = ok(schedule('start="20261012140000 -0330"'));
    expect(minus.programmes[0]?.startsAt).toBe("2026-10-12T17:30:00.000Z");
  });

  it("drops a listing whose start has no offset, with the contract's own reason", () => {
    const document = ok(schedule('start="20261012193000"'));
    expect(document.programmes).toEqual([]);
    const refusal = document.diagnostics.find((d) => d.code === "programme_start_refused");
    expect(refusal?.timestampRefusal).toBe("missing_offset");
  });

  it("keeps a null end time when stop is refused, and never infers one", () => {
    const document = ok(schedule('start="20261012193000 +0000" stop="20261012"'));
    expect(document.programmes[0]?.endsAt).toBeNull();
    const refusal = document.diagnostics.find((d) => d.code === "programme_stop_refused");
    expect(refusal?.timestampRefusal).toBe("malformed_timestamp");
  });

  it("leaves a missing stop as null", () => {
    const document = ok(schedule('start="20261012193000 +0000"'));
    expect(document.programmes[0]?.endsAt).toBeNull();
  });

  it("reads title, sub-title, desc and every category", () => {
    const document = ok(
      schedule(
        'start="20261012193000 +0000"',
        "<title>Aurora Desk</title><sub-title>Late</sub-title><desc>Synthetic</desc><category>News</category><category>Documentary</category>"
      )
    );
    const programme = document.programmes[0];
    expect(programme?.title).toBe("Aurora Desk");
    expect(programme?.episodeTitle).toBe("Late");
    expect(programme?.description).toBe("Synthetic");
    expect(programme?.categories).toEqual(["News", "Documentary"]);
  });

  it("leaves categories null when the feed states none", () => {
    const document = ok(schedule('start="20261012193000 +0000"'));
    expect(document.programmes[0]?.categories).toBeNull();
  });

  it("reads an xmltv_ns episode number one-based and declines every other system", () => {
    const ns = ok(
      schedule('start="20261012193000 +0000"', '<title>T</title><episode-num system="xmltv_ns">2.11.0/1</episode-num>')
    );
    expect(ns.programmes[0]?.seasonNumber).toBe(3);
    expect(ns.programmes[0]?.episodeNumber).toBe(12);

    const onscreen = ok(
      schedule('start="20261012193000 +0000"', '<title>T</title><episode-num system="onscreen">S2 Ep 4</episode-num>')
    );
    expect(onscreen.programmes[0]?.seasonNumber).toBeNull();
    expect(onscreen.programmes[0]?.episodeNumber).toBeNull();
    expect(onscreen.diagnostics.map((d) => d.code)).toContain("episode_num_system_not_read");
  });

  it("keeps <new/> and <previously-shown/> tri-state", () => {
    const silent = ok(schedule('start="20261012193000 +0000"'));
    expect(silent.programmes[0]?.isNew).toBeNull();
    expect(silent.programmes[0]?.isPreviouslyShown).toBeNull();
    const stated = ok(schedule('start="20261012193000 +0000"', "<title>T</title><new /><previously-shown />"));
    expect(stated.programmes[0]?.isNew).toBe(true);
    expect(stated.programmes[0]?.isPreviouslyShown).toBe(true);
  });

  it("drops a programme with no channel, no start or no title, each by name", () => {
    const noChannel = ok(wrap('<channel id="a"><display-name>A</display-name></channel><programme start="20261012193000 +0000"><title>T</title></programme>'));
    expect(noChannel.diagnostics.map((d) => d.code)).toContain("programme_without_channel_attribute");
    const noStart = ok(schedule(""));
    expect(noStart.diagnostics.map((d) => d.code)).toContain("programme_without_start_attribute");
    const noTitle = ok(schedule('start="20261012193000 +0000"', "<desc>no title</desc>"));
    expect(noTitle.diagnostics.map((d) => d.code)).toContain("programme_without_title");
    expect(noTitle.programmes).toEqual([]);
  });

  it("keeps overlapping programmes, because real grids overlap", () => {
    const document = ok(
      wrap(
        '<channel id="a"><display-name>A</display-name></channel>' +
          '<programme channel="a" start="20261012190000 +0000" stop="20261012200000 +0000"><title>First</title></programme>' +
          '<programme channel="a" start="20261012193000 +0000" stop="20261012203000 +0000"><title>Second</title></programme>'
      )
    );
    expect(document.programmes).toHaveLength(2);
  });

  it("reports a programme for an undeclared channel once, in a pass that ignores document order", () => {
    const programmeFirst = ok(
      wrap(
        '<programme channel="later" start="20261012190000 +0000"><title>T</title></programme>' +
          '<channel id="later"><display-name>Later</display-name></channel>'
      )
    );
    /* Declared after the programme, so it must NOT be reported as undeclared. */
    expect(programmeFirst.diagnostics.map((d) => d.code)).not.toContain("programme_for_undeclared_channel");

    const orphan = ok(
      wrap(
        '<channel id="a"><display-name>A</display-name></channel>' +
          '<programme channel="ghost" start="20261012190000 +0000"><title>One</title></programme>' +
          '<programme channel="ghost" start="20261012200000 +0000"><title>Two</title></programme>'
      )
    );
    expect(orphan.diagnostics.filter((d) => d.code === "programme_for_undeclared_channel")).toHaveLength(1);
    /* Kept as metadata; `epg-assembly` is what declines to schedule it. */
    expect(orphan.programmes).toHaveLength(2);
  });
});

describe("text, entities and CDATA", () => {
  it("decodes the five predefined entities and numeric references", () => {
    const document = ok(
      wrap('<channel id="a"><display-name>A&amp;B &lt;C&gt; &quot;D&quot; &apos;E&apos; &#65; &#x42;</display-name></channel>')
    );
    expect(document.channels[0]?.displayName).toBe("A&B <C> \"D\" 'E' A B");
  });

  it("treats CDATA as literal text, entities included", () => {
    const document = ok(
      wrap('<channel id="a"><display-name><![CDATA[Raw &amp; <literal>]]></display-name></channel>')
    );
    expect(document.channels[0]?.displayName).toBe("Raw &amp; <literal>");
  });

  it("reads an attribute value containing a greater-than sign", () => {
    const document = ok(wrap('<channel id="5 &gt; 4"><display-name>A</display-name></channel>'));
    expect(document.channels[0]?.sourceChannelId).toBe("5 > 4");
  });

  it("skips comments and processing instructions", () => {
    const document = ok(`<?xml version="1.0"?><!-- a comment --><tv><!-- another --><channel id="a"><display-name>A</display-name></channel></tv>`);
    expect(document.channels).toHaveLength(1);
  });
});

describe("the synthetic EPG fixture, end to end", () => {
  const document = ok(readLiveTvFixture("synthetic-epg.xml"));

  it("reads both declared channels and every readable programme", () => {
    expect(document.generatorName).toBe("synthetic-fixture-generator");
    expect(document.channels.map((channel) => channel.sourceChannelId)).toEqual([
      "aurora.news.example",
      "meridian.sport.example"
    ]);
    expect(document.programmes).toHaveLength(7);
  });

  it("normalises the DST-crossing programme to 45 real minutes", () => {
    const dst = document.programmes.find((p) => p.title === "Aurora Spring Forward Special");
    expect(dst?.startsAt).toBe("2026-03-08T06:30:00.000Z");
    expect(dst?.endsAt).toBe("2026-03-08T07:15:00.000Z");
  });

  it("keeps the no-stop programme's end time null", () => {
    const open = document.programmes.find((p) => p.title === "Meridian Late Highlights");
    expect(open?.endsAt).toBeNull();
    expect(open?.isNew).toBe(true);
  });

  it("reports the undeclared-channel programme", () => {
    expect(document.diagnostics.map((d) => d.code)).toContain("programme_for_undeclared_channel");
  });
});
