// SpectraCode: a single static colour matrix carrying the whole payload.
//
// Canonical layout. Everything is expressed in fractions of the code region
// (the area inside the black border), so the sender can render at any size and
// the receiver can sample the same positions after warping.
//
//   +------------------------------------------+  black border
//   |  (o)                                (o)  |  bullseye markers
//   |     [36 reference colour patches]        |  calibration strip
//   |     +--------------------------------+   |
//   |     |     120 x 80 payload cells     |   |
//   |     +--------------------------------+   |
//   |  (o)                                (o)  |
//   +------------------------------------------+

import { PALETTE, BITS_PER_CELL } from './palette.js';
import { rsEncode, BLOCK_DATA, BLOCK_TOTAL } from './rs.js';

export const GRID_COLS = 120;
export const GRID_ROWS = 80;
export const CELL_COUNT = GRID_COLS * GRID_ROWS;
export const RAW_CAPACITY = Math.floor((CELL_COUNT * BITS_PER_CELL) / 8); // 6000 B
export const RS_BLOCKS = Math.floor(RAW_CAPACITY / BLOCK_TOTAL); // 23
export const PAYLOAD_CAPACITY = RS_BLOCKS * BLOCK_DATA; // 5129 B

export const LAYOUT = {
  border: 0.012, // black border thickness, fraction of the code region
  marker: { inset: 0.05, radius: 0.032 },
  calibration: { x0: 0.1, x1: 0.9, y0: 0.1, y1: 0.14, patches: PALETTE.length },
  payload: { x0: 0.1, x1: 0.9, y0: 0.18, y1: 0.9 },
};

/** Canonical marker centres, clockwise from top-left, in code-region space. */
export function markerCentres() {
  const i = LAYOUT.marker.inset;
  return [
    [i, i],
    [1 - i, i],
    [1 - i, 1 - i],
    [i, 1 - i],
  ];
}

export function calibrationPatchCentre(index) {
  const { x0, x1, y0, y1, patches } = LAYOUT.calibration;
  const w = (x1 - x0) / patches;
  return [x0 + w * (index + 0.5), (y0 + y1) / 2];
}

export function cellCentre(col, row) {
  const { x0, x1, y0, y1 } = LAYOUT.payload;
  return [
    x0 + ((x1 - x0) * (col + 0.5)) / GRID_COLS,
    y0 + ((y1 - y0) * (row + 0.5)) / GRID_ROWS,
  ];
}

/**
 * Pack a payload into `CELL_COUNT` palette indices: RS-protect, pad, then slice
 * the bit stream into 5-bit symbols.
 */
export function payloadToSymbols(payload) {
  if (payload.length > PAYLOAD_CAPACITY) {
    throw new Error(
      `payload ${payload.length} B exceeds SpectraCode capacity ${PAYLOAD_CAPACITY} B`,
    );
  }
  const framed = new Uint8Array(RS_BLOCKS * BLOCK_DATA);
  framed.set(payload);
  const coded = rsEncode(framed);
  const bytes = new Uint8Array(RAW_CAPACITY);
  bytes.set(coded.subarray(0, RAW_CAPACITY));

  const symbols = new Uint8Array(CELL_COUNT);
  let bitPos = 0;
  for (let i = 0; i < CELL_COUNT; i++) {
    let v = 0;
    for (let b = 0; b < BITS_PER_CELL; b++, bitPos++) {
      const byte = bytes[bitPos >> 3] ?? 0;
      v = (v << 1) | ((byte >> (7 - (bitPos & 7))) & 1);
    }
    symbols[i] = v; // 5 bits -> exactly DATA_COLOURS distinct indices
  }
  return symbols;
}

/** Inverse of {@link payloadToSymbols} up to the RS layer (returns raw bytes). */
export function symbolsToBytes(symbols) {
  const bytes = new Uint8Array(RAW_CAPACITY);
  let bitPos = 0;
  for (let i = 0; i < symbols.length; i++) {
    const v = symbols[i];
    for (let b = BITS_PER_CELL - 1; b >= 0; b--, bitPos++) {
      if ((v >> b) & 1) bytes[bitPos >> 3] |= 1 << (7 - (bitPos & 7));
    }
  }
  return bytes;
}

/**
 * Draw a SpectraCode.
 * @param {{fillRect:Function, fillCircle:Function}} surface
 * @param {Uint8Array} symbols palette indices, length CELL_COUNT
 * @param {number} size square side in pixels
 */
export function drawSpectraCode(surface, symbols, size) {
  const black = [0, 0, 0];
  const white = [255, 255, 255];
  surface.fillRect(0, 0, size, size, black);

  // The code region sits inside the black border.
  const b = LAYOUT.border * size;
  const region = size - 2 * b;
  const px = (fx, fy) => [b + fx * region, b + fy * region];
  surface.fillRect(b, b, region, region, white);

  const { x0, x1, y0, y1 } = LAYOUT.payload;
  const cw = ((x1 - x0) * region) / GRID_COLS;
  const ch = ((y1 - y0) * region) / GRID_ROWS;
  for (let row = 0; row < GRID_ROWS; row++) {
    for (let col = 0; col < GRID_COLS; col++) {
      const [cx, cy] = px(x0 + ((x1 - x0) * col) / GRID_COLS, y0 + ((y1 - y0) * row) / GRID_ROWS);
      surface.fillRect(cx, cy, Math.ceil(cw) + 1, Math.ceil(ch) + 1, PALETTE[symbols[row * GRID_COLS + col]]);
    }
  }

  const cal = LAYOUT.calibration;
  const pw = ((cal.x1 - cal.x0) * region) / cal.patches;
  const phTop = b + cal.y0 * region;
  const ph = (cal.y1 - cal.y0) * region;
  for (let i = 0; i < cal.patches; i++) {
    const x = b + (cal.x0 + ((cal.x1 - cal.x0) * i) / cal.patches) * region;
    surface.fillRect(x, phTop, Math.ceil(pw) + 1, Math.ceil(ph), PALETTE[i]);
  }

  const r = LAYOUT.marker.radius * region;
  for (const [fx, fy] of markerCentres()) {
    const [cx, cy] = px(fx, fy);
    surface.fillCircle(cx, cy, r, black);
    surface.fillCircle(cx, cy, r * 0.62, white);
    surface.fillCircle(cx, cy, r * 0.3, black);
  }
}
