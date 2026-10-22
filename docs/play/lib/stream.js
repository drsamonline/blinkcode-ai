// Multi-frame transfers.
//
// One SpectraCode holds a few kilobytes, which is fine for a note or a key but
// not for a real file. A transfer is therefore a sequence of frames that the
// sender loops on screen; the receiver keeps scanning until it has collected
// every index, in any order, with duplicates ignored.
//
// Frame header (18 B) in front of each chunk:
//   magic u8 (0xb1) | version u8 | transferId u16 | index u16 | count u16
//   | totalLen u32 | chunkLen u16 | crc32 u32   -- all big-endian

export const FRAME_MAGIC = 0xb1;
export const FRAME_VERSION = 1;
export const FRAME_HEADER = 18;

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let b = 0; b < 8; b++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

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

// ---------------------------------------------------------------------------
// Rateless (fountain) framing
//
// The numbered frames above need every index. These carry fountain symbols
// instead: the sender emits an endless stream and the receiver finishes from any
// k + overhead symbols, so a missed frame costs one more symbol, not a loop.
//
//   magic 0xB2 | version | transferId u16 | k u16 | blockSize u16
//   | totalLen u32 | crc32 u32 | symbolId u32      (20 bytes)  + symbol

import { blockCount, splitBlocks, encodeSymbol, LTDecoder } from './fountain.js';

export const FOUNTAIN_MAGIC = 0xb2;
export const FOUNTAIN_VERSION = 1;
export const FOUNTAIN_HEADER = 20;

// A frame is untrusted input: bound what a header may claim, so a corrupt or
// crafted frame cannot make the receiver allocate a huge decoder.
export const MAX_CONTAINER = 64 * 1024 * 1024;

/** Symbol bytes that fit one SpectraCode frame at this density. */
export const symbolBytes = (spec) => spec.payloadCapacity - FOUNTAIN_HEADER;

/** Pack one fountain symbol into a frame. */
export function packFountainFrame({ transferId, k, blockSize, totalLen, checksum, symbolId, data }) {
  const out = new Uint8Array(FOUNTAIN_HEADER + data.length);
  const view = new DataView(out.buffer);
  out[0] = FOUNTAIN_MAGIC;
  out[1] = FOUNTAIN_VERSION;
  view.setUint16(2, transferId & 0xffff, false);
  view.setUint16(4, k, false);
  view.setUint16(6, blockSize, false);
  view.setUint32(8, totalLen, false);
  view.setUint32(12, checksum, false);
  view.setUint32(16, symbolId, false);
  out.set(data, FOUNTAIN_HEADER);
  return out;
}

/** Parse a decoded QR payload back into a fountain frame. */
export function parseFountainFrame(bytes) {
  if (bytes.length < FOUNTAIN_HEADER) throw new Error('frame truncated');
  if (bytes[0] !== FOUNTAIN_MAGIC) throw new Error('not a fountain frame');
  if (bytes[1] !== FOUNTAIN_VERSION) throw new Error(`unsupported frame version ${bytes[1]}`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const k = view.getUint16(4, false);
  const blockSize = view.getUint16(6, false);
  if (k === 0 || blockSize === 0) throw new Error('frame has an empty grid');
  // The payload must actually carry `blockSize` bytes, and k blocks must be able
  // to hold the container — otherwise a crafted frame could request a huge
  // allocation in the fountain decoder.
  if (bytes.length < FOUNTAIN_HEADER + blockSize) throw new Error('frame payload truncated');
  const totalLen = view.getUint32(8, false);
  if (totalLen > k * blockSize) throw new Error('frame sizes are inconsistent');
  if (totalLen > MAX_CONTAINER) throw new Error('frame declares an oversized transfer');
  return {
    transferId: view.getUint16(2, false),
    k,
    blockSize,
    totalLen,
    checksum: view.getUint32(12, false),
    symbolId: view.getUint32(16, false),
    data: bytes.slice(FOUNTAIN_HEADER, FOUNTAIN_HEADER + blockSize),
  };
}

/**
 * Rateless collector: absorbs fountain symbols from any SpectraCode frame until
 * the container is rebuilt, then verifies CRC-32.
 */
export class FountainCollector {
  constructor() {
    this.reset();
  }

  reset() {
    this.transferId = null;
    this.decoder = null;
    this.checksum = 0;
    this.symbols = 0;
  }

  get count() {
    return this.decoder ? this.decoder.k : 0;
  }

  get received() {
    return this.decoder ? this.decoder.resolved : 0;
  }

  get complete() {
    return this.decoder ? this.decoder.complete : false;
  }

  get progress() {
    return this.decoder ? this.decoder.progress : 0;
  }

  /** Absorb one decoded frame. */
  add(frame) {
    if (
      !this.decoder ||
      this.transferId !== frame.transferId ||
      this.decoder.k !== frame.k ||
      this.decoder.blockSize !== frame.blockSize ||
      this.decoder.length !== frame.totalLen
    ) {
      this.transferId = frame.transferId;
      this.decoder = new LTDecoder(frame.k, frame.blockSize, frame.totalLen);
      this.checksum = frame.checksum;
      this.symbols = 0;
      this.decoder.addSymbol(frame.symbolId, frame.data);
      this.symbols++;
      return { fresh: true, restarted: true };
    }
    const fresh = this.decoder.addSymbol(frame.symbolId, frame.data);
    if (fresh) this.symbols++;
    return { fresh, restarted: false };
  }

  /** Rebuild the container and verify its checksum. */
  assemble() {
    if (!this.complete) throw new Error('transfer incomplete');
    const out = this.decoder.payload();
    if (crc32(out) !== this.checksum) throw new Error('checksum mismatch — rescan the code');
    return out;
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
