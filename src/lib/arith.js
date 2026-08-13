// Byte-level arithmetic coder driven by an order-1 context model.
//
// The probability model is the swappable part of the pipeline: today it is a
// static order-1 frequency table shipped in the downloadable model file and
// refined adaptively while coding. Replacing `Order1Model` with a neural
// next-byte predictor (same `freqs(ctx)` / `update(ctx, sym)` interface) turns
// this into the real Universal Compression Graph without touching the coder.

const ALPHABET = 257; // 0..255 plus an end-of-stream symbol
export const EOS = 256;

const TOP = 0x100000000;
const HALF = 0x80000000;
const QUARTER = 0x40000000;
const THREE_QUARTERS = 0xc0000000;
const MAX_TOTAL = 1 << 16;

export class Order1Model {
  /**
   * @param {Uint16Array|null} priors 256*257 static counts (context, symbol).
   */
  constructor(priors = null) {
    this.counts = new Uint16Array(256 * ALPHABET);
    this.totals = new Uint32Array(256);
    if (priors && priors.length === 256 * ALPHABET) {
      this.counts.set(priors);
      for (let c = 0; c < 256; c++) {
        let t = 0;
        const base = c * ALPHABET;
        for (let s = 0; s < ALPHABET; s++) {
          if (this.counts[base + s] === 0) this.counts[base + s] = 1;
          t += this.counts[base + s];
        }
        this.totals[c] = t;
      }
    } else {
      this.counts.fill(1);
      this.totals.fill(ALPHABET);
    }
    for (let c = 0; c < 256; c++) this.rescaleIfNeeded(c);
  }

  rescaleIfNeeded(ctx) {
    if (this.totals[ctx] < MAX_TOTAL) return;
    const base = ctx * ALPHABET;
    let t = 0;
    for (let s = 0; s < ALPHABET; s++) {
      const v = (this.counts[base + s] >> 1) || 1;
      this.counts[base + s] = v;
      t += v;
    }
    this.totals[ctx] = t;
  }

  /** Cumulative frequency below `sym`, and the symbol's own frequency. */
  range(ctx, sym) {
    const base = ctx * ALPHABET;
    let low = 0;
    for (let s = 0; s < sym; s++) low += this.counts[base + s];
    return [low, low + this.counts[base + sym], this.totals[ctx]];
  }

  /** Inverse lookup used by the decoder. */
  symbolFor(ctx, target) {
    const base = ctx * ALPHABET;
    let low = 0;
    for (let s = 0; s < ALPHABET; s++) {
      const high = low + this.counts[base + s];
      if (target < high) return [s, low, high, this.totals[ctx]];
      low = high;
    }
    throw new Error('arithmetic decoder desynchronised');
  }

  update(ctx, sym) {
    this.counts[ctx * ALPHABET + sym] += 24;
    this.totals[ctx] += 24;
    this.rescaleIfNeeded(ctx);
  }
}

class BitWriter {
  constructor() {
    this.bytes = [];
    this.cur = 0;
    this.nbits = 0;
  }

  bit(b) {
    this.cur = (this.cur << 1) | b;
    if (++this.nbits === 8) {
      this.bytes.push(this.cur & 0xff);
      this.cur = 0;
      this.nbits = 0;
    }
  }

  bitPlusPending(b, pending) {
    this.bit(b);
    for (let i = 0; i < pending; i++) this.bit(b ? 0 : 1);
  }

  finish() {
    while (this.nbits !== 0) this.bit(0);
    return Uint8Array.from(this.bytes);
  }
}

class BitReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.pos = 0;
    this.nbits = 0;
    this.cur = 0;
  }

  bit() {
    if (this.nbits === 0) {
      this.cur = this.pos < this.bytes.length ? this.bytes[this.pos++] : 0;
      this.nbits = 8;
    }
    this.nbits--;
    return (this.cur >> this.nbits) & 1;
  }
}

export function arithEncode(data, model) {
  const out = new BitWriter();
  let low = 0;
  let high = 0xffffffff;
  let pending = 0;
  let ctx = 0;

  const emit = (sym) => {
    const [cLow, cHigh, total] = model.range(ctx, sym);
    const range = high - low + 1;
    high = low + Math.floor((range * cHigh) / total) - 1;
    low = low + Math.floor((range * cLow) / total);
    for (;;) {
      if (high < HALF) {
        out.bitPlusPending(0, pending);
        pending = 0;
      } else if (low >= HALF) {
        out.bitPlusPending(1, pending);
        pending = 0;
        low -= HALF;
        high -= HALF;
      } else if (low >= QUARTER && high < THREE_QUARTERS) {
        pending++;
        low -= QUARTER;
        high -= QUARTER;
      } else {
        break;
      }
      low = low * 2;
      high = high * 2 + 1;
    }
    model.update(ctx, sym);
    ctx = sym === EOS ? 0 : sym;
  };

  for (let i = 0; i < data.length; i++) emit(data[i]);
  emit(EOS);

  pending++;
  if (low < QUARTER) out.bitPlusPending(0, pending);
  else out.bitPlusPending(1, pending);
  return out.finish();
}

export function arithDecode(bytes, model, maxBytes = 1 << 24) {
  const input = new BitReader(bytes);
  let low = 0;
  let high = 0xffffffff;
  let value = 0;
  for (let i = 0; i < 32; i++) value = value * 2 + input.bit();

  const out = [];
  let ctx = 0;
  for (;;) {
    const range = high - low + 1;
    const total = model.totals[ctx];
    const target = Math.min(
      total - 1,
      Math.floor(((value - low + 1) * total - 1) / range),
    );
    const [sym, cLow, cHigh] = model.symbolFor(ctx, target);
    high = low + Math.floor((range * cHigh) / total) - 1;
    low = low + Math.floor((range * cLow) / total);
    for (;;) {
      if (high < HALF) {
        // nothing to strip
      } else if (low >= HALF) {
        low -= HALF;
        high -= HALF;
        value -= HALF;
      } else if (low >= QUARTER && high < THREE_QUARTERS) {
        low -= QUARTER;
        high -= QUARTER;
        value -= QUARTER;
      } else {
        break;
      }
      low = low * 2;
      high = high * 2 + 1;
      value = value * 2 + input.bit();
      if (value >= TOP) value -= TOP;
    }
    model.update(ctx, sym);
    if (sym === EOS) break;
    out.push(sym);
    ctx = sym;
    if (out.length > maxBytes) throw new Error('decoded stream too large');
  }
  return Uint8Array.from(out);
}
