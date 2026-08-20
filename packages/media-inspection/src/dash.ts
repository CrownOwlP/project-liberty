import { DOMParser } from "@xmldom/xmldom";
import { readDeclaredCodecs } from "./codecs";
import { canonicaliseRenditions } from "./order";
import { buildRendition, readFrameRate, readPositiveInteger, type RawDeclaration } from "./rendition";
import type {
  DeclaredRendition,
  InspectedFact,
  ManifestParseContext,
  ParsedLadder,
  RenditionKind
} from "./types";

/* -------------------------------------------------------------------------
 * DASH: the declared ladder out of an MPD.
 *
 * WHY `@xmldom/xmldom` DIRECTLY RATHER THAN `mpd-parser`.
 *
 * The research recommends `mpd-parser`, and for a PLAYER it is the right choice:
 * it normalises an MPD into the same playlist shape `m3u8-parser` produces, with
 * segment lists already resolved. That normalisation is the reason it is the
 * wrong choice here.
 *
 *   - It is a segment-list generator first. An MPD it cannot turn into a
 *     playable playlist -- no `SegmentTemplate`, no `SegmentList`, no
 *     `SegmentBase` -- raises rather than returning what the document declared.
 *     For a service whose entire job is to report DECLARED facts, refusing a
 *     valid ladder because the packaging is unusual is a false negative, and a
 *     false "we could not read this" is exactly the unknown-metadata problem
 *     PL-0205 exists to stop manufacturing.
 *   - Its normalised attributes are the ones a player needs, keyed by their HLS
 *     spellings. `@frameRate` is not something a player's ABR uses, and it is
 *     one of the four facts we are asked to return. Reporting it as unknown
 *     because an intermediate shape did not carry it would be reporting a
 *     library's limitation as a publisher's silence -- the same category error
 *     the whole package is built to avoid.
 *
 * So we take the dependency the research actually flagged as dangerous --
 * `@xmldom/xmldom`, which is what parses the attacker-influenced XML either way,
 * whether we depend on it directly or inherit it through `mpd-parser` -- pin it
 * to an EXACT version, size-limit the body before it ever reaches this file (see
 * `http.ts`), and read the five attributes ourselves. One fewer layer between
 * hostile bytes and our types, and no third party deciding what counts as
 * unreadable.
 *
 * WHY THE PIN IS `0.9.10` EVEN THOUGH npm CALLS IT DEPRECATED. Installing this
 * package prints `deprecated @xmldom/xmldom@0.9.10: this version has critical
 * issues, please update to the latest version`, and the instinct that warning
 * produces -- move off it -- is exactly wrong here, so the reasoning is recorded
 * rather than rediscovered:
 *
 *   - 0.9.10 IS the `latest` tag. The deprecation and the newest release are the
 *     same version, so "update to the latest version" resolves to staying put.
 *     There is nowhere newer to go.
 *   - 0.9.10 is the release that FIXES the advisories, including the unbounded
 *     recursion in `getElementsByTagName`. This file calls exactly that method,
 *     on attacker-influenced input, on every MPD -- see `elementsNamed`. Moving
 *     to 0.9.9 to silence the install warning would reintroduce the bug the pin
 *     exists to avoid, on the one code path that reaches it.
 *
 * So the warning is noise on this version and the pin is deliberate. If a 0.9.11
 * or later ships, the move is forward and through a review of what changed in
 * the parser -- never backward.
 *
 * `onError` is a no-op so that the parser is LENIENT: a recoverable XML error in
 * one element must not discard a ladder we could otherwise read. The default
 * handler would instead write the offending source to `console.error`, which for
 * a signed manifest is a credential in a log line. `fatalError` still throws --
 * that is xmldom's behaviour and not ours to override -- so the call is wrapped.
 *
 * NO URL IS EVER PRODUCED FOR A DASH RENDITION. Segment URLs in an MPD are
 * CONSTRUCTED from `BaseURL`, `SegmentTemplate` and `$Number$`/`$Time$`
 * substitution. Performing that construction would make this service a generator
 * of attacker-specified URLs on an attacker's behalf, which is the second-order
 * input problem in its purest form. It is player work and we decline it; the
 * location is `not_applicable`, which is a refusal rather than an absence.
 * ---------------------------------------------------------------------- */

