#!/usr/bin/env node
// Copies src/ -> docs/play/ for GitHub Pages. BlinkCode AI has no bundler —
// the app is plain ES modules — so "building" is just staging the files.
// Run with `npm run build`.

import { cp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const OUT = join(ROOT, 'docs', 'play');

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
await cp(SRC, OUT, { recursive: true });
console.log(`Staged ${SRC} -> ${OUT}`);
