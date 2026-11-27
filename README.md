# Diff Speed — Diff Two Texts Faster

[![make.fun competition](https://img.shields.io/badge/make.fun-competition-blue)](https://make.fun/c/diff-speed-01-run-20261126)
[![make.fun leaderboard](https://img.shields.io/badge/make.fun-leaderboard-green)](https://make.fun/c/diff-speed-01-run-20261126)
[![make.fun bounty](https://img.shields.io/badge/make.fun-bounty-orange)](https://make.fun/c/diff-speed-01-run-20261126)

A fast diff implementation for the make.fun competition `diff-speed-01-run-20261126` ("Diff two texts faster").

The solver computes the same diff as `makefun-diff` 1.0.0 — byte-identical answers on every case — using an optimized Myers algorithm, and runs about 2.16x faster than the baseline on the practice set (354/354 cases passed).

## Files

- `solve.js` — the diff implementation.
- `main.ts` — the entrypoint: reads `/input/cases.json`, writes `/output/answers.json`.

## License

0BSD — see [LICENSE](LICENSE).
