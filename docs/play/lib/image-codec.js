// Perceptual image mode: a tiny linear autoencoder.
//
// The encoder is a fixed orthonormal analysis transform (2-D DCT on a 32x32
// luma plane plus 8x8 chroma planes) followed by an 8-bit quantiser, producing
// a 64-value latent. The decoder is the matching synthesis transform. This is
// the same shape as a learned conv autoencoder — analysis -> latent -> synthesis
// — so swapping in trained weights only means replacing the two transforms and
// keeping `LATENT_SIZE`.

export const LATENT_SIZE = 64;
const LUMA_N = 32;
const CHROMA_N = 8;
const LUMA_COEFFS = 40;
const CHROMA_COEFFS = 12;

const cosTables = new Map();
function cosTable(n) {
  if (!cosTables.has(n)) {
    const t = new Float64Array(n * n);
    for (let k = 0; k < n; k++) {
      for (let x = 0; x < n; x++) {
        t[k * n + x] =
          Math.cos(((2 * x + 1) * k * Math.PI) / (2 * n)) *
          (k === 0 ? Math.sqrt(1 / n) : Math.sqrt(2 / n));
      }
    }
    cosTables.set(n, t);
  }
  return cosTables.get(n);
}

function dct2(plane, n) {
  const t = cosTable(n);
  const tmp = new Float64Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let k = 0; k < n; k++) {
      let s = 0;
      for (let x = 0; x < n; x++) s += plane[y * n + x] * t[k * n + x];
      tmp[y * n + k] = s;
    }
  }
  const out = new Float64Array(n * n);
  for (let k = 0; k < n; k++) {
    for (let j = 0; j < n; j++) {
      let s = 0;
      for (let y = 0; y < n; y++) s += tmp[y * n + k] * t[j * n + y];
      out[j * n + k] = s;
    }
  }
  return out;
}

function idct2(coeffs, n) {
  const t = cosTable(n);
  const tmp = new Float64Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let x = 0; x < n; x++) {
      let s = 0;
      for (let k = 0; k < n; k++) s += coeffs[j * n + k] * t[k * n + x];
      tmp[j * n + x] = s;
    }
  }
  const out = new Float64Array(n * n);
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) {
      let s = 0;
      for (let j = 0; j < n; j++) s += tmp[j * n + x] * t[j * n + y];
      out[y * n + x] = s;
    }
  }
  return out;
}

/** Zig-zag order for an n×n coefficient block. */
function zigzag(n) {
  const order = [];
  for (let s = 0; s < 2 * n - 1; s++) {
    for (let y = 0; y <= s; y++) {
      const x = s - y;
      if (x < n && y < n) order.push(y * n + x);
    }
  }
  return order;
}

function boxResize(image, n) {
  const { data, width, height } = image;
  const out = new Float64Array(n * n * 3);
  for (let ty = 0; ty < n; ty++) {
    const y0 = Math.floor((ty * height) / n);
    const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * height) / n));
    for (let tx = 0; tx < n; tx++) {
      const x0 = Math.floor((tx * width) / n);
      const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * width) / n));
      let r = 0;
      let g = 0;
      let b = 0;
      let count = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * width + x) * 4;
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          count++;
        }
      }
      const o = (ty * n + tx) * 3;
      out[o] = r / count;
      out[o + 1] = g / count;
      out[o + 2] = b / count;
    }
  }
  return out;
}

function downsamplePlane(plane, from, to) {
  const out = new Float64Array(to * to);
  const factor = from / to;
  for (let y = 0; y < to; y++) {
    for (let x = 0; x < to; x++) {
      let s = 0;
      let n = 0;
      for (let sy = Math.floor(y * factor); sy < Math.floor((y + 1) * factor); sy++) {
        for (let sx = Math.floor(x * factor); sx < Math.floor((x + 1) * factor); sx++) {
          s += plane[sy * from + sx];
          n++;
        }
      }
      out[y * to + x] = n ? s / n : 0;
    }
  }
  return out;
}

function upsamplePlane(plane, from, to) {
  const out = new Float64Array(to * to);
  for (let y = 0; y < to; y++) {
    const sy = Math.min(from - 1, (y * from) / to);
    const y0 = Math.floor(sy);
    const y1 = Math.min(from - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < to; x++) {
      const sx = Math.min(from - 1, (x * from) / to);
      const x0 = Math.floor(sx);
      const x1 = Math.min(from - 1, x0 + 1);
      const fx = sx - x0;
      const top = plane[y0 * from + x0] * (1 - fx) + plane[y0 * from + x1] * fx;
      const bottom = plane[y1 * from + x0] * (1 - fx) + plane[y1 * from + x1] * fx;
      out[y * to + x] = top * (1 - fy) + bottom * fy;
    }
  }
  return out;
}

/** Default quantiser scales; the model bundle can override them. */
export function defaultLatentScales() {
  const scales = new Float32Array(LATENT_SIZE);
  for (let i = 0; i < LUMA_COEFFS; i++) scales[i] = i === 0 ? 8 : 4 + i * 0.6;
  for (let i = LUMA_COEFFS; i < LATENT_SIZE; i++) {
    const k = (i - LUMA_COEFFS) % CHROMA_COEFFS;
    scales[i] = k === 0 ? 4 : 3 + k * 0.5;
  }
  return scales;
}

