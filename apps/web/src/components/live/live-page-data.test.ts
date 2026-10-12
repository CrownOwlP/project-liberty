/* -------------------------------------------------------------------------
 * THE SURFACE RENDERS THE RIGHTS GATE'S REAL VERDICT (Wave 132, Worker E).
 *
 * `apps/web/vitest.config.ts` is `environment: "node"`, so no component can be
 * rendered here. All of the surface's logic therefore lives in
 * `./live-page-data.ts` and all of it is asserted below — including the two
 * properties the whole worker is accountable for: the shipped screen says no
 * licensed feed is configured, and no synthetic fixture can reach it.
 * ---------------------------------------------------------------------- */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { NO_FAVOURITES } from "../../lib/livetv/channels";
import {
  LIVE_FEED_NOT_CONFIGURED_REASON,
  resolveLiveFeed,
  type RegisteredLiveFeed
} from "../../lib/livetv/feed-configuration";
import { fixedClock } from "../../lib/livetv/schedule";
import { readLiveTvFixture, sourceWithoutComments } from "../../lib/livetv/testing/fixtures";
import { UTC_ZONE, resolveViewerZone } from "../../lib/livetv/time";
import { buildLivePageModel, type LivePageInputs } from "./live-page-data";

const NOW = "2026-10-12T19:15:00.000Z";

const AUTHORIZED_FEED: RegisteredLiveFeed = {
  label: "Synthetic Test Provider",
  playlistText: readLiveTvFixture("authorized-synthetic.m3u"),
  epgText: readLiveTvFixture("synthetic-epg.xml"),
  authorization: {
    providerId: "synthetic-test-provider",
    declaredOrigins: ["edge.example.invalid"],
    channelRights: {
      "aurora.news.example": "licensed",
      "meridian.sport.example": "licensed",
      "polaris.docs.example": "public-domain",
      "harbour.local.example": "owned"
    }
  }
};

function build(overrides: Partial<LivePageInputs> = {}) {
  return buildLivePageModel({
    clock: fixedClock(NOW),
    zone: UTC_ZONE,
    favourites: NO_FAVOURITES,
    groupKey: null,
    query: "",
    ...overrides
  });
}

const configured = (feed: RegisteredLiveFeed = AUTHORIZED_FEED) => resolveLiveFeed(feed);

describe("THE SHIPPED CONFIGURATION", () => {
  it("says no licensed feed is configured, using the registry's own answer", () => {
    /* No argument: this is what `/live` renders in this repository today. */
    const model = build();
    expect(model.status).toBe("unconfigured");
    if (model.status === "unconfigured") {
      expect(model.reason).toBe(LIVE_FEED_NOT_CONFIGURED_REASON);
      expect(model.detail).toContain("PL-0602");
    }
  });

  it("has no branch in which a fixture becomes a channel", () => {
    /*
     * THE GUARD THAT MATTERS. The tempting move, with a finished parser and no
     * feed, is to register the synthetic fixtures as a development feed so the
     * screen has something on it — which is how a synthetic channel list ends up
     * in front of a user.
     */
    for (const moduleUrl of [
      new URL("./live-page-data.ts", import.meta.url),
      new URL("./live-surface.tsx", import.meta.url),
      new URL("../../app/live/page.tsx", import.meta.url),
      new URL("../../lib/livetv/feed-configuration.ts", import.meta.url)
    ]) {
      const source = sourceWithoutComments(moduleUrl);
      expect(source, `${moduleUrl.pathname} must not reach the fixtures`).not.toContain("testing/fixtures");
      expect(source, `${moduleUrl.pathname} must not reach media/`).not.toContain("media/fixtures");
    }

    /* And nothing on the surface CALLS the registrar. `feed-configuration.ts` is
     * excluded from this one because it DECLARES it; a module that may not name
     * its own export would be an unmeetable rule. */
    for (const moduleUrl of [
      new URL("./live-page-data.ts", import.meta.url),
      new URL("./live-surface.tsx", import.meta.url),
      new URL("../../app/live/page.tsx", import.meta.url)
    ]) {
      expect(sourceWithoutComments(moduleUrl), `${moduleUrl.pathname}`).not.toContain("registerLiveFeed");
    }
  });

  it("names no fixture file anywhere on the surface's module graph", () => {
    const names = ["authorized-synthetic.m3u", "synthetic-epg.xml", "hostile-synthetic.m3u"];
    for (const moduleUrl of [
      new URL("./live-page-data.ts", import.meta.url),
      new URL("./live-surface.tsx", import.meta.url),
      new URL("../../app/live/page.tsx", import.meta.url)
    ]) {
      const source = readFileSync(moduleUrl, "utf8");
      for (const name of names) expect(source, `${moduleUrl.pathname}`).not.toContain(name);
    }
  });
});

