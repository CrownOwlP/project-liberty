import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { LogEvent } from "@liberty/observability";
import { CMCD_COLLECTOR_PATH } from "../../../../../components/player/telemetry-decision";
import {
  CMCD_JSON_REPORT_MEDIA_TYPE,
  CMCD_REPORT_MEDIA_TYPE,
  cmcdCollectorResponseSchema,
  type CmcdCollectorResponse
} from "./contract";
import { CMCD_SFV_LIMITS } from "./cmcd-sfv";
import { handleCmcdReportRequest, type CmcdCollectorOptions } from "./handler";
import { POST } from "./route";

/* -------------------------------------------------------------------------
 * The HTTP half. What is pinned here is that the status code and the outcome
 * never disagree, that a client-caused failure is a client status rather than a
 * 500 -- which for this endpoint is not a style preference, because shaka's
 * reporter RE-QUEUES a batch on 429 and 5xx -- and that nothing from the request
 * reaches either a sink or the response except through the collector's redacted
 * output.
 * ---------------------------------------------------------------------- */

const RECEIVED_AT = new Date("2026-08-20T09:00:00.000Z");

const SIGNED =
  "https://cdn.example.com/movies/northstar/1080p/seg-000012.m4s" +
  "?Policy=eyJTdGF0ZW1lbnQi&Signature=SECRET-SIGNATURE&Key-Pair-Id=APKAEXAMPLE";

function collectorOptions(sink: (event: LogEvent) => void): CmcdCollectorOptions {
  return { now: () => RECEIVED_AT, sink };
}

function post(body: string, contentType: string | null): Request {
  const headers: Record<string, string> = contentType === null ? {} : { "content-type": contentType };
  return new Request(`https://liberty.test${CMCD_COLLECTOR_PATH}`, {
    method: "POST",
    headers,
    body
  });
}

interface Answer {
  readonly status: number;
  readonly body: CmcdCollectorResponse;
  readonly logs: readonly LogEvent[];
}

async function answer(request: Request): Promise<Answer> {
  const logs: LogEvent[] = [];
  const response = await handleCmcdReportRequest(
    request,
    collectorOptions((event) => {
      logs.push(event);
    })
  );
  return {
    status: response.status,
    // Parsed against the published union, so a body that is not a member of it
    // fails here rather than being asserted field by field.
    body: cmcdCollectorResponseSchema.parse(await response.json()),
    logs
  };
}

const EVENT_LINE = 'e=ps,sta=s,msd=1500,cid="the-northstar-affair",ts=1700000000000';

describe("the collector path is the one the player is pointed at", () => {
  it("matches this route module's own location on disk", () => {
    /*
     * `telemetry-decision.ts` declares the path as a constant rather than
     * importing one from here, because importing out of `app/api/**` into a
     * client component would pull zod and the observability sink into the
     * browser bundle. This is what keeps the two honest: the path is derived
     * from where this file actually sits under `app/`.
     */
    const segments = dirname(fileURLToPath(import.meta.url)).split(/[\\/]/);
    const appIndex = segments.lastIndexOf("app");
    expect(appIndex).toBeGreaterThan(-1);
    expect(`/${segments.slice(appIndex + 1).join("/")}`).toBe(CMCD_COLLECTOR_PATH);
  });
});

