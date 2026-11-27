# save-token (v1.3.0)

**Language:** English | [Tiếng Việt](./README.vi.md)

Zero-dependency universal token-saving MCP server, cross-platform lifecycle hooks, RTK + TOON + PageRank RepoMap compression, Reversible CCR receipts, and **0-LLM anchored session handoff** for AI coding & research agents.

Works across **Antigravity**, **Claude Code**, **Codex**, **DeepSeek Harness (`dsh`)**, **Cursor**, **Gemini CLI**, **OpenCode**, and any stdio MCP host using built-in **Node.js `>= 22.5`** (`node:sqlite`, `node:vm`, `node:child_process`) with **0 npm runtime dependencies**.

---

## Supported Platforms

| Platform | Config / Hooks / Skill Targets | Install Command |
| :--- | :--- | :--- |
| **Auto-detect (Recommended)** | Detects installed harnesses + installs `~/.save-token` & 3 shared skills (`save-token`, `save-token-terse`, `lean-review`) | `node install.mjs` |
| **Antigravity** | `~/.gemini/config/plugins/save-token` (`plugin.json`, `mcp_config.json`, `hooks.json`, `sidecars/context-hud`, `skills/`, `rules/`) | `node install.mjs --target antigravity` |
| **Claude Code** | `~/.claude.json` (`mcpServers.save-token`) + `~/.claude/settings.json` (`PreToolUse`, `SessionStart` hooks) + `~/.claude/skills/*` | `node install.mjs --target claude` |
| **Codex** | `~/.codex/config.toml` (`[mcp_servers.save-token]`) + `~/.agents/skills/*` | `node install.mjs --target codex` |
| **DeepSeek Harness (`dsh`)** | `~/.agents/skills/*` + `~/.dsh/save-token.cordis.yml` + `~/.dsh/save-token.AGENTS.md` | `node install.mjs --target dsh` |
| **Cursor** | `~/.cursor/mcp.json` + `~/.cursor/hooks.json` (`preToolUse`) + `~/.agents/skills/*` | `node install.mjs --target cursor` |
| **Gemini CLI** | `~/.gemini/settings.json` (`mcpServers` + `BeforeTool` & `SessionStart` hooks) + `~/.agents/skills/*` | `node install.mjs --target gemini-cli` |
| **OpenCode** | `~/.config/opencode/opencode.json` (`mcp.save-token`) + `~/.agents/skills/*` (see [`adapters/opencode.json`](./adapters/opencode.json)) | `node install.mjs --target opencode` |
| **All platforms** | Installs every target above without clobbering existing configs or user hooks | `node install.mjs --target all` |

> **Options:** Add `--dry-run` to preview changes, `--skip-browser` to skip installing `agent-browser`, `--skip-hooks` to wire MCP/skills only without lifecycle hooks, or `--uninstall --target <name>` to cleanly remove `save-token` entries and hooks while keeping user settings intact.

---

## What's New in v1.3.0
- **Universal Cross-Platform Storage & Hooks:** `scripts/storage-paths.mjs` keeps Antigravity's `~/.gemini/antigravity/plugin_data/save-token/store.db` intact and automatically falls back to `~/.save-token/data/store.db` on non-Antigravity hosts. `PreToolUse` / `BeforeTool` / `SessionStart` hooks auto-adapt to Antigravity, Claude Code, Gemini CLI, and Cursor payloads.
- **Lossless TOON Encoder (`tools.toToon`):** Encodes uniform arrays of objects into compact tabular TOON blocks (typically 35–60% fewer tokens than JSON) while preserving exact types and quoted delimiters.
- **0-LLM Personalized PageRank RepoMap (`tools.repoMap`):** Builds a lightweight dependency graph and ranks key symbols across JS/TS/Python/Rust repos.
- **RTK Log Compactor + Reversible CCR Receipts:** Compresses git/test/build/log spam, supports `.save-token/filters.json`, saves raw logs on failures (`>= 500B`) or heavily compressed outputs (`>= 8KB`, `>= 50%` saved) with a rotating `| full=<path>` receipt.
- **Read-Dedup Guard:** Prevents wasting tokens re-reading unchanged `>= 4KB` files/slices within 20 minutes (with a 2-minute second-attempt bypass to avoid deadlocks).
- **Multi-Format Anchored Delta Distiller:** Incrementally distills transcripts from **Antigravity**, **Claude Code**, **Codex CLI**, and generic JSONL chats with 0 LLM tokens, preserving 5 semantic anchors (*Goal, Decisions, Rejected/Constraints, Files/Symbols, Tests/Errors*).
- **Opt-In Terse Output Skill (`skills/save-token-terse`) & Antigravity Context HUD:** Zero baseline prompt-cache overhead (`AGENTS.md` untouched) plus HUD KV-cache warmth timer and 5h/7d weighted burn split (`GET /api/burn`).

