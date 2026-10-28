/* optical-kit — the shared optical-transfer core for drsamonline apps.
 *
 * One file, no build step, no dependencies. It provides the *transport* layer
 * that the transfer apps (helioprism, blinkcode-ai, BLINKTRANSFER) share:
 *
 *   - a systematic LT fountain code, so the receiver needs ANY ~k frames
 *     (a dropped frame costs time, never correctness — there is no back-channel);
 *   - self-describing frames (session, seq, k, block size, length, CRC);
 *   - a sender and a receiver with progress;
 *   - a pluggable codec: the app supplies the QR / colour-matrix renderer.
 *
 * PolyForm Noncommercial 1.0.0. (c) 2026 Dr Sohil Momin.
 */
(function (root) {
  "use strict";
  var Optical = { version: "0.1.0" };

  /* ---------- bytes ---------- */
  var enc = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;
  var dec = typeof TextDecoder !== "undefined" ? new TextDecoder() : null;

  Optical.bytes = {
    fromText: function (s) {
      if (enc) return enc.encode(s);
      var u = unescape(encodeURIComponent(s)), a = new Uint8Array(u.length);
      for (var i = 0; i < u.length; i++) a[i] = u.charCodeAt(i);
      return a;
    },
    toText: function (b) {
      if (dec) return dec.decode(b);
      var s = "";
      for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
      return decodeURIComponent(escape(s));
    },
    toBase64: function (b) {
      var s = "";
      for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
      return (typeof btoa !== "undefined" ? btoa(s) : Buffer.from(b).toString("base64"));
    },
    fromBase64: function (s) {
      if (typeof atob !== "undefined") {
        var bin = atob(s), a = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
        return a;
      }
      return new Uint8Array(Buffer.from(s, "base64"));
    }
  };

  /* ---------- crc32 (frame integrity) ---------- */
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256), c, n, k;
    for (n = 0; n < 256; n++) {
      c = n;
      for (k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  Optical.crc32 = crc32;

  /* ---------- deterministic PRNG (mulberry32) ---------- */
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function seed(session, seq) { return ((session * 2654435761) ^ (seq * 40503)) >>> 0; }

  /* ---------- robust soliton degree distribution ---------- */
  var cdfCache = {};
  function solitonCDF(k) {
    if (cdfCache[k]) return cdfCache[k];
    var c = 0.1, delta = 0.05;                 // robust-soliton tuning
    var R = c * Math.log(k / delta) * Math.sqrt(k);
    if (R < 0.01) R = 0.01;
    var kR = Math.floor(k / R); if (kR < 1) kR = 1; if (kR > k) kR = k;
    var rho = new Array(k + 1), tau = new Array(k + 1), Z = 0, i;
    for (i = 1; i <= k; i++) { rho[i] = (i === 1) ? 1 / k : 1 / (i * (i - 1)); tau[i] = 0; }
    for (i = 1; i < kR; i++) tau[i] = R / (i * k);
    tau[kR] += (R * Math.log(R / delta)) / k;   // the spike
    var cdf = new Array(k + 1), acc = 0;
    for (i = 1; i <= k; i++) { Z += rho[i] + tau[i]; }
    for (i = 1; i <= k; i++) { acc += (rho[i] + tau[i]) / Z; cdf[i] = acc; }
    cdf[k] = 1; // guard
    cdfCache[k] = cdf;
    return cdf;
  }
  function sampleDegree(rand, cdf) {
    var r = rand(), lo = 1, hi = cdf.length - 1;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (cdf[mid] < r) lo = mid + 1; else hi = mid; }
    return lo;
  }

  /* ---------- frame indices for a symbol ---------- */
  function symbolIndices(session, seq, k) {
    if (seq < k) return [seq];                    // systematic prefix: block seq itself
    var rand = mulberry32(seed(session, seq));
    var d = sampleDegree(rand, solitonCDF(k));
    var set = [], guard = 0;
    while (set.length < d && guard < 10000) {
      var idx = Math.floor(rand() * k);
      if (set.indexOf(idx) === -1) set.push(idx);
      guard++;
    }
    if (!set.length) set = [0];
    return set;
  }
  function xorInto(target, src) { for (var i = 0; i < target.length; i++) target[i] ^= src[i]; }

  /* ---------- fountain ---------- */
  Optical.Fountain = {
    encode: function (data, opts) {
      opts = opts || {};
      var blockSize = opts.blockSize || 1400;
      var blocks = [], n = data.length, i;
      for (i = 0; i < n; i += blockSize) {
        var b = new Uint8Array(blockSize);
        b.set(data.subarray(i, Math.min(i + blockSize, n)));
        blocks.push(b);
      }
      if (!blocks.length) blocks.push(new Uint8Array(blockSize));
      return {
        k: blocks.length, blockSize: blockSize, blocks: blocks,
        session: opts.session || (1 + Math.floor(Math.random() * 65535)),
        totalLen: n
      };
    },
    symbol: function (e, seq) {
      var idx = symbolIndices(e.session, seq, e.k);
      var out = new Uint8Array(e.blockSize);
      for (var i = 0; i < idx.length; i++) xorInto(out, e.blocks[idx[i]]);
      return out;
    }
  };

  /* ---------- decoder (peeling) ---------- */
  Optical.Decoder = function (k, blockSize, session) {
    var solved = new Array(k), pending = [], seen = {};
    for (var s = 0; s < k; s++) solved[s] = null;

    function peel() {
      var progress = true;
      while (progress) {
        progress = false;
        for (var i = pending.length - 1; i >= 0; i--) {
          var p = pending[i], unknown = [], j;
          for (j = 0; j < p.indices.length; j++) if (!solved[p.indices[j]]) unknown.push(p.indices[j]);
          if (unknown.length === 0) { pending.splice(i, 1); continue; }
          if (unknown.length === 1) {
            var idx = unknown[0];
            solved[idx] = p.data.slice();
            pending.splice(i, 1);
            for (var q = 0; q < pending.length; q++) {
              var pos = pending[q].indices.indexOf(idx);
              if (pos !== -1) {
                xorInto(pending[q].data, solved[idx]);
                pending[q].indices.splice(pos, 1);
              }
            }
            progress = true;
          }
        }
      }
    }
    return {
      add: function (seq, payload) {
        if (seen[seq]) return this.progress();
        seen[seq] = 1;
        var idx = symbolIndices(session, seq, k), data = payload.slice(), i;
        // Reduce against blocks already solved, so the frame holds only the
        // XOR of its still-unknown blocks (keeps the peeling invariant true).
        for (i = 0; i < idx.length; i++) if (solved[idx[i]]) xorInto(data, solved[idx[i]]);
        var unknown = idx.filter(function (x) { return !solved[x]; });
        if (!unknown.length) return this.progress(); // fully redundant frame
        pending.push({ indices: unknown, data: data });
        peel();
        return this.progress();
      },
      progress: function () { var c = 0; for (var i = 0; i < k; i++) if (solved[i]) c++; return c / k; },
      result: function (len) {
        for (var i = 0; i < k; i++) if (!solved[i]) return null;
        var out = new Uint8Array(k * blockSize);
        for (var j = 0; j < k; j++) out.set(solved[j], j * blockSize);
        return len ? out.subarray(0, len) : out;
      }
    };
  };

  /* ---------- self-describing frames ---------- */
  var HEADER = 17; // magic(1) session(2) seq(2) k(2) blockSize(2) totalLen(4) crc(4)
  Optical.Frame = {
    HEADER: HEADER,
    pack: function (h, payload) {
      var buf = new Uint8Array(HEADER + payload.length);
      var dv = new DataView(buf.buffer);
      buf[0] = 0x4F; // 'O'
      dv.setUint16(1, h.session); dv.setUint16(3, h.seq); dv.setUint16(5, h.k);
      dv.setUint16(7, h.blockSize); dv.setUint32(9, h.totalLen); dv.setUint32(13, crc32(payload));
      buf.set(payload, HEADER);
      return buf;
    },
    unpack: function (buf) {
      if (!buf || buf.length < HEADER || buf[0] !== 0x4F) return null;
      var dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      var h = { session: dv.getUint16(1), seq: dv.getUint16(3), k: dv.getUint16(5),
                blockSize: dv.getUint16(7), totalLen: dv.getUint32(9), crc: dv.getUint32(13) };
      var payload = buf.slice(HEADER);
      if (crc32(payload) !== h.crc) return null;
      return { header: h, payload: payload };
    }
  };

  /* ---------- sender / receiver ---------- */
  Optical.Sender = function (data, opts) {
    var e = Optical.Fountain.encode(data, opts), seq = 0;
    return {
      k: e.k, session: e.session, blockSize: e.blockSize, totalLen: e.totalLen,
      next: function () {
        var payload = Optical.Fountain.symbol(e, seq);
        var frame = Optical.Frame.pack({ session: e.session, seq: seq, k: e.k, blockSize: e.blockSize, totalLen: e.totalLen }, payload);
        seq++;
        return frame;
      }
    };
  };
  Optical.Receiver = function (session, k, blockSize, totalLen) {
    var dec = Optical.Decoder(k, blockSize, session);
    return {
      add: function (buf) {
        var f = Optical.Frame.unpack(buf);
        if (!f || f.header.session !== session) return null;
        return dec.add(f.header.seq, f.payload);
      },
      progress: function () { return dec.progress(); },
      result: function () { return dec.result(totalLen); }
    };
  };

  root.Optical = Optical;
})(typeof globalThis !== "undefined" ? globalThis : this);
