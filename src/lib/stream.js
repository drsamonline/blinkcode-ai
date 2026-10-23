// Multi-frame transfers.
//
// One SpectraCode holds a few kilobytes, which is fine for a note or a key but
// not for a real file. A transfer is therefore a sequence of frames that the
// sender loops on screen; the receiver keeps scanning until it has collected
// every index, in any order, with duplicates ignored.
//
// Two framings are offered:
//   * numbered frames (magic 0xB1) — every index is required;
//   * rateless (fountain) frames (magic 0xB2) — the receiver finishes from any
//     k + overhead symbols, so a missed frame costs one more symbol, not a loop.
//
// The fountain header, its strict validation and its collector — and the CRC-32
// the numbered framing also uses — now live once in `drsamonline/frame-kit`,
// vendored beside this file as `frame-kit.js`.

import './frame-kit.js'; // side-effect: defines globalThis.Frame
import { blockCount, splitBlocks, encodeSymbol, LTDecoder } from './fountain.js';

const Frame = globalThis.Frame;

export const crc32 = Frame.crc32;

/* ---------------------------------------------------------------------------
 * Numbered frames (magic 0xB1)
 *
 * Frame header (18 B) in front of each chunk:
 *   magic u8 (0xb1) | version u8 | transferId u16 | index u16 | count u16
 *   | totalLen u32 | chunkLen u16 | crc32 u32   -- all big-endian
 * ------------------------------------------------------------------------- */

export const FRAME_MAGIC = 0xb1;
export const FRAME_VERSION = 1;
export const FRAME_HEADER = 18;

export const chunkSize = (spec) => spec.payloadCapacity - FRAME_HEADER;

/** Number of frames a container of `length` bytes needs at this density. */
export const frameCount = (length, spec) => Math.max(1, Math.ceil(length / chunkSize(spec)));

/**
 * Split a File DNA container into frame payloads.
 * @returns {{transferId:number, total:number, checksum:number, frames:Uint8Array[]}}
 */
export function splitIntoFrames(container, spec, transferId = (Math.random() * 0x10000) | 0) {
  const size = chunkSize(spec);
  const count = frameCount(container.length, spec);
  if (count > 0xffff) throw new Error('transfer too large for one stream');
  const checksum = crc32(container);
  const frames = [];
  for (let i = 0; i < count; i++) {
    const chunk = container.subarray(i * size, Math.min((i + 1) * size, container.length));
    const frame = new Uint8Array(FRAME_HEADER + chunk.length);
    const view = new DataView(frame.buffer);
    frame[0] = FRAME_MAGIC;
    frame[1] = FRAME_VERSION;
    view.setUint16(2, transferId & 0xffff, false);
    view.setUint16(4, i, false);
    view.setUint16(6, count, false);
    view.setUint32(8, container.length, false);
    view.setUint16(12, chunk.length, false);
    view.setUint32(14, checksum, false);
    frame.set(chunk, FRAME_HEADER);
    frames.push(frame);
  }
  return { transferId: transferId & 0xffff, total: container.length, checksum, frames };
}

