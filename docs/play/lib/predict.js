// Order-1 model + a match (LZP) model, blended into the arithmetic coder.
//
// The plain order-1 model sees one byte of context, so it cannot exploit
// repeated *phrases* — exactly where gzip wins. This adds a match model on top:
// it remembers the byte that followed the last occurrence of the current H-byte
// context and, when it has one, boosts that byte's frequency.
//
// The interface is identical to `Order1Model` (range / symbolFor / update), so
// the coder and the rest of the pipeline are unchanged. Both encoder and
// decoder derive the prediction from bytes they have already coded, so they
// stay in lockstep with no side channel.
//
// Timing matters: the boost must be visible to the coder *before* it queries
// the distribution. The decoder reads `totals[ctx]` and then calls
// `symbolFor(ctx)`, so a boost applied lazily inside `symbolFor` would desync.
// Instead the boost for the next symbol (whose context is the byte just coded)
// is applied at the end of `update`, and removed at the start of the next one.

import { Order1Model, ALPHABET, EOS } from './arith.js';

export const MATCH_DEFAULTS = { h: 6, boostMul: 4, boostMin: 64 };
const HASH_BITS = 20;
const HASH_SIZE = 1 << HASH_BITS;
// A context's boosted total never exceeds this, so `range * total` (< 2^32 * 2^20)
// stays an exact integer in the coder.
const BOOST_CAP = 1 << 20;

export class Order1MatchModel extends Order1Model {
  constructor(priors = null, options = {}) {
    super(priors);
    this.h = options.h ?? MATCH_DEFAULTS.h;
    this.boostMul = options.boostMul ?? MATCH_DEFAULTS.boostMul;
    this.boostMin = options.boostMin ?? MATCH_DEFAULTS.boostMin;
    this.boostAmt = 0; // amount currently added to the boosted context
    this.buf = new Uint8Array(1 << 16);
    this.len = 0;
    this.win = new Uint8Array(this.h);
    this.winLen = 0;
    this.table = new Int32Array(HASH_SIZE).fill(-1);
    this.pred = -1;
    this.boostCtx = -1; // context currently carrying a boost, or -1
  }

  #push(byte) {
    if (this.len === this.buf.length) {
      const grown = new Uint8Array(this.buf.length * 2);
      grown.set(this.buf);
      this.buf = grown;
    }
    this.buf[this.len++] = byte;
  }

  #hash() {
    let h = 0x811c9dc5;
    for (let i = 0; i < this.winLen; i++) h = Math.imul(h ^ this.win[i], 0x01000193) >>> 0;
    return h & (HASH_SIZE - 1);
  }

  #applyBoost(ctx) {
    if (this.pred < 0) return;
    // Scale the boost with the context's own mass so the prediction stays
    // dominant even after the order-1 counts have grown. Capped so the coder's
    // `range * cumulative` product stays well inside a safe integer.
    const desired = Math.max(this.boostMin, Math.round(this.boostMul * this.totals[ctx]));
    const amount = Math.min(desired, BOOST_CAP - this.totals[ctx]);
    if (amount <= 0) return;
    this.counts[ctx * ALPHABET + this.pred] += amount;
    this.totals[ctx] += amount;
    this.boostAmt = amount;
    this.boostCtx = ctx;
  }

  #clearBoost() {
    if (this.boostCtx < 0) return;
    this.counts[this.boostCtx * ALPHABET + this.pred] -= this.boostAmt;
    this.totals[this.boostCtx] -= this.boostAmt;
    this.boostCtx = -1;
  }

  update(ctx, sym) {
    this.#clearBoost();
    super.update(ctx, sym);
    if (sym === EOS) {
      this.pred = -1;
      return;
    }

    const idx = this.len;
    this.#push(sym);
    if (this.winLen < this.h) this.win[this.winLen++] = sym;
    else {
      this.win.copyWithin(0, 1);
      this.win[this.h - 1] = sym;
    }
    if (this.winLen === this.h) {
      const h = this.#hash();
      const pos = this.table[h];
      this.pred = pos >= 0 && pos < this.len ? this.buf[pos] : -1;
      this.table[h] = idx + 1; // the byte that will follow this context
    } else {
      this.pred = -1;
    }
    // The context of the *next* symbol is `sym`; boost its predicted byte now
    // so the coder sees it when it queries the distribution.
    if (this.pred >= 0) this.#applyBoost(sym);
  }
}
