// The pixel sampler the wave-station gate judges with, measured on rasters a test builds itself.
//
// WHY THIS TEST EXISTS. tools/verify-wave-dot-opacity.mjs decides, from rendered pixels, whether the connector shows
// through the wave station's disc. A sampler that was blind - a wrong radius, a label mask that covered every row, a
// threshold that never fires - would pass every shot and the live gate would be a green light over a defect. So the
// same functions are pointed at images whose answer is known: a disc with the line painted through it (the defect) and
// a disc that hides it (the fix), and the PNG decoder is round-tripped through every filter Chromium can write.
import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";

import {
  analyseDot,
  channelGap,
  contrast,
  decodePng,
  modeColour,
  over,
  parseColour,
  pixelAt,
} from "../tools/verify-wave-dot-opacity.mjs";

// ---- a PNG writer, so the decoder has something it did not make ------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

/** A truecolour-alpha PNG, `filter` applied to every scanline exactly as a PNG encoder would. */
function encodePng(width, height, rgba, filter = 0) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = filter;
    for (let i = 0; i < stride; i += 1) {
      const value = rgba[y * stride + i];
      const a = i >= 4 ? rgba[y * stride + i - 4] : 0;
      const b = y > 0 ? rgba[(y - 1) * stride + i] : 0;
      const c = i >= 4 && y > 0 ? rgba[(y - 1) * stride + i - 4] : 0;
      let encoded = value;
      if (filter === 1) encoded = (value - a) & 255;
      else if (filter === 2) encoded = (value - b) & 255;
      else if (filter === 3) encoded = (value - ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        encoded = (value - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
      raw[y * (stride + 1) + 1 + i] = encoded;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const gradient = (width, height) => {
  const out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      out[i] = (x * 17) & 255;
      out[i + 1] = (y * 29) & 255;
      out[i + 2] = (x * y * 7) & 255;
      out[i + 3] = 255;
    }
  }
  return out;
};

test("the PNG decoder reads every filter a screenshot can carry", () => {
  const width = 7;
  const height = 4;
  const source = gradient(width, height);
  for (const filter of [0, 1, 2, 3, 4]) {
    const raster = decodePng(encodePng(width, height, source, filter));
    assert.equal(raster.width, width, `filter ${filter}: width`);
    assert.equal(raster.height, height, `filter ${filter}: height`);
    for (let i = 0; i < width * height; i += 1) {
      assert.deepEqual(
        [raster.data[i * 4], raster.data[i * 4 + 1], raster.data[i * 4 + 2], raster.data[i * 4 + 3]],
        [source[i * 4], source[i * 4 + 1], source[i * 4 + 2], source[i * 4 + 3]],
        `filter ${filter}: pixel ${i}`,
      );
    }
  }
});

test("a colour token is parsed with its alpha, and laid over a fill the way a browser lays it", () => {
  assert.deepEqual(parseColour("#56d364"), [0x56, 0xd3, 0x64, 1]);
  assert.deepEqual(parseColour("rgba(46, 160, 67, 0.14)"), [46, 160, 67, 0.14]);
  assert.deepEqual(parseColour("rgb(1, 2, 3)"), [1, 2, 3, 1]);
  assert.equal(parseColour("not a colour"), null);
  // The running tint over the card surface: the ONE composite the current disc has to keep.
  assert.deepEqual(over([46, 160, 67, 0.14], [20, 25, 34]), [24, 44, 39]);
  assert.deepEqual(over([86, 211, 100, 1], [20, 25, 34]), [86, 211, 100]);
  assert.equal(over(null, [1, 2, 3]), null);
});

test("contrast and channel distance answer the obvious cases", () => {
  assert.equal(Math.round(contrast([0, 0, 0], [255, 255, 255])), 21);
  assert.equal(contrast([10, 10, 10], [10, 10, 10]), 1);
  assert.equal(channelGap([10, 20, 30], [11, 20, 30]), 1);
  assert.equal(channelGap(null, [1, 2, 3]), 255);
  assert.deepEqual(modeColour([[1, 2, 3], [1, 2, 3], [9, 9, 9]]), [1, 2, 3]);
});

// ---- the sampler, on a disc whose answer is known ---------------------------------------------------------------
const W = 42;
const H = 42;
const CX = 21;
const CY = 21;
const R = 11;
const STROKE = 2;
const SURFACE = [20, 25, 34];
const TINTED = [24, 44, 39];
const RING = [86, 211, 100];
const LINE = [158, 203, 255];

/**
 * A station exactly as the lane draws it: a 22px disc with a two-pixel ring, the label's ink where a glyph sits, and
 * the connector either painted through the disc (`leak`) or stopped at the ring (opaque).
 */
function station({ leak, fill = TINTED }) {
  const data = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i += 1) {
    data[i * 4] = SURFACE[0];
    data[i * 4 + 1] = SURFACE[1];
    data[i * 4 + 2] = SURFACE[2];
    data[i * 4 + 3] = 255;
  }
  const set = (x, y, rgb) => {
    const i = (y * W + x) * 4;
    data[i] = rgb[0];
    data[i + 1] = rgb[1];
    data[i + 2] = rgb[2];
  };
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const d = Math.hypot(x - CX, y - CY);
      if (d <= R && d > R - STROKE) set(x, y, RING);
      else if (d < R - STROKE) set(x, y, fill);
    }
  }
  // The connector: two pixels wide, the whole height of the clip, but only reaching into the disc when it leaks.
  for (let y = 0; y < H; y += 1) {
    if (!leak && Math.hypot(0, y - CY) <= R) continue;
    set(CX, y, LINE);
    set(CX - 1, y, LINE);
  }
  return { width: W, height: H, data };
}

