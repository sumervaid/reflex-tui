# Embedding models

Matching by words always runs. A local embedding model adds matching by meaning; it is optional and
runs on your machine (WebAssembly, no native code, no network after the download).

| | `reflex model fetch` (default) | `reflex model fetch --light` |
| --- | --- | --- |
| Model | bge-m3, int8 | all-MiniLM-L6-v2, int8 |
| Reads | 100+ languages, and requests that mix them | English (Latin script); other text is matched by words only |
| Download | 587 MB | 23 MB |
| Memory while embedding | about 2.8 GB | about 0.6 GB |
| Time per session, 1 / 4 threads | about 2.9 s / 0.8 s | about 0.09 s / 0.03 s |

Measured on Apple silicon with real-length requests; older CPUs can be up to about 3x slower. The
`Embedding benchmark` workflow (`.github/workflows/embedding-bench.yml`; on pull requests that change embedding or matching code, by hand, and weekly)
measures load time, time per request and peak memory for both models on Linux (x64 and ARM),
Windows and macOS (Intel and Apple silicon), and checks matching quality is the same everywhere;
locally: `REFLEX_PERF=bge-m3 REFLEX_TEST_MODELS=~/.reflex/models pnpm vitest run packages/analysis/test/eval/perf.test.ts`. On
English requests MiniLM matches at least as well as bge-m3, so English-only users lose nothing with
`--light`. Embedding uses up to 4 cores (`REFLEX_EMBED_THREADS` to change). Before downloading,
`model fetch` estimates the first scan's time from your stored sessions and recommends `--light`
on machines with under 8 GB of memory or fewer than 4 cores. Each scan spends at most
`--embed-minutes` (default 5) embedding, newest sessions first, and the next scan continues; a
machine without memory for the model skips it with a warning. Vectors are cached per model, so
`reflex model use <name>` switches without re-embedding what either model already did.

