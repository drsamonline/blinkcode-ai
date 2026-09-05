# BlinkCode AI

Optical file transfer as an offline-first PWA. A file is compressed into a
compact "File DNA" container, painted as **SpectraCode colour matrices**, and
recovered by pointing a camera at the sender's screen — no server, no network
after the first launch. Small payloads fit in a single static frame; larger ones
loop as a numbered frame sequence the receiver collects while scanning.

```
file ─▶ order-1 arithmetic coder ─▶ File DNA ─▶ frames ─▶ RS(255,223) ─▶ colour grid
                                                                            │
              file ◀─ arithmetic decoder ◀─ CRC-32 ◀─ frame collector ◀─ RS ◀┘
                                                          ▲
              camera frames ─▶ bullseye detection ─▶ homography ─▶ colour correction
```

## Run it

```bash
npm run build:model   # (re)train and package the downloadable model bundle
npm run serve         # http://localhost:8080
npm test              # codec + full optical loopback tests
```

Open the app, pick a file (or paste text), hit **Compress**, then **Show
SpectraCode** on the sender and **Start scanning** on the receiver — the
receiver decodes continuously and shows how many frames it still needs. Without
a second device, the **loopback self-test** button pushes every rendered frame
back through the real optical decoder.

## What is actually implemented

| Piece | Status |
| --- | --- |
| One-time model download, Cache Storage + IndexedDB, fully offline afterwards | real |
| Order-1 context model + arithmetic coder (lossless, any file type) | real |
| Perceptual image mode: 64-value latent, 8-bit quantised | real (linear DCT autoencoder, see below) |
| SpectraCode render: 36-colour palette, bullseye markers, calibration strip | real |
| Reed-Solomon RS(255,223), corrects 16 bytes per block | real |
| Marker detection → homography → 3×4 colour correction → cell classification | real |
| Multi-frame streaming: chunk header, out-of-order collection, CRC-32 verify | real |
| Two grid densities (120×80 / 60×40) signalled by a density patch and auto-detected | real |
| Continuous camera auto-scan, wake lock while displaying, Web Share of results | real |
| Workers for model loading, compression, decompression and optical decode | real |
| Installable PWA with precached shell | real |

## Honest limits

These matter more than the pitch, so they are stated plainly in the app's
"How it works" tab too:

- **One SpectraCode frame holds 5,111 payload bytes** (1,097 in robust density):
  120×80 cells × 5 bits = 6,000 bytes raw, minus Reed-Solomon parity and the
  18-byte frame header. Bigger files are split across frames, so throughput is
  roughly `5 KB × frame rate` — about 15 KB/s at 3 frames per second, and every
  missed frame costs a full loop.
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
  low-end camera sensors are what the robust density exists for; they may still
  need per-cell voting and multi-frame averaging.

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
    stream.js         frame header, CRC-32, out-of-order frame collector
    surface.js        canvas / buffer drawing targets
  workers/            model loader, compression, decompression, optical decode
  models/ucg-v1.bin   downloadable model bundle
tools/                build-model.js, serve.js
tests/                codec + end-to-end optical loopback
```

## Licence

BlinkCode AI is source-available under the [BlinkCode AI Personal Use License](LICENSE),
not an open-source licence:

- **Personal, academic and non-profit use is free**, including modifying and
  sharing the code.
- **Attribution is required** — keep the licence file and credit Dr Sohil Momin
  ([@drsamonline](https://github.com/drsamonline)) with a link back to this
  repository wherever you credit authors.
- **Commercial or enterprise use needs written permission** from the author;
  ask via https://github.com/drsamonline for a commercial licence.