const LUMA_ORDER = zigzag(LUMA_N).slice(0, LUMA_COEFFS);
const CHROMA_ORDER = zigzag(CHROMA_N).slice(0, CHROMA_COEFFS);

/**
 * Encode an image to `4 + LATENT_SIZE` bytes (dimensions + quantised latent).
 */
export function encodeImageLatent(image, scales = defaultLatentScales()) {
  const rgb = boxResize(image, LUMA_N);
  const y = new Float64Array(LUMA_N * LUMA_N);
  const cb = new Float64Array(LUMA_N * LUMA_N);
  const cr = new Float64Array(LUMA_N * LUMA_N);
  for (let i = 0; i < LUMA_N * LUMA_N; i++) {
    const r = rgb[i * 3];
    const g = rgb[i * 3 + 1];
    const b = rgb[i * 3 + 2];
    y[i] = 0.299 * r + 0.587 * g + 0.114 * b - 128;
    cb[i] = -0.168736 * r - 0.331264 * g + 0.5 * b;
    cr[i] = 0.5 * r - 0.418688 * g - 0.081312 * b;
  }

  const latent = new Int8Array(LATENT_SIZE);
  const yc = dct2(y, LUMA_N);
  LUMA_ORDER.forEach((idx, i) => {
    latent[i] = Math.max(-127, Math.min(127, Math.round(yc[idx] / scales[i])));
  });
  [cb, cr].forEach((plane, p) => {
    const small = downsamplePlane(plane, LUMA_N, CHROMA_N);
    const c = dct2(small, CHROMA_N);
    CHROMA_ORDER.forEach((idx, i) => {
      const slot = LUMA_COEFFS + p * CHROMA_COEFFS + i;
      latent[slot] = Math.max(-127, Math.min(127, Math.round(c[idx] / scales[slot])));
    });
  });

  const out = new Uint8Array(4 + LATENT_SIZE);
  new DataView(out.buffer).setUint16(0, Math.min(65535, image.width), false);
  new DataView(out.buffer).setUint16(2, Math.min(65535, image.height), false);
  out.set(new Uint8Array(latent.buffer), 4);
  return out;
}

/**
 * Reconstruct an ImageData-like object from a latent produced above.
 */
export function decodeImageLatent(bytes, scales = defaultLatentScales()) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = Math.max(1, view.getUint16(0, false));
  const height = Math.max(1, view.getUint16(2, false));
  const latent = new Int8Array(bytes.buffer, bytes.byteOffset + 4, LATENT_SIZE);

  const yc = new Float64Array(LUMA_N * LUMA_N);
  LUMA_ORDER.forEach((idx, i) => {
    yc[idx] = latent[i] * scales[i];
  });
  const y = idct2(yc, LUMA_N);

  const chroma = [0, 1].map((p) => {
    const c = new Float64Array(CHROMA_N * CHROMA_N);
    CHROMA_ORDER.forEach((idx, i) => {
      c[idx] = latent[LUMA_COEFFS + p * CHROMA_COEFFS + i] * scales[LUMA_COEFFS + p * CHROMA_COEFFS + i];
    });
    return upsamplePlane(idct2(c, CHROMA_N), CHROMA_N, LUMA_N);
  });

  const small = new Uint8ClampedArray(LUMA_N * LUMA_N * 4);
  for (let i = 0; i < LUMA_N * LUMA_N; i++) {
    const luma = y[i] + 128;
    const cb = chroma[0][i];
    const cr = chroma[1][i];
    small[i * 4] = luma + 1.402 * cr;
    small[i * 4 + 1] = luma - 0.344136 * cb - 0.714136 * cr;
    small[i * 4 + 2] = luma + 1.772 * cb;
    small[i * 4 + 3] = 255;
  }

  // Bilinear upscale back to the original dimensions.
  const out = new Uint8ClampedArray(width * height * 4);
  for (let ch = 0; ch < 3; ch++) {
    const plane = new Float64Array(LUMA_N * LUMA_N);
    for (let i = 0; i < plane.length; i++) plane[i] = small[i * 4 + ch];
    const scaledW = new Float64Array(width * height);
    for (let ty = 0; ty < height; ty++) {
      const sy = Math.min(LUMA_N - 1, (ty * LUMA_N) / height);
      const y0 = Math.floor(sy);
      const y1 = Math.min(LUMA_N - 1, y0 + 1);
      const fy = sy - y0;
      for (let tx = 0; tx < width; tx++) {
        const sx = Math.min(LUMA_N - 1, (tx * LUMA_N) / width);
        const x0 = Math.floor(sx);
        const x1 = Math.min(LUMA_N - 1, x0 + 1);
        const fx = sx - x0;
        const top = plane[y0 * LUMA_N + x0] * (1 - fx) + plane[y0 * LUMA_N + x1] * fx;
        const bot = plane[y1 * LUMA_N + x0] * (1 - fx) + plane[y1 * LUMA_N + x1] * fx;
        scaledW[ty * width + tx] = top * (1 - fy) + bot * fy;
      }
    }
    for (let i = 0; i < width * height; i++) out[i * 4 + ch] = scaledW[i];
  }
  for (let i = 0; i < width * height; i++) out[i * 4 + 3] = 255;
  return { data: out, width, height };
}
