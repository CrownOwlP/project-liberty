/* -------------------------------------------------------------------------
 * THE RIGHTS GATE, ASSERTED EXHAUSTIVELY (Wave 132, Worker E).
 *
 * This is the test file that matters. `admitPlaylistChannels` is the only minter
 * of a `LiveChannel` in `apps/web`, and the product invariant it enforces is
 * invariant 1: only licensed, user-owned or public-domain content may enter
 * playback resolution. Everything below is an attempt to get an unauthorized
 * channel past it.
 * ---------------------------------------------------------------------- */
import { describe, expect, it } from "vitest";

import { PLAYABLE_CONTENT_RIGHTS } from "@liberty/contracts/shared/rights";

import { parseM3u } from "./m3u";
import {
  admitPlaylistChannels,
  normalizeChannelIdentity,
  rejectionsOfReason,
  type LiveFeedAuthorization
} from "./playlist-validation";
import { readLiveTvFixture, sourceWithoutComments } from "./testing/fixtures";

const AUTHORIZATION: LiveFeedAuthorization = {
  providerId: "synthetic-test-provider",
  declaredOrigins: ["edge.example.invalid"],
  channelRights: {
    "aurora.news.example": "licensed",
    "meridian.sport.example": "licensed",
    "polaris.docs.example": "public-domain",
    "harbour.local.example": "owned",
    "quoted.name.example": "licensed",
    "unterminated.example": "licensed",
    "bad.scheme.example": "licensed",
    "dangling.example": "licensed",
    "orphan.one.example": "licensed"
  },
  channelCountry: { "aurora.news.example": "gb" }
};

const admit = (text: string, authorization: LiveFeedAuthorization = AUTHORIZATION) =>
  admitPlaylistChannels(parseM3u(text), authorization);

const entry = (id: string, name: string, url = `https://edge.example.invalid/${id}`): string =>
  `#EXTINF:-1 tvg-id="${id}" group-title="News",${name}\n${url}`;

describe("the module cannot reach a network or a disk", () => {
  it("imports only contracts and its sibling reader, and names no transport", () => {
    const url = new URL("./playlist-validation.ts", import.meta.url);
    const source = sourceWithoutComments(url);
    for (const forbidden of ["fetch(", "XMLHttpRequest", "require(", "node:"]) {
      expect(source, `must not reach ${forbidden}`).not.toContain(forbidden);
    }
    /* `new URL()` parses. It does not resolve a name or open a socket. */
    expect(source).toContain("new URL(url)");
  });
});