---

## 6 MCP Tools

1. **`save_token_exec`**: Persistent JS REPL (`state` across turns, ``await $`...`.compact()``, `tools.outline()`, `tools.readSymbol()`, `tools.repoMap()`, `tools.toToon()`, `tools.compactData()`, `tools.stripComments()`, `tools.fetchText(url)`, `tools.detectClis()`, `tools.saveMemory`/`loadMemory`, `tools.glob`/`grep`/`readMany`/`edit`/`batchReplace`) backed by **SQLite FTS5 BM25 + Trigram**.
2. **`save_token_poll`**: Monitor, wait for, or kill background commands spawned by `tools.spawnBg(cmd)` with optional `.compact` and FTS5 `intent`.
3. **`save_token_search`**: Query indexed outputs across sessions, strictly scoped by `branch` and `tags`.
4. **`save_token_handoff`**: Zero-LLM session handoff builder that extracts goals/decisions/files/errors (Antigravity, Claude Code, Codex CLI, or generic JSONL) into SQLite + `.md` + live `progress/<branch>.md`.
5. **`save_token_resume`**: 3-layer progressive disclosure resume (`()` branch index -> `({ branch | handoffId })` summary -> `save_token_search` / `tools.loadMemory`).
6. **`save_token_stats`**: Reports real `rawProcessed` vs `returnedToContext` bytes, `%` saved, `state`, `kv_memory`, FTS5 sources, and jobs.

---

## Quick Start

```bash
git clone https://github.com/rikkurea-boop/save-token.git
cd save-token
npm test                  # Runs 23 MCP/Engine E2E tests + 7-platform installer tests + HUD tests
node install.mjs          # Auto-detects & configures your installed agent harnesses
```

### DeepSeek Harness (`dsh`) & OpenCode Notes
- `install.mjs --target dsh` installs skills into `~/.agents/skills/` (loaded automatically by `@deepseek-ai/dsh-skill-filesystem`) and writes `~/.dsh/save-token.cordis.yml` (copy into your `cordis.yml` `plugins:` list; see [`adapters/dsh-cordis.yml`](./adapters/dsh-cordis.yml)).
- `install.mjs --target opencode` configures `mcp.save-token` inside `~/.config/opencode/opencode.json` cleanly (see [`adapters/opencode.json`](./adapters/opencode.json)).

### Default Browser CLI (`agent-browser`)
`node install.mjs` **automatically installs [`agent-browser`](https://github.com/vercel-labs/agent-browser) globally** (`npm install -g agent-browser`) if not already on `PATH`. Pass `--skip-browser` if you only want MCP, hooks, and skills.

---

## Requirements & Verification
- **Node.js `>= 22.5.0`** (Node 24+ recommended; uses built-in `node:sqlite`).
- Zero external npm runtime dependencies.
- Verified on Windows 11 and macOS Apple Silicon (`arm64`): `npm test` (`server/test-save-token.mjs`, `server/test-installer.mjs`, `sidecars/context-hud/test-hud.mjs`).

## Author & License
- **Author:** [Rikku_desu~](https://github.com/rikkurea-boop)
- **Repository:** [https://github.com/rikkurea-boop/save-token](https://github.com/rikkurea-boop/save-token)
- **License:** [MIT](./LICENSE)
