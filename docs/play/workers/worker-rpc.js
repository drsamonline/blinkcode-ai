// Minimal request/response plumbing shared by every worker.

export function serve(handlers) {
  self.onmessage = async (event) => {
    const { id, type, payload } = event.data;
    const handler = handlers[type];
    if (!handler) {
      self.postMessage({ id, ok: false, error: `unknown request ${type}` });
      return;
    }
    try {
      const { result, transfer = [] } = await handler(payload);
      self.postMessage({ id, ok: true, result }, transfer);
    } catch (err) {
      self.postMessage({ id, ok: false, error: err.message || String(err) });
    }
  };
}

/** Client side: wraps a Worker in a promise-based `call(type, payload)`. */
export class WorkerClient {
  constructor(url) {
    this.worker = new Worker(url, { type: 'module' });
    this.pending = new Map();
    this.nextId = 1;
    // A worker that fails to load, or throws at the top level, used to leave
    // every pending call waiting forever. Fail them instead.
    const fail = (message) => {
      for (const [, entry] of this.pending) entry.reject(new Error(message));
      this.pending.clear();
    };
    this.worker.onerror = (event) => fail(event.message || 'worker failed to start');
    this.worker.onmessageerror = () => fail('worker message could not be deserialised');

    this.worker.onmessage = (event) => {
      const { id, ok, result, error, progress } = event.data;
      const entry = this.pending.get(id);
      if (!entry) return;
      if (progress !== undefined) {
        entry.onProgress?.(progress);
        return;
      }
      this.pending.delete(id);
      if (ok) entry.resolve(result);
      else entry.reject(new Error(error));
    };
  }

  call(type, payload, { transfer = [], onProgress } = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      this.worker.postMessage({ id, type, payload }, transfer);
    });
  }
}
