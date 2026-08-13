// File DNA pipeline: bytes (or pixels) -> container -> SpectraCode payload.

import { arithEncode, arithDecode, Order1Model } from './arith.js';
import { packContainer, unpackContainer, MODE } from './format.js';
import {
  encodeImageLatent,
  decodeImageLatent,
  defaultLatentScales,
} from './image-codec.js';
import { PAYLOAD_CAPACITY } from './spectracode.js';

const scalesFor = (model) => model?.latentScales ?? defaultLatentScales();
const priorsFor = (model) => model?.order1 ?? null;

export function compressBytes(bytes, model) {
  return arithEncode(bytes, new Order1Model(priorsFor(model)));
}

export function decompressBytes(bytes, model) {
  return arithDecode(bytes, new Order1Model(priorsFor(model)));
}

/**
 * Build a File DNA container.
 * @param {object} input
 * @param {string} input.name original file name
 * @param {number} input.mode MODE.LOSSLESS or MODE.PERCEPTUAL_IMAGE
 * @param {Uint8Array} [input.bytes] raw file bytes (lossless mode)
 * @param {{data:Uint8ClampedArray,width:number,height:number}} [input.image]
 *        decoded pixels (perceptual mode)
 * @param {object} [model] UCG model bundle
 */
export function encodeFileDna({ name, mode, bytes, image }, model) {
  const source =
    mode === MODE.PERCEPTUAL_IMAGE
      ? encodeImageLatent(image, scalesFor(model))
      : bytes;
  const compressed = compressBytes(source, model);
  const container = packContainer({ name, mode, payload: compressed });
  return {
    container,
    stats: {
      originalBytes: mode === MODE.PERCEPTUAL_IMAGE ? image.width * image.height * 4 : bytes.length,
      latentBytes: source.length,
      compressedBytes: compressed.length,
      containerBytes: container.length,
      capacity: PAYLOAD_CAPACITY,
    },
  };
}

/**
 * Reverse {@link encodeFileDna}.
 * @returns {{name:string, mode:number, bytes?:Uint8Array, image?:object}}
 */
export function decodeFileDna(container, model) {
  const { name, mode, payload } = unpackContainer(container);
  const raw = decompressBytes(payload, model);
  if (mode === MODE.PERCEPTUAL_IMAGE) {
    return { name, mode, image: decodeImageLatent(raw, scalesFor(model)) };
  }
  return { name, mode, bytes: raw };
}

export { MODE };
