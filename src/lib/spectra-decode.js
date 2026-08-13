// SpectraCode decoding pipeline: marker detection -> homography -> colour
// calibration -> cell classification -> Reed-Solomon.
//
// Everything here is pure computation on an ImageData-like object so it can run
// in a Web Worker (and in node tests) without touching the DOM.

import { PALETTE } from './palette.js';
import { homography, applyHomography, fitColourCorrection } from './geometry.js';
import {
  GRID_COLS,
  GRID_ROWS,
  CELL_COUNT,
  LAYOUT,
  markerCentres,
  calibrationPatchCentre,
  cellCentre,
  symbolsToBytes,
} from './spectracode.js';
import { rsDecode } from './rs.js';

function luminance(data, i) {
  return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
}

/** Otsu threshold over a luminance histogram. */
function otsu(gray) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let bestVar = -1;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) {
      bestVar = between;
      best = t;
    }
  }
  return best;
}

function toGray(image) {
  const { data, width, height } = image;
  const gray = new Uint8Array(width * height);
  for (let p = 0; p < gray.length; p++) gray[p] = luminance(data, p * 4) | 0;
  return gray;
}

/** Dark connected components (8-connectivity) with basic shape statistics. */
function components(gray, width, height, threshold, maxArea) {
  const labels = new Int32Array(width * height).fill(-1);
  const stack = new Int32Array(width * height);
  const found = [];
  for (let start = 0; start < labels.length; start++) {
    if (labels[start] !== -1 || gray[start] > threshold) continue;
    const id = found.length;
    let sp = 0;
    stack[sp++] = start;
    labels[start] = id;
    let area = 0;
    let sx = 0;
    let sy = 0;
    let minX = width;
    let maxX = 0;
    let minY = height;
    let maxY = 0;
    while (sp > 0) {
      const p = stack[--sp];
      const x = p % width;
      const y = (p / width) | 0;
      area++;
      sx += x;
      sy += y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const np = ny * width + nx;
          if (labels[np] !== -1 || gray[np] > threshold) continue;
          labels[np] = id;
          stack[sp++] = np;
        }
      }
    }
    if (area > maxArea) continue;
    found.push({
      area,
      cx: sx / area,
      cy: sy / area,
      w: maxX - minX + 1,
      h: maxY - minY + 1,
    });
  }
  return found;
}

/**
 * A bullseye is a solid black disc (radius r) inside a white ring inside a
 * black ring. Probe those three radii to reject payload cells and noise.
 */
function looksLikeBullseye(gray, width, height, blob, threshold) {
  const r = Math.sqrt(blob.area / Math.PI);
  const probe = (factor) => {
    let dark = 0;
    let n = 0;
    for (let a = 0; a < 12; a++) {
      const ang = (a / 12) * Math.PI * 2;
      const x = Math.round(blob.cx + Math.cos(ang) * r * factor);
      const y = Math.round(blob.cy + Math.sin(ang) * r * factor);
      if (x < 0 || y < 0 || x >= width || y >= height) return null;
      n++;
      if (gray[y * width + x] <= threshold) dark++;
    }
    return dark / n;
  };
  const white = probe(1.5);
  const black = probe(2.6);
  if (white === null || black === null) return false;
  return white < 0.25 && black > 0.75;
}

function orderQuad(points) {
  const cx = points.reduce((a, p) => a + p[0], 0) / points.length;
  const cy = points.reduce((a, p) => a + p[1], 0) / points.length;
  return [...points].sort(
    (a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx),
  );
}

/** Locate the four bullseye centres, clockwise starting anywhere. */
export function findMarkers(image) {
  const { width, height } = image;
  const gray = toGray(image);
  const threshold = Math.max(40, Math.min(200, otsu(gray)));
  const blobs = components(gray, width, height, threshold, (width * height) / 25);
  const minArea = Math.max(4, (width * height) / 200000);
  const candidates = blobs
    .filter((b) => {
      if (b.area < minArea) return false;
      const aspect = b.w / b.h;
      if (aspect < 0.6 || aspect > 1.7) return false;
      const fill = b.area / (b.w * b.h);
      return fill > 0.55 && fill < 0.95;
    })
    .filter((b) => looksLikeBullseye(gray, width, height, b, threshold));
  if (candidates.length < 4) return null;

  // Keep the four most extreme candidates: the code's corners.
  const pick = (score) =>
    candidates.reduce((best, b) => (score(b) < score(best) ? b : best));
  const corners = [
    pick((b) => b.cx + b.cy),
    pick((b) => -b.cx + b.cy),
    pick((b) => -b.cx - b.cy),
    pick((b) => b.cx - b.cy),
  ].map((b) => [b.cx, b.cy]);
  const unique = new Set(corners.map((c) => c.join(',')));
  if (unique.size !== 4) return null;
  return orderQuad(corners);
}

