// Rateless (fountain) frames: pure codec tests, plus a full optical loopback.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseModel } from '../src/lib/model.js';
import { encodeFileDna, decodeFileDna, MODE } from '../src/lib/codec.js';
import { drawSpectraCode, payloadToSymbols, specByName } from '../src/lib/spectracode.js';
import { decodeSpectraCode } from '../src/lib/spectra-decode.js';
import { BufferSurface } from '../src/lib/surface.js';
import {
  FountainCollector,
  fountainStream,
  packFountainFrame,
  parseFountainFrame,
  symbolBytes,
  splitBlocks,
  encodeSymbol,
} from '../src/lib/stream.js';
import { LTDecoder } from '../src/lib/fountain.js';

const model = parseModel(new Uint8Array(readFileSync('src/models/ucg-v1.bin')));

test('LT decoder rebuilds the container from any enough symbols', () => {
  const spec = specByName('standard');
  const blockSize = symbolBytes(spec);
  const container = crypto.getRandomValues(new Uint8Array(blockSize * 6 + 137));
  const stream = fountainStream(container, spec, 7);
  const blocks = splitBlocks(container, stream.blockSize);

  const dec = new LTDecoder(stream.k, stream.blockSize, stream.totalLen);
  let used = 0;
  for (let id = 0; id < stream.k * 4 && !dec.complete; id++) {
    dec.addSymbol(id, encodeSymbol(id, blocks));
    used++;
  }
  assert.equal(dec.complete, true);
  assert.deepEqual(dec.payload(), container);
  assert.ok(used < stream.k * 2, `overhead too high: ${used} for k=${stream.k}`);
});

test('fountain frames pack and parse, and reject non-frames', () => {
  const data = new Uint8Array(32).map((_, i) => i);
  const frame = packFountainFrame({
    transferId: 0x1234, k: 9, blockSize: 32, totalLen: 300, checksum: 0xdeadbeef, symbolId: 5, data,
  });
  const parsed = parseFountainFrame(frame);
  assert.equal(parsed.transferId, 0x1234);
  assert.equal(parsed.k, 9);
  assert.equal(parsed.blockSize, 32);
  assert.equal(parsed.totalLen, 300);
  assert.equal(parsed.checksum, 0xdeadbeef);
  assert.equal(parsed.symbolId, 5);
  assert.deepEqual(parsed.data, data);
  assert.throws(() => parseFountainFrame(Uint8Array.of(1, 2, 3)), /truncated/);
});

test('FountainCollector tolerates duplicates and out-of-order symbols', () => {
  const spec = specByName('standard');
  const container = crypto.getRandomValues(new Uint8Array(symbolBytes(spec) * 4));
  const stream = fountainStream(container, spec, 3);
  const blocks = splitBlocks(container, stream.blockSize);
  const collector = new FountainCollector();

  const frame = (id) =>
    parseFountainFrame(
      packFountainFrame({ ...stream, symbolId: id, data: encodeSymbol(id, blocks) }),
    );

  // out of order, with duplicates
  const order = [3, 1, 3, 0, 2, 1, 4, 5, 6, 7];
  for (const id of order) {
    collector.add(frame(id));
    if (collector.complete) break;
  }
  assert.equal(collector.complete, true);
  assert.deepEqual(collector.assemble(), container);
  assert.ok(collector.symbols < stream.k * 3);
});

test('FountainCollector restarts on a new transfer id', () => {
  const spec = specByName('standard');
  const a = fountainStream(new Uint8Array(symbolBytes(spec) * 2).fill(1), spec, 1);
  const b = fountainStream(new Uint8Array(symbolBytes(spec) * 2).fill(2), spec, 2);
  const blocksA = splitBlocks(new Uint8Array(a.totalLen).fill(1), a.blockSize);
  const collector = new FountainCollector();
  const f = (s, blocks, id) =>
    parseFountainFrame(packFountainFrame({ ...s, symbolId: id, data: encodeSymbol(id, blocks) }));

  collector.add(f(a, blocksA, 0));
  const { restarted } = collector.add(f(b, splitBlocks(new Uint8Array(b.totalLen).fill(2), b.blockSize), 0));
  assert.equal(restarted, true);
  assert.equal(collector.transferId, 2);
});

test('fountain stream survives a full optical loopback', () => {
  const spec = specByName('standard');
  const bytes = crypto.getRandomValues(new Uint8Array(symbolBytes(spec) * 2 + 50));
  const { container } = encodeFileDna({ name: 'rand.bin', mode: MODE.LOSSLESS, bytes }, model);
  const stream = fountainStream(container, spec, 0x5a5a);
  const blocks = splitBlocks(container, stream.blockSize);

  const collector = new FountainCollector();
  const size = 1400;
  let rendered = 0;
  for (let id = 0; id < stream.k * 3 + 8 && !collector.complete; id++) {
    const surface = new BufferSurface(size, size);
    const frame = packFountainFrame({ ...stream, symbolId: id, data: encodeSymbol(id, blocks) });
    drawSpectraCode(surface, payloadToSymbols(frame, spec), size, spec);
    const decoded = decodeSpectraCode(surface.toImageData());
    collector.add(parseFountainFrame(decoded.payload));
    rendered++;
  }
  assert.equal(collector.complete, true, `did not complete after ${rendered} symbols`);
  const restored = decodeFileDna(collector.assemble(), model);
  assert.deepEqual(restored.bytes, bytes);
});
