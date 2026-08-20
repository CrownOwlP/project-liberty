/**
 * Ambient types for `m3u8-parser` (PL-0304).
 *
 * WHY THIS FILE EXISTS. `m3u8-parser@7.2.0` publishes no `types` field and no
 * bundled declarations, so `import { Parser } from "m3u8-parser"` is a TS7016
 * error under this repository's `strict` build. The alternatives were a
 * `@ts-expect-error`, which suppresses the next real error too, or
 * DefinitelyTyped, which is a third party's guess at a fourth party's shape.
 *
 * WHY `manifest` IS `unknown` RATHER THAN A MODELLED SHAPE. It is the single
 * most important line in the file. `parser.manifest` is a plain object built
 * from ATTACKER-INFLUENCED TEXT: every key under `playlists[].attributes` comes
 * from an attribute list a publisher wrote, and the library coerces some values
 * (`BANDWIDTH` through `parseInt`, `FRAME-RATE` through `parseFloat`) in ways
 * that yield `NaN` rather than throwing. A hand-written interface here would be
 * a promise this file cannot keep -- the compiler would then let `hls.ts` read
 * `attributes.BANDWIDTH` as a `number` that is actually `NaN`, or as a field
 * that is actually absent. Typing it `unknown` forces every read through the
 * narrowing helpers in `hls.ts`, which is what we would have to do anyway if the
 * declarations were accurate.
 *
 * An ambient module declaration takes priority over node_modules resolution, so
 * if a future version of `m3u8-parser` starts shipping its own types this file
 * still wins and nothing silently changes shape. Deleting it is then a
 * deliberate, reviewable act rather than an upgrade side effect.
 */
declare module "m3u8-parser" {
  export class Parser {
    constructor();
    /** Accepts the manifest text; may be called repeatedly with fragments. */
    push(chunk: string): void;
    /** Flushes the final line. Must be called before reading `manifest`. */
    end(): void;
    /** See the file header: deliberately not modelled. */
    readonly manifest: unknown;
  }
}
