// One-time model download + offline persistence.
//
// The bundle is written to Cache Storage (so the service worker can serve it
// like any other asset) and mirrored into IndexedDB, which survives cache
// eviction in some browsers. Every later launch reads from storage and never
// touches the network.

import { MODEL_URL } from './model.js';

const CACHE_NAME = 'blinkcode-model-v1';
const DB_NAME = 'blinkcode';
const STORE = 'models';

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    tx.onsuccess = () => resolve(tx.result ?? null);
    tx.onerror = () => reject(tx.error);
  });
}

async function idbPut(key, value) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite').objectStore(STORE).put(value, key);
    tx.onsuccess = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function fromCache() {
  if (typeof caches === 'undefined') return null;
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(MODEL_URL);
  return hit ? new Uint8Array(await hit.arrayBuffer()) : null;
}

export async function storedModelBytes() {
  const cached = await fromCache();
  if (cached) return cached;
  const stored = await idbGet(MODEL_URL).catch(() => null);
  return stored ? new Uint8Array(stored) : null;
}

/**
 * Fetch the model bundle once and persist it.
 * @param {(loaded:number, total:number) => void} [onProgress]
 */
export async function downloadModel(onProgress) {
  const response = await fetch(MODEL_URL);
  if (!response.ok) throw new Error(`model download failed: HTTP ${response.status}`);
  const total = Number(response.headers.get('content-length')) || 0;

  let bytes;
  if (response.body && onProgress) {
    const reader = response.body.getReader();
    const chunks = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      onProgress(loaded, total);
    }
    bytes = new Uint8Array(loaded);
    let p = 0;
    for (const c of chunks) {
      bytes.set(c, p);
      p += c.length;
    }
  } else {
    bytes = new Uint8Array(await response.arrayBuffer());
  }

  if (typeof caches !== 'undefined') {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(
      MODEL_URL,
      new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } }),
    );
  }
  await idbPut(MODEL_URL, bytes).catch(() => {});
  return bytes;
}

/** Storage-first model bytes; downloads only on the very first launch. */
export async function ensureModelBytes(onProgress) {
  const stored = await storedModelBytes();
  if (stored) return { bytes: stored, downloaded: false };
  return { bytes: await downloadModel(onProgress), downloaded: true };
}
