#!/usr/bin/env node
// Robustness sweep: how far can the optical decoder be pushed before it breaks?
// Renders a container, applies a simulated camera (perspective, colour cast,
// vignetting, blur, sensor noise) and reports decode success. Development tool.
// Run: node tools/robustness.js

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseModel } from '../src/lib/model.js';
import { encodeFileDna, decodeFileDna, MODE } from '../src/lib/codec.js';
import { drawSpectraCode, payloadToSymbols, specByName } from '../src/lib/spectracode.js';
import { decodeSpectraCode } from '../src/lib/spectra-decode.js';
import { BufferSurface } from '../src/lib/surface.js';
import { homography, applyHomography } from '../src/lib/geometry.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const model = parseModel(new Uint8Array(readFileSync(join(ROOT, 'src', 'models', 'ucg-v1.bin'))));

function photograph(image, { tilt = 0.06, cast = [1.06, 0.97, 0.9], gain = 0.9, blur = 0, noise = 0, seed = 1 } = {}) {
  const { width: w, height: h } = image;
  const out = { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
  const src = [[0, 0], [w, 0], [w, h], [0, h]];
  const dst = [
    [w * tilt, h * tilt * 0.5],
    [w * (1 - tilt * 0.4), h * tilt],
    [w * (1 - tilt), h * (1 - tilt * 0.6)],
    [w * tilt * 0.5, h * (1 - tilt)],
  ];
  const inverse = homography(dst, src);
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 4294967296);
  const sample = (sx, sy) => {
    if (blur <= 0) {
      const i = ((sy | 0) * w + (sx | 0)) * 4;
      return [image.data[i], image.data[i + 1], image.data[i + 2]];
    }
    let r = 0, g = 0, b = 0, n = 0;
    for (let ky = -blur; ky <= blur; ky++) {
      for (let kx = -blur; kx <= blur; kx++) {
        const px = Math.min(w - 1, Math.max(0, (sx | 0) + kx));
        const py = Math.min(h - 1, Math.max(0, (sy | 0) + ky));
        const i = (py * w + px) * 4;
        r += image.data[i]; g += image.data[i + 1]; b += image.data[i + 2]; n++;
      }
    }
    return [r / n, g / n, b / n];
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [sx, sy] = applyHomography(inverse, x + 0.5, y + 0.5);
      const o = (y * w + x) * 4;
      if (sx < 0 || sy < 0 || sx >= w || sy >= h) {
        out.data[o] = out.data[o + 1] = out.data[o + 2] = 250;
        out.data[o + 3] = 255;
        continue;
      }
      const [sr, sg, sb] = sample(sx, sy);
      const base = [sr, sg, sb];
      const dx = (x / w - 0.5) * 2;
      const dy = (y / h - 0.5) * 2;
      const vig = 1 - 0.18 * (dx * dx + dy * dy);
      for (let c = 0; c < 3; c++) {
        let v = base[c] * cast[c] * gain * vig + 8;
        if (noise) v += (rnd() * 2 - 1) * noise;
        out.data[o + c] = v;
      }
      out.data[o + 3] = 255;
    }
  }
  return out;
}

const spec = specByName('standard');
const bytes = crypto.getRandomValues(new Uint8Array(600));
const { container } = encodeFileDna({ name: 'probe.bin', mode: MODE.LOSSLESS, bytes }, model);
const surface = new BufferSurface(1400, 1400);
drawSpectraCode(surface, payloadToSymbols(container, spec), 1400, spec);
const clean = surface.toImageData();

const trial = (opts) => {
  try {
    const { payload } = decodeSpectraCode(photograph(clean, opts));
    const restored = decodeFileDna(payload, model).bytes;
    return restored.length === bytes.length && restored.every((v, i) => v === bytes[i]);
  } catch {
    return false;
  }
};

console.log('noise sweep (blur 1, gain 0.8):');
for (const noise of [0, 8, 12, 16, 20, 24, 28, 32]) {
  console.log(`  noise ${String(noise).padStart(2)}  ${trial({ blur: 1, noise, gain: 0.8 }) ? 'decode' : 'FAIL'}`);
}
console.log('blur sweep (noise 12, gain 0.8):');
for (const blur of [0, 1, 2, 3]) {
  console.log(`  blur  ${blur}  ${trial({ blur, noise: 12, gain: 0.8 }) ? 'decode' : 'FAIL'}`);
}
console.log('low light (blur 1, noise 12):');
for (const gain of [1.0, 0.8, 0.6, 0.45, 0.3]) {
  console.log(`  gain ${gain}  ${trial({ blur: 1, noise: 12, gain }) ? 'decode' : 'FAIL'}`);
}