describe("THE RIGHTS GATE", () => {
  it("admits a channel the authorization states a surfaceable basis for", () => {
    const admission = admit(`#EXTM3U\n${entry("aurora.news.example", "Aurora News One")}\n`);
    expect(admission.rejected).toEqual([]);
    expect(admission.channels).toHaveLength(1);
    expect(admission.channels[0]?.rights).toBe("licensed");
    expect(admission.channels[0]?.providerId).toBe("synthetic-test-provider");
  });

  it("REFUSES a channel the authorization says nothing about", () => {
    /*
     * THE CENTRAL CASE. A perfectly well-formed playlist line on a declared
     * origin, which nobody established a rights basis for. It must not appear in
     * `channels` in any form.
     */
    const admission = admit(`#EXTM3U\n${entry("nobody.cleared.this.example", "Unlicensed Channel")}\n`);
    expect(admission.channels).toEqual([]);
    expect(rejectionsOfReason(admission, "no_rights_basis_declared")).toHaveLength(1);
  });

  it("refuses a basis that is not on the platform's surfaceable allowlist", () => {
    const admission = admit(`#EXTM3U\n${entry("aurora.news.example", "Aurora")}\n`, {
      ...AUTHORIZATION,
      /* A value outside the vocabulary: exactly what the allowlist exists for. */
      channelRights: { "aurora.news.example": "scraped" as never }
    });
    expect(admission.channels).toEqual([]);
    expect(rejectionsOfReason(admission, "rights_basis_not_surfaceable")).toHaveLength(1);
  });

  it("admits each value of the allowlist and nothing else", () => {
    for (const rights of PLAYABLE_CONTENT_RIGHTS) {
      const admission = admit(`#EXTM3U\n${entry("probe.example", "Probe")}\n`, {
        ...AUTHORIZATION,
        channelRights: { "probe.example": rights }
      });
      expect(admission.channels[0]?.rights, rights).toBe(rights);
    }
  });

  it("reads the basis ONLY from the authorization, never from a playlist attribute", () => {
    /*
     * A feed attempting to license itself. Every one of these attributes is a
     * rights claim made by the document, and none of them may be read: the
     * channel is refused because the AUTHORIZATION states nothing.
     */
    const hostile =
      '#EXTM3U\n#EXTINF:-1 tvg-id="self.licensed.example" rights="licensed" entitlement="granted" is-playable="true" licensed="yes",Self Licensed\nhttps://edge.example.invalid/self\n';
    const admission = admit(hostile);
    expect(admission.channels).toEqual([]);
    expect(rejectionsOfReason(admission, "no_rights_basis_declared")).toHaveLength(1);
  });

  it("admits nothing at all when the authorization covers no channel", () => {
    const admission = admit(readLiveTvFixture("authorized-synthetic.m3u"), {
      ...AUTHORIZATION,
      channelRights: {}
    });
    expect(admission.channels).toEqual([]);
    expect(admission.rejected.length).toBeGreaterThan(0);
    for (const rejection of admission.rejected) {
      expect(rejection.reason).toBe("no_rights_basis_declared");
    }
  });
});

describe("the origin allowlist: a playlist cannot introduce an origin", () => {
  it("refuses an address on an origin the feed did not declare", () => {
    const admission = admit(
      `#EXTM3U\n${entry("aurora.news.example", "Aurora", "https://someone-else.example.invalid/a")}\n`
    );
    expect(admission.channels).toEqual([]);
    expect(rejectionsOfReason(admission, "origin_not_declared_by_feed")).toHaveLength(1);
  });

  it("refuses every entry of the unauthorized-origin fixture", () => {
    const admission = admit(readLiveTvFixture("unauthorized-origin.m3u"), {
      ...AUTHORIZATION,
      channelRights: {
        ...AUTHORIZATION.channelRights,
        "unlisted.one.example": "licensed",
        "unlisted.two.example": "licensed"
      }
    });
    expect(admission.channels).toEqual([]);
    expect(rejectionsOfReason(admission, "origin_not_declared_by_feed")).toHaveLength(2);
  });

  it("admits nothing when the feed declared no origin, rather than skipping the check", () => {
    const admission = admit(`#EXTM3U\n${entry("aurora.news.example", "Aurora")}\n`, {
      ...AUTHORIZATION,
      declaredOrigins: []
    });
    expect(admission.channels).toEqual([]);
  });

  it("compares the origin AFTER the URL parser has normalised it", () => {
    /*
     * `new URL()` folds decimal, octal, hex and uppercase host spellings, so the
     * comparison is against one canonical form rather than against a list of
     * spellings somebody thought of — the lesson
     * `packages/net-policy/src/classify.ts` records at length.
     */
    const upper = admit(
      `#EXTM3U\n${entry("aurora.news.example", "Aurora", "https://EDGE.Example.INVALID/a")}\n`
    );
    expect(upper.channels).toHaveLength(1);

    const defaultPort = admit(
      `#EXTM3U\n${entry("aurora.news.example", "Aurora", "https://edge.example.invalid:443/a")}\n`
    );
    expect(defaultPort.channels).toHaveLength(1);

    const otherPort = admit(
      `#EXTM3U\n${entry("aurora.news.example", "Aurora", "https://edge.example.invalid:8443/a")}\n`
    );
    expect(otherPort.channels).toEqual([]);
  });

  it("refuses a non-HTTP scheme, including the ones that are attacks", () => {
    for (const url of [
      "file:///synthetic/example.invalid/not-a-stream",
      "javascript:alert(1)",
      "data:text/plain,hello",
      "not a url at all",
      ""
    ]) {
      const text = `#EXTM3U\n#EXTINF:-1 tvg-id="aurora.news.example",Aurora\n${url}\n`;
      const admission = admit(text);
      expect(admission.channels, url).toEqual([]);
    }
  });
});

