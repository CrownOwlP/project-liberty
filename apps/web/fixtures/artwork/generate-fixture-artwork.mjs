#!/usr/bin/env node
/*
 * Regenerates the development artwork fixtures (PW-0302).
 *
 * WHY A GENERATOR AND NOT SIX HAND-MADE FILES. The images in this directory are
 * not artwork in the product sense -- see README.md, which says exactly what
 * they are and are not. They exist so the artwork resolution boundary and the
 * browse card can be exercised end to end on a machine with no licensed
 * provider, and the honest way to ship such a thing is with the program that
 * produced it committed beside it. Anyone can re-run this and get the same bytes
 * back; nothing here came from anywhere else.
 *
 * NO DEPENDENCIES. A PNG is a signature, an IHDR, a zlib-compressed IDAT and an
 * IEND, and `node:zlib` is the only part of that Node does not already have as
 * arithmetic. Reaching for an image library to draw a gradient would add a
 * native dependency to a repository that deliberately avoids one on the image
 * path -- see `apps/web/src/components/artwork/poster-artwork.tsx`.
 *
 * Usage: node apps/web/fixtures/artwork/generate-fixture-artwork.mjs
 */
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 2:3, the shape a poster is composed in. Small enough to read in a diff stat. */
const WIDTH = 400;
const HEIGHT = 600;

/**
 * The six fixture works, by the asset reference each one's poster is stored
 * under. The references match `ARTWORK_ASSET_REF_PATTERN` in
 * `@liberty/contracts/shared/artwork` -- lower-case, hyphen-separated, no dot
 * and no slash -- and `apps/web/src/lib/demo-catalog.ts` names the same six.
 */
const POSTERS = [
  "aurora-fall-poster",
  "signal-zero-poster",
  "deep-current-poster",
  "northstar-poster",
  "open-skies-poster",
  "harbor-lights-poster"
];

/** FNV-1a, so a reference always produces the same hue on every machine. */
function hueFor(reference) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < reference.length; index += 1) {
    hash ^= reference.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 360;
}

function hslToRgb(hue, saturation, lightness) {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const second = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const match = lightness - chroma / 2;
  const [red, green, blue] =
    hue < 60 ? [chroma, second, 0] :
    hue < 120 ? [second, chroma, 0] :
    hue < 180 ? [0, chroma, second] :
    hue < 240 ? [0, second, chroma] :
    hue < 300 ? [second, 0, chroma] : [chroma, 0, second];
  return [
    Math.round((red + match) * 255),
    Math.round((green + match) * 255),
    Math.round((blue + match) * 255)
  ];
}

/** CRC-32, the one checksum every PNG chunk carries. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, payload) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), payload]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/**
 * One poster: a vertical gradient in the reference's own hue, with a soft
 * off-centre highlight, matching the CSS gradient the card falls back to so the
 * two states do not look like different products.
 */
function posterPng(reference) {
  const hue = hueFor(reference);
  // Filter byte 0 (None) per row, then RGB triples.
  const raw = Buffer.alloc(HEIGHT * (1 + WIDTH * 3));
  let cursor = 0;
  for (let y = 0; y < HEIGHT; y += 1) {
    raw[cursor] = 0;
    cursor += 1;
    const down = y / (HEIGHT - 1);
    for (let x = 0; x < WIDTH; x += 1) {
      const across = x / (WIDTH - 1);
      const dx = across - 0.68;
      const dy = down - 0.26;
      const highlight = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) * 2.4);
      const lightness = 0.1 + down * 0.16 + highlight * highlight * 0.34;
      const [red, green, blue] = hslToRgb(hue, 0.44, lightness);
      raw[cursor] = red;
      raw[cursor + 1] = green;
      raw[cursor + 2] = blue;
      cursor += 3;
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(WIDTH, 0);
  header.writeUInt32BE(HEIGHT, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: truecolour
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

const directory = dirname(fileURLToPath(import.meta.url));
for (const reference of POSTERS) {
  const file = join(directory, `${reference}.png`);
  writeFileSync(file, posterPng(reference));
  console.log(`${reference}.png  ${WIDTH}x${HEIGHT}`);
}
