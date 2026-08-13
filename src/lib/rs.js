// Reed-Solomon RS(255,223) over GF(256) with the QR-style primitive 0x11d.
// Corrects up to 16 damaged bytes per block, which is what lets a SpectraCode
// survive glare, shadow and a handful of mis-classified cells.
//
// Polynomials are big-endian arrays: index 0 is the highest-degree coefficient.

const PRIM = 0x11d;
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

(function initTables() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= PRIM;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);
const div = (a, b) => {
  if (b === 0) throw new Error('GF divide by zero');
  return a === 0 ? 0 : EXP[(LOG[a] + 255 - LOG[b]) % 255];
};
const inv = (a) => EXP[255 - LOG[a]];
const pow = (a, n) => EXP[(((LOG[a] * n) % 255) + 255) % 255];

function polyAdd(p, q) {
  const r = new Array(Math.max(p.length, q.length)).fill(0);
  for (let i = 0; i < p.length; i++) r[i + r.length - p.length] ^= p[i];
  for (let i = 0; i < q.length; i++) r[i + r.length - q.length] ^= q[i];
  return r;
}

function polyMul(p, q) {
  const r = new Array(p.length + q.length - 1).fill(0);
  for (let i = 0; i < p.length; i++) {
    if (p[i] === 0) continue;
    for (let j = 0; j < q.length; j++) r[i + j] ^= mul(p[i], q[j]);
  }
  return r;
}

const polyScale = (p, x) => p.map((c) => mul(c, x));

function polyEval(p, x) {
  let y = p[0];
  for (let i = 1; i < p.length; i++) y = mul(y, x) ^ p[i];
  return y;
}

function generator(nsym) {
  let g = [1];
  for (let i = 0; i < nsym; i++) g = polyMul(g, [1, pow(2, i)]);
  return g;
}

export const NSYM = 32;
export const BLOCK_DATA = 223;
export const BLOCK_TOTAL = BLOCK_DATA + NSYM;
const GEN = generator(NSYM);

/** Append `NSYM` parity bytes to one data block. */
export function encodeBlock(data) {
  const out = new Uint8Array(data.length + NSYM);
  out.set(data);
  for (let i = 0; i < data.length; i++) {
    const coef = out[i];
    if (coef === 0) continue;
    for (let j = 1; j < GEN.length; j++) out[i + j] ^= mul(GEN[j], coef);
  }
  out.set(data);
  return out;
}

/** Syndromes with the conventional leading zero term. */
function syndromes(msg) {
  const s = [0];
  for (let i = 0; i < NSYM; i++) s.push(polyEval(msg, pow(2, i)));
  return s;
}

function errorLocator(synd) {
  let errLoc = [1];
  let oldLoc = [1];
  const shift = synd.length - NSYM;
  for (let i = 0; i < NSYM; i++) {
    const k = i + shift;
    let delta = synd[k];
    for (let j = 1; j < errLoc.length; j++) {
      delta ^= mul(errLoc[errLoc.length - 1 - j], synd[k - j]);
    }
    oldLoc = oldLoc.concat([0]);
    if (delta !== 0) {
      if (oldLoc.length > errLoc.length) {
        const newLoc = polyScale(oldLoc, delta);
        oldLoc = polyScale(errLoc, inv(delta));
        errLoc = newLoc;
      }
      errLoc = polyAdd(errLoc, polyScale(oldLoc, delta));
    }
  }
  while (errLoc.length && errLoc[0] === 0) errLoc.shift();
  return errLoc;
}

/**
 * Chien search. A root at alpha^i means the error sits at coefficient degree
 * (255 - i) mod 255, i.e. byte index n - 1 - degree.
 */
function errorPositions(errLoc, n) {
  const errs = errLoc.length - 1;
  const positions = [];
  for (let i = 0; i < 255; i++) {
    if (polyEval(errLoc, pow(2, i)) !== 0) continue;
    const degree = (255 - i) % 255;
    const pos = n - 1 - degree;
    if (pos < 0 || pos >= n) return null;
    positions.push(pos);
  }
  return positions.length === errs ? positions : null;
}

function errataLocator(coefPos) {
  let loc = [1];
  for (const p of coefPos) loc = polyMul(loc, polyAdd([1], [pow(2, p), 0]));
  return loc;
}

function errorEvaluator(syndRev, errLoc, nsym) {
  const r = polyMul(syndRev, errLoc);
  return r.slice(r.length - (nsym + 1));
}

/** Forney algorithm: compute and apply error magnitudes. */
function correctErrata(msg, synd, positions) {
  const coefPos = positions.map((p) => msg.length - 1 - p);
  const errLoc = errataLocator(coefPos);
  const errEval = errorEvaluator(
    synd.slice().reverse(),
    errLoc,
    errLoc.length - 1,
  ).reverse();

  const X = coefPos.map((p) => pow(2, -(255 - p)));
  const E = new Array(msg.length).fill(0);
  for (let i = 0; i < X.length; i++) {
    const xiInv = inv(X[i]);
    let denom = 1;
    for (let j = 0; j < X.length; j++) {
      if (j !== i) denom = mul(denom, 1 ^ mul(xiInv, X[j]));
    }
    if (denom === 0) throw new Error('Forney denominator vanished');
    const y = mul(X[i], polyEval(errEval.slice().reverse(), xiInv));
    E[positions[i]] = div(y, denom);
  }
  return Uint8Array.from(polyAdd(Array.from(msg), E));
}

/**
 * Decode one RS block.
 * @returns {{data: Uint8Array, corrected: number}}
 * @throws if the block has more damage than the code can repair.
 */
export function decodeBlock(block) {
  let msg = Uint8Array.from(block);
  const synd = syndromes(msg);
  if (synd.every((v) => v === 0)) {
    return { data: msg.slice(0, msg.length - NSYM), corrected: 0 };
  }
  const errLoc = errorLocator(synd);
  if (errLoc.length - 1 > NSYM / 2) throw new Error('too many errors');
  const positions = errorPositions(errLoc, msg.length);
  if (!positions) throw new Error('error locator failed');
  msg = correctErrata(msg, synd, positions);
  if (!syndromes(msg).every((v) => v === 0)) {
    throw new Error('block still corrupt after repair');
  }
  return { data: msg.slice(0, msg.length - NSYM), corrected: positions.length };
}

export function rsEncode(bytes) {
  const nBlocks = Math.ceil(bytes.length / BLOCK_DATA) || 1;
  const out = new Uint8Array(nBlocks * BLOCK_TOTAL);
  for (let i = 0; i < nBlocks; i++) {
    const chunk = new Uint8Array(BLOCK_DATA);
    chunk.set(bytes.subarray(i * BLOCK_DATA, (i + 1) * BLOCK_DATA));
    out.set(encodeBlock(chunk), i * BLOCK_TOTAL);
  }
  return out;
}

export function rsDecode(bytes) {
  const nBlocks = Math.floor(bytes.length / BLOCK_TOTAL);
  const out = new Uint8Array(nBlocks * BLOCK_DATA);
  let corrected = 0;
  for (let i = 0; i < nBlocks; i++) {
    const res = decodeBlock(bytes.subarray(i * BLOCK_TOTAL, (i + 1) * BLOCK_TOTAL));
    out.set(res.data, i * BLOCK_DATA);
    corrected += res.corrected;
  }
  return { data: out, corrected };
}
