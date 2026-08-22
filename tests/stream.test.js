// Multi-frame transfers and grid densities, end to end through the optical
// decoder (render every frame, decode it, reassemble, restore the file).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseModel } from '../src/lib/model.js';
import { encodeFileDna, decodeFileDna, MODE } from '../src/lib/codec.js';
import { drawSpectraCode, payloadToSymbols, specByName, DENSITIES } from '../src/lib/spectracode.js';
import { decodeSpectraCode } from '../src/lib/spectra-decode.js';
import { BufferSurface } from '../src/lib/surface.js';
import { splitIntoFrames, parseFrame, chunkSize, crc32, FrameCollector } from '../src/lib/stream.js';

const model = parseModel(new Uint8Array(readFileSync('src/models/ucg-v1.bin')));

function photographFrame(frame, spec, size) {
  const surface = new BufferSurface(size, size);
  drawSpectraCode(surface, payloadToSymbols(frame, spec), size, spec);
  return surface.toImageData();
}

/** Render, decode and collect every frame of a container. */
function roundTrip(container, spec, size) {
  const { frames } = splitIntoFrames(container, spec, 0x1234);
  const collector = new FrameCollector();
  const densities = new Set();
  for (const frame of frames) {
    const decoded = decodeSpectraCode(photographFrame(frame, spec, size));
    densities.add(decoded.density);
    collector.add(parseFrame(decoded.payload));
  }
  return { collector, frames, densities };
}

test('a file larger than one code streams across frames and reassembles', () => {
  const bytes = new TextEncoder().encode(
    'BlinkCode streams anything that does not fit in a single frame. '.repeat(400),
  );
  const spec = specByName('standard');
  const { container } = encodeFileDna({ name: 'long.txt', mode: MODE.LOSSLESS, bytes }, model);
  assert.ok(container.length > chunkSize(spec), 'test needs a multi-frame payload');

  const { collector, frames } = roundTrip(container, spec, 1400);
  assert.ok(frames.length > 1, `expected several frames, got ${frames.length}`);
  assert.equal(collector.complete, true);
  assert.deepEqual(decodeFileDna(collector.assemble(), model).bytes, bytes);
});

test('frames may arrive out of order, duplicated, with gaps reported', () => {
  const container = new Uint8Array(9000).map((_, i) => (i * 37) & 0xff);
  const spec = specByName('standard');
  const { frames } = splitIntoFrames(container, spec, 7);
  const collector = new FrameCollector();

  collector.add(parseFrame(frames[1]));
  assert.equal(collector.complete, false);
  assert.deepEqual(collector.missing, [0]);
  assert.equal(collector.add(parseFrame(frames[1])).fresh, false);
  collector.add(parseFrame(frames[0]));

  assert.equal(collector.complete, true);
  assert.deepEqual(collector.assemble(), container);
});

test('a new transfer id resets the collector', () => {
  const spec = specByName('standard');
  const first = splitIntoFrames(new Uint8Array(9000).fill(1), spec, 1);
  const second = splitIntoFrames(new Uint8Array(9000).fill(2), spec, 2);
  const collector = new FrameCollector();

  collector.add(parseFrame(first.frames[0]));
  const { restarted } = collector.add(parseFrame(second.frames[0]));
  assert.equal(restarted, true);
  assert.equal(collector.received, 1);
  collector.add(parseFrame(second.frames[1]));
  assert.deepEqual(collector.assemble(), new Uint8Array(9000).fill(2));
});

test('a corrupted chunk is caught by the transfer checksum', () => {
  const container = new Uint8Array(9000).map((_, i) => i & 0xff);
  const spec = specByName('standard');
  const { frames } = splitIntoFrames(container, spec, 3);
  const collector = new FrameCollector();
  for (const frame of frames) collector.add(parseFrame(frame));
  collector.chunks.get(0)[10] ^= 0xff;
  assert.throws(() => collector.assemble(), /checksum/);
});

test('crc32 matches the known check value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('robust density is detected from the density patch', () => {
  const spec = specByName('robust');
  assert.ok(spec.payloadCapacity < specByName('standard').payloadCapacity);
  const bytes = new TextEncoder().encode('handheld phones need bigger cells. '.repeat(30));
  const { container } = encodeFileDna({ name: 'note.txt', mode: MODE.LOSSLESS, bytes }, model);

  const { collector, densities } = roundTrip(container, spec, 900);
  assert.deepEqual([...densities], ['robust']);
  assert.deepEqual(decodeFileDna(collector.assemble(), model).bytes, bytes);
});

test('every density advertises a distinct patch colour', () => {
  const ids = new Set(DENSITIES.map((d) => d.id));
  assert.equal(ids.size, DENSITIES.length);
});
