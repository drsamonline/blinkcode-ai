// SpectraCode decoding pipeline: marker detection -> homography -> colour
// calibration -> cell classification -> Reed-Solomon.
//
// Everything here is pure computation on an ImageData-like object so it can run
// in a Web Worker (and in node tests) without touching the DOM.

import { PALETTE } from './palette.js';
import { homography, applyHomography, fitColourCorrection } from './geometry.js';
import {
  DENSITIES,
  SPEC,
  LAYOUT,
  markerCentres,
  calibrationPatchCentre,
  densityPatchCentre,
  densityColourIndex,
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

/**
 * Linear contrast stretch on the 2nd..98th luminance percentiles. A dim capture
 * (low gain, poor light) otherwise lands entirely in the bottom of the range and
 * binarises badly, which is why marker detection used to be gain-sensitive.
 */
function stretchContrast(gray) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let acc = 0;
  let lo = 0;
  let hi = 255;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= total * 0.02) {
      lo = v;
      break;
    }
  }
  acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= total * 0.98) {
      hi = v;
      break;
    }
  }
  if (hi - lo < 8) return gray;
  const out = new Uint8Array(gray.length);
  const scale = 255 / (hi - lo);
  for (let i = 0; i < gray.length; i++) {
    out[i] = Math.max(0, Math.min(255, Math.round((gray[i] - lo) * scale)));
  }
  return out;
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

/** Mean luminance on a ring at `factor` × r around (cx, cy), or null if off-image. */
function ringMean(gray, width, height, cx, cy, r, factor) {
  let sum = 0;
  let n = 0;
  for (let a = 0; a < 16; a++) {
    const ang = (a / 16) * Math.PI * 2;
    const x = Math.round(cx + Math.cos(ang) * r * factor);
    const y = Math.round(cy + Math.sin(ang) * r * factor);
    if (x < 0 || y < 0 || x >= width || y >= height) return null;
    sum += gray[y * width + x];
    n++;
  }
  return n ? sum / n : null;
}

/**
 * A bullseye is a solid black disc (radius r) inside a white ring inside a black
 * ring. Compare the mean luminance at those radii by *contrast* rather than
 * against an absolute threshold — an absolute cut is defeated by blur (which
 * averages the rings together) and by a dim capture.
 */
function looksLikeBullseye(gray, width, height, blob) {
  const r = Math.sqrt(blob.area / Math.PI);
  const centre = ringMean(gray, width, height, blob.cx, blob.cy, r, 0);
  const ring = ringMean(gray, width, height, blob.cx, blob.cy, r, 1.5);
  const outer = ringMean(gray, width, height, blob.cx, blob.cy, r, 2.6);
  if (centre === null || ring === null || outer === null) return false;
  const margin = 18;
  return ring - centre > margin && ring - outer > margin;
}

function orderQuad(points) {
  const cx = points.reduce((a, p) => a + p[0], 0) / points.length;
  const cy = points.reduce((a, p) => a + p[1], 0) / points.length;
  return [...points].sort(
    (a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx),
  );
}