/** Parse one decoded frame payload. Trailing RS padding is ignored. */
export function parseFrame(bytes) {
  if (bytes.length < FRAME_HEADER) throw new Error('frame truncated');
  if (bytes[0] !== FRAME_MAGIC) throw new Error('not a BlinkCode frame');
  if (bytes[1] !== FRAME_VERSION) throw new Error(`unsupported frame version ${bytes[1]}`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunkLen = view.getUint16(12, false);
  if (FRAME_HEADER + chunkLen > bytes.length) throw new Error('frame chunk truncated');
  const index = view.getUint16(4, false);
  const count = view.getUint16(6, false);
  // A header the RS decoder mis-corrected must not enter a collector, where an
  // out-of-range index would leave the transfer permanently incomplete.
  if (count === 0 || index >= count) {
    throw new Error(`frame ${index} outside a transfer of ${count}`);
  }
  return {
    transferId: view.getUint16(2, false),
    index,
    count,
    total: view.getUint32(8, false),
    checksum: view.getUint32(14, false),
    chunk: bytes.slice(FRAME_HEADER, FRAME_HEADER + chunkLen),
  };
}

/** Collects frames of one transfer until the container is complete. */
export class FrameCollector {
  constructor() {
    this.reset();
  }

  reset() {
    this.transferId = null;
    this.count = 0;
    this.total = 0;
    this.checksum = 0;
    this.chunks = new Map();
  }

  get received() {
    return this.chunks.size;
  }

  get complete() {
    return this.count > 0 && this.chunks.size === this.count;
  }

  get missing() {
    const gaps = [];
    for (let i = 0; i < this.count; i++) if (!this.chunks.has(i)) gaps.push(i);
    return gaps;
  }

  /**
   * Absorb one decoded frame.
   * @returns {{fresh:boolean, restarted:boolean}} whether it added anything new
   */
  add(frame) {
    if (frame.count === 0 || frame.index >= frame.count) {
      throw new Error(`frame ${frame.index} outside a transfer of ${frame.count}`);
    }
    const restarted = this.transferId !== null && frame.transferId !== this.transferId;
    if (restarted || this.transferId === null) {
      this.reset();
      this.transferId = frame.transferId;
      this.count = frame.count;
      this.total = frame.total;
      this.checksum = frame.checksum;
    }
    const fresh = !this.chunks.has(frame.index);
    this.chunks.set(frame.index, frame.chunk);
    return { fresh, restarted };
  }

  /** Concatenate the collected chunks and verify the checksum. */
  assemble() {
    if (!this.complete) throw new Error('transfer incomplete');
    const out = new Uint8Array(this.total);
    let offset = 0;
    for (let i = 0; i < this.count; i++) {
      const chunk = this.chunks.get(i);
      out.set(chunk.subarray(0, Math.min(chunk.length, this.total - offset)), offset);
      offset += chunk.length;
    }
    if (crc32(out) !== this.checksum) throw new Error('checksum mismatch — rescan the code');
    return out;
  }
}

/* ---------------------------------------------------------------------------
 * Rateless (fountain) frames (magic 0xB2)
 *
 * The sender emits an endless stream and the receiver finishes from any
 * k + overhead symbols, so a missed frame costs one more symbol, not a loop.
 *
 *   magic 0xB2 | version | transferId u16 | k u16 | blockSize u16
 *   | totalLen u32 | crc32 u32 | symbolId u32 | headerCRC u16   (22 bytes)
 *   + symbol
 *
 * The header, its validation and the collector come from `frame-kit`.
 * ------------------------------------------------------------------------- */

export const FOUNTAIN_MAGIC = 0xb2;
export const FOUNTAIN_VERSION = Frame.VERSION;
export const FOUNTAIN_HEADER = Frame.HEADER_SIZE;

// A frame is untrusted input: bound what a header may claim, so a corrupt or
// crafted frame cannot make the receiver allocate a huge decoder.
export const MAX_CONTAINER = Frame.MAX_CONTAINER;

/** Symbol bytes that fit one SpectraCode frame at this density. */
export const symbolBytes = (spec) => spec.payloadCapacity - FOUNTAIN_HEADER;

/** Pack one fountain symbol into a frame. */
export function packFountainFrame({ transferId, k, blockSize, totalLen, totalLength, checksum, payloadCRC, symbolId, data }) {
  return Frame.pack({
    magic: FOUNTAIN_MAGIC,
    transferId,
    k,
    blockSize,
    totalLength: totalLen != null ? totalLen : totalLength,
    payloadCRC: checksum != null ? checksum : payloadCRC,
    symbolId,
    data,
  });
}

/** Parse a decoded QR payload back into a fountain frame. */
export function parseFountainFrame(bytes) {
  const f = Frame.parse(bytes, { magics: [FOUNTAIN_MAGIC], label: 'fountain' });
  return {
    transferId: f.transferId,
    k: f.k,
    blockSize: f.blockSize,
    totalLength: f.totalLength,
    totalLen: f.totalLength,
    payloadCRC: f.payloadCRC,
    checksum: f.payloadCRC,
    symbolId: f.symbolId,
    data: f.data,
  };
}

/**
 * Rateless collector: absorbs fountain symbols from any SpectraCode frame until
 * the container is rebuilt, then verifies CRC-32. The logic now lives in
 * `frame-kit`; this binds it to the repo's LT decoder.
 */
export class FountainCollector extends Frame.FountainCollector {
  constructor() {
    super(LTDecoder);
  }
}

/** Fountain stream parameters for a container at a given density. */
export function fountainStream(container, spec, transferId = (Math.random() * 0x10000) | 0) {
  const blockSize = symbolBytes(spec);
  return {
    transferId: transferId & 0xffff,
    k: blockCount(container.length, blockSize),
    blockSize,
    totalLen: container.length,
    checksum: crc32(container),
  };
}

export { splitBlocks, encodeSymbol };
