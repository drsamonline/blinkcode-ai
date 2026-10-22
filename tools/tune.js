#!/usr/bin/env node
// Sweep the match-model parameters (context length h, boost) to pick defaults.
// Not part of the build; a development tool. Run: node tools/tune.js

import { readFileSync, readdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { arithEncode, Order1Model } from '../src/lib/arith.js';
import { Order1MatchModel } from '../src/lib/predict.js';
import { parseModel } from '../src/lib/model.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const model = parseModel(new Uint8Array(readFileSync(join(ROOT, 'src', 'models', 'ucg-v1.bin'))));
const enc = new TextEncoder();

function walk(dir, exts, limit, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (acc.length >= limit) break;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, exts, limit, acc);
    else if (exts.includes(extname(e.name))) acc.push(p);
  }
  return acc;
}
const src = walk(join(ROOT, 'src'), ['.js', '.html', '.css'], 16)
  .map((f) => new Uint8Array(readFileSync(f)))
  .reduce((a, b) => {
    const o = new Uint8Array(a.length + b.length);
    o.set(a);
    o.set(b, a.length);
    return o;
  }, new Uint8Array(0));

const corpora = {
  'prose (repeated)': enc.encode('The quick brown fox jumps over the lazy dog. '.repeat(400)),
  'prose (varied)': enc.encode(Array.from({ length: 200 }, (_, i) => `Line ${i}: the value of the measurement was recorded for item number ${i}.`).join('\n')),
  JSON: enc.encode(JSON.stringify(Array.from({ length: 400 }, (_, i) => ({ id: i, name: 'item' + i, active: i % 2 === 0, score: i * 3.14 }))).repeat(3)),
  source: src,
  'gzip-blob': new Uint8Array(gzipSync(Buffer.from('The quick brown fox '.repeat(2000)))),
  random: crypto.getRandomValues(new Uint8Array(16000)),
};
const totalOrig = Object.values(corpora).reduce((n, b) => n + b.length, 0);

function totalRatio(makeModel) {
  let enc2 = 0;
  for (const bytes of Object.values(corpora)) enc2 += arithEncode(bytes, makeModel()).length;
  return totalOrig / enc2;
}

const o1 = totalRatio(() => new Order1Model(model.order1));
const gz = Object.values(corpora).reduce((n, b) => n + gzipSync(Buffer.from(b)).length, 0);

console.log(`order-1 baseline: ${o1.toFixed(3)}x   gzip: ${(totalOrig / gz).toFixed(3)}x\n`);
const [hArg, mulArg] = process.argv.slice(2).map(Number);
if (hArg && mulArg) {
  const r = totalRatio(() => new Order1MatchModel(model.order1, { h: hArg, boostMul: mulArg }));
  console.log(`h=${hArg} boostMul=${mulArg} -> ${r.toFixed(3)}x`);
} else {
  console.log('usage: node tools/tune.js <h> <boostMul>');
}
