// Fetches the UCG model bundle once, caches it, and reports progress.

import { serve } from './worker-rpc.js';
import { ensureModelBytes, storedModelBytes } from '../lib/storage.js';
import { parseModel } from '../lib/model.js';

serve({
  async status() {
    const bytes = await storedModelBytes();
    return { result: { cached: Boolean(bytes), bytes: bytes?.length ?? 0 } };
  },

  async ensure() {
    const { bytes, downloaded } = await ensureModelBytes();
    // Parsing here validates the bundle before the app relies on it.
    const model = parseModel(bytes);
    return {
      result: {
        downloaded,
        version: model.version,
        bytes: bytes.length,
        contexts: model.order1 ? 256 : 0,
      },
    };
  },
});