function sampleAverage(image, x, y, radius) {
  const { data, width, height } = image;
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  const x0 = Math.max(0, Math.round(x - radius));
  const x1 = Math.min(width - 1, Math.round(x + radius));
  const y0 = Math.max(0, Math.round(y - radius));
  const y1 = Math.min(height - 1, Math.round(y + radius));
  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      const i = (py * width + px) * 4;
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      n++;
    }
  }
  return n ? [r / n, g / n, b / n] : [0, 0, 0];
}

function classify(rgb, references) {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < references.length; i++) {
    const p = references[i];
    const d =
      (rgb[0] - p[0]) ** 2 + (rgb[1] - p[1]) ** 2 + (rgb[2] - p[2]) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

/**
 * Sample one candidate orientation.
 * @returns {{symbols: Uint8Array, residual: number}|null}
 */
function readWithQuad(image, quad) {
  const H = homography(markerCentres(), quad);
  if (!H) return null;

  // Approximate on-screen cell size, used to size the sampling window.
  const [ax, ay] = applyHomography(H, LAYOUT.payload.x0, LAYOUT.payload.y0);
  const [bx, by] = applyHomography(H, LAYOUT.payload.x1, LAYOUT.payload.y1);
  const cellPx = Math.max(
    1,
    Math.min(
      Math.abs(bx - ax) / GRID_COLS,
      Math.abs(by - ay) / GRID_ROWS,
    ),
  );
  const cellRadius = Math.max(0, cellPx / 2 - 1);

  const measured = [];
  for (let i = 0; i < PALETTE.length; i++) {
    const [fx, fy] = calibrationPatchCentre(i);
    const [x, y] = applyHomography(H, fx, fy);
    measured.push(sampleAverage(image, x, y, Math.max(1, cellPx * 0.8)));
  }
  const correct = fitColourCorrection(measured, PALETTE);
  let residual = 0;
  for (let i = 0; i < measured.length; i++) {
    const c = correct(measured[i]);
    residual +=
      (c[0] - PALETTE[i][0]) ** 2 +
      (c[1] - PALETTE[i][1]) ** 2 +
      (c[2] - PALETTE[i][2]) ** 2;
  }
  residual = Math.sqrt(residual / (measured.length * 3));

  const symbols = new Uint8Array(CELL_COUNT);
  const dataRefs = PALETTE.slice(0, 32);
  for (let row = 0; row < GRID_ROWS; row++) {
    for (let col = 0; col < GRID_COLS; col++) {
      const [fx, fy] = cellCentre(col, row);
      const [x, y] = applyHomography(H, fx, fy);
      const rgb = correct(sampleAverage(image, x, y, cellRadius));
      symbols[row * GRID_COLS + col] = classify(rgb, dataRefs);
    }
  }
  return { symbols, residual };
}

/** Four rotations of the quad plus their mirrors (winding is unknown). */
function orientations(quad) {
  const mirrored = [...quad].reverse();
  return [quad, mirrored].flatMap((q) =>
    [0, 1, 2, 3].map((k) => q.map((_, i) => q[(i + k) % 4])),
  );
}

/**
 * Decode a captured frame into the raw payload bytes.
 * @param {{data:Uint8ClampedArray,width:number,height:number}} image
 * @param {{quad?: number[][]}} [options] pre-detected marker quad
 * @returns {{payload: Uint8Array, corrected: number, residual: number}}
 */
export function decodeSpectraCode(image, options = {}) {
  const quad = options.quad ?? findMarkers(image);
  if (!quad) throw new Error('no SpectraCode markers found');

  const attempts = orientations(quad)
    .map((q) => ({ q, read: readWithQuad(image, q) }))
    .filter((a) => a.read)
    .sort((a, b) => a.read.residual - b.read.residual);

  let lastError = new Error('unable to sample the code');
  for (const attempt of attempts) {
    try {
      const { data, corrected } = rsDecode(symbolsToBytes(attempt.read.symbols));
      return { payload: data, corrected, residual: attempt.read.residual };
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`SpectraCode unreadable: ${lastError.message}`);
}
