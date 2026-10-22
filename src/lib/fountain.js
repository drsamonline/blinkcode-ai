// Luby Transform (LT) fountain codes for the frame stream.
//
// The frame stream used to be a numbered list: miss frame 7 of 12 and the
// receiver could never finish, so it had to catch a whole clean loop. Fountain
// coding removes that — the sender emits an endless stream of encoded symbols
// and the receiver rebuilds the container from *any* k + a little overhead,
// in any order, with duplicates ignored.
//
// Each symbol is the XOR of a pseudorandom subset of the source blocks, derived
// purely from the symbol id and k, so the decoder needs no side channel.

const DEFAULT_C = 0.03;
const DEFAULT_DELTA = 0.5;
const CDF_CACHE = new Map();

function mulberry32(seed) {
  let s = seed >>> 0;
  return function next() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function xorInto(target, source) {
  const n = Math.min(target.length, source.length);
  for (let i = 0; i < n; i++) target[i] ^= source[i];
}

/** Cumulative degree distribution (Robust Soliton) for k blocks. */
export function degreeCDF(k, c = DEFAULT_C, delta = DEFAULT_DELTA) {
  const key = `${k}:${c}:${delta}`;
  const hit = CDF_CACHE.get(key);
  if (hit) return hit;

  const rho = new Float64Array(k + 1);
  rho[1] = 1 / k;
  for (let d = 2; d <= k; d++) rho[d] = 1 / (d * (d - 1));

  const R = c * Math.log(k / delta) * Math.sqrt(k);
  const tau = new Float64Array(k + 1);
  const kr = Math.max(1, Math.min(k, Math.round(k / R)));
  for (let d = 1; d < kr; d++) tau[d] = R / (d * k);
  // R/delta < 1 for small k makes the spike term negative; clamp it. A negative
  // mass would corrupt the whole distribution and blow up the overhead.
  tau[kr] += Math.max(0, (R * Math.log(R / delta)) / k);

  const cdf = new Float64Array(k + 1);
  let sum = 0;
  for (let d = 1; d <= k; d++) {
    sum += rho[d] + tau[d];
    cdf[d] = sum;
  }
  for (let d = 1; d <= k; d++) cdf[d] /= sum;
  CDF_CACHE.set(key, cdf);
  return cdf;
}

export function degreeFor(symbolId, k, c = DEFAULT_C, delta = DEFAULT_DELTA) {
  if (symbolId < k) return 1; // systematic prefix
  const cdf = degreeCDF(k, c, delta);
  const rng = mulberry32((symbolId ^ 0x9e3779b9) >>> 0);
  const u = rng();
  let lo = 1;
  let hi = k;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cdf[mid] < u) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function indicesFor(symbolId, k, c = DEFAULT_C, delta = DEFAULT_DELTA) {
  // Systematic prefix: symbols 0..k-1 are the raw blocks, so a clean pass needs
  // exactly k symbols. Symbols >= k are fountain repairs for anything missed.
  if (symbolId < k) return [symbolId];
  const d = Math.min(k, degreeFor(symbolId, k, c, delta));
  const rng = mulberry32((symbolId ^ 0x85ebca6b) >>> 0);
  const picked = new Set();
  while (picked.size < d) picked.add((rng() * k) | 0);
  return Array.from(picked);
}

/** The encoded symbol for `symbolId`, XOR of its chosen blocks. */
export function encodeSymbol(symbolId, blocks, c = DEFAULT_C, delta = DEFAULT_DELTA) {
  const k = blocks.length;
  const idx = indicesFor(symbolId, k, c, delta);
  const out = Uint8Array.from(blocks[idx[0]]);
  for (let i = 1; i < idx.length; i++) xorInto(out, blocks[idx[i]]);
  return out;
}

/** Split a payload into k equal-length blocks, zero-padded on the last. */
export function splitBlocks(payload, blockSize) {
  const k = Math.max(1, Math.ceil(payload.length / blockSize));
  const blocks = [];
  for (let i = 0; i < k; i++) {
    const block = new Uint8Array(blockSize);
    block.set(payload.subarray(i * blockSize, (i + 1) * blockSize));
    blocks.push(block);
  }
  return blocks;
}

export const blockCount = (length, blockSize) => Math.max(1, Math.ceil(length / blockSize));

/** Belief-propagation LT decoder. */
export class LTDecoder {
  constructor(k, blockSize, length, c = DEFAULT_C, delta = DEFAULT_DELTA) {
    this.k = k;
    this.blockSize = blockSize;
    this.length = length;
    this.c = c;
    this.delta = delta;
    this.blocks = new Array(k).fill(null);
    this.resolved = 0;
    this.symbols = new Map();
    this.adjacency = new Map();
    this.ripple = [];
    this.seen = new Set();
  }

  get complete() {
    return this.resolved === this.k;
  }

  get progress() {
    return this.k === 0 ? 1 : this.resolved / this.k;
  }

  addSymbol(symbolId, data) {
    if (this.complete || this.seen.has(symbolId)) return false;
    this.seen.add(symbolId);

    const value = Uint8Array.from(data);
    const set = new Set();
    for (const b of indicesFor(symbolId, this.k, this.c, this.delta)) {
      if (this.blocks[b]) xorInto(value, this.blocks[b]);
      else set.add(b);
    }
    if (set.size === 0) return false;

    this.symbols.set(symbolId, { value, set });
    for (const b of set) {
      let list = this.adjacency.get(b);
      if (!list) this.adjacency.set(b, (list = new Set()));
      list.add(symbolId);
    }
    if (set.size === 1) this.ripple.push(symbolId);
    this.#propagate();
    return true;
  }

  #propagate() {
    while (this.ripple.length) {
      const id = this.ripple.pop();
      const sym = this.symbols.get(id);
      if (!sym || sym.set.size !== 1) continue;
      const [b] = sym.set;
      if (this.blocks[b]) continue;

      this.blocks[b] = sym.value;
      this.resolved++;
      this.symbols.delete(id);

      const neighbours = this.adjacency.get(b);
      this.adjacency.delete(b);
      if (!neighbours) continue;
      for (const nid of neighbours) {
        const ns = this.symbols.get(nid);
        if (!ns) continue;
        xorInto(ns.value, sym.value);
        ns.set.delete(b);
        if (ns.set.size === 1) this.ripple.push(nid);
        else if (ns.set.size === 0) this.symbols.delete(nid);
      }
    }
  }

  /** Reassemble the container. Throws if the transfer is not yet complete. */
  payload() {
    if (!this.complete) throw new Error('transfer incomplete');
    const out = new Uint8Array(this.k * this.blockSize);
    for (let i = 0; i < this.k; i++) out.set(this.blocks[i], i * this.blockSize);
    return out.subarray(0, this.length);
  }
}
