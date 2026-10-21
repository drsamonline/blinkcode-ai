// SpectraCode: a static colour matrix carrying one frame of a transfer.
//
// Canonical layout. Everything is expressed in fractions of the code region
// (the area inside the black border), so the sender can render at any size and
// the receiver can sample the same positions after warping.
//
//   +------------------------------------------+  black border
//   |  (o)                                (o)  |  bullseye markers
//   |  [m] [36 reference colour patches]       |  density patch + calibration
//   |     +--------------------------------+   |
//   |     |        cols x rows cells       |   |
//   |     +--------------------------------+   |
//   |  (o)                                (o)  |
//   +------------------------------------------+
//
// The grid density is not fixed: a phone held at arm's length resolves far
// fewer cells than a tripod shot, so the sender picks a density and records it
// in the density patch. The receiver reads that patch before sampling.

import { PALETTE, BITS_PER_CELL } from './palette.js';
import { rsEncode, BLOCK_DATA, BLOCK_TOTAL } from './rs.js';

/** Build the derived parameters of one grid density. */
function makeSpec(id, name, cols, rows, hint) {
  const cellCount = cols * rows;
  const rawCapacity = Math.floor((cellCount * BITS_PER_CELL) / 8);
  const rsBlocks = Math.floor(rawCapacity / BLOCK_TOTAL);
  return {
    id,
    name,
    hint,
    cols,
    rows,
    cellCount,
    rawCapacity,
    rsBlocks,
    payloadCapacity: rsBlocks * BLOCK_DATA,
  };
}

/**
 * Densities, ordered by id. The id is painted into the density patch as
 * `PALETTE[1 + id]`, so it must stay stable across versions.
 */
export const DENSITIES = [
  makeSpec(0, 'standard', 120, 80, 'best capacity — steady hands or a tripod'),
  makeSpec(1, 'robust', 60, 40, 'quarter the cells — handheld phones, poor light'),
];

export const SPEC = DENSITIES[0];
export const GRID_COLS = SPEC.cols;
export const GRID_ROWS = SPEC.rows;
export const CELL_COUNT = SPEC.cellCount;
export const RAW_CAPACITY = SPEC.rawCapacity;
export const RS_BLOCKS = SPEC.rsBlocks;
export const PAYLOAD_CAPACITY = SPEC.payloadCapacity;

export function specById(id) {
  return DENSITIES.find((d) => d.id === id) ?? null;
}

export function specByName(name) {
  return DENSITIES.find((d) => d.name === name) ?? SPEC;
}

export const LAYOUT = {
  border: 0.012, // black border thickness, fraction of the code region
  marker: { inset: 0.05, radius: 0.032 },
  density: { x0: 0.015, x1: 0.075, y0: 0.1, y1: 0.14 },
  calibration: { x0: 0.1, x1: 0.9, y0: 0.1, y1: 0.14, patches: PALETTE.length },
  payload: { x0: 0.1, x1: 0.9, y0: 0.18, y1: 0.9 },
};

/** Palette index used to paint the density patch of `spec`. */
export const densityColourIndex = (spec) => 1 + spec.id;

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

export function densityPatchCentre() {
  const { x0, x1, y0, y1 } = LAYOUT.density;
  return [(x0 + x1) / 2, (y0 + y1) / 2];
}

export function cellCentre(col, row, spec = SPEC) {
  const { x0, x1, y0, y1 } = LAYOUT.payload;
  return [
    x0 + ((x1 - x0) * (col + 0.5)) / spec.cols,
    y0 + ((y1 - y0) * (row + 0.5)) / spec.rows,
  ];
}

/**
 * Pack a payload into `spec.cellCount` palette indices: RS-protect, pad, then
 * slice the bit stream into 5-bit symbols.
 */
export function payloadToSymbols(payload, spec = SPEC) {
  if (payload.length > spec.payloadCapacity) {
    throw new Error(
      `payload ${payload.length} B exceeds SpectraCode capacity ${spec.payloadCapacity} B`,
    );
  }
  const framed = new Uint8Array(spec.rsBlocks * BLOCK_DATA);
  framed.set(payload);
  const coded = rsEncode(framed);
  const bytes = new Uint8Array(spec.rawCapacity);
  bytes.set(coded.subarray(0, spec.rawCapacity));

  const symbols = new Uint8Array(spec.cellCount);
  let bitPos = 0;
  for (let i = 0; i < spec.cellCount; i++) {
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
export function symbolsToBytes(symbols, spec = SPEC) {
  const bytes = new Uint8Array(spec.rawCapacity);
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
 * @param {Uint8Array} symbols palette indices, length spec.cellCount
 * @param {number} size square side in pixels
 * @param {object} [spec] grid density, defaults to standard
 */
export function drawSpectraCode(surface, symbols, size, spec = SPEC) {
  const black = [0, 0, 0];
  const white = [255, 255, 255];
  surface.fillRect(0, 0, size, size, black);

  // The code region sits inside the black border.
  const b = LAYOUT.border * size;
  const region = size - 2 * b;
  const px = (fx, fy) => [b + fx * region, b + fy * region];
  surface.fillRect(b, b, region, region, white);

  const { x0, x1, y0, y1 } = LAYOUT.payload;
  const cw = ((x1 - x0) * region) / spec.cols;
  const ch = ((y1 - y0) * region) / spec.rows;
  for (let row = 0; row < spec.rows; row++) {
    for (let col = 0; col < spec.cols; col++) {
      const [cx, cy] = px(x0 + ((x1 - x0) * col) / spec.cols, y0 + ((y1 - y0) * row) / spec.rows);
      surface.fillRect(cx, cy, Math.ceil(cw) + 1, Math.ceil(ch) + 1, PALETTE[symbols[row * spec.cols + col]]);
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

  const den = LAYOUT.density;
  surface.fillRect(
    b + den.x0 * region,
    b + den.y0 * region,
    Math.ceil((den.x1 - den.x0) * region),
    Math.ceil((den.y1 - den.y0) * region),
    PALETTE[densityColourIndex(spec)],
  );

  const r = LAYOUT.marker.radius * region;
  for (const [fx, fy] of markerCentres()) {
    const [cx, cy] = px(fx, fy);
    surface.fillCircle(cx, cy, r, black);
    surface.fillCircle(cx, cy, r * 0.62, white);
    surface.fillCircle(cx, cy, r * 0.3, black);
  }
}
