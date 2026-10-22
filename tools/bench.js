#!/usr/bin/env node
// Compression benchmark: File DNA coders vs gzip, on a spread of corpora.
// Run with `npm run bench`. Used to measure changes to the model.
//
// Three columns, honestly:
//   o1    — plain order-1 context model (the original)
//   o1+m  — order-1 + match (LZP) model (src/lib/predict.js)
//   gzip  — zlib, as a familiar reference point

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
const o1 = (b) => arithEncode(b, new Order1Model(model.order1)).length;
const o1m = (b) => arithEncode(b, new Order1MatchModel(model.order1)).length;
const gz = (b) => gzipSync(Buffer.from(b)).length;

function walk(dir, exts, limit, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (acc.length >= limit) break;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, exts, limit, acc);
    else if (exts.includes(extname(e.name))) acc.push(p);
  }
  return acc;
}

const sourceBytes = walk(join(ROOT, 'src'), ['.js', '.html', '.css'], 40)
  .map((f) => new Uint8Array(readFileSync(f)))
  .reduce((a, b) => {
    const out = new Uint8Array(a.length + b.length);
    out.set(a);
    out.set(b, a.length);
    return out;
  }, new Uint8Array(0));

const corpora = {
  'english prose (repeated)': enc.encode('The quick brown fox jumps over the lazy dog. '.repeat(400)),
  'english prose (varied)': enc.encode(
    Array.from({ length: 200 }, (_, i) => `Line ${i}: the value of the measurement was recorded for item number ${i}.`).join('\n'),
  ),
  'JSON records': enc.encode(JSON.stringify(Array.from({ length: 400 }, (_, i) => ({ id: i, name: 'item' + i, active: i % 2 === 0, score: i * 3.14 }))).repeat(3)),
  'source code (this repo)': sourceBytes,
  'already-compressed (gzip)': new Uint8Array(gzipSync(Buffer.from('The quick brown fox '.repeat(2000)))),
  'random bytes': crypto.getRandomValues(new Uint8Array(16000)),
};

const pad = (s, n) => String(s).padEnd(n);
const num = (s, n) => String(s).padStart(n);

console.log(`model bundle: ${(readFileSync(join(ROOT, 'src', 'models', 'ucg-v1.bin')).length / 1024).toFixed(0)} KB\n`);
console.log(pad('corpus', 28), num('orig', 8), num('o1', 8), num('o1+m', 8), num('gzip', 8), num('o1+m x', 8));
console.log('-'.repeat(72));
let tO = 0;
let tA = 0;
let tM = 0;
let tG = 0;
for (const [name, bytes] of Object.entries(corpora)) {
  const a = o1(bytes);
  const m = o1m(bytes);
  const g = gz(bytes);
  tO += bytes.length;
  tA += a;
  tM += m;
  tG += g;
  console.log(pad(name, 28), num(bytes.length, 8), num(a, 8), num(m, 8), num(g, 8), num((bytes.length / m).toFixed(2), 8));
}
console.log('-'.repeat(72));
console.log(pad('TOTAL', 28), num(tO, 8), num(tA, 8), num(tM, 8), num(tG, 8), num((tO / tM).toFixed(2), 8));
console.log(`\nmatch model gain over order-1: ${(((tA - tM) / tA) * 100).toFixed(1)}% smaller overall`);
