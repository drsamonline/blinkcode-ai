#!/usr/bin/env node
// Refresh only the `latentScales` entry of the committed model bundle, leaving
// the order-1 priors untouched. Needed when the perceptual codec's geometry
// changes (e.g. LUMA_N) but the byte model has not been retrained.
// Run: node tools/update-scales.js

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseModel, serialiseModel } from '../src/lib/model.js';
import { defaultLatentScales } from '../src/lib/image-codec.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TARGETS = [join(ROOT, 'src', 'models', 'ucg-v1.bin'), join(ROOT, 'docs', 'play', 'models', 'ucg-v1.bin')];

const src = parseModel(new Uint8Array(readFileSync(TARGETS[0])));
const bundle = serialiseModel({
  order1: { dtype: 'u16', values: src.order1 },
  latentScales: { dtype: 'f32', values: defaultLatentScales() },
});
for (const t of TARGETS) {
  try {
    writeFileSync(t, bundle);
    console.log(`updated ${t} (${bundle.length} B)`);
  } catch {
    console.log(`skipped ${t} (not present)`);
  }
}