describe("identity and presentation", () => {
  it("folds a provider id into a normalized content id and keeps the original", () => {
    expect(normalizeChannelIdentity("BBCOne.uk")).toBe("bbcone-uk");
    expect(normalizeChannelIdentity("  Aurora News  ")).toBe("aurora-news");
    expect(normalizeChannelIdentity("a--b")).toBe("a-b");
    expect(normalizeChannelIdentity("...")).toBeNull();
    expect(normalizeChannelIdentity("")).toBeNull();

    const admission = admit(`#EXTM3U\n${entry("aurora.news.example", "Aurora News One")}\n`);
    expect(admission.channels[0]?.id).toBe("aurora-news-example");
    expect(admission.channels[0]?.sourceChannelId).toBe("aurora.news.example");
  });

  it("refuses an identity that cannot be normalized rather than inventing one", () => {
    const admission = admit('#EXTM3U\n#EXTINF:-1 tvg-id="...",…\nhttps://edge.example.invalid/a\n', {
      ...AUTHORIZATION,
      channelRights: { "...": "licensed" }
    });
    expect(admission.channels).toEqual([]);
    expect(rejectionsOfReason(admission, "identity_not_normalizable")).toHaveLength(1);
  });

  it("falls back to the display name as identity when there is no tvg-id", () => {
    const admission = admit(
      "#EXTM3U\n#EXTINF:-1,Harbour Local\nhttps://edge.example.invalid/h\n",
      { ...AUTHORIZATION, channelRights: { "Harbour Local": "owned" } }
    );
    expect(admission.channels[0]?.id).toBe("harbour-local");
    expect(admission.channels[0]?.rights).toBe("owned");
  });

  it("refuses an entry with neither identity nor name", () => {
    const admission = admit("#EXTM3U\n#EXTINF:-1,\nhttps://edge.example.invalid/a\n");
    expect(rejectionsOfReason(admission, "no_channel_identity")).toHaveLength(1);
  });

  it("refuses an entry with an identity and no name", () => {
    const admission = admit('#EXTM3U\n#EXTINF:-1 tvg-id="aurora.news.example",\nhttps://edge.example.invalid/a\n');
    expect(rejectionsOfReason(admission, "no_display_name")).toHaveLength(1);
  });

  it("refuses an entry the playlist gave no address for", () => {
    const admission = admit('#EXTM3U\n#EXTINF:-1 tvg-id="orphan.one.example",Orphan\n');
    expect(rejectionsOfReason(admission, "no_stream_address")).toHaveLength(1);
  });

  it("carries the group through as the channel's single category, and null when absent", () => {
    const grouped = admit(`#EXTM3U\n${entry("aurora.news.example", "Aurora")}\n`);
    expect(grouped.channels[0]?.categories).toEqual(["News"]);
    const ungrouped = admit(
      '#EXTM3U\n#EXTINF:-1 tvg-id="aurora.news.example",Aurora\nhttps://edge.example.invalid/a\n'
    );
    expect(ungrouped.channels[0]?.categories).toBeNull();
  });

  it("upper-cases a declared country and leaves it null when none was declared", () => {
    const admission = admit(readLiveTvFixture("authorized-synthetic.m3u"));
    const aurora = admission.channels.find((channel) => channel.sourceChannelId === "aurora.news.example");
    expect(aurora?.countryCode).toBe("GB");
    const meridian = admission.channels.find((channel) => channel.sourceChannelId === "meridian.sport.example");
    expect(meridian?.countryCode).toBeNull();
  });
});