/**
 * The structural minimum this module needs from an element.
 *
 * Written as a local interface rather than importing xmldom's `Element` so that
 * the coupling is one method with one signature. An upstream change to any other
 * part of that (large) DOM surface cannot break this file.
 */
interface AttributeSource {
  getAttribute(name: string): string | null;
}

/**
 * The structural minimum needed from a node that can be searched.
 *
 * `Document` and `Element` both satisfy it, which is what lets the same helper
 * run over the whole document and over one `AdaptationSet`.
 */
interface ElementScope {
  getElementsByTagName(name: string): {
    readonly length: number;
    item(index: number): (AttributeSource & ElementScope) | null;
  };
}

/**
 * Elements by LOCAL name, ignoring any namespace prefix.
 *
 * `getElementsByTagName("Representation")` matches the qualified name, so it
 * misses `<dash:Representation>` in an MPD that binds its namespace to a prefix.
 * That spelling is legal, rare, and trivially chosen by a publisher -- so
 * matching on the qualified name would mean a document could make its ladder
 * invisible to us by adding a prefix. Enumerating with `"*"` and comparing local
 * names removes that choice.
 */
function elementsNamed(scope: ElementScope, localName: string): (AttributeSource & ElementScope)[] {
  const all = scope.getElementsByTagName("*");
  const out: (AttributeSource & ElementScope)[] = [];
  for (let index = 0; index < all.length; index++) {
    const element = all.item(index);
    if (element === null) continue;
    const name = elementLocalName(element);
    if (name === localName) out.push(element);
  }
  return out;
}

/**
 * The local name of an element, read from the DOM rather than from a string.
 *
 * `nodeName` carries the prefix (`dash:Representation`); everything after the
 * last `:` is the local name. Written this way rather than reading `localName`
 * directly because `nodeName` is a `Node` member and is therefore the most
 * stable thing to depend on across DOM implementations.
 */
function elementLocalName(element: AttributeSource & ElementScope): string {
  const named = element as unknown as { readonly nodeName?: unknown };
  const nodeName = typeof named.nodeName === "string" ? named.nodeName : "";
  const colon = nodeName.lastIndexOf(":");
  return colon === -1 ? nodeName : nodeName.slice(colon + 1);
}

/**
 * Reads an attribute from the `Representation`, falling back to the
 * `AdaptationSet`, and says WHICH one answered.
 *
 * DASH allows `@width`, `@height`, `@frameRate`, `@codecs` and `@mimeType` to be
 * stated once on an `AdaptationSet` and inherited by every `Representation`
 * under it. Ignoring inheritance would report a correctly-authored MPD as
 * declaring almost nothing. Recording which element answered is not decoration:
 * "every rendition in this set is 1080p because the set says so" and "this
 * rendition says it is 1080p" are different claims, and a reason trail that
 * cannot tell them apart cannot explain a ladder whose set-level and
 * rendition-level declarations disagree.
 *
 * An empty attribute value is treated as PRESENT, not absent -- `getAttribute`
 * returns `""` for `width=""`, which is a declaration that cannot be read, and
 * the readers classify it as such. Falling back to the parent for an empty
 * string would silently substitute the set's value for the rendition's own
 * broken one.
 */
function inherited(
  representation: AttributeSource,
  adaptationSet: AttributeSource | null,
  name: string
): { readonly raw: RawDeclaration; readonly owner: "Representation" | "AdaptationSet" | null } {
  const own = representation.getAttribute(name);
  if (own !== null) return { raw: own, owner: "Representation" };
  const parent = adaptationSet === null ? null : adaptationSet.getAttribute(name);
  if (parent !== null) return { raw: parent, owner: "AdaptationSet" };
  return { raw: null, owner: null };
}

