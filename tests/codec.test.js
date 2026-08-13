import test from 'node:test';
import assert from 'node:assert/strict';

import { arithEncode, arithDecode, Order1Model } from '../src/lib/arith.js';
import { rsEncode, rsDecode, BLOCK_TOTAL } from '../src/lib/rs.js';

function bytes(str) {
  return new TextEncoder().encode(str);
}

test('reed-solomon round-trips clean data', () => {
  const data = bytes('BlinkCode AI '.repeat(30));
  const enc = rsEncode(data);
  const { data: dec, corrected } = rsDecode(enc);
  assert.equal(corrected, 0);
  assert.deepEqual(dec.subarray(0, data.length), data);
});

test('reed-solomon repairs up to 16 byte errors per block', () => {
  const data = new Uint8Array(223).map((_, i) => (i * 7) & 0xff);
  const enc = rsEncode(data);
  for (let i = 0; i < 16; i++) enc[i * 13] ^= 0xa5;
  const { data: dec, corrected } = rsDecode(enc);
  assert.equal(corrected, 16);
  assert.deepEqual(dec, data);
});

test('reed-solomon rejects damage beyond its capacity', () => {
  const data = new Uint8Array(223).fill(9);
  const enc = rsEncode(data);
  for (let i = 0; i < 40; i++) enc[i * 5] ^= 0xff;
  assert.throws(() => rsDecode(enc));
});

test('reed-solomon handles multiple blocks', () => {
  const data = new Uint8Array(500).map((_, i) => (i * 31 + 5) & 0xff);
  const enc = rsEncode(data);
  assert.equal(enc.length, 3 * BLOCK_TOTAL);
  enc[10] ^= 0xff;
  enc[BLOCK_TOTAL + 20] ^= 0xff;
  const { data: dec } = rsDecode(enc);
  assert.deepEqual(dec.subarray(0, data.length), data);
});

test('arithmetic coder round-trips text and shrinks it', () => {
  const data = bytes('the quick brown fox jumps over the lazy dog. '.repeat(40));
  const enc = arithEncode(data, new Order1Model());
  const dec = arithDecode(enc, new Order1Model());
  assert.deepEqual(dec, data);
  assert.ok(enc.length < data.length * 0.5, `ratio too weak: ${enc.length}/${data.length}`);
});

test('arithmetic coder round-trips binary and empty input', () => {
  for (const data of [
    new Uint8Array(0),
    Uint8Array.of(0),
    new Uint8Array(1024).map((_, i) => (i * 251) & 0xff),
    crypto.getRandomValues(new Uint8Array(2048)),
  ]) {
    const dec = arithDecode(arithEncode(data, new Order1Model()), new Order1Model());
    assert.deepEqual(dec, data);
  }
});
