# Semantic delegation and visual boards

All web descendants inherit MINI_AGENT_GRAPH_RAG_URL=http://127.0.0.1:9446/. The common Rust launch path retrieves for spawn, dispatch, plans, delegate and handoff, including nested launches. The terminal binary and its environment are unchanged.

The local Python service uses fastembed/ONNX all-MiniLM-L6-v2, 384 dimensions, two CPU threads. Embeddings and source text are stored on MiniAgent, MiniTask and MiniCard in the existing neo4j-rust Bolt graph. It performs exact cosine over at most 4,000 candidates scoped to the session tree or exact project cwd, then supplies up to four sources scoring at least .28. Generic /, /tmp and home directories do not authorize cross-session project retrieval. No remote embedding API. MiniLM is English-first; Spanish retrieval quality is not equivalent to a multilingual model.

Retrieved text is historical evidence, never instructions or permission. Each result includes source ID, session and score; MiniRetrieval nodes plus RETRIEVED edges audit delivery candidates. Launch events distinguish actual delivery from a full-context-budget omission. Unavailable retrieval adds an explicit warning, not an invented hit. Existing explicit handoff takes priority. Audit candidates are not a promise that the agent used them correctly.

Install dependencies: python3 -m pip install fastembed neo4j numpy. First start downloads the 90MB ONNX model; cache is ~/.cache/mini-tui-embeddings. Install deploy/mini-tui-graph-rag.service and enable it. Projection and embeddings refresh asynchronously (3s / 5s). Warmup and failure are shown in the drawer.

UI uses native generated shadcn-svelte Tabs, upstream Control UI Timeline and upstream Beautiful UI TaskRows as real React islands, with registry receipts in vendor/. Demo timers removed; all status comes from saved task data. Drawer rail supports pointer drag and Left/Right/Home/End; width persisted locally, mobile clamped to viewport. Kanban supports horizontal scroll and hides empty columns when tasks exist.

Manual QA only, no test suites or Playwright. QA evidence: main session s-mvfu6x0q9a5b, graph retrieval at worker and leaf launch, six-byte RAG-OK file, 390px no overflow/16px fields, sidebar expanded to1146 and1342px on1366px viewport. Source libraries: https://control-ui.dev/r/timeline.json and https://beautifului.dev/r/task-rows.json.
