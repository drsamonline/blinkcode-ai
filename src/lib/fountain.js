// Luby Transform (LT) fountain codes — delegated to the shared `optical-kit`.
//
// A fountain code turns k source blocks into an endless stream of encoded
// symbols. The receiver can rebuild the source from *any* k + a little overhead
// symbols, in any order, with duplicates ignored — which is exactly what an
// optical link needs, because the camera will always miss some frames.
//
// This module used to carry its own copy of the encoder, the belief-propagation
// decoder, the robust-soliton degree distribution and the seeded PRNG. That code
// was extracted once into `drsamonline/optical-kit` (`Optical.Fountain`,
// `Optical.Decoder`), which is vendored beside this file as `optical-kit.js`.
// Everything here is now a thin adapter over the kit, so the repo keeps the same
// public API while the algorithm lives in one place.
//
//   import { LTDecoder, encodeSymbol, splitBlocks, indicesFor, degreeFor }
//     from './fountain.js';   // unchanged callers, unchanged behaviour

import './optical-kit.js'; // side-effect: defines globalThis.Optical

const Optical = globalThis.Optical;

// The kit is session-seeded. These repos send a single transfer per stream, so a
// fixed session keeps the symbol set deterministic and reproducible for tests.
const SESSION = 1;

// The kit's robust-soliton tuning (kept exported so callers importing the old
// constants keep compiling).
export const DEFAULT_C = 0.1;
export const DEFAULT_DELTA = 0.05;

/** The kit's view of a set of source blocks. */
const asFountain = (blocks) => ({
  session: SESSION,
  k: blocks.length,
  blockSize: blocks[0].length,
  blocks,
});

/** Number of source blocks a payload needs at this block size. */
export const blockCount = (length, blockSize) => Math.max(1, Math.ceil(length / blockSize));

/** Split a payload into k equal-length blocks, zero-padded on the last. */
export function splitBlocks(payload, blockSize) {
  return Optical.Fountain.encode(payload, { blockSize, session: SESSION }).blocks;
}

/**
 * The distinct source-block indices XORed into symbol `symbolId`.
 *
 * Derived from the kit rather than recomputed: encode `k` unit vectors and read
 * back which ones the kit's symbol mixes. For the systematic prefix
 * (symbolId < k) that is exactly `[symbolId]`.
 */
export function indicesFor(symbolId, k) {
  const basis = [];
  for (let i = 0; i < k; i++) {
    const b = new Uint8Array(k);
    b[i] = 1;
    basis.push(b);
  }
  const sym = Optical.Fountain.symbol(asFountain(basis), symbolId);
  const out = [];
  for (let i = 0; i < k; i++) if (sym[i]) out.push(i);
  return out.length ? out : [0];
}

/** Degree of the symbol with this id. Deterministic on both sides. */
export function degreeFor(symbolId, k) {
  return indicesFor(symbolId, k).length;
}

/** The encoded symbol for `symbolId`, XOR of its chosen blocks. */
export function encodeSymbol(symbolId, blocks) {
  return Optical.Fountain.symbol(asFountain(blocks), symbolId);
}

/**
 * Belief-propagation LT decoder — the kit's `Optical.Decoder` behind the repo's
 * original class shape, so existing callers and tests are untouched.
 *
 * Feed it `addSymbol(id, data)` in any order, with any number of duplicates,
 * until `complete` is true, then read `payload()` (trimmed to `length`).
 */
export class LTDecoder {
  constructor(k, blockSize, length) {
    this.k = k;
    this.blockSize = blockSize;
    this.length = length;
    this._dec = Optical.Decoder(k, blockSize, SESSION);
  }

  get complete() {
    return this._dec.progress() >= 1;
  }

  get progress() {
    return this._dec.progress();
  }

  /** Absorb one symbol. */
  addSymbol(symbolId, data) {
    this._dec.add(symbolId, data);
    return true;
  }

  /** Reassemble the payload. Throws if the transfer is not yet complete. */
  payload() {
    if (!this.complete) throw new Error('transfer incomplete');
    return this._dec.result(this.length);
  }
}
