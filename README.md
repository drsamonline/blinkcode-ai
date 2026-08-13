# BlinkCode AI

Single-shot optical file transfer as an offline-first PWA. A file is compressed
into a compact "File DNA" container, painted as **one static SpectraCode colour
matrix**, and recovered from a single camera frame — no animated QR stream, no
server, no network after the first launch.

```
file ─▶ order-1 arithmetic coder ─▶ File DNA ─▶ RS(255,223) ─▶ 120×80 colour grid
                                                                     │
                       file ◀─ arithmetic decoder ◀─ RS ◀─ cell classification
                                                          ▲
                       camera frame ─▶ bullseye detection ─▶ homography ─▶ colour correction
```

## Run it

```bash
npm run build:model   # (re)train and package the downloadable model bundle
npm run serve         # http://localhost:8080
npm test              # codec + full optical loopback tests
```

Open the app, pick a file, hit **Compress**, then **Show SpectraCode** on the
sender and **Capture & decode** on the receiver. Without a second device, the
**loopback self-test** button pushes the rendered code back through the real
optical decoder.

## What is actually implemented

| Piece | Status |
| --- | --- |
| One-time model download, Cache Storage + IndexedDB, fully offline afterwards | real |
| Order-1 context model + arithmetic coder (lossless, any file type) | real |
| Perceptual image mode: 64-value latent, 8-bit quantised | real (linear DCT autoencoder, see below) |
| SpectraCode render: 36-colour palette, bullseye markers, calibration strip | real |
| Reed-Solomon RS(255,223), corrects 16 bytes per block | real |
| Marker detection → homography → 3×4 colour correction → cell classification | real |
| Workers for model loading, compression, decompression and optical decode | real |
| Installable PWA with precached shell | real |

## Honest limits

These matter more than the pitch, so they are stated plainly in the app's
"How it works" tab too:

- **One SpectraCode holds 5,129 payload bytes.** 120×80 cells × 5 bits = 6,000
  bytes raw, minus Reed-Solomon parity. Files whose compressed form exceeds
  that are rejected up front rather than silently truncated.
- **1000:1 lossless compression of arbitrary files is impossible.** Lossless
  coding cannot go below the entropy of the data; a universal 1000:1 compressor
  would let you recurse to one byte. Real measured ratios here: ~2–4× on text,
  JSON and source code, ~1× (slight expansion) on already-compressed data such
  as JPEG, ZIP or MP4.
- **Extreme ratios only exist in perceptual mode**, which is genuinely lossy:
  an image becomes a 64-value latent and comes back as a soft, 32×32-detail
  reconstruction. That is a 1000:1+ ratio and a very different picture.
- **The "neural" model is a mock with a real interface.** The bundle format,
  one-time download, offline caching and the coder's model API are production
  shaped; the weights inside are trained order-1 byte statistics plus DCT
  quantiser scales (~129 KB), not a 50 MB neural net. `Order1Model` in
  `src/lib/arith.js` and the transforms in `src/lib/image-codec.js` are the two
  swap points for a real learned predictor / autoencoder — nothing else changes.
  TensorFlow.js is intentionally not bundled: no runtime CDN dependency is
  allowed, and shipping a placeholder network would add megabytes without
  improving compression.
- **Camera decoding is validated in simulation**, not against physical phone
  optics: the test suite renders a code, applies perspective tilt, a colour cast
  and vignetting, and decodes it end to end. Real-world glare, motion blur and
  low-end camera sensors will need per-cell voting and a smaller grid.

## Layout

```
src/
  index.html app.js styles.css sw.js manifest.webmanifest
  lib/
    arith.js          arithmetic coder + order-1 model (swap point for a neural predictor)
    codec.js          File DNA encode/decode orchestration
    format.js         container header
    image-codec.js    perceptual latent encoder/decoder
    geometry.js       linear solver, homography, colour-correction fit
    palette.js        the 36 reference colours
    rs.js             Reed-Solomon GF(256)
    spectracode.js    layout, symbol packing, renderer
    spectra-decode.js marker detection → payload bytes
    storage.js        one-time model download + offline persistence
    surface.js        canvas / buffer drawing targets
  workers/            model loader, compression, decompression, optical decode
  models/ucg-v1.bin   downloadable model bundle
tools/                build-model.js, serve.js
tests/                codec + end-to-end optical loopback
```
