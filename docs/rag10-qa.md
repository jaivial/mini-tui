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

Refinement: deferred handoff must wake the child to synthesize final child results, not relay its stale handoff as completion. Final closure validation uses s-mvglpy1o4e70.

Final QA run s-mvgluraz1d04: ten real nested workers, eleven boards/cards including depth10 leaf. All eleven cards done with nonempty result, persisted after QA closure and projection/RAG restart. Ten launch retrieval events delivered=true with multilingual model. Spanish leaf evidence query cosine .8638; unrelated session + /tmp returned zero candidates/hits. result.txt RAG10-OK eight bytes. Actual final reports needed operator clarification; redundant read-only research, CPU refusal and provider goal-judge timeouts/format errors occurred. Not a clean autonomous/model-judge PASS.

Persistence follow-up: MiniAgent.result now projects the latest assistant-authored submission from saved messages, separately from exit_status and exit_submission. result_source names provenance and result_is_judge_approval is always false. It does not turn a proposal/handoff into verified completion. Judge failure no longer erases the authored report. No-report failures stay empty, never use an error string as the report. Cache by session updated_at avoids parsing every saved conversation each poll. Manual source snapshot: initial5.85s, cached0.25s across1889nodes. No tests executed.
