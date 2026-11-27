# save-token (v1.3.0)

**Ngôn ngữ:** [English](./README.md) | Tiếng Việt

Bộ công cụ tối ưu token toàn diện **không phụ thuộc thư viện npm ngoài**: MCP server REPL cục bộ, hooks đa nền tảng (`PreToolUse` / `BeforeTool` / `SessionStart` / `Stop`), nén log RTK + TOON + PageRank RepoMap, lưu biên lai phục hồi CCR, và **bàn giao phiên chat 0-LLM** theo nhánh/nhãn.

Hoạt động trên **Antigravity**, **Claude Code**, **Codex**, **DeepSeek Harness (`dsh`)**, **Cursor**, **Gemini CLI**, **OpenCode** và mọi trình hỗ trợ MCP stdio chỉ với **Node.js `>= 22.5`** (`node:sqlite`, `node:vm`, `node:child_process`).

---

## Các nền tảng hỗ trợ

| Nền tảng | Vị trí cấu hình, Hooks & Skill | Lệnh cài đặt |
| :--- | :--- | :--- |
| **Tự động nhận diện (Khuyên dùng)** | Tự quét công cụ có sẵn + cài `~/.save-token` & 3 skill dùng chung (`save-token`, `save-token-terse`, `lean-review`) | `node install.mjs` |
| **Antigravity** | `~/.gemini/config/plugins/save-token` (`plugin.json`, `mcp_config.json`, `hooks.json`, `sidecars/context-hud`, `skills/`, `rules/`) | `node install.mjs --target antigravity` |
| **Claude Code** | `~/.claude.json` (`mcpServers.save-token`) + `~/.claude/settings.json` (hooks `PreToolUse`, `SessionStart`) + `~/.claude/skills/*` | `node install.mjs --target claude` |
| **Codex** | `~/.codex/config.toml` (`[mcp_servers.save-token]`) + `~/.agents/skills/*` | `node install.mjs --target codex` |
| **DeepSeek Harness (`dsh`)** | `~/.agents/skills/*` + `~/.dsh/save-token.cordis.yml` + `~/.dsh/save-token.AGENTS.md` | `node install.mjs --target dsh` |
| **Cursor** | `~/.cursor/mcp.json` + `~/.cursor/hooks.json` (`preToolUse`) + `~/.agents/skills/*` | `node install.mjs --target cursor` |
| **Gemini CLI** | `~/.gemini/settings.json` (`mcpServers` + hooks `BeforeTool`, `SessionStart`) + `~/.agents/skills/*` | `node install.mjs --target gemini-cli` |
| **OpenCode** | `~/.config/opencode/opencode.json` (`mcp.save-token`) + `~/.agents/skills/*` (xem [`adapters/opencode.json`](./adapters/opencode.json)) | `node install.mjs --target opencode` |
| **Tất cả nền tảng** | Cài toàn bộ 7 nền tảng trên mà không ghi đè cấu hình hay hook cũ của người dùng | `node install.mjs --target all` |

> **Tùy chọn:** Thêm `--dry-run` để xem trước, `--skip-browser` nếu không muốn tự cài `agent-browser`, `--skip-hooks` nếu chỉ muốn cài MCP & skill, hoặc `--uninstall --target <tên>` để gỡ sạch `save-token` và các hook của nó mà giữ nguyên cấu hình người dùng.

---

## Điểm mới ở v1.3.0
- **Đường dẫn & Hooks đa nền tảng:** `scripts/storage-paths.mjs` tự dùng `~/.gemini/antigravity/plugin_data/save-token/store.db` trên máy Antigravity và `~/.save-token/data/store.db` trên các nền tảng khác. Hook `PreToolUse` / `BeforeTool` / `SessionStart` tự thích ứng payload của Antigravity, Claude Code, Gemini CLI và Cursor.
- **Bộ mã hóa TOON không mất dữ liệu (`tools.toToon`):** Chuyển mảng object đồng nhất thành bảng TOON gọn nhẹ (thường tiết kiệm 35–60% so với JSON), tự trích xuất/escape chuỗi an toàn.
- **PageRank RepoMap 0-LLM (`tools.repoMap`):** Dựng đồ thị phụ thuộc import/export và xếp hạng file/symbol cốt lõi cho JS/TS/Python/Rust.
- **Nén log kiểu RTK + Biên lai khôi phục Reversible CCR:** Lọc log test/git/build, hỗ trợ `.save-token/filters.json`, tự lưu raw log khi lỗi (`>= 500B`) hoặc khi nén sâu (`>= 8KB`, giảm `>= 50%`) kèm `| full=<đường dẫn>`.
- **Chặn đọc lặp (`Read-Dedup Guard`):** Chặn đọc lại cùng vùng tệp `>= 4KB` chưa thay đổi trong 20 phút (cho phép gọi lại lần 2 trong 2 phút để tránh kẹt).
- **Chưng cất Delta có Neo đa định dạng:** Tích lũy theo bước từ log **Antigravity**, **Claude Code**, **Codex CLI** và JSONL tổng quát với 0 token LLM, giữ chắc 5 neo (*Mục tiêu, Quyết định, Phương án loại, Tệp & Symbol, Trạng thái test/lỗi*).
- **Skill trả lời siêu gọn Opt-in (`skills/save-token-terse`) & Context HUD:** Không làm tăng chi phí nền KV prompt cache mặc định; HUD có đồng hồ độ ấm KV-cache và phân tách tiêu hao 5h/7d theo trọng số (`/api/burn`).

