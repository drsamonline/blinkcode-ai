# Changelog

All notable changes to BlinkCode AI are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Optical robustness**: median per-cell sampling (robust to edge bleed and
  glare), a luminance contrast stretch before binarisation, a contrast-based
  bullseye test instead of an absolute threshold, and a wider multi-threshold
  marker search. `tools/robustness.js` (`npm run robustness`) measures the
  margin: noise ±32, blur radius 3, gain 0.3–1.0 all decode.
- **Rateless (fountain) frame stream** (`src/lib/fountain.js`, `stream.js`): frames
  are now LT symbols with a **systematic prefix**, so the receiver rebuilds the
  container from *any* k + overhead symbols — a missed frame costs one more
  symbol instead of a whole loop. `FountainCollector` replaces `FrameCollector`
  in the app, and the sender emits new symbols on every pass.
  `tests/fountain.test.js` covers the codec and a full optical loopback.
- **Match (LZP) model** (`src/lib/predict.js`) on top of the order-1 coder:
  remembers the byte that followed the last occurrence of the current 6-byte
  context and boosts it before coding. Measured **~31% smaller overall** than
  order-1 alone, and it round-trips exactly (`tests/predict.test.js`).
- `tools/bench.js` (`npm run bench`) — coders vs gzip on a spread of corpora.
- `tools/tune.js` — sweeps the match-model parameters.
- Dual licence: PolyForm Noncommercial 1.0.0 (`LICENSE`) + commercial-by-invoice
  (`COMMERCIAL.md`) + `NOTICE`.
- Badged README, landing page (`docs/index.html`) and a `tools/build.js` that
  stages `src/` into `docs/play/` for GitHub Pages.
- Workflows: `ci.yml`, `pages.yml`, `build-apps.yml` (portable EXE + Android APK
  on the `app-latest` release).

### Changed
- The arithmetic coder's frequency counts are now `Uint32Array` so a
  match-model boost cannot overflow a count.
- Relicensed future versions under the dual model; copies already distributed
  under the previous "Personal Use License" keep that grant.
- A multi-frame test now uses incompressible data, because better compression had
  shrunk its payload below one frame.

### Fixed
- Fountain degree distribution went negative for small k — the Robust Soliton
  spike term is `R·ln(R/δ)/k`, which is negative when `R/δ < 1` — inflating
  overhead badly. It is now clamped, and a systematic prefix makes a clean pass
  need exactly k symbols.
- Fountain frame checksum key mismatch (`crc32` vs `checksum`) that zeroed the
  stored checksum and failed every reassembly.
- Match-model boost timing: the decoder reads `totals[ctx]` before `symbolFor`,
  so the boost for the next symbol is now applied at the end of `update` rather
  than lazily during the query — the two sides stay in lockstep.

## [0.1.0] - earlier

- Initial SpectraCode optical transfer PWA: order-1 arithmetic coder, Reed-Solomon
  RS(255,223), perceptual image mode, multi-frame streaming, offline model bundle.

[Unreleased]: https://github.com/drsamonline/blinkcode-ai/compare/v0.1.0...HEAD
