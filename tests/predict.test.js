// The match model must round-trip exactly and must actually beat the plain
// order-1 model on repetitive data.

import test from 'node:test';
import assert from 'node:assert/strict';

import { arithEncode, arithDecode, Order1Model } from '../src/lib/arith.js';
import { Order1MatchModel } from '../src/lib/predict.js';

const enc = (s) => new TextEncoder().encode(s);

test('match model round-trips text, binary and empty input', () => {
  const cases = [
    new Uint8Array(0),
    Uint8Array.of(0),
    enc('the quick brown fox jumps over the lazy dog. '.repeat(80)),
    new Uint8Array(4096).map((_, i) => (i * 251) & 0xff),
    crypto.getRandomValues(new Uint8Array(2048)),
  ];
  for (const data of cases) {
    const coded = arithEncode(data, new Order1MatchModel());
    const back = arithDecode(coded, new Order1MatchModel());
    assert.deepEqual(back, data);
  }
});

test('match model beats order-1 on repetitive text', () => {
  const data = enc('BlinkCode streams anything that does not fit in one frame. '.repeat(200));
  const o1 = arithEncode(data, new Order1Model()).length;
  const o1m = arithEncode(data, new Order1MatchModel()).length;
  assert.ok(o1m < o1 * 0.9, `match model should win: o1=${o1} o1+m=${o1m}`);
});

test('match model never inflates entropy-heavy data much', () => {
  const data = crypto.getRandomValues(new Uint8Array(8000));
  const o1 = arithEncode(data, new Order1Model()).length;
  const o1m = arithEncode(data, new Order1MatchModel()).length;
  assert.ok(o1m < data.length * 1.15, `unexpected expansion: ${o1m}/${data.length}`);
  assert.ok(o1m <= o1 * 1.05, `match model should not hurt much: o1=${o1} o1+m=${o1m}`);
});
