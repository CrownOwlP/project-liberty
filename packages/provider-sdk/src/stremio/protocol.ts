import { z } from "zod";

/**
 * Wire shapes of the Stremio addon protocol (PL-0301).
 *
 * This file describes what an addon SAYS. Nothing here is trusted, and in
 * particular nothing here carries rights: there is no field in this protocol
 * that establishes what Project Liberty is entitled to serve, so no field in
 * this protocol is allowed to influence that decision. Rights come from the
 * operator's source configuration and only from there (see `source.ts`).
 *
 * The schemas are deliberately LENIENT about fields we do not use and STRICT
 * about the ones we do. An addon that ships an extra vendor field should not
 * take the whole source offline, but an addon whose `streams` is an object
 * rather than an array must not reach the mapper -- an unvalidated response is
 * how a third party gets to choose which branch of our code runs.
 *
 * Everything here parses; nothing here throws. A malformed response is an
 * ordinary, reportable outcome of talking to a third party, not an exception
 * that unwinds a playback request.
 */

/**
 * The manifest's `resources` entry is either a bare name (`"stream"`) or an
 * object narrowing that resource to particular types and id prefixes. Both
 * spellings are live in the wild, so both are accepted and normalised by
 * `manifestServes` below rather than being handled at every call site.
 */
const resourceSchema = z.union([
  z.string().min(1),
  z.object({
    name: z.string().min(1),
    types: z.array(z.string()).optional(),
    idPrefixes: z.array(z.string()).optional()
  })
]);

const catalogSchema = z.object({
  type: z.string().min(1),
  id: z.string().min(1),
  name: z.string().optional()
});

export const stremioManifestSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  /**
   * Optional with an empty default rather than required, because a manifest that
   * omits `types` is common and merely means "ask and find out". It is NOT
   * defaulted to a permissive list: `manifestServes` reads an empty list as "no
   * declared restriction", and that reading is stated in one place.
   */
  types: z.array(z.string()).default([]),
  resources: z.array(resourceSchema).default([]),
  catalogs: z.array(catalogSchema).default([]),
  idPrefixes: z.array(z.string()).optional(),
  behaviorHints: z
    .object({
      adult: z.boolean().optional(),
      p2p: z.boolean().optional(),
      configurable: z.boolean().optional(),
      configurationRequired: z.boolean().optional()
    })
    .optional()
});

export type StremioManifest = z.infer<typeof stremioManifestSchema>;

/**
 * A stream object.
 *
 * Every field that names a NON-direct source is modelled even though this
 * adapter refuses all of them, because "we did not look at `infoHash`" and "we
 * looked at `infoHash` and refused" are different guarantees, and only the second
 * one produces a reason a reviewer can audit. Stripping them at the schema would
 * make the mapper's refusal unreachable and untestable.
 */
export const stremioStreamSchema = z.object({
  /** A direct URL. The only field that can become a candidate. */
  url: z.string().optional(),
  /** A YouTube video id. Turning one into a media URL is extraction; refused. */
  ytId: z.string().optional(),
  /** A torrent info hash. Refused, and never looked up. */
  infoHash: z.string().optional(),
  /** File index within a torrent. Refused with its info hash. */
  fileIdx: z.number().optional(),
  /** Trackers / DHT hints belonging to an info hash. Refused. */
  sources: z.array(z.string()).optional(),
  /** A page to open in another app. Not a stream; refused. */
  externalUrl: z.string().optional(),
  name: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  behaviorHints: z
    .object({
      notWebReady: z.boolean().optional(),
      bingeGroup: z.string().optional(),
      /**
       * Headers the addon wants us to replay to the stream origin. Never sent.
       * See `mapping.ts`: a stream that only plays with someone else's headers
       * is a stream whose origin is enforcing an access control.
       */
      proxyHeaders: z.unknown().optional(),
      countryWhitelist: z.array(z.string()).optional(),
      videoSize: z.number().optional(),
      filename: z.string().optional()
    })
    .optional()
});

export type StremioStream = z.infer<typeof stremioStreamSchema>;

export const stremioStreamResponseSchema = z.object({
  streams: z.array(stremioStreamSchema).default([]),
  cacheMaxAge: z.number().nonnegative().optional()
});

export type StremioStreamResponse = z.infer<typeof stremioStreamResponseSchema>;

interface ParseIssueLike {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

/**
 * Flattens Zod issues into one line.
 *
 * Bounded at five issues: a hostile or badly broken response can produce
 * hundreds, and an error string that large ends up truncated by whatever logs it
 * -- usually losing the first issue, which is the useful one.
 */
export function formatIssues(issues: readonly ParseIssueLike[]): string {
  const shown = issues.slice(0, 5).map((issue) => {
    const path = issue.path.map((part) => String(part)).join(".");
    return `${path === "" ? "<root>" : path}: ${issue.message}`;
  });
  const extra = issues.length - shown.length;
  return extra > 0 ? `${shown.join("; ")} (+${extra} more)` : shown.join("; ");
}

export type ProtocolParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly detail: string };

function parseWith<T>(schema: { safeParse: (input: unknown) => unknown }, input: unknown): ProtocolParseResult<T> {
  const result = schema.safeParse(input) as
    | { success: true; data: T }
    | { success: false; error: { issues: readonly ParseIssueLike[] } };
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, detail: formatIssues(result.error.issues) };
}

export function parseStremioManifest(input: unknown): ProtocolParseResult<StremioManifest> {
  return parseWith<StremioManifest>(stremioManifestSchema, input);
}

export function parseStremioStreamResponse(input: unknown): ProtocolParseResult<StremioStreamResponse> {
  return parseWith<StremioStreamResponse>(stremioStreamResponseSchema, input);
}

/**
 * Whether the manifest claims to serve `resource` for this type and id.
 *
 * Used to skip a request the addon has already told us it cannot answer. This is
 * an optimisation and a blast-radius reduction -- it stops us handing a viewer's
 * content ids to an addon with no reason to see them -- and NOT a security
 * control: the addon authored the manifest, so a lying manifest simply widens
 * what it gets asked. The real gate is what comes back.
 *
 * An empty `types` or `resources` list means "not declared", which is read as
 * "no restriction". That is the permissive reading, and it is safe only because
 * nothing downstream trusts the manifest; if a future caller uses this to decide
 * anything about rights or safety, this default is wrong for that use.
 */
export function manifestServes(
  manifest: StremioManifest,
  resource: string,
  type: string,
  id: string
): boolean {
  const entries = manifest.resources.map((entry) =>
    typeof entry === "string" ? { name: entry, types: undefined, idPrefixes: undefined } : entry
  );

  const declared = entries.filter((entry) => entry.name === resource);
  if (entries.length > 0 && declared.length === 0) return false;

  if (manifest.types.length > 0 && !manifest.types.includes(type)) {
    // A resource entry may re-declare types; only conclude "no" if neither the
    // manifest nor the matching resource entry lists this type.
    const perResource = declared.some((entry) => entry.types?.includes(type) === true);
    if (!perResource) return false;
  }

  const prefixesFor = declared
    .map((entry) => entry.idPrefixes)
    .find((prefixes) => prefixes !== undefined) ?? manifest.idPrefixes;

  if (prefixesFor && prefixesFor.length > 0 && !prefixesFor.some((prefix) => id.startsWith(prefix))) {
    return false;
  }

  return true;
}