function citation(owner: "Representation" | "AdaptationSet" | null, attribute: string): string {
  return `${owner ?? "Representation"}@${attribute}`;
}

/**
 * The kind of track, from what the MPD DECLARES and from nothing else.
 *
 * `@contentType` first because it is the field that exists to say this;
 * `@mimeType`'s type part second. Never derived from the codec identifier: a
 * rendition whose set declares neither is `unknown`, and inferring "it must be
 * video because the codec is `avc1`" would be exactly the extension-sniffing
 * this package refuses to do, one layer up.
 */
function readKind(representation: AttributeSource, adaptationSet: AttributeSource | null): RenditionKind {
  const contentType = inherited(representation, adaptationSet, "contentType").raw;
  const declaredContentType = typeof contentType === "string" ? contentType.trim().toLowerCase() : "";
  if (declaredContentType === "video" || declaredContentType === "audio" || declaredContentType === "text") {
    return declaredContentType;
  }

  const mimeType = inherited(representation, adaptationSet, "mimeType").raw;
  const declaredMimeType = typeof mimeType === "string" ? mimeType.trim().toLowerCase() : "";
  const slash = declaredMimeType.indexOf("/");
  const type = slash === -1 ? declaredMimeType : declaredMimeType.slice(0, slash);
  if (type === "video" || type === "audio" || type === "text") return type;

  return "unknown";
}

