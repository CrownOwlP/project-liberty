import type { EgressPolicy, HostClass, HostClassifier, HostResolver } from "../egress";
import type { PinnedFetch } from "../pin";

/* -------------------------------------------------------------------------
 * Test support. NOTHING IN THIS FILE IS PRODUCTION CODE.
 *
 * It is reachable only from `*.test.ts` files in this package and it is not
 * re-exported from `src/index.ts`, so it does not widen the package's surface.
 * It lives under `src/` rather than beside the tests for the same reason
 * `@liberty/contracts` puts its arbitraries there: a generator or a renderer is
 * a SECOND description of a shape, and one copy shared by every suite cannot
 * drift from itself the way three copies can.
 * ---------------------------------------------------------------------- */

/**
 * A HOST CLASSIFIER FOR TESTS ONLY, and deliberately a crude one.
 *
 * The real classifier is `classifyHost` in
 * `@liberty/provider-sdk/src/stremio/url-policy.ts`, which handles IPv4-mapped
 * IPv6, CGNAT, TEST-NET, and the octal and decimal spellings of an address.
 * This is NOT a second implementation of it and must never become one -- see the
 * header of `egress.ts` on why two SSRF classifiers is a worse outcome than one
 * injected port. It exists so that this package's tests can exercise the
 * COMPOSITION (allowlist, loopback keys, redirect revalidation, resolved-address
 * rejection) without depending on a package outside this task's boundary.
 *
 * If it ever grows a case that the real classifier does not have, that is a bug
 * in this file, not a feature.
 */
export const testClassifyHost: HostClassifier = (hostname: string): HostClass => {
  const host = hostname.toLowerCase();
  if (host === "") return "unparseable";
  // The WHOLE of 127/8, not just 127.0.0.1. The real classifier treats the
  // range that way and so does every operating system, and the transport suite
  // needs it: its negative test pins `localhost` to 127.0.0.2 -- a loopback
  // address where nothing is listening -- and has to obtain that pin from
  // `authoriseFetchTarget` like production does. A classifier that called
  // 127.0.0.2 "public" would still have authorised it, but for the wrong reason,
  // and a test whose setup passes by accident is a test that will pass after the
  // control it depends on is removed.
  if (host === "localhost" || host.endsWith(".localhost") || host.startsWith("127.") || host === "[::1]") {
    return "loopback";
  }
  if (host === "not a host" || host === "0") return "unparseable";
  if (
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    host.startsWith("172.16.") ||
    host === "169.254.169.254" ||
    host === "[fe80::1]" ||
    host === "[fd00::1]" ||
    host.endsWith(".internal") ||
    host.endsWith(".local")
  ) {
    return "private";
  }
  return "public";
};

/** Resolves everything to one public address unless the map says otherwise. */
export function testResolver(answers: Readonly<Record<string, readonly string[]>> = {}): HostResolver {
  return async (hostname: string): Promise<readonly string[]> => {
    const configured = answers[hostname.toLowerCase()];
    return configured ?? ["93.184.216.34"];
  };
}

export const permissiveEgress: EgressPolicy = {
  allowedHosts: [
    "cdn.example.test",
    ".cdn.example.test",
    "other.example.test",
    "localhost",
    "127.0.0.1"
  ],
  allowLoopback: false,
  localDeployment: false
};

/**
 * One rung, as a test states it. Every field nullable so that "the publisher did
 * not declare this" is expressible, which is the case most of these tests are
 * about.
 */
export interface VariantSpec {
  readonly bandwidthBps: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly frameRate: number | null;
  readonly codecs: string | null;
  readonly uri: string;
}

export function variant(overrides: Partial<VariantSpec> = {}): VariantSpec {
  return {
    bandwidthBps: 2_400_000,
    width: 1280,
    height: 720,
    frameRate: 29.97,
    codecs: "avc1.4d401f,mp4a.40.2",
    uri: "v/720.m3u8",
    ...overrides
  };
}

/**
 * Renders a master playlist.
 *
 * Attributes whose spec value is `null` are OMITTED rather than written empty,
 * because omission is what a terse publisher does and it is the input the
 * unknown-stays-unknown tests need. `RESOLUTION` is written only when both
 * halves are stated: a half-written `1920x` is a malformed-manifest case with
 * its own test rather than something the general renderer should produce.
 */
export function renderHlsMaster(variants: readonly VariantSpec[]): string {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:7"];
  for (const spec of variants) {
    const attributes: string[] = [];
    if (spec.bandwidthBps !== null) attributes.push(`BANDWIDTH=${spec.bandwidthBps}`);
    if (spec.width !== null && spec.height !== null) {
      attributes.push(`RESOLUTION=${spec.width}x${spec.height}`);
    }
    if (spec.codecs !== null) attributes.push(`CODECS="${spec.codecs}"`);
    if (spec.frameRate !== null) attributes.push(`FRAME-RATE=${spec.frameRate}`);
    lines.push(`#EXT-X-STREAM-INF:${attributes.join(",")}`);
    lines.push(spec.uri);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Renders an MPD with one video `AdaptationSet`.
 *
 * The Representations carry every declared attribute themselves, so this
 * renderer exercises the non-inherited path; the inheritance path has its own
 * hand-written fixtures in `dash.test.ts`, where being able to see the nesting
 * is the point.
 */
export function renderDashMpd(variants: readonly VariantSpec[]): string {
  const representations = variants.map((spec) => {
    const attributes: string[] = [];
    if (spec.bandwidthBps !== null) attributes.push(`bandwidth="${spec.bandwidthBps}"`);
    if (spec.width !== null) attributes.push(`width="${spec.width}"`);
    if (spec.height !== null) attributes.push(`height="${spec.height}"`);
    if (spec.frameRate !== null) attributes.push(`frameRate="${spec.frameRate}"`);
    if (spec.codecs !== null) attributes.push(`codecs="${spec.codecs}"`);
    return `      <Representation ${attributes.join(" ")}/>`;
  });

  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011">',
    "  <Period>",
    '    <AdaptationSet contentType="video" segmentAlignment="true">',
    ...representations,
    "    </AdaptationSet>",
    "  </Period>",
    "</MPD>",
    ""
  ].join("\n");
}

/**
 * A transport double.
 *
 * Returns a real `Response`, so the size cap, the header reads and the manual
 * redirect handling all run against the same objects production uses. `steps` is
 * consumed in order, which is what lets a redirect chain be written as a list.
 *
 * IT RECORDS THE PIN AS WELL AS THE URL. `pinned[n]` is the address set the
 * transport was given for hop n, which is the only place a test can observe
 * whether the addresses `authoriseFetchTarget` classified are the ones a socket
 * would have been opened to. A double that recorded only the URL could not tell
 * a pinned request from an unpinned one -- the distinction this package's SSRF
 * boundary now rests on.
 */
export interface FetchStep {
  readonly status: number;
  readonly body: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export function scriptedFetch(steps: readonly FetchStep[]): {
  readonly fetchImpl: PinnedFetch;
  readonly requested: string[];
  readonly pinned: string[][];
} {
  const requested: string[] = [];
  const pinned: string[][] = [];
  let index = 0;

  const fetchImpl: PinnedFetch = async (target) => {
    requested.push(target.url);
    pinned.push([...target.addresses]);
    const step = steps[Math.min(index, steps.length - 1)];
    index += 1;
    if (step === undefined) throw new Error("scriptedFetch ran out of steps");
    return new Response(step.body, { status: step.status, headers: { ...step.headers } });
  };

  return { fetchImpl, requested, pinned };
}
