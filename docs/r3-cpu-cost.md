# R3.3 CPU Cost Record (BGE-M3 INT8, onnxruntime-node CPU, Windows dev machine)

> Freeze: BAAI/bge-m3 INT8 `C:\tmp\bge-poc\bge-m3-int8.onnx` (1.06 MB stub + 568 MB .data, total 541 MB on disk after quant). FP32→INT8 delta 0 pp on retrieval-eval Top-3 (see `C:\tmp\bge-poc\quant-eval.json`). NPU not used per freeze. Qwen3/E5 removed.

## Load / Latency (measured 2026-08-21, bench-int8.mjs, CPU EP only)

| Path | Load | L=32 | L=128 | L=512 |
|------|------|------|-------|-------|
| INT8 `bge-m3-int8.onnx` | 711 ms, rss delta 327 MB (rss 370 MB) | 17.7 ms | 44.5 ms | 580.7 ms |
| FP32 (hf cache) | 2515 ms, rss delta 1161 MB | 283.5 ms | 511.1 ms | 1307.2 ms |

- Inputs: `input_ids:int64[1,L]`, `attention_mask:int64[1,L]`; Outputs: `token_embeddings` + `sentence_embedding[1,1024]` (used, L2-normalized).
- Query path uses `sentence_embedding` only, truncated to 512 tokens (chunk 800 chars fits). Steady-state query latency P50 ≈ 18–45 ms (≤512 tokens).
- First embedding latency ≈ load + 1× L=32 (≈ 729 ms cold; warm ≈ 18 ms).

## Memory / Disk

- Disk: 568 MB (.data) + 1 MB (stub) = 541 MB effective (quant int8).
- RAM: +327 MB on session create; steady +0 per query (session reused, lazy singleton).
- Index size: `library_chunk_embeddings` = chunks × (4 KB embedding BLOB + overhead). For N chunks: ~4 KB × N (1024 × float32). 1k chunks ≈ 4 MB.

## vs R2 lexical

| Aspect | R2 lexical (FTS5 trigram) | R3 semantic (INT8) |
|--------|---------------------------|---------------------|
| CPU per query | <1 ms (MATCH + bm25) | 18–45 ms (+ FTS when fallback) |
| RAM | ~0 (DB only) | +327 MB when loaded (lazy; lexical-only queries do not load) |
| Disk | FTS index only | +4 KB/chunk |
| Recall on semantic subset | R2 Top3 ~low (Gate 27: semantic 0%, cross 33.3%) | INT8 Top3 95.8% overall (eval_quant) |
| Scope | lexical FTS | semantic is fallback only (Router), lexical-only circuits protect exact/filename/id |

Operational note: lexical-first ensures R3 does not increase P50 for exact/filename queries (semantic not loaded). Semantic session is lazy and only instantiated on first `shouldFallback=true` query. Fusion precedence: `exact title/filename > strong lexical > semantic > weak lexical`.