describe("what this endpoint will read", () => {
  it("takes shaka's Event Mode body and records it", async () => {
    const result = await answer(post(`${EVENT_LINE}\n`, CMCD_REPORT_MEDIA_TYPE));

    expect(result.status).toBe(202);
    expect(result.body.outcome).toBe("collected");
    expect(result.body.accepted).toBe(1);
    expect(result.logs).toHaveLength(1);
    expect(result.logs[0]?.event).toBe("playback.cmcd.startup");
    expect(result.logs[0]?.fields?.["cmcd.msdMs"]).toBe(1500);
    expect(result.logs[0]?.fields?.["telemetry.receivedAtEpochMs"]).toBe(RECEIVED_AT.getTime());
  });

  it("takes the JSON spelling of the same report", async () => {
    const result = await answer(
      post(
        JSON.stringify({ events: [{ e: "t", "com.liberty-avs-video-hole": "quiet" }] }),
        CMCD_JSON_REPORT_MEDIA_TYPE
      )
    );

    expect(result.status).toBe(202);
    expect(result.logs[0]?.fields?.["cmcd.custom.com.liberty-avs-video-hole"]).toBe("quiet");
  });

  it("tolerates a charset parameter on the media type", async () => {
    const result = await answer(post(EVENT_LINE, `${CMCD_REPORT_MEDIA_TYPE}; charset=utf-8`));
    expect(result.status).toBe(202);
  });

  it("refuses any media type it does not read, rather than sniffing the body", async () => {
    /*
     * `null` here means "we set no header": a `Request` built from a string body
     * still carries `text/plain` by the fetch specification, so what this case
     * actually exercises is the same refusal as the two below it. The absent-
     * header branch is the one that cannot be constructed through `Request`.
     */
    for (const contentType of [null, "text/plain", "application/x-www-form-urlencoded"]) {
      const result = await answer(post(EVENT_LINE, contentType));
      expect(result.status, String(contentType)).toBe(415);
      expect(result.body.reasons[0].code).toBe("content_type_not_supported");
    }
  });

  it("refuses a body larger than the stated bound", async () => {
    const result = await answer(
      post("x".repeat(CMCD_SFV_LIMITS.maxBodyBytes + 1), CMCD_REPORT_MEDIA_TYPE)
    );
    expect(result.status).toBe(413);
    expect(result.body.reasons[0].code).toBe("body_too_large");
    expect(result.logs).toEqual([]);
  });
});

describe("nothing that identifies a viewer is accepted", () => {
  it("refuses a top-level field beside `events` rather than stripping it", async () => {
    /*
     * The failure mode this prevents is the quiet one: zod strips unknown keys
     * by default, so a client sending `userId` would get a cheerful 202 and
     * believe the field meant something -- and the next person to extend the
     * schema would be one keystroke from honouring it.
     */
    const result = await answer(
      post(
        JSON.stringify({ events: [{ e: "t" }], userId: "viewer-4711" }),
        CMCD_JSON_REPORT_MEDIA_TYPE
      )
    );

    expect(result.status).toBe(400);
    expect(result.body.reasons[0].code).toBe("field_not_permitted");
    expect(JSON.stringify(result.body)).not.toContain("viewer-4711");
    expect(result.logs).toEqual([]);
  });

  it("turns no request header into data", async () => {
    const request = new Request(`https://liberty.test${CMCD_COLLECTOR_PATH}`, {
      method: "POST",
      headers: {
        "content-type": CMCD_REPORT_MEDIA_TYPE,
        "user-agent": "IdentifiableBrowser/1.0 (viewer-4711)",
        "x-request-id": "correlate-me-4711",
        referer: "https://liberty.test/watch/the-northstar-affair"
      },
      body: EVENT_LINE
    });

    const result = await answer(request);

    expect(result.status).toBe(202);
    const everything = JSON.stringify({ body: result.body, logs: result.logs });
    expect(everything).not.toContain("IdentifiableBrowser");
    expect(everything).not.toContain("correlate-me-4711");
    expect(everything).not.toContain("watch/the-northstar-affair");
    // CMCD's `sid` is the correlation id this pipeline joins on, and a header
    // is unbounded attacker-controlled text, so `requestId` is always null.
    expect(result.logs[0]).not.toHaveProperty("requestId");
  });
});