describe("duplicates, each with its own named reason", () => {
  it("keeps the first of two entries resolving to one channel id", () => {
    const text = `#EXTM3U\n${entry("aurora.news.example", "Aurora One")}\n${entry("aurora.news.example", "Aurora One Copy", "https://edge.example.invalid/copy")}\n`;
    const admission = admit(text);
    expect(admission.channels).toHaveLength(1);
    expect(admission.channels[0]?.displayName).toBe("Aurora One");
    expect(rejectionsOfReason(admission, "duplicate_channel_id")).toHaveLength(1);
  });

  it("keeps the first of two ids pointing at one address", () => {
    const shared = "https://edge.example.invalid/shared";
    const text = `#EXTM3U\n${entry("aurora.news.example", "Aurora", shared)}\n${entry("meridian.sport.example", "Meridian", shared)}\n`;
    const admission = admit(text);
    expect(admission.channels).toHaveLength(1);
    const rejection = rejectionsOfReason(admission, "duplicate_stream_address")[0];
    expect(rejection?.detail).toContain("aurora-news-example");
  });
});

describe("no address and no credential ever leaves this module", () => {
  it("puts no stream field on an admitted channel, because the contract has none", () => {
    const admission = admit(readLiveTvFixture("authorized-synthetic.m3u"));
    expect(admission.channels.length).toBeGreaterThan(0);
    for (const channel of admission.channels) {
      const serialised = JSON.stringify(channel);
      expect(serialised).not.toContain("edge.example.invalid");
      expect(serialised).not.toContain("index.m3u8");
      for (const key of ["streamUrl", "playbackUrl", "url", "candidates", "isPlayable", "entitlement"]) {
        expect(key in channel, `a LiveChannel must not carry ${key}`).toBe(false);
      }
    }
  });

  it("names a refused host but never a path or a query in a rejection detail", () => {
    const admission = admit(
      '#EXTM3U\n#EXTINF:-1 tvg-id="aurora.news.example",Aurora\nhttps://someone-else.example.invalid/secret/path?token=abcdef0123456789\n'
    );
    const rejection = admission.rejected[0];
    expect(rejection?.detail).toContain("someone-else.example.invalid");
    expect(rejection?.detail).not.toContain("token");
    expect(rejection?.detail).not.toContain("secret");
    expect(rejection?.detail).not.toContain("abcdef0123456789");
  });

  it("keeps the logo URL, which is the one URL a listings feed legitimately carries", () => {
    const admission = admit(readLiveTvFixture("authorized-synthetic.m3u"));
    const aurora = admission.channels.find((channel) => channel.sourceChannelId === "aurora.news.example");
    expect(aurora?.logoUrl).toBe("https://logos.example.invalid/aurora-news.png");
  });
});

describe("the whole authorized fixture", () => {
  const admission = admit(readLiveTvFixture("authorized-synthetic.m3u"));

  it("admits exactly the four synthetic channels the authorization covers", () => {
    expect(admission.channels.map((channel) => channel.id)).toEqual([
      "aurora-news-example",
      "meridian-sport-example",
      "polaris-docs-example",
      "harbour-local-example"
    ]);
    expect(admission.rejected).toEqual([]);
  });

  it("does not throw on the hostile fixture and admits only what passes every check", () => {
    const hostile = admit(readLiveTvFixture("hostile-synthetic.m3u"));
    expect(hostile.channels.length).toBeGreaterThan(0);
    const reasons = new Set(hostile.rejected.map((rejection) => rejection.reason));
    expect(reasons).toContain("no_stream_address");
    expect(reasons).toContain("duplicate_channel_id");
    expect(reasons).toContain("address_not_an_http_url");
  });
});
