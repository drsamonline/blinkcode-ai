#!/usr/bin/env node
// Perceptual-mode benchmark: reconstruction quality (RMSE) and size for the
// lossy image latent codec. Development tool. Run: node tools/perceptual.js

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseModel } from '../src/lib/model.js';
import { encodeImageLatent, decodeImageLatent, LATENT_SIZE } from '../src/lib/image-codec.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const model = parseModel(new Uint8Array(readFileSync(join(ROOT, 'src', 'models', 'ucg-v1.bin'))));
const scales = model.latentScales;

const W = 640;
const H = 480;

function makeImage(kind) {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      let r;
      let g;
      let b;
      if (kind === 'gradient') {
        r = 40 + 180 * Math.sin((x / W) * Math.PI);
        g = 30 + 120 * (y / H);
        b = 200 - 150 * (x / W);
      } else if (kind === 'detail') {
        // high-frequency structure: stripes + a soft blob
        const stripe = ((x >> 2) + (y >> 2)) % 2 ? 210 : 40;
        const blob = 120 * Math.exp(-(((x - 200) ** 2 + (y - 160) ** 2) / 20000));
        r = stripe;
        g = Math.min(255, stripe * 0.6 + blob);
        b = 90 + 40 * Math.sin((y / H) * 6);
      } else {
        // photo-like: smooth base, a couple of edges, mild grain
        const base = 110 + 60 * Math.sin((x / W) * 3) * Math.cos((y / H) * 2);
        const edge = x > W * 0.6 ? 70 : 0;
        const grain = ((x * 7 + y * 13) % 17) - 8;
        r = base + edge + grain;
        g = base * 0.9 + grain;
        b = base * 0.8 + edge * 0.5 + grain;
      }
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return { data, width: W, height: H };
}

function rmse(a, b) {
  let sum = 0;
  const n = W * H;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      const d = a.data[i * 4 + c] - b.data[i * 4 + c];
      sum += d * d;
    }
  }
  return Math.sqrt(sum / (n * 3));
}

console.log(`latent ${LATENT_SIZE} B  |  ${W}x${H} image`);
console.log('image'.padEnd(12), 'rmse'.padStart(8), 'psnr(dB)'.padStart(10));
for (const kind of ['gradient', 'detail', 'photo']) {
  const image = makeImage(kind);
  const latent = encodeImageLatent(image, scales);
  const restored = decodeImageLatent(latent, scales);
  const e = rmse(image, restored);
  const psnr = 20 * Math.log10(255 / e);
  console.log(kind.padEnd(12), e.toFixed(2).padStart(8), psnr.toFixed(1).padStart(10));
}
