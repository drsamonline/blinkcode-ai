// Compresses a file into File DNA and returns the parameters for a rateless
// frame stream. The sender renders fountain symbols on demand, so it never has
// to repeat a symbol — a missed frame just costs one more.

import { serve } from './worker-rpc.js';
import { ensureModelBytes } from '../lib/storage.js';
import { parseModel } from '../lib/model.js';
import { encodeFileDna, MODE } from '../lib/codec.js';
import { specByName } from '../lib/spectracode.js';
import { fountainStream } from '../lib/stream.js';

let model = null;
async function getModel() {
  if (!model) {
    const { bytes } = await ensureModelBytes();
    model = parseModel(bytes);
  }
  return model;
}

/** Decode an image bitmap into raw pixels for the perceptual codec. */
function pixelsOf(bitmap) {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
}

serve({
  async compress({ name, mode, bytes, bitmap, density = 'standard' }) {
    const started = performance.now();
    const loaded = await getModel();
    const spec = specByName(density);
    const input =
      mode === MODE.PERCEPTUAL_IMAGE
        ? { name, mode, image: pixelsOf(bitmap) }
        : { name, mode, bytes: new Uint8Array(bytes) };
    const { container, stats } = encodeFileDna(input, loaded);

    const stream = fountainStream(container, spec);

    return {
      result: {
        container,
        stream,
        density: spec.name,
        stats: {
          ...stats,
          k: stream.k,
          blockSize: stream.blockSize,
          density: spec.name,
          elapsedMs: Math.round(performance.now() - started),
        },
      },
      transfer: [container.buffer],
    };
  },
});
