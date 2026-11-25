# Save Token — Universal Context Optimization Rules

- **Multi-file, data & CLI tasks (3+ files, large logs/JSON/CSV, multi-step commands):** Run inside `save_token_exec` using `state.<key>` / `tools.saveMemory`, ``await $`...`.compact()``, `tools.fetchText(url)`, and `intent` (FTS5 BM25+Trigram). Default to `mode: "readonly"`; verify with `dryRun: true` before `mode: "write"`.
- **External services -> CLI first:** Prefer `git`, `gh`, `ffmpeg`, `python`, `mcp2cli`, or `agent-browser` inside `save_token_exec` to filter noise locally before returning output to chat.
- **Browser & frontend minimal ladder:** Try `tools.fetchText`/`search_web` -> `agent-browser` CLI (`snapshot -i`, `react`, `network`, `close`) inside `save_token_exec` -> DevTools (`take_snapshot`/`evaluate_script`/`list_network_requests`, avoid screenshots). Only invoke a visual browser subagent with a fast model (`flash`), 1 narrow goal, `<2KB` cap.
- **Zero-LLM session handoff:** Around ~60–80k+ tokens, call `save_token_handoff` and load cleanly in the fresh session with `save_token_resume({ handoffId: "latest" })`.