describe("redaction happens before anything is logged or answered", () => {
  it("lets no signed URL out through either the sink or the response", async () => {
    const result = await answer(
      post(`url="${SIGNED}",nor=("../seg-000013.m4s"),e=rr`, CMCD_REPORT_MEDIA_TYPE)
    );

    expect(result.status).toBe(202);

    /*
     * Searched for the SIGNATURE and the PATH, never for the string "url" --
     * which is a CMCD key name and therefore appears as the field name
     * `cmcd.url` in the very record this asserts is clean. A text search cannot
     * tell a key being named from a value being leaked, and `telemetry.test.ts`
     * records the same trap from the client side, where it reported a leak that
     * was not there.
     */
    const everything = JSON.stringify({ body: result.body, logs: result.logs });
    expect(everything).not.toContain("SECRET-SIGNATURE");
    expect(everything).not.toContain("movies");
    expect(everything).not.toContain("seg-000013");
    expect(result.logs[0]?.fields?.["cmcd.url"]).toBe("https://cdn.example.com/[redacted]");
  });

  it("does not echo a value it refused", async () => {
    const result = await answer(post(`cid="x",url=(${JSON.stringify(SIGNED)})`, CMCD_REPORT_MEDIA_TYPE));
    expect(JSON.stringify(result.body)).not.toContain("SECRET-SIGNATURE");
  });
});

describe("a refusal explains itself and is never a server error", () => {
  it("answers 4xx for every malformed request, because 5xx means resend", async () => {
    /*
     * `cmcd_reporter.js`'s `sendEventReport_` throws on 429 and 5xx, and the
     * caller re-queues the batch at the head of its queue. A body that can never
     * succeed answered with a 5xx is therefore a client-side queue that grows
     * without bound.
     */
    const cases: readonly (readonly [string, string])[] = [
      ["", CMCD_REPORT_MEDIA_TYPE],
      ["not a dictionary at all", CMCD_REPORT_MEDIA_TYPE],
      ["{not json", CMCD_JSON_REPORT_MEDIA_TYPE],
      [JSON.stringify({ events: [] }), CMCD_JSON_REPORT_MEDIA_TYPE],
      [JSON.stringify({ events: "not an array" }), CMCD_JSON_REPORT_MEDIA_TYPE],
      [JSON.stringify([{ e: "t" }]), CMCD_JSON_REPORT_MEDIA_TYPE]
    ];

    for (const [body, contentType] of cases) {
      const result = await answer(post(body, contentType));
      expect(result.status, body).toBeGreaterThanOrEqual(400);
      expect(result.status, body).toBeLessThan(500);
      expect(result.body.outcome, body).toBe("refused");
      expect(result.body.accepted, body).toBe(0);
      expect(result.body.reasons[0].detail.length, body).toBeGreaterThan(0);
      expect(result.logs, body).toEqual([]);
    }
  });

  it("collects what it can and lists what it would not take", async () => {
    // One good line, one that is not a dictionary, and a real key carrying the
    // wrong type. The batch is not discarded over any of them.
    const result = await answer(
      post(`${EVENT_LINE}\nnot a dictionary\nmsd="fifteen hundred"\n`, CMCD_REPORT_MEDIA_TYPE)
    );

    expect(result.status).toBe(202);
    expect(result.body.accepted).toBe(2);
    expect(result.body.refusals).toContainEqual({
      stage: "decode",
      reason: "line_unparseable",
      key: null,
      count: 1
    });
    expect(result.body.refusals).toContainEqual({
      stage: "collect",
      reason: "wrong_type",
      key: "msd",
      count: 1
    });
    // The decoder's refusals belong to no event, so they get their own line.
    expect(result.logs.map((entry) => entry.event)).toContain("playback.cmcd.decode_refused");
  });

  it("orders refusals by stage and reason rather than by which fired first", async () => {
    const body = `${EVENT_LINE}\nnot a dictionary\nmsd="x",br="y"\n`;
    const first = await answer(post(body, CMCD_REPORT_MEDIA_TYPE));
    const second = await answer(post(body, CMCD_REPORT_MEDIA_TYPE));

    expect(first.body.refusals).toEqual(second.body.refusals);
    expect(first.body.refusals.map((refusal) => refusal.stage)).toEqual([
      "collect",
      "collect",
      "decode"
    ]);
  });
});

describe("the route module", () => {
  it("is a thin adapter that answers with the handler's decision", async () => {
    const response = await POST(post(`${EVENT_LINE}\n`, CMCD_REPORT_MEDIA_TYPE));
    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("no-store");
    // Through the real sink and the real clock, so this also asserts that the
    // adapter supplying no options is a working configuration.
    expect(cmcdCollectorResponseSchema.parse(await response.json()).outcome).toBe("collected");
  });
});
