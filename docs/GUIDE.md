# BlinkCode AI — user guide

**PolyForm Noncommercial 1.0.0**

Transfer a file between two screens with no network, no cable and no pairing: the sender draws a
stream of colour codes, the receiver's camera reads them.

## The honest limits, first

These matter more than the pitch, so they come first here and live in the app's own *How it works*
tab:

- **One frame holds 5,111 payload bytes** (1,097 in robust density). Throughput is roughly
  `5 KB × frame rate` — about **15 KB/s at 3 fps**. Frames are rateless, so a missed frame costs one
  extra symbol, not a whole loop.
- **1000:1 lossless compression of arbitrary files is impossible.** Lossless coding cannot go below
  the entropy of the data. Real ratios are strong on structured text and around 1× on already
  compressed data.
- **Extreme ratios exist only in perceptual mode**, which is genuinely lossy: an image becomes a
  64-value latent and returns as a soft reconstruction.
- **The "neural" model is a mock with a real interface.** The bundle format, one-time download,
  offline caching and the coder's model API are production-shaped; the weights are trained order-1
  statistics plus DCT quantiser scales (~129 KB), not a large network. `Order1Model` in
  `src/lib/arith.js`, `Order1MatchModel` in `src/lib/predict.js` and the transforms in
  `src/lib/image-codec.js` are the swap points.
- **Camera decoding is validated in simulation**, not against physical phone optics: the tests render
  a code, apply perspective tilt, a colour cast and vignetting, and decode it end to end. Real glare,
  motion blur and low-end sensors may still need per-cell voting and multi-frame averaging.

## What is in the pipeline

- **SpectraCode transport** — a 36-colour palette, 5 bits per cell, bullseye markers and a
  calibration strip, at two densities (120×80 and 60×40).
- **Compression** — an order-1 arithmetic coder with a match (LZP) model, plus a perceptual image mode.
- **Reed–Solomon RS(255,223)** — repairs up to 16 damaged bytes per block, which is what lets a frame
  survive glare, shadow and misclassified cells.
- **Optical decoding** — marker detection → homography → 3×4 colour correction → cell classification
  → RS, all in a Web Worker.
- **A rateless (fountain) stream** — an LT code with a systematic prefix, so the receiver rebuilds the
  container from any *k* plus a little overhead. CRC-32 verifies the result.
- **Offline-first** — the model bundle is downloaded once and cached; after that the app never
  touches the network.

## When to use it, and when not to

Use it when two devices can see each other and nothing else can connect them — a locked-down laptop
and a phone, an air-gapped machine. Do not use it for anything large: at ~15 KB/s, a megabyte is over
a minute of perfect line of sight.

## Licence

PolyForm Noncommercial 1.0.0. See [LICENSE](../LICENSE).
