// Compresses a file into File DNA and packs it into SpectraCode symbols.

import { serve } from './worker-rpc.js';
import { ensureModelBytes } from '../lib/storage.js';
import { parseModel } from '../lib/model.js';
import { encodeFileDna, MODE } from '../lib/codec.js';
import { payloadToSymbols } from '../lib/spectracode.js';

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
  async compress({ name, mode, bytes, bitmap }) {
    const started = performance.now();
    const loaded = await getModel();
    const input =
      mode === MODE.PERCEPTUAL_IMAGE
        ? { name, mode, image: pixelsOf(bitmap) }
        : { name, mode, bytes: new Uint8Array(bytes) };
    const { container, stats } = encodeFileDna(input, loaded);
    const symbols = payloadToSymbols(container);
    return {
      result: {
        container,
        symbols,
        stats: { ...stats, elapsedMs: Math.round(performance.now() - started) },
      },
      transfer: [container.buffer, symbols.buffer],
    };
  },
});