---

## 6 Công cụ MCP

1. **`save_token_exec`**: REPL JavaScript cục bộ (`state` giữ xuyên lượt, ``await $`...`.compact()``, `tools.outline()`, `tools.readSymbol()`, `tools.repoMap()`, `tools.toToon()`, `tools.compactData()`, `tools.stripComments()`, `tools.fetchText(url)`, `tools.detectClis()`, `tools.saveMemory`/`loadMemory`, `tools.glob`/`grep`/`readMany`/`edit`/`batchReplace`) kèm tự động index **SQLite FTS5 BM25 + Trigram**.
2. **`save_token_poll`**: Theo dõi, chờ hoặc hủy tiến trình nền khởi chạy từ `tools.spawnBg(cmd)`.
3. **`save_token_search`**: Truy vấn lại dữ liệu/output lớn xuyên phiên, hỗ trợ lọc phạm vi theo `branch` và `tags`.
4. **`save_token_handoff`**: Đóng gói bàn giao ngữ cảnh **0 token LLM** từ transcript (Antigravity, Claude Code, Codex CLI, JSONL) vào SQLite + `.md` + `progress/<branch>.md`.
5. **`save_token_resume`**: Khôi phục 3 tầng (`()` xem nhánh -> `({ branch | handoffId })` đọc tóm tắt -> `save_token_search` / `tools.loadMemory`).
6. **`save_token_stats`**: Thống kê `rawProcessed` vs `returnedToContext`, `%` tiết kiệm, `state`, `kv_memory`, nguồn FTS5 và tác vụ nền.

---

## Cài đặt nhanh

```bash
git clone https://github.com/rikkurea-boop/save-token.git
cd save-token
npm test                  # Chạy 23 bài test MCP/Engine + test cài đặt 7 nền tảng + HUD test
node install.mjs          # Tự động nhận diện và cấu hình các công cụ AI trên máy
```

### Lưu ý thêm cho DeepSeek Harness (`dsh`) & OpenCode
- `node install.mjs --target dsh` cài skill vào `~/.agents/skills/` (được `@deepseek-ai/dsh-skill-filesystem` tự nạp) và tạo `~/.dsh/save-token.cordis.yml` (xem [`adapters/dsh-cordis.yml`](./adapters/dsh-cordis.yml)).
- `node install.mjs --target opencode` cấu hình `mcp.save-token` vào `~/.config/opencode/opencode.json` (xem [`adapters/opencode.json`](./adapters/opencode.json)).

### Trình duyệt CLI mặc định (`agent-browser`)
Khi chạy `node install.mjs`, bộ cài đặt **tự động cài [`agent-browser`](https://github.com/vercel-labs/agent-browser) toàn cục** nếu máy chưa có. Thêm `--skip-browser` nếu chỉ cần MCP server, hooks và skill.

---

## Yêu cầu & Kiểm chứng
- **Node.js `>= 22.5.0`** (khuyên dùng Node 24+ vì tích hợp sẵn `node:sqlite`).
- 0 thư viện npm ngoài khi chạy.
- Đã kiểm chứng trên Windows 11 và macOS Apple Silicon (`arm64`): `npm test`.

## Tác giả & Bản quyền
- **Tác giả:** [Rikku_desu~](https://github.com/rikkurea-boop)
- **Kho mã nguồn:** [https://github.com/rikkurea-boop/save-token](https://github.com/rikkurea-boop/save-token)
- **Giấy phép:** [MIT](./LICENSE)