describe("a configured feed", () => {
  it("lists exactly the channels the authorization cleared", () => {
    const model = build({ feed: configured() });
    expect(model.status).toBe("ready");
    if (model.status !== "ready") return;
    /* Group order first, by code point, ungrouped last: Documentary, News,
     * Regional, Sport. The order is the channel comparator's, not the feed's. */
    expect(model.rows.map((row) => row.channel.id)).toEqual([
      "polaris-docs-example",
      "aurora-news-example",
      "harbour-local-example",
      "meridian-sport-example"
    ]);
    expect(model.providerLabel).toBe("Synthetic Test Provider");
    expect(model.rejectedByReason).toEqual([]);
  });

  it("reports no_authorized_channels when the gate admits nothing", () => {
    const model = build({
      feed: configured({
        ...AUTHORIZED_FEED,
        authorization: { ...AUTHORIZED_FEED.authorization, channelRights: { "nobody.example": "licensed" } }
      })
    });
    expect(model.status).toBe("no_authorized_channels");
    if (model.status === "no_authorized_channels") {
      expect(model.rejectedByReason[0]?.reason).toBe("no_rights_basis_declared");
      expect(model.rejectedByReason[0]?.count).toBe(4);
    }
  });

  it("refuses the whole screen rather than degrading when the EPG document is refused", () => {
    const model = build({
      feed: configured({ ...AUTHORIZED_FEED, epgText: readLiveTvFixture("hostile-doctype-epg.xml") })
    });
    expect(model.status).toBe("epg_refused");
    if (model.status === "epg_refused") expect(model.refusal).toBe("doctype_or_entity_declaration");
  });

  it("works with no EPG at all, reporting every channel as having no schedule", () => {
    const model = build({ feed: configured({ ...AUTHORIZED_FEED, epgText: null }) });
    expect(model.status).toBe("ready");
    if (model.status !== "ready") return;
    for (const row of model.rows) {
      expect(row.nowAndNext.state).toBe("no_listings");
      expect(row.idleExplanation).toBe("No schedule has been loaded for this channel.");
    }
  });
});

describe("now and next, rendered in the viewer's zone", () => {
  it("labels the current programme with its local start time", () => {
    const model = build({ feed: configured() });
    if (model.status !== "ready") throw new Error("expected ready");
    const meridian = model.rows.find((row) => row.channel.id === "meridian-sport-example");
    /* The regatta runs 17:30Z-19:30Z; at 19:15Z it is on. */
    expect(meridian?.nowAndNext.state).toBe("on_air");
    expect(meridian?.nowLabel).toBe("17:30 Meridian Harbour Regatta");
  });

  it("re-labels the same programme for a viewer in another zone", () => {
    const kolkata = resolveViewerZone("Asia/Kolkata");
    if (!kolkata.ok) throw new Error("this runtime does not know Asia/Kolkata");
    const model = build({ feed: configured(), zone: kolkata.zone });
    if (model.status !== "ready") throw new Error("expected ready");
    const meridian = model.rows.find((row) => row.channel.id === "meridian-sport-example");
    expect(meridian?.nowLabel).toBe("23:00 Meridian Harbour Regatta");
  });

  it("explains the gap rather than reporting an empty channel", () => {
    const model = build({ feed: configured(), clock: fixedClock("2026-10-12T21:00:00.000Z") });
    if (model.status !== "ready") throw new Error("expected ready");
    const aurora = model.rows.find((row) => row.channel.id === "aurora-news-example");
    expect(aurora?.nowAndNext.state).toBe("in_gap");
    expect(aurora?.nowLabel).toBeNull();
    expect(aurora?.idleExplanation).toContain("Nothing is scheduled right now");
    expect(aurora?.nextLabel).toBe("23:30 Aurora Night Desk");
  });

  it("counts the listings it dropped for channels nobody cleared", () => {
    const model = build({ feed: configured() });
    if (model.status !== "ready") throw new Error("expected ready");
    expect(model.droppedListings).toBe(1);
  });
});