export function parseDashLadder(text: string, context: ManifestParseContext): ParsedLadder {
  const pairs: { readonly representation: AttributeSource; readonly set: AttributeSource | null }[] = [];

  // The traversal is inside the same `try` as the parse, not just the parse.
  // xmldom's DOM is built from hostile input and its node lists are lazy, so a
  // document that survived parsing can still fail while being walked -- and an
  // exception escaping into a playback request is the outcome this whole file
  // exists to prevent.
  try {
    const parser = new DOMParser({
      // See the file header. Swallowing recoverable errors keeps the parse
      // lenient; the default handler would print the offending source, and the
      // source here is somebody else's signed manifest.
      onError: () => undefined,
      // Line and column numbers on every node are memory we never read. The
      // input is size-capped upstream, so this is housekeeping rather than a
      // control, but it is free.
      locator: false
    });
    const document = parser.parseFromString(text, "text/xml") as unknown as ElementScope;

    // Counted in one pass over the document BEFORE anything is built, and
    // hoisted above the AdaptationSet walk so that the refusal costs one scan
    // rather than one scan per set. `declared` is every `Representation` the
    // document contains, which is exactly the number of rungs the loops below
    // would produce: each element is claimed by a set or read as an orphan, and
    // neither path can add one. See `ManifestParseContext.maxRenditions` -- a
    // two-megabyte MPD of minimal `<Representation/>` elements declares tens of
    // thousands of them, and the sort that would follow is millions of
    // `JSON.stringify` calls with no deadline over it.
    //
    // The count is DECLARED, not distinct: a multi-period MPD restates its
    // ladder in every `Period`, so a 40-period presentation of eight rungs
    // declares 320 and can be refused for a ladder that would have collapsed to
    // eight. That is the reading this cap is for -- the cost it bounds is
    // proportional to what the document declared, not to what survives
    // canonicalisation -- but it means the number is a work budget rather than a
    // ladder-width budget, and an operator whose catalogue is many-period MPDs
    // raises it deliberately instead of being surprised by a refusal.
    const declared = elementsNamed(document, "Representation");
    if (declared.length > context.maxRenditions) {
      return {
        renditions: [],
        reasons: [
          {
            code: "too_many_renditions",
            detail: `${declared.length} declared renditions exceeds the cap of ${context.maxRenditions}`
          }
        ]
      };
    }

    const claimed = new Set<AttributeSource>();
    for (const set of elementsNamed(document, "AdaptationSet")) {
      for (const representation of elementsNamed(set, "Representation")) {
        claimed.add(representation);
        pairs.push({ representation, set });
      }
    }

    // A `Representation` outside any `AdaptationSet` is malformed, and a
    // malformed MPD is precisely the input this service must handle rather than
    // reject. It is read with no inheritance, which is the only honest reading:
    // there is no parent whose attributes it could have inherited.
    for (const orphan of declared) {
      if (claimed.has(orphan)) continue;
      pairs.push({ representation: orphan, set: null });
    }
  } catch (error) {
    return {
      renditions: [],
      reasons: [
        {
          code: "manifest_unparseable",
          detail: `XML parser threw ${error instanceof Error ? error.name : typeof error}`
        }
      ]
    };
  }

  if (pairs.length === 0) {
    return {
      renditions: [],
      reasons: [
        { code: "no_renditions_declared", detail: "the document declared no Representation elements" }
      ]
    };
  }

  const renditions: DeclaredRendition[] = [];

  for (const { representation, set } of pairs) {
    const unreadableDeclarations: string[] = [];

    // `@bandwidth` is required on a Representation and is never inherited: it
    // describes one rendition's bitrate, so a set-level value would be
    // meaningless.
    const bandwidthRaw = representation.getAttribute("bandwidth");
    const bandwidth = readPositiveInteger(bandwidthRaw);
    if (bandwidth.unreadable) unreadableDeclarations.push("Representation@bandwidth");

    const widthDeclaration = inherited(representation, set, "width");
    const width = readPositiveInteger(widthDeclaration.raw);
    if (width.unreadable) unreadableDeclarations.push(citation(widthDeclaration.owner, "width"));

    const heightDeclaration = inherited(representation, set, "height");
    const height = readPositiveInteger(heightDeclaration.raw);
    if (height.unreadable) unreadableDeclarations.push(citation(heightDeclaration.owner, "height"));

    const frameRateDeclaration = inherited(representation, set, "frameRate");
    const frameRate = readFrameRate(frameRateDeclaration.raw);
    if (frameRate.unreadable) {
      unreadableDeclarations.push(citation(frameRateDeclaration.owner, "frameRate"));
    }

    const codecsDeclaration = inherited(representation, set, "codecs");
    const codecsText =
      typeof codecsDeclaration.raw === "string" && codecsDeclaration.raw.trim() !== ""
        ? codecsDeclaration.raw.trim()
        : null;
    if (codecsDeclaration.raw !== null && codecsText === null) {
      unreadableDeclarations.push(citation(codecsDeclaration.owner, "codecs"));
    }

    const codecCitation = citation(codecsDeclaration.owner, "codecs");
    const evidenceDetail: Readonly<Record<InspectedFact, string>> = {
      videoCodec: codecCitation,
      audioCodec: codecCitation,
      width: citation(widthDeclaration.owner, "width"),
      height: citation(heightDeclaration.owner, "height"),
      frameRate: citation(frameRateDeclaration.owner, "frameRate"),
      bandwidthBps: "Representation@bandwidth"
    };

    renditions.push(
      buildRendition({
        kind: readKind(representation, set),
        location: { kind: "not_applicable" },
        codecs: readDeclaredCodecs(codecsText),
        width: width.value,
        height: height.value,
        frameRate: frameRate.value,
        bandwidthBps: bandwidth.value,
        unreadableDeclarations,
        evidenceDetail,
        observedAt: context.observedAt
      })
    );
  }

  const canonical = canonicaliseRenditions(renditions);
  return {
    renditions: canonical,
    reasons:
      canonical.length === 0
        ? [{ code: "no_renditions_declared", detail: "the document declared no Representation elements" }]
        : []
  };
}
