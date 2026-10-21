// Universal Compression Graph (UCG) model bundle.
//
// One binary file holding every weight the app needs. It is downloaded once and
// then served from Cache Storage / IndexedDB, which is what makes the app work
// offline afterwards. Today it carries an order-1 byte model and the latent
// quantiser scales; a trained neural predictor would ship in exactly the same
// container under new entry names.
//
//   "UCGMODEL" | version u16 | manifestLen u32 | manifest JSON | blobs

const MAGIC = 'UCGMODEL';
export const MODEL_VERSION = 1;
// Resolved against this module so workers in any directory hit the same URL.
export const MODEL_URL = new URL('../models/ucg-v1.bin', import.meta.url).href;
export const ALPHABET = 257;

const DTYPES = {
  u16: { bytes: 2, array: Uint16Array },
  f32: { bytes: 4, array: Float32Array },
};

export function serialiseModel(entries) {
  const encoder = new TextEncoder();
  const manifest = [];
  let offset = 0;
  const blobs = [];
  for (const [name, { dtype, values }] of Object.entries(entries)) {
    const spec = DTYPES[dtype];
    const typed = values instanceof spec.array ? values : spec.array.from(values);
    const blob = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
    manifest.push({ name, dtype, offset, length: typed.length });
    blobs.push(blob);
    offset += blob.length;
  }
  const manifestBytes = encoder.encode(JSON.stringify({ version: MODEL_VERSION, entries: manifest }));
  const head = new Uint8Array(MAGIC.length + 2 + 4);
  head.set(encoder.encode(MAGIC), 0);
  const view = new DataView(head.buffer);
  view.setUint16(MAGIC.length, MODEL_VERSION, false);
  view.setUint32(MAGIC.length + 2, manifestBytes.length, false);

  const total = head.length + manifestBytes.length + offset;
  const out = new Uint8Array(total);
  out.set(head, 0);
  out.set(manifestBytes, head.length);
  let p = head.length + manifestBytes.length;
  for (const blob of blobs) {
    out.set(blob, p);
    p += blob.length;
  }
  return out;
}

export function parseModel(bytes) {
  const decoder = new TextDecoder();
  if (decoder.decode(bytes.subarray(0, MAGIC.length)) !== MAGIC) {
    throw new Error('not a UCG model bundle');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(MAGIC.length, false);
  if (version !== MODEL_VERSION) throw new Error(`unsupported model version ${version}`);
  const manifestLen = view.getUint32(MAGIC.length + 2, false);
  const headLen = MAGIC.length + 6;
  const manifest = JSON.parse(decoder.decode(bytes.subarray(headLen, headLen + manifestLen)));
  const base = headLen + manifestLen;

  const out = {};
  for (const entry of manifest.entries) {
    const spec = DTYPES[entry.dtype];
    const start = base + entry.offset;
    // Copy: the source buffer is not guaranteed to be correctly aligned.
    const slice = bytes.slice(start, start + entry.length * spec.bytes);
    out[entry.name] = new spec.array(slice.buffer);
  }
  return { version, ...out };
}

/** A model bundle with no learned statistics — used until the download lands. */
export function fallbackModel() {
  return { version: MODEL_VERSION, order1: null, latentScales: null };
}