/** Bullseye candidates at one binarisation threshold; the corner quad or null. */
function markersAt(gray, width, height, threshold) {
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
    .filter((b) => looksLikeBullseye(gray, width, height, b));
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

/**
 * Locate the four bullseye centres, clockwise starting anywhere. Tries a few
 * binarisation thresholds, because a single Otsu estimate is fragile under dim,
 * low-contrast or unevenly lit conditions.
 */
export function findMarkers(image) {
  const { width, height } = image;
  const gray = stretchContrast(toGray(image));
  const base = Math.max(40, Math.min(200, otsu(gray)));
  for (const threshold of [base, base - 16, base + 16, base - 32, base + 32, base - 48, base + 48, base - 64, base + 64]) {
    if (threshold <= 8 || threshold >= 248) continue;
    const quad = markersAt(gray, width, height, threshold);
    if (quad) return quad;
  }
  return null;
}

function median(values) {
  values.sort((a, b) => a - b);
  const mid = values.length >> 1;
  return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}

/**
 * Median colour over a small patch centred on (x, y). Median rather than mean:
 * a cell that straddles an edge, or a specular highlight, drags a mean toward
 * the neighbour but barely moves a median.
 */
function sampleColour(image, x, y, radius) {
  const { data, width, height } = image;
  const x0 = Math.max(0, Math.round(x - radius));
  const x1 = Math.min(width - 1, Math.round(x + radius));
  const y0 = Math.max(0, Math.round(y - radius));
  const y1 = Math.min(height - 1, Math.round(y + radius));
  const stepX = Math.max(1, Math.floor((x1 - x0 + 1) / 5));
  const stepY = Math.max(1, Math.floor((y1 - y0 + 1) / 5));
  const rs = [];
  const gs = [];
  const bs = [];
  for (let py = y0; py <= y1; py += stepY) {
    for (let px = x0; px <= x1; px += stepX) {
      const i = (py * width + px) * 4;
      rs.push(data[i]);
      gs.push(data[i + 1]);
      bs.push(data[i + 2]);
    }
  }
  if (rs.length === 0) return [0, 0, 0];
  return [median(rs), median(gs), median(bs)];
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
 * Warp one candidate orientation and fit its colour correction. The grid
 * density is read from the density patch, so a single pass tells us how many
 * cells to sample.
 * @returns {{residual: number, spec: object, sample: Function}|null}
 */
function readWithQuad(image, quad) {
  const H = homography(markerCentres(), quad);
  if (!H) return null;

  const [ax, ay] = applyHomography(H, LAYOUT.payload.x0, LAYOUT.payload.y0);
  const [bx, by] = applyHomography(H, LAYOUT.payload.x1, LAYOUT.payload.y1);
  const regionW = Math.abs(bx - ax);
  const regionH = Math.abs(by - ay);

  const measured = [];
  for (let i = 0; i < PALETTE.length; i++) {
    const [fx, fy] = calibrationPatchCentre(i);
    const [x, y] = applyHomography(H, fx, fy);
    measured.push(sampleColour(image, x, y, Math.max(1, regionW / SPEC.cols)));
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

  const [dx, dy] = applyHomography(H, ...densityPatchCentre());
  const patchRadius = Math.max(
    1,
    ((LAYOUT.density.x1 - LAYOUT.density.x0) * regionW) / (LAYOUT.payload.x1 - LAYOUT.payload.x0) / 3,
  );
  const patch = correct(sampleColour(image, dx, dy, patchRadius));
  const patchIndex = classify(patch, PALETTE);
  const marked = DENSITIES.find((d) => densityColourIndex(d) === patchIndex);

  const dataRefs = PALETTE.slice(0, 32);
  const sample = (spec) => {
    const cellPx = Math.max(1, Math.min(regionW / spec.cols, regionH / spec.rows));
    const cellRadius = Math.max(0, cellPx / 2 - 1);
    const symbols = new Uint8Array(spec.cellCount);
    for (let row = 0; row < spec.rows; row++) {
      for (let col = 0; col < spec.cols; col++) {
        const [fx, fy] = cellCentre(col, row, spec);
        const [x, y] = applyHomography(H, fx, fy);
        const rgb = correct(sampleColour(image, x, y, cellRadius));
        symbols[row * spec.cols + col] = classify(rgb, dataRefs);
      }
    }
    return symbols;
  };

  // Densities to try, most likely first: the one the patch claims, then the rest
  // in case the patch itself was misread.
  const specs = marked ? [marked, ...DENSITIES.filter((d) => d !== marked)] : [...DENSITIES];
  return { residual, specs, sample };
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
 * @returns {{payload: Uint8Array, corrected: number, residual: number, density: string}}
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
    for (const spec of attempt.read.specs) {
      try {
        const symbols = attempt.read.sample(spec);
        const { data, corrected } = rsDecode(symbolsToBytes(symbols, spec));
        return { payload: data, corrected, residual: attempt.read.residual, density: spec.name };
      } catch (err) {
        lastError = err;
      }
    }
  }
  throw new Error(`SpectraCode unreadable: ${lastError.message}`);
}