const analyse = (raster) =>
  analyseDot({
    raster,
    clip: { x: 0, y: 0 },
    dot: { x: CX - R, y: CY - R, w: R * 2, h: R * 2, border: STROKE },
    label: { x: CX - 6, y: CY - 6, w: 12, h: 12 },
    tokens: { connector: LINE, ring: RING },
  });

test("a disc that hides the connector samples as clean, and the ring and the line at its edges are found", () => {
  const r = analyse(station({ leak: false }));
  assert.deepEqual(r.interiorRgb, TINTED, "the disc's own colour is the modal pixel of its inner area");
  assert.equal(r.stripePixels, 0, "no stray pixel in the connector's columns");
  assert.equal(r.stripeMaxRange, 0, "the run across the disc is one colour");
  assert.ok(r.stripeRows.length >= 2, `rows clear of the label were sampled (${r.stripeRows.length})`);
  assert.equal(r.connectorAtBothEdges, true, "the line is present above and below the ring");
  assert.equal(r.ringComplete, true, "the ring is drawn at all four cardinal points");
  assert.deepEqual(r.ringRgb.slice(0, 3), RING, "the ring's own colour is read, not a blend");
  assert.equal(r.ringVsTokenGap, 0);
  assert.ok(r.ringContrast > 3, `the ring reads against the disc (${r.ringContrast}:1)`);
});

test("a disc the connector runs through samples as the defect, in the connector's own columns", () => {
  const r = analyse(station({ leak: true }));
  assert.ok(r.stripePixels > 0, `stray pixels are counted in the connector's columns (${r.stripePixels})`);
  assert.ok(r.stripeMaxRange > 6, `the run across the disc is not one colour (${r.stripeMaxRange})`);
  assert.equal(r.connectorAtBothEdges, true, "the line still reaches both edges");
  assert.deepEqual(r.ringRgb.slice(0, 3), RING, "the ring is still read on its own");
});

test("the label's ink is not mistaken for the connector, and does not hide the defect either", () => {
  // A glyph, as a font draws one: a stroke either side of the centre over a band of rows, with the disc between them.
  const MODE_INK = [233, 237, 244];
  const withInk = (raster) => {
    const copy = { ...raster, data: Buffer.from(raster.data) };
    for (let y = CY - 5; y <= CY + 5; y += 1) {
      for (const x of [CX - 3, CX + 3]) {
        const i = (y * W + x) * 4;
        copy.data[i] = MODE_INK[0];
        copy.data[i + 1] = MODE_INK[1];
        copy.data[i + 2] = MODE_INK[2];
      }
    }
    return copy;
  };
  const clean = analyse(withInk(station({ leak: false })));
  assert.equal(clean.stripePixels, 0, "ink on the sides is excluded, not counted as the line");
  assert.ok(clean.labelRows.length > 0, "the ink band was found");
  assert.ok(clean.stripeRows.every((row) => row.y < CY - 5 || row.y > CY + 5), "the ink band is skipped whole");
  const defect = analyse(withInk(station({ leak: true })));
  assert.ok(defect.stripePixels > 0, "the defect is still seen on the rows the ink does not cover");
});

test("pixelAt answers null outside the raster rather than reading another row", () => {
  const raster = station({ leak: false });
  assert.deepEqual(pixelAt(raster, 0, 0), [SURFACE[0], SURFACE[1], SURFACE[2], 255]);
  assert.equal(pixelAt(raster, -1, 0), null);
  assert.equal(pixelAt(raster, W, 0), null);
  assert.equal(pixelAt(raster, 0, H), null);
});
