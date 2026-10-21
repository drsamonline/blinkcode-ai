// Small linear-algebra helpers: dense solver, homography estimation and the
// least-squares colour-correction fit used by the receiver.

/** Solve A x = b for a dense n×n system (Gaussian elimination, partial pivot). */
export function solve(A, b) {
  const n = b.length;
  const m = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    }
    if (Math.abs(m[pivot][col]) < 1e-12) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    const p = m[col][col];
    for (let c = col; c <= n; c++) m[col][c] /= p;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) m[r][c] -= f * m[col][c];
    }
  }
  return m.map((row) => row[n]);
}

/**
 * Homography mapping four source points to four destination points.
 * @returns {Float64Array|null} row-major 3×3 matrix with h22 = 1
 */
export function homography(src, dst) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const h = solve(A, b);
  if (!h) return null;
  return Float64Array.from([...h, 1]);
}

export function applyHomography(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [
    (H[0] * x + H[1] * y + H[2]) / w,
    (H[3] * x + H[4] * y + H[5]) / w,
  ];
}

/**
 * Fit a 3×4 affine colour-correction matrix (RGB + bias) by least squares so
 * that measured calibration patches map onto their reference colours.
 * @param {number[][]} measured N×3
 * @param {number[][]} reference N×3
 * @returns {(rgb:number[]) => number[]}
 */
export function fitColourCorrection(measured, reference) {
  const AtA = Array.from({ length: 4 }, () => new Array(4).fill(0));
  const Atb = [0, 1, 2].map(() => new Array(4).fill(0));
  for (let i = 0; i < measured.length; i++) {
    const f = [measured[i][0], measured[i][1], measured[i][2], 1];
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) AtA[r][c] += f[r] * f[c];
      for (let ch = 0; ch < 3; ch++) Atb[ch][r] += f[r] * reference[i][ch];
    }
  }
  for (let i = 0; i < 4; i++) AtA[i][i] += 1e-6; // ridge term keeps it stable
  const rows = [0, 1, 2].map((ch) => solve(AtA.map((r) => [...r]), Atb[ch]));
  if (rows.some((r) => !r)) return (rgb) => rgb;
  return (rgb) =>
    rows.map((row) =>
      Math.max(
        0,
        Math.min(255, row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2] + row[3]),
      ),
    );
}
