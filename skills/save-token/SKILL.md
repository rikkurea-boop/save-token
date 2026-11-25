---
name: save-token
description: Universal token-saving toolkit across AI coding and research agents (Antigravity, Claude Code, Codex, DeepSeek Harness, Cursor, Gemini CLI). Provides MCP tools `save_token_exec`, `save_token_poll`, `save_token_search`, `save_token_handoff`, `save_token_resume`, and `save_token_stats`. Use for multi-file/data work, external CLI compression, browser cost control, or 0-LLM cross-session handoff.
---

# Save Token (`save-token`)

| Tool | Purpose |
| :--- | :--- |
| `save_token_exec` | Persistent JS REPL (`state`, ``await $`...`.compact()``, `tools.*`) with durable SQLite FTS5+Trigram indexing & `intent` BM25 filtering. |
| `save_token_poll` | Check, wait for, or kill background jobs from `tools.spawnBg(cmd)` with optional `compact` & `intent`. |
| `save_token_search` | Query indexed sources across **current and prior sessions** (`chunks` Porter BM25 + `chunks_tri` Trigram). |
| `save_token_handoff` | Zero-LLM handoff builder: optionally extracts recent prompts/files/errors from a transcript, persists selected `state` keys into `kv_memory`, and writes a compact `.md` snapshot. |
| `save_token_resume` | 3-layer resume: `()` lists recent handoffs; `({ handoffId: "latest" })` loads summary + `memoryKeys`/`indexedSources`. |
| `save_token_stats` | Reports raw bytes processed vs returned to context, `%` saved, `state`, `kv_memory`, FTS5 sources, and jobs. |

## 1. Universal Data, Code & CLI Rules

- Use `save_token_exec` whenever inspecting **3+ files**, filtering logs/JSON/CSV, fetching/cleaning static web pages (`tools.fetchText(url)`), or running external CLIs via ``await $`...`.compact()``.
- Keep bulky datasets in `state.<key>` (same session) or `tools.saveMemory(key, val)` (cross-session SQLite `kv_memory`), returning only counts/samples to chat.
- Pass `intent` on `save_token_exec` when output may be large so SQLite FTS5 returns only matching chunks instead of dumping raw text.
- Keep `mode: "readonly"` by default; verify edits with `dryRun: true` before `mode: "write"`.
- For **1–2 small files**, use native file read/edit tools directly.

## 2. External Tools -> CLI-First

Prefer local CLIs inside `save_token_exec` over verbose external MCP schemas or raw shell dumps. Read `references/cli-first-guide.md` for `gh`, `git`, `ffmpeg`, `uvx mcp2cli`, `agent-browser`, and `.compact()` patterns.

## 3. Browser & Frontend-Direct Scoping

**Never** send a visual browser agent blindly for static pages, API scraping, or frontend debugging. Follow the 4-tier ladder in `references/browser-playbook.md`: `tools.fetchText`/`search_web` (Tier 0) -> `agent-browser` CLI (`open`, `snapshot -i`, `react`, `network`, `close`) inside `save_token_exec` (Tier 1) -> DevTools `take_snapshot`/`evaluate_script`/`list_network_requests` without screenshots (Tier 2) -> fast visual browser subagent with `<2KB` output cap (Tier 3).

## 4. Zero-LLM Context Handoff & Fresh Session

When context grows long (~60–80k+ tokens) or you want to switch to a fresh chat without losing state:
1. Call `save_token_handoff({ title, goal, decisions, nextSteps, saveStateKeys, conversationId?, transcriptPath? })` (0 LLM tokens).
2. On Antigravity, optionally run `scripts/handoff-new-chat.mjs --handoff "<filePath>" --title "<title>"` via shell to spawn the next conversation automatically; on other harnesses, start a fresh session and pass the `handoffId` or `.md` summary.
3. In the new session, call `save_token_resume({ handoffId: "latest" })` and `save_token_search` / `tools.loadMemory` on demand.
