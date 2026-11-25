# CLI-First Guide (Replacing Heavy External MCPs)

Why: Antigravity lazy-loads MCP tool names (~23–123 tokens static), **but** external MCP calls dump huge raw payloads directly into chat context and require multi-turn round-trips. Calling CLIs inside `save_token_exec` filters 90–99% of noise locally in 1 turn.

## 1. Quick Discovery
Run inside `save_token_exec`:
```js
return tools.detectClis();
```

## 2. Mapping External Services -> CLI + `save_token_exec`

| Domain | Instead of Verbose MCP / Raw Output | Use CLI Inside `save_token_exec` |
| :--- | :--- | :--- |
| **Git / GitHub** | Multi-turn `run_command` dumps | ``await $`git status --short`.compact()``, ``await $`gh pr list --json number,title,state`.json()`` |
| **Tests / Builds** | Full stdout test logs in chat | ``await $`npm test`.nothrow().compact("test")`` (keeps `FAIL`/`ERROR`, collapses `PASS`) |
| **Static Web / Docs** | Browser subagent or raw `curl` | `await tools.fetchText(url)` + `tools.index("doc", res.text)` |
| **Media / Video** | Manual frame inspection | `ffprobe -v quiet -print_format json -show_format -show_streams ...` parsed via `.json()` |
| **Any MCP / OpenAPI / GraphQL** | Mounting 30+ MCP tool schemas globally | `uvx mcp2cli --mcp <url> --search "<kw>"` or `uvx mcp2cli --spec <openapi.json> <cmd>` (when `uvx` is installed) |
| **Live Web UI & React/CDP** | Multi-turn screenshot browser loops | `agent-browser open <url>` + `snapshot -i` (`@e1` refs), `react`, `network`, `close` (installed on PATH; `playwright-cli` fallback) |

## 3. Compacting Rules (`$.compact()` & `tools.compactOutput`)
- `tools.compactOutput(text, "auto" | "test" | "generic")` automatically:
  1. Strips ANSI color codes and terminal `\r` progress spinners.
  2. Collapses consecutive identical lines into `line ... (xN repeats)`.
  3. In `"test"` mode, preserves every `ERROR`/`FAIL`/`WARN`/summary line while collapsing noisy `PASS`/`ok`/checkmark runs.
