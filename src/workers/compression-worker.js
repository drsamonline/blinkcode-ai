// Compresses a file into File DNA and packs it into SpectraCode frames.

import { serve } from './worker-rpc.js';
import { ensureModelBytes } from '../lib/storage.js';
import { parseModel } from '../lib/model.js';
import { encodeFileDna, MODE } from '../lib/codec.js';
import { payloadToSymbols, specByName } from '../lib/spectracode.js';
import { splitIntoFrames } from '../lib/stream.js';

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

    const { frames, transferId, checksum } = splitIntoFrames(container, spec);
    const symbolFrames = frames.map((frame) => payloadToSymbols(frame, spec));

    return {
      result: {
        container,
        symbolFrames,
        transferId,
        checksum,
        density: spec.name,
        stats: {
          ...stats,
          frames: frames.length,
          density: spec.name,
          elapsedMs: Math.round(performance.now() - started),
        },
      },
      transfer: [container.buffer, ...symbolFrames.map((s) => s.buffer)],
    };
  },
});
