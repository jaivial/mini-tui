# Multilingual graph RAG and depth-10 QA

- Local multilingual-e5-small quantized ONNX,384D,two CPU threads. Correct query:/passage: prefixes. No external embedding API.
- Durable versioned MiniChunk + HAS_CHUNK in neo4j-rust. Windows900chars, overlap150. Bounds title240/description1800/task1800/result6000 retain late results instead of losing all results behind a long task. Not a whole-document recall guarantee.
- Exact cosine + lexical reranking, relative window, max6chunks/max2 per source, deduplication, E5-specific .70 floor. Over8000candidate chunks reports unavailable instead of silent truncation.
- Session tree or exact project cwd scope, generic home/root/tmp excluded. Source/chunk IDs, hierarchy/depth. Old revisions retained but excluded from current search by hash.
- Retrieval audit has model version, board scope, RETRIEVED chunk edges. Escape angle-bracket delimiters in injected evidence.
- Maximum-depth leaf no longer receives shared-context tool instructions requiring its nonexistent hub.
- Drawer shows records/chunks/model.

Manual QA only, no test suites/Playwright. Baseline s-mvgl4bp68105 spawned10 real nested workers with11 boards/cards including leaf board, all11 done; result=RAG10-OK8bytes. Redundant model research occurred; stop/polling instructions clarified. Follow-up s-mvglcwgd4468 runs new multilingual model and rebuilt web-only agent. Shared-context tool handover disabled only for this scripted follow-up, isolating retrieval. Actual workers create/assign boards then launch next child, not fabricated fixtures.

Spanish paraphrase query retrieved relevant level2/4/5/7/9/10 nodes at cosine .8504-.8538. English query found root and nested workers. Examples are not benchmark accuracy claims.

Model source: https://huggingface.co/intfloat/multilingual-e5-small

Follow-up exposed a separate lifecycle bug: handoff exits deferred while descendants run were never re-evaluated when descendants settled, leaving ancestors running forever. Added explicit deferred-turn state and one-shot monitor completion; new input/assistant activity clears it, stopped children excluded. Final validation run s-mvglj494eaea.
