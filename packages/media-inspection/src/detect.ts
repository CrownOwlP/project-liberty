import type { ManifestFormat } from "./types";

/**
 * A UTF-8 BOM survives `TextDecoder` as U+FEFF and would push `#EXTM3U` off the
 * front of the document. Publishers emit one often enough that treating a BOM'd
 * playlist as an unrecognised format would be a routine false negative.
 *
 * Built from its code point rather than typed into a string literal, because
 * U+FEFF is invisible in a diff and a reviewer cannot check what they cannot
 * see -- and because a stray BOM inside a source file is one of the more
 * annoying things to debug.
 */
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

/**
 * Which format a manifest is, decided from the BYTES and from nothing else.
 *
 * NOT from the URL. A `.m3u8` suffix is chosen by whoever wrote the URL, and for
 * a manifest URL that is a third party; routing an XML document into the HLS
 * parser because its path ended in `.m3u8` would be the same class of mistake as
 * deriving a codec from a file extension, which `codecs.ts` refuses to do one
 * layer down.
 *
 * NOT from `Content-Type` either. It is a header the same third party sets, it
 * is wrong constantly in practice for `application/vnd.apple.mpegurl` versus
 * `application/x-mpegURL` versus `text/plain`, and preferring it would mean a
 * publisher could steer our parser selection with a header while serving
 * something else entirely.
 *
 * HLS is checked first and is checked STRICTLY: RFC 8216 requires `#EXTM3U` to
 * be the first line, so anything else is not an HLS playlist however much it
 * looks like one.
 */
export function detectManifestFormat(text: string): ManifestFormat | null {
  const withoutMark = text.startsWith(BYTE_ORDER_MARK) ? text.slice(BYTE_ORDER_MARK.length) : text;
  const start = withoutMark.trimStart();

  if (start.startsWith("#EXTM3U")) return "hls";

  // The root element, with or without a namespace prefix, allowing the XML
  // declaration, comments, processing instructions and a DOCTYPE to precede it.
  // Bounded to the first 4 KiB so that a megabyte of leading comments cannot
  // turn detection into a scan of the whole body.
  if (/<(?:[A-Za-z_][\w.-]*:)?MPD[\s>/]/.test(start.slice(0, 4096))) return "dash";

  return null;
}
