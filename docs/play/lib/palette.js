// 36 reference colours chosen for distinguishability under phone cameras.
// The first 32 entries carry payload data (5 bits per cell); all 36 appear in
// the calibration strip so the receiver can fit a colour-correction matrix.
export const PALETTE = [
  [255, 255, 255], [0, 0, 0], [255, 0, 0], [0, 255, 0], [0, 0, 255],
  [255, 255, 0], [255, 0, 255], [0, 255, 255], [128, 0, 0], [0, 128, 0],
  [0, 0, 128], [128, 128, 0], [128, 0, 128], [0, 128, 128], [192, 192, 192],
  [128, 128, 128], [64, 0, 0], [0, 64, 0], [0, 0, 64], [64, 64, 0],
  [64, 0, 64], [0, 64, 64], [255, 128, 0], [255, 0, 128], [128, 255, 0],
  [0, 255, 128], [0, 128, 255], [128, 0, 255], [255, 128, 128], [128, 255, 128],
  [128, 128, 255], [255, 255, 128], [255, 128, 255], [128, 255, 255],
  [192, 0, 0], [0, 192, 0],
];

export const DATA_COLOURS = 32; // 5 bits per cell
export const BITS_PER_CELL = 5;

export function rgbToCss([r, g, b]) {
  return `rgb(${r},${g},${b})`;
}

export function nearestDataColour(r, g, b) {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < DATA_COLOURS; i++) {
    const p = PALETTE[i];
    const dr = r - p[0];
    const dg = g - p[1];
    const db = b - p[2];
    const d = dr * dr + dg * dg + db * db;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}
