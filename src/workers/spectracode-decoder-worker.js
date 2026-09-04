// Optical decoding: marker detection, homography, colour correction and
// Reed-Solomon, off the main thread so the camera preview stays smooth.

import { serve } from './worker-rpc.js';
import { decodeSpectraCode, findMarkers } from '../lib/spectra-decode.js';

serve({
  /** Cheap pre-check used to show a "code in frame" indicator. */
  locate({ data, width, height }) {
    const quad = findMarkers({ data: new Uint8ClampedArray(data), width, height });
    return { result: { quad } };
  },

  decode({ data, width, height }) {
    const started = performance.now();
    const image = { data: new Uint8ClampedArray(data), width, height };
    const { payload, corrected, residual, density } = decodeSpectraCode(image);
    return {
      result: {
        payload,
        corrected,
        density,
        residual: Math.round(residual * 10) / 10,
        elapsedMs: Math.round(performance.now() - started),
      },
      transfer: [payload.buffer],
    };
  },
});