describe("organisation", () => {
  it("offers every group with a count, and marks the selected one", () => {
    const model = build({ feed: configured(), groupKey: "News" });
    if (model.status !== "ready") throw new Error("expected ready");
    expect(model.groups.map((group) => group.key)).toEqual(["Documentary", "News", "Regional", "Sport"]);
    expect(model.groups.find((group) => group.key === "News")?.selected).toBe(true);
    expect(model.rows.map((row) => row.channel.id)).toEqual(["aurora-news-example"]);
    expect(model.filteredOut).toBe(3);
  });

  it("filters by query and reports how many were hidden", () => {
    const model = build({ feed: configured(), query: "meridian" });
    if (model.status !== "ready") throw new Error("expected ready");
    expect(model.rows).toHaveLength(1);
    expect(model.filteredOut).toBe(3);
  });

  it("puts a favourite first without changing anything else about the order", () => {
    const model = build({ feed: configured(), favourites: ["polaris-docs-example"] });
    if (model.status !== "ready") throw new Error("expected ready");
    expect(model.rows[0]?.channel.id).toBe("polaris-docs-example");
    expect(model.rows[0]?.favourite).toBe(true);
    expect(model.rows.slice(1).map((row) => row.channel.id)).toEqual([
      "aurora-news-example",
      "harbour-local-example",
      "meridian-sport-example"
    ]);
  });

  it("labels an ungrouped channel rather than showing the sentinel key", () => {
    const model = build({
      feed: configured({
        ...AUTHORIZED_FEED,
        playlistText: '#EXTM3U\n#EXTINF:-1 tvg-id="aurora.news.example",Aurora\nhttps://edge.example.invalid/a\n',
        epgText: null
      })
    });
    if (model.status !== "ready") throw new Error("expected ready");
    expect(model.rows[0]?.groupLabel).toBe("Ungrouped");
  });

  it("returns an empty row set, not an error, when a filter matches nothing", () => {
    const model = build({ feed: configured(), query: "no such channel" });
    if (model.status !== "ready") throw new Error("expected ready");
    expect(model.rows).toEqual([]);
    expect(model.filteredOut).toBe(4);
  });
});

describe("nothing unauthorized reaches a row", () => {
  it("never puts a rejected entry on the screen in any styling", () => {
    const model = build({
      feed: configured({
        ...AUTHORIZED_FEED,
        playlistText: `${readLiveTvFixture("authorized-synthetic.m3u")}#EXTINF:-1 tvg-id="uncleared.example" group-title="News",Uncleared Channel\nhttps://edge.example.invalid/uncleared\n`,
        epgText: null
      })
    });
    if (model.status !== "ready") throw new Error("expected ready");
    expect(model.rows.map((row) => row.channel.displayName)).not.toContain("Uncleared Channel");
    expect(model.rejectedByReason).toEqual([{ reason: "no_rights_basis_declared", count: 1 }]);
  });

  it("carries no stream address anywhere in the model", () => {
    const model = build({ feed: configured() });
    const serialised = JSON.stringify(model);
    expect(serialised).not.toContain("edge.example.invalid");
    expect(serialised).not.toContain("index.m3u8");
  });
});
