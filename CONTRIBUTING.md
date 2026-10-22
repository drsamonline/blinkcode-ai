# Contributing to BlinkCode AI

Thanks for wanting to help.

## Getting set up

```bash
git clone https://github.com/drsamonline/blinkcode-ai.git
cd blinkcode-ai
npm install
npm test          # codec, stream, predict + optical loopback
npm run lint
npm run bench     # compression benchmark
npm run serve     # http://localhost:8080
```

`npm run build` stages `src/` into `docs/play/` for GitHub Pages.

## Ways to help

- **Optical robustness** — the most valuable reports are real-camera ones: this
  phone, this lighting, this distance. Screenshots and short clips help most.
- **Compression** — if you improve the model, show the benchmark before and after
  (`npm run bench`), and keep the round-trip tests green.
- **Bug reports / PRs** — one change per PR, please.

## Ground rules

- Run `npm test` and `npm run lint` before opening a PR; both must pass.
- The transport has **zero runtime dependencies** — please keep it that way.
- Add tests for anything in `src/lib/`.
- Keep the "Honest limits" section of the README honest.

## Licence of contributions

By contributing you agree that your contributions are licensed under the same
terms as the project (see `LICENSE`).

## Code of conduct

Participation is covered by our [Code of Conduct](CODE_OF_CONDUCT.md).
