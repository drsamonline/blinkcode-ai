// "File DNA" container: a compact header in front of the compressed payload.
//
//   magic "BKAI" | version u8 | mode u8 | nameLen u8 | name utf-8 | length u32be

export const MAGIC = Uint8Array.of(0x42, 0x4b, 0x41, 0x49); // BKAI
export const VERSION = 1;

export const MODE = {
  LOSSLESS: 0,
  PERCEPTUAL_IMAGE: 1,
};

export function packContainer({ name, mode, payload }) {
  const nameBytes = new TextEncoder().encode(name).slice(0, 255);
  const out = new Uint8Array(4 + 1 + 1 + 1 + nameBytes.length + 4 + payload.length);
  out.set(MAGIC, 0);
  out[4] = VERSION;
  out[5] = mode;
  out[6] = nameBytes.length;
  out.set(nameBytes, 7);
  const lenOffset = 7 + nameBytes.length;
  new DataView(out.buffer).setUint32(lenOffset, payload.length, false);
  out.set(payload, lenOffset + 4);
  return out;
}

export function unpackContainer(bytes) {
  if (bytes.length < 12) throw new Error('container truncated');
  for (let i = 0; i < 4; i++) {
    if (bytes[i] !== MAGIC[i]) throw new Error('not a File DNA container');
  }
  const version = bytes[4];
  if (version !== VERSION) throw new Error(`unsupported container version ${version}`);
  const mode = bytes[5];
  const nameLen = bytes[6];
  const name = new TextDecoder().decode(bytes.subarray(7, 7 + nameLen));
  const lenOffset = 7 + nameLen;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(lenOffset, false);
  const start = lenOffset + 4;
  if (start + length > bytes.length) throw new Error('payload truncated');
  return { version, mode, name, payload: bytes.subarray(start, start + length) };
}
