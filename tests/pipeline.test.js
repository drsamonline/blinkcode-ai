// End-to-end optical loopback: file -> File DNA -> SpectraCode pixels ->
// marker detection -> homography -> colour correction -> RS -> file.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseModel } from '../src/lib/model.js';
import { encodeFileDna, decodeFileDna, MODE } from '../src/lib/codec.js';
import { payloadToSymbols, PAYLOAD_CAPACITY } from '../src/lib/spectracode.js';
import { decodeSpectraCode } from '../src/lib/spectra-decode.js';
import { drawSpectraCode } from '../src/lib/spectracode.js';
import { BufferSurface } from '../src/lib/surface.js';
import { applyHomography, homography } from '../src/lib/geometry.js';

const model = parseModel(new Uint8Array(readFileSync('src/models/ucg-v1.bin')));

function render(container, size = 1400) {
  const surface = new BufferSurface(size, size);
  drawSpectraCode(surface, payloadToSymbols(container), size);
  return surface.toImageData();
}

/** Simulate a phone camera: perspective tilt, colour cast and vignetting. */
function photograph(image, { tilt = 0.06, cast = [1.06, 0.97, 0.9], gain = 0.9 } = {}) {
  const { width: w, height: h } = image;
  const out = {
    data: new Uint8ClampedArray(w * h * 4),
    width: w,
    height: h,
  };
  const src = [
    [0, 0],
    [w, 0],
    [w, h],
    [0, h],
  ];
  const dst = [
    [w * tilt, h * tilt * 0.5],
    [w * (1 - tilt * 0.4), h * tilt],
    [w * (1 - tilt), h * (1 - tilt * 0.6)],
    [w * tilt * 0.5, h * (1 - tilt)],
  ];
  const inverse = homography(dst, src);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [sx, sy] = applyHomography(inverse, x + 0.5, y + 0.5);
      const o = (y * w + x) * 4;
      if (sx < 0 || sy < 0 || sx >= w || sy >= h) {
        out.data[o] = out.data[o + 1] = out.data[o + 2] = 250;
        out.data[o + 3] = 255;
        continue;
      }
      const i = ((sy | 0) * w + (sx | 0)) * 4;
      // Radial falloff mimics uneven lighting.
      const dx = (x / w - 0.5) * 2;
      const dy = (y / h - 0.5) * 2;
      const vignette = 1 - 0.18 * (dx * dx + dy * dy);
      for (let c = 0; c < 3; c++) {
        out.data[o + c] = image.data[i + c] * cast[c] * gain * vignette + 8;
      }
      out.data[o + 3] = 255;
    }
  }
  return out;
}

test('lossless round trip through a rendered SpectraCode', () => {
  const bytes = new TextEncoder().encode(
    'BlinkCode AI single-shot optical transfer. '.repeat(20),
  );
  const { container, stats } = encodeFileDna(
    { name: 'note.txt', mode: MODE.LOSSLESS, bytes },
    model,
  );
  assert.ok(stats.compressedBytes < bytes.length, 'payload should shrink');

  const image = render(container);
  const { payload } = decodeSpectraCode(image);
  const restored = decodeFileDna(payload, model);
  assert.equal(restored.name, 'note.txt');
  assert.deepEqual(restored.bytes, bytes);
});

test('decodes a simulated camera photo with tilt, colour cast and vignetting', () => {
  const bytes = crypto.getRandomValues(new Uint8Array(600));
  const { container } = encodeFileDna(
    { name: 'random.bin', mode: MODE.LOSSLESS, bytes },
    model,
  );
  const photo = photograph(render(container, 1600));
  const { payload, residual } = decodeSpectraCode(photo);
  assert.ok(residual < 60, `colour residual too high: ${residual}`);
  assert.deepEqual(decodeFileDna(payload, model).bytes, bytes);
});

test('perceptual image mode fits a photo into a few hundred bytes', () => {
  const w = 640;
  const h = 480;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i] = 40 + 180 * Math.sin((x / w) * Math.PI);
      data[i + 1] = 30 + 120 * (y / h);
      data[i + 2] = 200 - 150 * (x / w);
      data[i + 3] = 255;
    }
  }
  const image = { data, width: w, height: h };
  const { container, stats } = encodeFileDna(
    { name: 'photo.jpg', mode: MODE.PERCEPTUAL_IMAGE, image },
    model,
  );
  assert.ok(container.length < 200, `container too large: ${container.length}`);

  const restored = decodeFileDna(
    decodeSpectraCode(render(container)).payload,
    model,
  );
  assert.equal(restored.image.width, w);
  assert.equal(restored.image.height, h);

  let error = 0;
  for (let i = 0; i < w * h; i++) {
    for (let c = 0; c < 3; c++) {
      error += (restored.image.data[i * 4 + c] - data[i * 4 + c]) ** 2;
    }
  }
  const rmse = Math.sqrt(error / (w * h * 3));
  assert.ok(rmse < 25, `perceptual reconstruction too poor: rmse ${rmse}`);
  assert.ok(stats.originalBytes / stats.containerBytes > 1000, 'ratio claim');
});

test('payloads above capacity are rejected up front', () => {
  assert.throws(
    () => payloadToSymbols(new Uint8Array(PAYLOAD_CAPACITY + 1)),
    /capacity/,
  );
});
