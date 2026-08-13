#!/usr/bin/env node
// Builds the downloadable UCG model bundle.
//
// "Training" here means counting order-1 byte transitions over a diverse
// corpus (text, source code, JSON, compressed blobs and random data) and
// storing the normalised counts as priors for the arithmetic coder. Swap this
// script for a real trainer and the app picks up the new bundle unchanged.

import { readFileSync, writeFileSync, statSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { serialiseModel, ALPHABET } from '../src/lib/model.js';
import { defaultLatentScales } from '../src/lib/image-codec.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'src', 'models', 'ucg-v1.bin');
const MAX_PER_FILE = 512 * 1024;

function collect(dir, exts, limit, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (acc.length >= limit) return acc;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) collect(path, exts, limit, acc);
    else if (exts.some((e) => entry.name.endsWith(e))) {
      try {
        if (statSync(path).size > 1024) acc.push(path);
      } catch {
        /* unreadable, skip */
      }
    }
  }
  return acc;
}

function corpus() {
  const files = [
    ...collect('/usr/lib/python3.10', ['.py'], 120),
    ...collect('/usr/share/doc', ['.txt', '.md'], 60),
    ...collect('/usr/share/dict', [''], 5),
    ...collect(join(ROOT, 'src'), ['.js', '.html', '.css'], 40),
  ];
  const chunks = files.map((f) => {
    const buf = readFileSync(f);
    return new Uint8Array(buf.subarray(0, MAX_PER_FILE));
  });
  // Binary-ish material so the priors are not purely text-shaped.
  const text = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  chunks.push(new Uint8Array(gzipSync(text.subarray(0, 1 << 20))));
  const noise = new Uint8Array(1 << 16);
  for (let i = 0; i < noise.length; i++) noise[i] = (Math.random() * 256) | 0;
  chunks.push(noise);
  return chunks;
}

function train(chunks) {
  const counts = new Float64Array(256 * ALPHABET);
  let total = 0;
  for (const chunk of chunks) {
    let ctx = 0;
    for (let i = 0; i < chunk.length; i++) {
      counts[ctx * ALPHABET + chunk[i]] += 1;
      ctx = chunk[i];
      total++;
    }
    counts[ctx * ALPHABET + 256] += 1; // end-of-stream
  }

  // Normalise each context to a Uint16 range, keeping a floor of 1 so no
  // symbol is ever impossible (the coder must stay able to encode anything).
  const out = new Uint16Array(256 * ALPHABET);
  for (let c = 0; c < 256; c++) {
    const base = c * ALPHABET;
    let max = 0;
    for (let s = 0; s < ALPHABET; s++) max = Math.max(max, counts[base + s]);
    for (let s = 0; s < ALPHABET; s++) {
      const scaled = max > 0 ? Math.round((counts[base + s] / max) * 120) : 0;
      out[base + s] = Math.max(1, Math.min(200, scaled));
    }
  }
  return { priors: out, total };
}

const chunks = corpus();
const { priors, total } = train(chunks);
const bundle = serialiseModel({
  order1: { dtype: 'u16', values: priors },
  latentScales: { dtype: 'f32', values: defaultLatentScales() },
});

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, bundle);
console.log(
  `trained on ${chunks.length} chunks / ${(total / 1e6).toFixed(1)} MB -> ${OUT} (${(bundle.length / 1024).toFixed(0)} KB)`,
);
