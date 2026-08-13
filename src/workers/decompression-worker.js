// Turns a recovered File DNA container back into the original file.

import { serve } from './worker-rpc.js';
import { ensureModelBytes } from '../lib/storage.js';
import { parseModel } from '../lib/model.js';
import { decodeFileDna, MODE } from '../lib/codec.js';

let model = null;
async function getModel() {
  if (!model) {
    const { bytes } = await ensureModelBytes();
    model = parseModel(bytes);
  }
  return model;
}

/** Re-encode reconstructed pixels as a PNG so the receiver can save them. */
async function pixelsToPng(image) {
  const canvas = new OffscreenCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
}

serve({
  async decompress({ container }) {
    const started = performance.now();
    const loaded = await getModel();
    const restored = decodeFileDna(new Uint8Array(container), loaded);

    let bytes;
    let name = restored.name;
    let type = 'application/octet-stream';
    if (restored.mode === MODE.PERCEPTUAL_IMAGE) {
      bytes = await pixelsToPng(restored.image);
      name = `${name.replace(/\.[^.]+$/, '')}.png`;
      type = 'image/png';
    } else {
      bytes = restored.bytes;
    }
    return {
      result: {
        name,
        type,
        mode: restored.mode,
        bytes,
        elapsedMs: Math.round(performance.now() - started),
      },
      transfer: [bytes.buffer],
    };
  },
});
