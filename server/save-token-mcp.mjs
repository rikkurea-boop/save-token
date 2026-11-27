import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import vm from "node:vm";
import readline from "node:readline";
import { exec, spawn } from "node:child_process";
import { promisify } from "node:util";
import { StringDecoder } from "node:string_decoder";
import { DatabaseSync } from "node:sqlite";
import { inferBranch, inferTags, normalizeBranch, normalizeTags } from "../scripts/context-meta.mjs";
import { compactOutput, compactStructuredData, encodeToon, stripAnsi, stripSourceComments } from "../scripts/compact-engine.mjs";
import { extractOutline, extractSymbolSlice } from "../scripts/code-outline.mjs";
import { buildRepoMap } from "../scripts/repo-map.mjs";
import { resolveDataDir, resolveDbPath } from "../scripts/storage-paths.mjs";

const execAsync = promisify(exec);

const DEFAULT_IGNORES = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "__pycache__",
  ".venv",
]);

const SERVER_INFO = { name: "save-token", version: "1.3.0" };
const DEFAULT_CHUNK_BYTES = 1500;
const MAX_BG_STREAM_BYTES = 4 * 1024 * 1024;
const STRIPPED_ENV_KEYS = new Set([
  "NODE_OPTIONS",
  "NODE_REPL_EXTERNAL_MODULE",
  "NODE_V8_COVERAGE",
  "BUN_OPTIONS",
  "DENO_OPTIONS",
]);

const DB_PATH = resolveDbPath(process.env);
const DATA_DIR = resolveDataDir(process.env);
const HANDOFF_DIR = path.join(DATA_DIR, "handoffs");
const PROGRESS_DIR = path.join(DATA_DIR, "progress");
const ANTIGRAVITY_BRAIN_DIR =
  process.env.ANTIGRAVITY_BRAIN_DIR || path.join(os.homedir(), ".gemini", "antigravity", "brain");

const TOOL_DEFINITIONS = [
  {
    name: "save_token_exec",
    description:
      "REPL JavaScript cục bộ tối ưu token cho mọi tác vụ (code, dữ liệu, tài liệu, web tĩnh, CLI): giữ `state` xuyên lượt, hỗ trợ ``await $`...`.compact()``, `tools.outline()`, `tools.readSymbol()`, `tools.repoMap()`, `tools.toToon()`, `tools.fetchText(url)`, `tools.compactOutput()`, `tools.detectClis()`, `tools.saveMemory`/`loadMemory`, và tự động index SQLite FTS5+Trigram bền vững.",
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "Async JavaScript body (supports `await`, `return`, `state`, `$`, `tools`, `console`).",
        },
        cwd: { type: "string", description: "Working directory for relative paths and shell commands." },
        mode: {
          type: "string",
          enum: ["readonly", "write"],
          default: "readonly",
          description: "Safety lock: defaults to 'readonly'. Set to 'write' to allow file edits/writes.",
        },
        intent: {
          type: "string",
          description: "BM25 search intent to return only matching chunks when output is large.",
        },
        timeoutMs: { type: "number", default: 30000, description: "Timeout in ms (1000..300000)." },
        maxOutputChars: { type: "number", default: 8000, description: "Context budget cap (500..32000)." },
        resetState: { type: "boolean", default: false, description: "Clear in-memory `state` before running." },
      },
      required: ["code"],
    },
  },
  {
    name: "save_token_poll",
    description:
      "Kiểm tra, chờ hoặc hủy tác vụ nền khởi chạy bởi `tools.spawnBg(cmd)`, hỗ trợ nén RTK (`compact`) và lọc `intent` qua FTS5.",
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string", description: "Job ID returned by `tools.spawnBg`." },
        waitMs: { type: "number", default: 0, description: "Wait up to N ms (0..30000) for completion." },
        kill: { type: "boolean", default: false, description: "Terminate the running background process tree." },
        compact: { type: "boolean", default: false, description: "Apply RTK-style log compaction to output." },
        intent: { type: "string", description: "Optional BM25 intent filter for large outputs." },
        maxOutputChars: { type: "number", default: 8000, description: "Output character cap (500..32000)." },
      },
      required: ["jobId"],
    },
  },
  {
    name: "save_token_search",
    description:
      "Truy vấn lại dữ liệu/output lớn đã index trong kho SQLite bền vững (Porter BM25 + Trigram), hỗ trợ lọc cứng theo `branch` và `tags` để không quét lan sang ngữ cảnh khác.",
    inputSchema: {
      type: "object",
      properties: {
        queries: { type: "array", items: { type: "string" }, description: "Search queries." },
        source: { type: "string", description: "Optional source label filter (e.g. 'exec:1', 'handoff:...')." },
        branch: { type: "string", description: "Optional context branch filter (e.g. 'auth-flow'). Strictly restricts search to that branch." },
        tags: { type: "array", items: { type: "string" }, description: "Optional required tag labels (chunk source must contain all listed tags)." },
        limit: { type: "number", default: 5, description: "Max chunks per query (1..20)." },
        maxOutputChars: { type: "number", default: 8000, description: "Output character cap (500..32000)." },
      },
      required: ["queries"],
    },
  },
  {
    name: "save_token_handoff",
    description:
      "Đóng gói bàn giao ngữ cảnh phiên chat (0 token LLM) theo `branch` và `tags`: tự trích xuất từ transcript, lưu SQLite + tệp `.md` + cập nhật `progress/<branch>.md` thời gian thực.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title (optional when conversationId or transcriptPath is supplied)." },
        conversationId: {
          type: "string",
          description: "Antigravity conversationId (full UUID, 6+ char prefix, or 'latest') to distill into a handoff .md file.",
        },
        transcriptPath: { type: "string", description: "Optional explicit path to transcript_full.jsonl." },
        project: { type: "string", description: "Optional project name or path." },
        branch: { type: "string", description: "Virtual context branch name (auto-inferred with 0 LLM tokens from git/prompt/files when omitted)." },
        tags: { type: "array", items: { type: "string" }, description: "Topic/module tags attached to this handoff & its FTS5 source (auto-inferred when omitted)." },
        goal: { type: "string", description: "Current primary goal." },
        decisions: { type: "array", items: { type: "string" }, description: "Key technical decisions." },
        nextSteps: { type: "array", items: { type: "string" }, description: "Ordered remaining next steps." },
        openRisks: { type: "array", items: { type: "string" }, description: "Open issues or caveats." },
        saveStateKeys: { type: "array", items: { type: "string" }, description: "Keys from `state` to persist into kv_memory." },
        maxChars: { type: "number", default: 3800, description: "Max bytes/chars for handoff Markdown (800..8000)." },
        force: { type: "boolean", default: false, description: "Rebuild handoff even if transcript source cache matches." },
      },
      required: [],
    },
  },
  {
    name: "save_token_resume",
    description:
      "Nạp lại ngữ cảnh phiên chat theo cơ chế 3 tầng (0 token LLM): bỏ trống để liệt kê danh sách + nhánh, truyền `branch` (+ `tags` tùy chọn) để nạp tiến độ nhánh, truyền `handoffId`, hoặc truyền `conversationId`.",
    inputSchema: {
      type: "object",
      properties: {
        handoffId: { type: "string", description: "Omit for compact list; pass 'latest' or exact handoffId to load details." },
        branch: { type: "string", description: "Load latest handoff, progress/<branch>.md, and scoped memory/sources for this context branch." },
        tags: { type: "array", items: { type: "string" }, description: "Optional tags filter when resuming by branch." },
        conversationId: {
          type: "string",
          description:
            "Antigravity conversationId (full UUID, 6+ char prefix, or 'latest'). Automatically runs 0-LLM handoff to .md (cached by transcript mtime) and returns the summary.",
        },
        maxChars: {
          type: "number",
          default: 3800,
          description: "Max bytes/chars when auto-distilling from conversationId (800..8000).",
        },
      },
    },
  },
  {
    name: "save_token_stats",
    description:
      "Xem thống kê tối ưu token: lượt gọi, bytes xử lý vs bytes trả về ngữ cảnh, % tiết kiệm, khóa `state`, `kv_memory`, nguồn FTS5, handoff và job nền.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

// ── Persistent SQLite Store & Session State ──────────────────────────

let sessionState = Object.create(null);
let execSeq = 0;
const metrics = {
  calls: { exec: 0, poll: 0, search: 0, handoff: 0, resume: 0 },
  rawBytes: 0,
  returnedBytes: 0,
};
const jobs = new Map();
let jobSeq = 0;

function parseTagsJson(raw) {
  try {
    const parsed = JSON.parse(String(raw || "[]"));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function isSafePathWithin(targetPath, baseDir) {
  if (!targetPath || !baseDir) return false;
  const norm = (p) => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));
  const rel = path.relative(norm(baseDir), norm(targetPath));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function ensureColumn(conn, table, column, defSql) {
  const cols = conn.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    conn.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${defSql}`);
  }
}

function initDb() {
  fsSync.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fsSync.mkdirSync(HANDOFF_DIR, { recursive: true });
  fsSync.mkdirSync(PROGRESS_DIR, { recursive: true });
  const conn = new DatabaseSync(DB_PATH);
  conn.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT UNIQUE NOT NULL,
      bytes_total INTEGER NOT NULL,
      chunk_count INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
      source_id UNINDEXED,
      ord UNINDEXED,
      title,
      body,
      tokenize = 'porter unicode61 remove_diacritics 2'
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_tri USING fts5(
      source_id UNINDEXED,
      ord UNINDEXED,
      title,
      body,
      tokenize = 'trigram'
    );
    CREATE TABLE IF NOT EXISTS kv_memory (
      key TEXT PRIMARY KEY,
      project TEXT NOT NULL DEFAULT '',
      value_json TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS handoffs (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      project TEXT NOT NULL DEFAULT '',
      conversation_id TEXT NOT NULL DEFAULT '',
      file_path TEXT NOT NULL,
      summary_md TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS metrics_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      tool TEXT NOT NULL,
      raw_bytes INTEGER NOT NULL,
      returned_bytes INTEGER NOT NULL,
      saved_bytes INTEGER NOT NULL,
      project TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_metrics_events_ts ON metrics_events(ts);
  `);
  ensureColumn(conn, "sources", "branch", "TEXT NOT NULL DEFAULT 'main'");
  ensureColumn(conn, "sources", "tags_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(conn, "kv_memory", "branch", "TEXT NOT NULL DEFAULT 'main'");
  ensureColumn(conn, "kv_memory", "tags_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(conn, "handoffs", "branch", "TEXT NOT NULL DEFAULT 'main'");
  ensureColumn(conn, "handoffs", "tags_json", "TEXT NOT NULL DEFAULT '[]'");
  conn.exec(`
    CREATE INDEX IF NOT EXISTS idx_sources_branch ON sources(branch);
    CREATE INDEX IF NOT EXISTS idx_kv_memory_branch ON kv_memory(branch);
    CREATE INDEX IF NOT EXISTS idx_handoffs_branch_ts ON handoffs(branch, created_at);
  `);
  return conn;
}

const db = initDb();

function closeDbQuietly() {
  try {
    db.close();
  } catch {
    // already closed
  }
}

function recordMetricEvent(tool, rawBytes, returnedBytes, project = "") {
  try {
    const raw = Math.max(0, Math.trunc(Number(rawBytes) || 0));
    const ret = Math.max(0, Math.trunc(Number(returnedBytes) || 0));
    const saved = Math.max(0, raw - ret);
    const proj = typeof project === "string" ? project.slice(0, 260) : "";
    db.prepare(
      "INSERT INTO metrics_events(ts, tool, raw_bytes, returned_bytes, saved_bytes, project) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(Date.now(), String(tool || "unknown"), raw, ret, saved, proj);
  } catch {
    // Metrics persistence is best-effort and must never break MCP tool execution.
  }
}

function clampNumber(val, min, max, fallback) {
  if (typeof val !== "number" || !Number.isFinite(val)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(val)));
}

function toPosix(p) {
  return String(p).replace(/\\/g, "/");
}

function isRegExpLike(val) {
  return val instanceof RegExp || Object.prototype.toString.call(val) === "[object RegExp]";
}

function utf8Bytes(s) {
  return Buffer.byteLength(s, "utf8");
}

function capBytes(s, maxBytes) {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return { text: s, cut: false, fullBytes: buf.length };
  const dec = new StringDecoder("utf8");
  const text = dec.write(buf.subarray(0, maxBytes));
  return { text, cut: true, fullBytes: buf.length };
}

function withDarwinPath(rawPath = "") {
  const parts = String(rawPath).split(path.delimiter).filter(Boolean);
  if (process.platform === "darwin") {
    for (const p of ["/opt/homebrew/bin", "/usr/local/bin"]) {
      if (!parts.includes(p)) parts.push(p);
    }
  }
  return parts;
}

function buildChildEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    const up = k.toUpperCase();
    if (STRIPPED_ENV_KEYS.has(up)) continue;
    if (up.startsWith("NODE_") && up.endsWith("_OPTIONS")) continue;
    env[k] = v;
  }
  if (process.platform === "darwin") {
    env.PATH = withDarwinPath(env.PATH || env.Path || "").join(path.delimiter);
  }
  return { ...env, NO_COLOR: "1", FORCE_COLOR: "0", ...extra };
}

function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already exited
    }
  }
}

// ── HTML Text Extraction (compactOutput imported from ../scripts/compact-engine.mjs) ──

function htmlToCleanText(html) {
  let s = String(html)
    .replace(/<(script|style|svg|noscript|nav|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, "\n")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/(?:p|div|li|h[1-6]|tr|section|article|blockquote|pre)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  s = s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  return s
    .split(/\r?\n/)
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .filter((l, idx, arr) => l !== "" || (idx > 0 && arr[idx - 1] !== ""))
    .join("\n")
    .trim();
}

// ── Chunking & FTS5 Indexing / Search ────────────────────────────────

function chunkText(text, maxBytes = DEFAULT_CHUNK_BYTES) {
  const normalized = String(text).replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!normalized) return [];
  const cap = Math.max(256, maxBytes);
  const lines = normalized.split("\n");

  const blocks = [];
  const stack = [];
  let title = "";
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const headingText = headingMatch[2].trim();
      while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, text: headingText });
      title = stack.map((h) => h.text).join(" > ");
      blocks.push({ title, text: line });
      i += 1;
      continue;
    }

    const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1].slice(0, 3);
      const fenceLines = [line];
      i += 1;
      while (i < lines.length) {
        fenceLines.push(lines[i]);
        if (lines[i].trimStart().startsWith(marker)) {
          i += 1;
          break;
        }
        i += 1;
      }
      blocks.push({ title, text: fenceLines.join("\n") });
      continue;
    }

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    const paraLines = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^\s{0,3}(`{3,}|~{3,})/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i += 1;
    }
    blocks.push({ title, text: paraLines.join("\n") });
  }

  const chunks = [];
  let curTitle = "";
  let curBuf = "";

  const pushChunk = (t, body) => {
    if (!body) return;
    if (utf8Bytes(body) <= cap) {
      chunks.push({ ord: chunks.length, title: t, text: body, bytes: utf8Bytes(body) });
      return;
    }
    let acc = "";
    for (const ln of body.split("\n")) {
      const candidate = acc ? `${acc}\n${ln}` : ln;
      if (utf8Bytes(candidate) <= cap) {
        acc = candidate;
      } else {
        if (acc) {
          chunks.push({ ord: chunks.length, title: t, text: acc, bytes: utf8Bytes(acc) });
          acc = "";
        }
        if (utf8Bytes(ln) <= cap) {
          acc = ln;
        } else {
          let rest = ln;
          while (utf8Bytes(rest) > cap) {
            const slice = capBytes(rest, cap).text;
            const stepLen = slice.length > 0 ? slice.length : 1;
            chunks.push({
              ord: chunks.length,
              title: t,
              text: rest.slice(0, stepLen),
              bytes: utf8Bytes(rest.slice(0, stepLen)),
            });
            rest = rest.slice(stepLen);
          }
          acc = rest;
        }
      }
    }
    if (acc) chunks.push({ ord: chunks.length, title: t, text: acc, bytes: utf8Bytes(acc) });
  };

  for (const b of blocks) {
    if (b.title !== curTitle && curBuf) {
      pushChunk(curTitle, curBuf);
      curBuf = "";
    }
    curTitle = b.title;
    const candidate = curBuf ? `${curBuf}\n\n${b.text}` : b.text;
    if (utf8Bytes(candidate) <= cap) {
      curBuf = candidate;
    } else {
      if (curBuf) pushChunk(curTitle, curBuf);
      if (utf8Bytes(b.text) <= cap) {
        curBuf = b.text;
      } else {
        pushChunk(curTitle, b.text);
        curBuf = "";
      }
    }
  }
  if (curBuf) pushChunk(curTitle, curBuf);
  return chunks;
}

function indexIntoStore(label, text, maxChunkBytes = DEFAULT_CHUNK_BYTES, opts = {}) {
  const cleanLabel = String(label);
  const chunks = chunkText(text, maxChunkBytes);
  const bytesTotal = utf8Bytes(String(text));
  const branch = normalizeBranch(opts.branch);
  const tagsJson = JSON.stringify(normalizeTags(opts.tags));

  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = db.prepare("SELECT id FROM sources WHERE label = ?").get(cleanLabel);
    if (existing) {
      db.prepare("DELETE FROM chunks WHERE source_id = ?").run(existing.id);
      db.prepare("DELETE FROM chunks_tri WHERE source_id = ?").run(existing.id);
      db.prepare("DELETE FROM sources WHERE id = ?").run(existing.id);
    }
    const row = db
      .prepare(
        "INSERT INTO sources(label, bytes_total, chunk_count, created_at, branch, tags_json) VALUES (?, ?, ?, ?, ?, ?) RETURNING id"
      )
      .get(cleanLabel, bytesTotal, chunks.length, Date.now(), branch, tagsJson);
    const sourceId = Number(row.id);

    const insChunk = db.prepare("INSERT INTO chunks(source_id, ord, title, body) VALUES (?, ?, ?, ?)");
    const insTri = db.prepare("INSERT INTO chunks_tri(source_id, ord, title, body) VALUES (?, ?, ?, ?)");
    for (const c of chunks) {
      insChunk.run(sourceId, c.ord, c.title, c.text);
      insTri.run(sourceId, c.ord, c.title, c.text);
    }
    db.exec("COMMIT");
    return { sourceId, label: cleanLabel, chunkCount: chunks.length, bytesTotal, branch };
  } catch (err) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw err;
  }
}

function buildFtsMatches(query) {
  const raw = String(query ?? "").trim();
  if (!raw) return { porterAnd: null, porterOr: null, trigramAnd: null, trigramOr: null };

  const wordTokens = raw.match(/[\p{L}\p{N}_]+/gu) ?? [];
  const quotedWords = [...new Set(wordTokens)].map((t) => `"${t}"`);
  const porterAnd = quotedWords.length > 0 ? quotedWords.join(" AND ") : null;
  const porterOr = quotedWords.length > 1 ? quotedWords.join(" OR ") : null;

  const triParts = raw
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3)
    .map((t) => `"${t.replace(/"/g, '""')}"`);
  const trigramAnd = triParts.length > 0 ? triParts.join(" AND ") : null;
  const trigramOr = triParts.length > 1 ? triParts.join(" OR ") : null;

  return { porterAnd, porterOr, trigramAnd, trigramOr };
}

function queryStore(query, { source, branch, tags, limit = 5, sourceId } = {}) {
  const lim = clampNumber(limit, 1, 20, 5);
  const cleanBranch = typeof branch === "string" && branch.trim() ? normalizeBranch(branch) : null;
  const reqTags = normalizeTags(tags);
  const fetchLimit = reqTags.length > 0 ? Math.min(80, lim * 4) : lim;
  const { porterAnd, porterOr, trigramAnd, trigramOr } = buildFtsMatches(query);
  const seen = new Set();
  const hits = [];

  const addRows = (rows, tier) => {
    for (const r of rows) {
      const k = `${r.source_id}:${r.ord}`;
      if (seen.has(k)) continue;
      const rowTags = parseTagsJson(r.tags_json);
      if (reqTags.length > 0 && !reqTags.every((t) => rowTags.includes(t))) continue;
      seen.add(k);
      hits.push({
        sourceId: Number(r.source_id),
        source: r.label,
        branch: r.branch || "main",
        tags: rowTags,
        ord: Number(r.ord),
        title: r.title || "",
        body: r.body,
        score: Number(r.score ?? 0),
        tier,
      });
      if (hits.length >= lim) break;
    }
  };

  const runPorter = (expr) => {
    if (!expr) return [];
    try {
      return db
        .prepare(
          `SELECT c.source_id, c.ord, c.title, c.body, s.label, s.branch, s.tags_json,
                  -bm25(chunks, 0, 0, 1.0, 1.0) AS score
           FROM chunks c
           JOIN sources s ON s.id = c.source_id
           WHERE chunks MATCH ?
             AND (? IS NULL OR s.label = ?)
             AND (? IS NULL OR c.source_id = ?)
             AND (? IS NULL OR s.branch = ?)
           ORDER BY score DESC, c.source_id DESC, c.ord ASC
           LIMIT ?`
        )
        .all(expr, source ?? null, source ?? null, sourceId ?? null, sourceId ?? null, cleanBranch, cleanBranch, fetchLimit);
    } catch {
      return [];
    }
  };

  const runTrigram = (expr) => {
    if (!expr) return [];
    try {
      return db
        .prepare(
          `SELECT t.source_id, t.ord, t.title, t.body, s.label, s.branch, s.tags_json,
                  -bm25(chunks_tri, 0, 0, 1.0, 1.0) AS score
           FROM chunks_tri t
           JOIN sources s ON s.id = t.source_id
           WHERE chunks_tri MATCH ?
             AND (? IS NULL OR s.label = ?)
             AND (? IS NULL OR t.source_id = ?)
             AND (? IS NULL OR s.branch = ?)
           ORDER BY score DESC, t.source_id DESC, t.ord ASC
           LIMIT ?`
        )
        .all(expr, source ?? null, source ?? null, sourceId ?? null, sourceId ?? null, cleanBranch, cleanBranch, fetchLimit);
    } catch {
      return [];
    }
  };

  if (porterAnd) addRows(runPorter(porterAnd), "porter");
  if (hits.length < lim && trigramAnd) addRows(runTrigram(trigramAnd), "trigram");
  if (hits.length < lim && porterOr) addRows(runPorter(porterOr), "porter_or");
  if (hits.length < lim && trigramOr) addRows(runTrigram(trigramOr), "trigram_or");

  return hits;
}

function selectChunksForBudget(sourceId, intent, budgetChars) {
  let picked = [];
  if (intent && intent.trim()) {
    const ranked = queryStore(intent, { sourceId, limit: 20 });
    let used = 0;
    for (const h of ranked) {
      const cost = h.body.length + (picked.length > 0 ? 2 : 0);
      if (used + cost <= budgetChars) {
        picked.push(h);
        used += cost;
      }
    }
    if (picked.length === 0 && ranked.length > 0) {
      const top = ranked[0];
      picked.push({ ...top, body: top.body.slice(0, Math.max(200, budgetChars)) });
    }
    picked.sort((a, b) => a.ord - b.ord);
  }

  if (picked.length === 0) {
    const rows = db
      .prepare("SELECT source_id, ord, title, body FROM chunks WHERE source_id = ? ORDER BY ord ASC")
      .all(sourceId);
    let used = 0;
    for (const r of rows) {
      const cost = r.body.length + (picked.length > 0 ? 2 : 0);
      if (used + cost <= budgetChars) {
        picked.push({ ord: Number(r.ord), title: r.title, body: r.body });
        used += cost;
      } else {
        break;
      }
    }
    if (picked.length === 0 && rows.length > 0) {
      picked.push({ ord: 0, title: rows[0].title, body: rows[0].body.slice(0, Math.max(200, budgetChars)) });
    }
  }

  return picked.map((p) => p.body).join("\n\n");
}

// ── Structural JSON Truncation ───────────────────────────────────────

function shrinkJsonNode(val, budgetChars) {
  if (val == null || typeof val === "number" || typeof val === "boolean") return val;
  if (typeof val === "string") {
    if (val.length <= budgetChars) return val;
    const keep = Math.max(24, budgetChars - 24);
    return `${val.slice(0, keep)}...--- TRUNCATED ---`;
  }
  if (Array.isArray(val)) {
    const out = [];
    const perItemGuess = Math.max(48, Math.floor(budgetChars / Math.max(1, Math.min(val.length, 6))));
    for (let i = 0; i < val.length; i++) {
      const candidateItem = shrinkJsonNode(val[i], perItemGuess);
      const testArr = [...out, candidateItem, `--- TRUNCATED: omitted ${val.length - i - 1} items ---`];
      if (JSON.stringify(testArr, null, 2).length > budgetChars && out.length > 0) {
        out.push(`--- TRUNCATED: omitted ${val.length - i} items ---`);
        return out;
      }
      out.push(candidateItem);
    }
    return out;
  }
  if (typeof val === "object") {
    const entries = Object.entries(val);
    entries.sort((a, b) => JSON.stringify(a[1] ?? null).length - JSON.stringify(b[1] ?? null).length);
    const out = {};
    for (let i = 0; i < entries.length; i++) {
      const [k, v] = entries[i];
      const remainingBudget = Math.max(80, budgetChars - JSON.stringify(out, null, 2).length);
      const candidateVal = shrinkJsonNode(v, Math.floor(remainingBudget * 0.6));
      const next = { ...out, [k]: candidateVal };
      if (JSON.stringify(next, null, 2).length > budgetChars && Object.keys(out).length > 0) {
        out.__truncated__ = `--- TRUNCATED: omitted ${entries.length - i} keys ---`;
        return out;
      }
      out[k] = candidateVal;
    }
    return out;
  }
  return String(val);
}

function truncateStructured(value, budgetChars) {
  const raw = JSON.stringify(value, null, 2);
  if (raw.length <= budgetChars) return { text: raw, truncated: false };
  const shrunk = shrinkJsonNode(value, Math.max(200, budgetChars));
  let text = JSON.stringify(shrunk, null, 2);
  if (text.length > budgetChars) {
    text = JSON.stringify(
      { truncated: "--- TRUNCATED ---", preview: raw.slice(0, Math.max(120, budgetChars - 80)) },
      null,
      2
    );
  }
  return { text, truncated: true };
}

// ── Persistent KV Memory Helpers ─────────────────────────────────────

function saveMemory(key, value, opts = {}) {
  const cleanKey = String(key);
  const project = String(opts.project ?? "");
  const branch = normalizeBranch(opts.branch);
  const tagsJson = JSON.stringify(normalizeTags(opts.tags));
  const json = JSON.stringify(value);
  const bytes = utf8Bytes(json);
  db.prepare(
    `INSERT INTO kv_memory(key, project, value_json, bytes, updated_at, branch, tags_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET project=excluded.project, value_json=excluded.value_json, bytes=excluded.bytes, updated_at=excluded.updated_at, branch=excluded.branch, tags_json=excluded.tags_json`
  ).run(cleanKey, project, json, bytes, Date.now(), branch, tagsJson);
  return { key: cleanKey, project, branch, tags: parseTagsJson(tagsJson), bytes };
}

function loadMemory(key) {
  const row = db.prepare("SELECT value_json FROM kv_memory WHERE key = ?").get(String(key));
  if (!row) return undefined;
  return JSON.parse(row.value_json);
}

function listMemory(projectOrOpts) {
  const opts =
    projectOrOpts && typeof projectOrOpts === "object"
      ? projectOrOpts
      : { project: projectOrOpts };
  const p = opts.project ? String(opts.project) : null;
  const b = typeof opts.branch === "string" && opts.branch.trim() ? normalizeBranch(opts.branch) : null;
  const reqTags = normalizeTags(opts.tags);
  const rows = db
    .prepare(
      `SELECT key, project, branch, tags_json, bytes, updated_at FROM kv_memory
       WHERE (? IS NULL OR project = ?)
         AND (? IS NULL OR branch = ?)
       ORDER BY updated_at DESC`
    )
    .all(p, p, b, b);
  return rows
    .map((r) => ({
      key: r.key,
      project: r.project,
      branch: r.branch || "main",
      tags: parseTagsJson(r.tags_json),
      bytes: r.bytes,
      updated_at: r.updated_at,
    }))
    .filter((r) => reqTags.length === 0 || reqTags.every((t) => r.tags.includes(t)));
}

// ── Glob & Sandbox Tools ─────────────────────────────────────────────

function globToRegex(pattern) {
  const norm = toPosix(pattern || "**/*").replace(/^\.\//, "");
  let re = "^";
  let i = 0;
  while (i < norm.length) {
    const ch = norm[i];
    if (ch === "*") {
      if (norm[i + 1] === "*") {
        if (norm[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
      } else {
        re += "[^/]*";
        i += 1;
      }
    } else if (ch === "?") {
      re += "[^/]";
      i += 1;
    } else if ("\\^$.|+()[]{}".includes(ch)) {
      re += "\\" + ch;
      i += 1;
    } else {
      re += ch;
      i += 1;
    }
  }
  re += "$";
  return new RegExp(re);
}

function formatLogArg(arg) {
  if (typeof arg === "string") return arg;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function quoteShellArg(val) {
  if (Array.isArray(val)) return val.map(quoteShellArg).join(" ");
  const s = String(val);
  if (s === "") return '""';
  if (/^[a-zA-Z0-9_./:-]+$/.test(s)) return s;
  if (process.platform === "win32") return `"${s.replace(/"/g, '\\"')}"`;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function findCommandOnPath(cmd) {
  const dirs = withDarwinPath(process.env.PATH || process.env.Path || "");
  const isWin = process.platform === "win32";
  const exts = isWin ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, cmd + (isWin && !path.extname(cmd) ? ext.toLowerCase() : ""));
      const fullUpper = path.join(dir, cmd + (isWin && !path.extname(cmd) ? ext : ""));
      for (const candidate of [full, fullUpper]) {
        try {
          const st = fsSync.statSync(candidate, { throwIfNoEntry: false });
          if (st && st.isFile()) return candidate;
        } catch {
          // ignore unreadable entries
        }
      }
    }
  }
  return null;
}

function buildSandboxTools(baseCwd, mode, defaultTimeoutMs, byteTracker) {
  const resolvePath = (target = ".") => path.resolve(baseCwd, String(target));
  const childEnv = buildChildEnv();

  async function walkFiles(dir, { ignore = [], maxFiles = 5000 } = {}) {
    const rootDir = resolvePath(dir);
    const ignoreSet = new Set([...DEFAULT_IGNORES, ...ignore]);
    const files = [];

    async function visit(currentDir) {
      if (files.length >= maxFiles) return;
      let entries;
      try {
        entries = await fs.readdir(currentDir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (files.length >= maxFiles) break;
        if (ignoreSet.has(entry.name)) continue;
        const full = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          await visit(full);
        } else if (entry.isFile()) {
          files.push(toPosix(path.relative(rootDir, full)));
        }
      }
    }

    await visit(rootDir);
    return files;
  }

  async function glob(pattern = "**/*", opts = {}) {
    const dir = opts.dir ?? ".";
    const regex = globToRegex(pattern);
    const all = await walkFiles(dir, {
      ignore: opts.ignore ?? [],
      maxFiles: opts.maxFiles ?? 5000,
    });
    return all.filter((rel) => regex.test(rel));
  }

  async function ls(dirPath = ".", opts = {}) {
    const rootDir = resolvePath(dirPath);
    const recursive = Boolean(opts.recursive);
    const maxDepth = typeof opts.depth === "number" ? opts.depth : recursive ? 10 : 1;
    const out = [];

    async function visit(currentDir, depth) {
      if (depth > maxDepth) return;
      const entries = await fs.readdir(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        if (DEFAULT_IGNORES.has(entry.name)) continue;
        const full = path.join(currentDir, entry.name);
        const rel = toPosix(path.relative(rootDir, full));
        out.push({
          path: rel,
          name: entry.name,
          type: entry.isDirectory() ? "dir" : entry.isFile() ? "file" : "other",
        });
        if (recursive && entry.isDirectory() && depth < maxDepth) {
          await visit(full, depth + 1);
        }
      }
    }

    await visit(rootDir, 1);
    return out;
  }

  async function stat(filePath) {
    const full = resolvePath(filePath);
    try {
      const s = await fs.stat(full);
      return { exists: true, isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size, mtimeMs: s.mtimeMs };
    } catch {
      return { exists: false, isFile: false, isDirectory: false, size: 0, mtimeMs: 0 };
    }
  }

  async function read(filePath, opts = {}) {
    const full = resolvePath(filePath);
    const text = await fs.readFile(full, "utf8");
    byteTracker.internalBytes += utf8Bytes(text);
    if (opts.startLine == null && opts.endLine == null) return text;
    const lines = text.split(/\r?\n/);
    const start = Math.max(1, Number(opts.startLine ?? 1));
    const end = Math.min(lines.length, Number(opts.endLine ?? lines.length));
    return lines.slice(start - 1, end).join("\n");
  }

  async function readJson(filePath) {
    return JSON.parse(await read(filePath));
  }

  async function readMany(paths, opts = {}) {
    return Promise.all(
      paths.map(async (p) => {
        try {
          const content = await read(p, opts);
          return {
            path: toPosix(p),
            content,
            lineCount: content === "" ? 0 : content.split(/\r?\n/).length,
            error: null,
          };
        } catch (err) {
          return { path: toPosix(p), content: null, lineCount: 0, error: err?.message ?? String(err) };
        }
      })
    );
  }

  async function outline(target = ".", opts = {}) {
    const rawTarget = String(target || ".");
    const isPattern = /[*?{}]/.test(rawTarget);
    if (!isPattern) {
      const s = await stat(rawTarget);
      if (s.isFile) {
        const text = await read(rawTarget);
        return { path: toPosix(rawTarget), ...extractOutline(text, rawTarget, opts) };
      }
    }
    const maxFiles = clampNumber(opts.maxFiles, 1, 50, 20);
    const matches = await glob(isPattern ? rawTarget : "**/*", {
      dir: isPattern ? opts.dir ?? "." : rawTarget,
      ignore: opts.ignore ?? [],
    });
    const outFiles = [];
    for (const rel of matches.slice(0, maxFiles)) {
      const fullTarget = isPattern ? path.join(opts.dir ?? ".", rel) : path.join(rawTarget, rel);
      try {
        const text = await read(fullTarget);
        outFiles.push({ path: toPosix(rel), ...extractOutline(text, rel, opts) });
      } catch {
        // skip binary/unreadable
      }
    }
    return { totalMatched: matches.length, shown: outFiles.length, files: outFiles };
  }

  async function readSymbol(filePath, symbolName, opts = {}) {
    const text = await read(filePath);
    return { path: toPosix(filePath), ...extractSymbolSlice(text, filePath, symbolName, opts) };
  }

  async function repoMap(target = ".", opts = {}) {
    const absTarget = resolvePath(target);
    const map = buildRepoMap(absTarget, opts);
    byteTracker.rawBytes += Buffer.byteLength(map.text || "", "utf8");
    return map;
  }

  function compactData(raw, opts = {}) {
    return compactStructuredData(raw, opts);
  }

  function toToon(value, opts = {}) {
    return encodeToon(value, opts);
  }

  function stripComments(code, filePath = "") {
    return stripSourceComments(code, filePath);
  }

  async function grep(pattern, opts = {}) {
    const dir = opts.dir ?? ".";
    const rootDir = resolvePath(dir);
    const globPattern = opts.glob ?? "**/*";
    const ignoreCase = Boolean(opts.ignoreCase);
    const maxMatches = clampNumber(opts.maxMatches, 1, 5000, 200);
    const contextLines = clampNumber(opts.contextLines, 0, 20, 0);
    const maxFileBytes = clampNumber(opts.maxFileBytes, 1024, 20 * 1024 * 1024, 1048576);

    let rx;
    if (isRegExpLike(pattern)) {
      const flags = pattern.flags.replace(/g/g, "") + (ignoreCase && !pattern.flags.includes("i") ? "i" : "");
      rx = new RegExp(pattern.source, flags);
    } else {
      const flags = ignoreCase ? "i" : "";
      try {
        rx = new RegExp(String(pattern), flags);
      } catch {
        rx = new RegExp(String(pattern).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
      }
    }

    const candidates = await glob(globPattern, { dir, ignore: opts.ignore ?? [] });
    const matches = [];
    let scannedFiles = 0;
    let truncated = false;

    for (const rel of candidates) {
      if (matches.length >= maxMatches) {
        truncated = true;
        break;
      }
      const full = path.join(rootDir, rel);
      let st;
      try {
        st = await fs.stat(full);
      } catch {
        continue;
      }
      if (!st.isFile() || st.size > maxFileBytes) continue;

      let buf;
      try {
        buf = await fs.readFile(full);
      } catch {
        continue;
      }
      if (buf.subarray(0, 4096).includes(0)) continue;
      scannedFiles += 1;
      byteTracker.internalBytes += buf.length;

      const lines = buf.toString("utf8").split(/\r?\n/);
      for (let idx = 0; idx < lines.length; idx++) {
        if (rx.test(lines[idx])) {
          const item = { file: rel, line: idx + 1, text: lines[idx] };
          if (contextLines > 0) {
            const from = Math.max(0, idx - contextLines);
            const to = Math.min(lines.length, idx + contextLines + 1);
            item.context = lines.slice(from, to);
          }
          matches.push(item);
          if (matches.length >= maxMatches) {
            truncated = true;
            break;
          }
        }
      }
    }

    return { scannedFiles, totalMatches: matches.length, truncated, matches };
  }

  async function shell(cmd, opts = {}) {
    const runCwd = opts.cwd ? resolvePath(opts.cwd) : baseCwd;
    const timeout = clampNumber(opts.timeout, 100, 300000, defaultTimeoutMs);
    try {
      const { stdout, stderr } = await execAsync(String(cmd), {
        cwd: runCwd,
        env: childEnv,
        timeout,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      });
      const out = stdout ?? "";
      const err = stderr ?? "";
      byteTracker.internalBytes += utf8Bytes(out) + utf8Bytes(err);
      return { code: 0, stdout: out, stderr: err };
    } catch (err) {
      const out = err?.stdout ?? "";
      const errOut = err?.stderr || err?.message || String(err);
      byteTracker.internalBytes += utf8Bytes(out) + utf8Bytes(errOut);
      return {
        code: typeof err?.code === "number" ? err.code : 1,
        stdout: out,
        stderr: errOut,
      };
    }
  }

  function makeShellTag() {
    const makeChain = (cmdStr, throwOnError = true) => {
      const run = async () => {
        const res = await shell(cmdStr);
        if (throwOnError && res.code !== 0) {
          throw new Error(`Command failed (${res.code}): ${cmdStr}\n${res.stderr || res.stdout}`);
        }
        return res;
      };
      return {
        nothrow() {
          return makeChain(cmdStr, false);
        },
        then(onFulfilled, onRejected) {
          return run().then(onFulfilled, onRejected);
        },
        catch(onRejected) {
          return run().catch(onRejected);
        },
        async text() {
          const res = await run();
          return res.stdout;
        },
        async lines() {
          const res = await run();
          return res.stdout
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean);
        },
        async json() {
          const res = await run();
          return JSON.parse(res.stdout);
        },
        async compact(kind = "auto") {
          const res = await run();
          const compactOpts = typeof kind === "string"
            ? { kind, commandHint: cmdStr }
            : { ...(kind || {}), commandHint: cmdStr };
          return compactOutput([res.stdout, res.stderr].filter(Boolean).join("\n"), compactOpts);
        },
      };
    };

    return (strings, ...values) => {
      let cmd = strings[0] ?? "";
      for (let i = 0; i < values.length; i++) {
        cmd += quoteShellArg(values[i]) + (strings[i + 1] ?? "");
      }
      return makeChain(cmd.trim(), true);
    };
  }

  function assertWriteAllowed(action) {
    if (mode !== "write") {
      throw new Error(`Permission denied: ${action} requires mode='write'`);
    }
  }

  async function write(filePath, content) {
    assertWriteAllowed("write");
    const full = resolvePath(filePath);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, String(content), "utf8");
    return { file: toPosix(filePath), bytes: utf8Bytes(String(content)) };
  }

  async function replace(filePath, search, replacement, opts = {}) {
    const dryRun = Boolean(opts.dryRun);
    const all = opts.all !== false;
    if (!dryRun) assertWriteAllowed("replace");

    const full = resolvePath(filePath);
    const original = await fs.readFile(full, "utf8");
    byteTracker.internalBytes += utf8Bytes(original);
    let updated = original;
    let replacements = 0;

    if (isRegExpLike(search)) {
      let flags = search.flags;
      if (all && !flags.includes("g")) flags += "g";
      if (!all && flags.includes("g")) flags = flags.replace(/g/g, "");
      const rx = new RegExp(search.source, flags);
      updated = original.replace(rx, (...args) => {
        replacements += 1;
        return typeof replacement === "function" ? replacement(...args) : String(replacement);
      });
    } else {
      const needle = String(search);
      const rep = String(replacement);
      if (needle.length > 0) {
        if (all) {
          const parts = original.split(needle);
          replacements = parts.length - 1;
          if (replacements > 0) updated = parts.join(rep);
        } else {
          const idx = original.indexOf(needle);
          if (idx !== -1) {
            replacements = 1;
            updated = original.slice(0, idx) + rep + original.slice(idx + needle.length);
          }
        }
      }
    }

    const changed = replacements > 0 && updated !== original;
    if (!dryRun && changed) {
      await fs.writeFile(full, updated, "utf8");
    }

    return { file: toPosix(filePath), replacements, changed, dryRun };
  }

  async function edit(filePath, oldStr, newStr, opts = {}) {
    return replace(filePath, oldStr, newStr, { ...opts, all: Boolean(opts.all) });
  }

  async function batchReplace(files, search, replacement, opts = {}) {
    const dryRun = Boolean(opts.dryRun);
    if (!dryRun) assertWriteAllowed("batchReplace");
    const touched = [];
    let totalReplacements = 0;
    for (const f of files) {
      const res = await replace(f, search, replacement, opts);
      if (res.replacements > 0) {
        touched.push({ file: res.file, replacements: res.replacements });
        totalReplacements += res.replacements;
      }
    }
    return { dryRun, scanned: files.length, modified: touched.length, totalReplacements, files: touched };
  }

  async function fetchText(url, opts = {}) {
    const timeoutMs = clampNumber(opts.timeoutMs, 1000, 60000, 15000);
    const res = await fetch(String(url), {
      headers: {
        "User-Agent": "Mozilla/5.0 Antigravity-SaveToken/1.0",
        Accept: "text/html,application/json,text/plain;q=0.9,*/*;q=0.8",
        ...(opts.headers ?? {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await res.text();
    byteTracker.internalBytes += utf8Bytes(raw);
    const contentType = (res.headers.get("content-type") || "").toLowerCase();

    if (
      res.status === 403 ||
      res.status === 429 ||
      /sorry\/index|g-recaptcha|hcaptcha|cf-turnstile|verify you are human/i.test(raw)
    ) {
      throw new Error(`Blocked/CAPTCHA (${res.status}) at ${url} — stop and report to user`);
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} fetching ${url}`);
    }

    if (contentType.includes("application/json")) {
      return { status: res.status, contentType, json: JSON.parse(raw), text: raw };
    }
    if (contentType.includes("text/html") || /^\s*<!doctype\s+html|^\s*<html/i.test(raw)) {
      return { status: res.status, contentType, text: htmlToCleanText(raw) };
    }
    return { status: res.status, contentType, text: raw };
  }

  function detectClis(extraNames = []) {
    const list = [
      "git",
      "gh",
      "node",
      "python",
      "ffmpeg",
      "ffprobe",
      "curl",
      "uvx",
      "npx",
      "rtk",
      "agent-browser",
      "playwright-cli",
      "mcp2cli",
      "gdrive",
      "gsheets",
      "capcut",
      "obsidian",
      ...extraNames,
    ];
    const available = [];
    const missing = [];
    for (const name of [...new Set(list)]) {
      const p = findCommandOnPath(name);
      if (p) available.push({ name, path: toPosix(p) });
      else missing.push(name);
    }
    return { available, missing };
  }

  function index(label, text, opts = {}) {
    const info = indexIntoStore(label, String(text), DEFAULT_CHUNK_BYTES, opts);
    return { source: info.label, branch: info.branch, chunks: info.chunkCount, bytes: info.bytesTotal };
  }

  function search(queries, opts = {}) {
    const list = Array.isArray(queries) ? queries : [queries];
    const limit = opts.limit ?? 5;
    const seen = new Set();
    const hits = [];
    for (const q of list) {
      for (const h of queryStore(q, { source: opts.source, branch: opts.branch, tags: opts.tags, limit })) {
        const k = `${h.source}:${h.ord}`;
        if (seen.has(k)) continue;
        seen.add(k);
        hits.push(h);
      }
    }
    return hits;
  }

  function spawnBg(cmd, opts = {}) {
    const runCwd = opts.cwd ? resolvePath(opts.cwd) : baseCwd;
    const jobId = `job-${++jobSeq}`;
    const stdoutBufs = [];
    const stderrBufs = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const waiters = [];

    const child = spawn(String(cmd), {
      cwd: runCwd,
      env: childEnv,
      shell: true,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const record = {
      jobId,
      cmd: String(cmd),
      pid: child.pid ?? null,
      status: "running",
      exitCode: null,
      startedAt: Date.now(),
      finishedAt: null,
      getOutput() {
        return {
          stdout: Buffer.concat(stdoutBufs).toString("utf8"),
          stderr: Buffer.concat(stderrBufs).toString("utf8"),
        };
      },
      wait(ms) {
        if (settled) return Promise.resolve();
        return new Promise((resolve) => {
          const timer = setTimeout(resolve, ms);
          waiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      },
      kill() {
        if (settled) return false;
        record.status = "killed";
        killTree(child.pid);
        return true;
      },
    };

    const finish = (status, code) => {
      if (settled) return;
      settled = true;
      if (record.status === "running") record.status = status;
      record.exitCode = code;
      record.finishedAt = Date.now();
      while (waiters.length > 0) waiters.shift()();
    };

    child.stdout?.on("data", (chunk) => {
      if (stdoutBytes < MAX_BG_STREAM_BYTES) {
        stdoutBufs.push(chunk);
        stdoutBytes += chunk.length;
      }
    });
    child.stderr?.on("data", (chunk) => {
      if (stderrBytes < MAX_BG_STREAM_BYTES) {
        stderrBufs.push(chunk);
        stderrBytes += chunk.length;
      }
    });
    child.on("close", (code) => finish(code === 0 ? "done" : "error", code));
    child.on("error", (err) => {
      stderrBufs.push(Buffer.from(err?.message ?? String(err), "utf8"));
      finish("error", 1);
    });

    jobs.set(jobId, record);
    return { jobId, pid: record.pid, status: "running" };
  }

  function distill(items, opts = {}) {
    const arr = Array.isArray(items) ? items : [];
    const limit = clampNumber(opts.limit, 1, 1000, 30);
    if (typeof opts.groupBy === "function") {
      const groups = {};
      for (const item of arr) {
        const key = String(opts.groupBy(item));
        if (!groups[key]) groups[key] = [];
        groups[key].push(item);
      }
      const summarized = Object.entries(groups).map(([key, list]) => ({
        key,
        count: list.length,
        sample: list.slice(0, limit),
      }));
      return {
        total: arr.length,
        shown: Math.min(arr.length, summarized.length),
        omitted: Math.max(0, arr.length - summarized.length),
        groups: summarized,
      };
    }
    const shownItems = arr.slice(0, limit);
    return { total: arr.length, shown: shownItems.length, omitted: Math.max(0, arr.length - shownItems.length), items: shownItems };
  }

  return {
    tools: {
      cwd: toPosix(baseCwd),
      mode,
      state: sessionState,
      glob,
      ls,
      stat,
      read,
      readJson,
      readMany,
      outline,
      readSymbol,
      repoMap,
      grep,
      shell,
      write,
      edit,
      replace,
      batchReplace,
      compactOutput,
      compactData,
      toToon,
      stripComments,
      fetchText,
      detectClis,
      saveMemory,
      loadMemory,
      listMemory,
      index,
      search,
      spawnBg,
      distill,
    },
    $: makeShellTag(),
  };
}

// ── Transcript Extractor for Zero-LLM Handoff ────────────────────────

const NOISE_PATH_RE = /\/(?:\.system_generated|browser_sandbox|tempmediaStorage)\/|\.metadata\.json$/i;

function clipInline(text, maxLen) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (!s || s.length <= maxLen) return s;
  return `${s.slice(0, Math.max(0, maxLen - 1)).trimEnd()}…`;
}

function clipBlock(text, maxLen) {
  const s = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!s || s.length <= maxLen) return s;
  return `${s.slice(0, Math.max(0, maxLen - 14)).trimEnd()}\n…[trimmed]`;
}

function stripWrapperTags(text) {
  return String(text || "")
    .replace(/<(voice_instructions|talker_agent_context|ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|SYSTEM_MESSAGE)>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(voice_instructions|talker_agent_context|ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|SYSTEM_MESSAGE)>[\s\S]*?(?=\r?\n#|$)/gi, " ")
    .replace(/<\/?USER_REQUEST>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanCheckpointSummary(raw) {
  const cleaned = String(raw || "")
    .replace(/<(voice_instructions|talker_agent_context|ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|SYSTEM_MESSAGE)>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(voice_instructions|talker_agent_context|ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|SYSTEM_MESSAGE)>[\s\S]*?(?=\r?\n#|$)/gi, " ")
    .replace(/<\/?USER_REQUEST>/gi, " ")
    .replace(/^#\s*Resuming from a compaction\s*/i, "")
    .replace(/^You are continuing work on the task described above[\s\S]*?This summary was generated at[^\n]*\n?/i, "")
    .replace(/(?:^|\r?\n)#\s*User Requests[\s\S]*?(?=\r?\n##\s|$)/i, "")
    .trim();

  const picked = [];
  for (const heading of ["## 1. Task Overview", "## 6. Active Context", "## 8. Next Steps"]) {
    const idx = cleaned.indexOf(heading);
    if (idx < 0) continue;
    const after = cleaned.slice(idx);
    const nextSec = after.slice(heading.length).search(/\r?\n##\s/);
    const block = nextSec >= 0 ? after.slice(0, heading.length + nextSec) : after;
    picked.push(clipBlock(block.trim(), 220));
  }
  return picked.length > 0 ? clipBlock(picked.join("\n"), 500) : clipBlock(cleaned, 480);
}

function extractVoiceUserUtterances(text) {
  const utterances = [];
  const blockRe = /<talker_agent_context>([\s\S]*?)<\/talker_agent_context>/gi;
  let match;
  while ((match = blockRe.exec(String(text))) !== null) {
    for (const rawLine of match[1].split(/\r?\n/)) {
      const m = rawLine.trim().match(/^\[[^\]]+\]\s*user:\s*"(.*)"\s*$/i);
      if (!m) continue;
      const cleaned = m[1].replace(/\\"/g, '"').replace(/\s+/g, " ").trim();
      if (cleaned) utterances.push(cleaned);
    }
  }
  return utterances;
}

function findTranscriptInDir(convDir) {
  const full = path.join(convDir, ".system_generated", "logs", "transcript_full.jsonl");
  if (fsSync.existsSync(full)) return full;
  const compact = path.join(convDir, ".system_generated", "logs", "transcript.jsonl");
  if (fsSync.existsSync(compact)) return compact;
  return "";
}

function resolveAntigravityConversation(targetArg) {
  const root = ANTIGRAVITY_BRAIN_DIR;
  if (!fsSync.existsSync(root)) {
    throw new Error(`Antigravity brain directory not found: ${toPosix(root)}`);
  }
  const currentId = String(process.env.ANTIGRAVITY_CONVERSATION_ID || "").toLowerCase();
  const entries = fsSync
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== "tempmediaStorage")
    .map((d) => {
      const dirPath = path.join(root, d.name);
      const transcriptPath = findTranscriptInDir(dirPath);
      if (!transcriptPath) return null;
      return { id: d.name, dirPath, transcriptPath, stat: fsSync.statSync(transcriptPath) };
    })
    .filter(Boolean);

  if (entries.length === 0) {
    throw new Error(`No conversation transcripts found under ${toPosix(root)}`);
  }

  const query = String(targetArg || "").trim();
  if (!query || query.toLowerCase() === "latest") {
    const filtered = entries
      .filter((e) => !currentId || e.id.toLowerCase() !== currentId)
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    return filtered[0] || entries.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)[0];
  }

  const lower = query.toLowerCase();
  const exact = entries.find((e) => e.id.toLowerCase() === lower);
  if (exact) return exact;

  if (lower.length < 6) {
    throw new Error(`Conversation ID prefix "${query}" is too short (need >= 6 chars, full UUID, or "latest").`);
  }
  const matches = entries.filter((e) => e.id.toLowerCase().startsWith(lower));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(`Ambiguous conversation prefix "${query}": ${matches.map((m) => m.id).join(", ")}`);
  }
  throw new Error(`Conversation not found: "${query}"`);
}

function inferWorkspaceRoot(filePaths) {
  const counts = new Map();
  for (const fp of filePaths) {
    if (/\/\.gemini\/antigravity\/brain\//i.test(fp)) continue;
    const m =
      fp.match(/^([A-Za-z]:\/(?:Users\/[^/]+\/\.gemini\/antigravity\/scratch\/[^/]+|[^/]+\/[^/]+))/i) ||
      fp.match(/^(\/(?:Users|home)\/[^/]+\/[^/]+\/[^/]+)/);
    if (!m) continue;
    counts.set(m[1], (counts.get(m[1]) || 0) + 1);
  }
  let best = "";
  let bestScore = 0;
  for (const [dir, n] of counts.entries()) {
    if (n > bestScore) {
      best = dir;
      bestScore = n;
    }
  }
  return best;
}

function listConvArtifacts(convDir) {
  if (!convDir || !fsSync.existsSync(convDir)) return [];
  try {
    return fsSync
      .readdirSync(convDir, { withFileTypes: true })
      .filter((e) => e.isFile() && /\.md$/i.test(e.name) && !/\.metadata\.json$/i.test(e.name))
      .map((e) => e.name)
      .slice(0, 12);
  } catch {
    return [];
  }
}

async function extractTranscriptFacts(transcriptFile, convDir = "") {
  const empty = {
    loaded: false,
    stepCount: 0,
    userTurnCount: 0,
    firstUserPrompt: "",
    userPrompts: [],
    assistantReplies: [],
    lastPlan: "",
    lastCheckpoint: "",
    touchedFiles: [],
    artifacts: [],
    workspace: "",
    recentErrors: [],
  };
  if (!transcriptFile || !fsSync.existsSync(transcriptFile)) return empty;

  let firstUserPrompt = "";
  const userPrompts = [];
  const seenPrompts = new Set();
  const touchedFiles = new Map();
  const assistantReplies = [];
  const recentErrors = [];
  let lastPlan = "";
  let lastCheckpoint = "";
  let stepCount = 0;
  let userTurnCount = 0;

  const pushPrompt = (txt) => {
    const val = clipInline(txt, 200);
    if (!val || seenPrompts.has(val)) return;
    seenPrompts.add(val);
    if (!firstUserPrompt) firstUserPrompt = val;
    userPrompts.push(val);
    if (userPrompts.length > 7) userPrompts.shift();
  };

  const touchFile = (rawPath) => {
    const p = toPosix(String(rawPath || "").trim());
    if (!p || NOISE_PATH_RE.test(p)) return;
    const prev = touchedFiles.get(p) || 0;
    touchedFiles.delete(p);
    touchedFiles.set(p, prev + 1);
  };

  const pushError = (txt) => {
    const val = clipInline(txt, 180);
    if (!val || recentErrors[recentErrors.length - 1] === val) return;
    recentErrors.push(val);
    if (recentErrors.length > 3) recentErrors.shift();
  };

  const rl = readline.createInterface({
    input: fsSync.createReadStream(transcriptFile, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const ln of rl) {
    if (!ln.trim()) continue;
    let o;
    try {
      o = JSON.parse(ln);
    } catch {
      continue;
    }
    stepCount += 1;
    const type = String(o.type || "");
    const content = typeof o.content === "string" ? o.content : "";

    if (type === "USER_INPUT") {
      userTurnCount += 1;
      const rawInput = content || JSON.stringify(o);
      for (const u of extractVoiceUserUtterances(rawInput)) pushPrompt(u);
      pushPrompt(stripWrapperTags(rawInput));
    } else if (type === "PLANNER_RESPONSE") {
      if (content.trim().length > 20) {
        assistantReplies.push(content.trim());
        if (assistantReplies.length > 2) assistantReplies.shift();
      }
      if (Array.isArray(o.tool_calls)) {
        for (const tc of o.tool_calls) {
          const name = String(tc?.name || "");
          const tcArgs = tc?.args || tc?.arguments || {};
          if (name === "edit_file" || name === "write_file") {
            touchFile(tcArgs.Path || tcArgs.path || "");
          } else if (name === "exit_plan_mode" && typeof tcArgs.plan === "string" && tcArgs.plan.trim()) {
            lastPlan = clipBlock(tcArgs.plan, 500);
          }
        }
      }
    } else if (type === "CHECKPOINT" && content.trim()) {
      lastCheckpoint = cleanCheckpointSummary(content);
    } else if (type === "ERROR_MESSAGE") {
      pushError(content || JSON.stringify(o));
    } else if (type === "GENERIC" && content) {
      if (/Created file|Made \d+ replacement|write_file|edit_file/i.test(content)) {
        const matches = content.match(/(?:[A-Za-z]:[\\/]|\/(?:Users|home|opt|etc|tmp|var)\/)[^\s"'`<>]+/g) || [];
        for (const m of matches) touchFile(m);
      }
      if (/Command exited with code [1-9]|Encountered error in/i.test(content)) {
        pushError(content);
      }
    }
  }

  const orderedFiles = [...touchedFiles.keys()].reverse().slice(0, 12);
  return {
    loaded: true,
    stepCount,
    userTurnCount,
    firstUserPrompt,
    userPrompts,
    assistantReplies,
    lastPlan,
    lastCheckpoint,
    touchedFiles: orderedFiles,
    artifacts: listConvArtifacts(convDir),
    workspace: inferWorkspaceRoot([...touchedFiles.keys()]),
    recentErrors,
  };
}

// ── Handlers for the 6 MCP Tools ─────────────────────────────────────

async function executeCodeMode(args = {}) {
  metrics.calls.exec += 1;
  const startMs = Date.now();
  const code = typeof args.code === "string" ? args.code : "";
  if (!code.trim()) {
    return { isError: true, text: "Invalid arguments: 'code' must be a non-empty string." };
  }
  if (args.resetState === true) {
    sessionState = Object.create(null);
  }

  const cwd = args.cwd ? path.resolve(String(args.cwd)) : process.cwd();
  const mode = args.mode === "write" ? "write" : "readonly";
  const intent = typeof args.intent === "string" ? args.intent.trim() : "";
  const timeoutMs = clampNumber(args.timeoutMs, 1000, 300000, 30000);
  const maxOutputChars = clampNumber(args.maxOutputChars, 500, 32000, 8000);

  const logs = [];
  const captureLog =
    (prefix) =>
    (...items) => {
      logs.push((prefix ? `[${prefix}] ` : "") + items.map(formatLogArg).join(" "));
    };

  const byteTracker = { internalBytes: 0 };
  const { tools: sandboxTools, $ } = buildSandboxTools(cwd, mode, timeoutMs, byteTracker);

  const context = vm.createContext({
    tools: sandboxTools,
    state: sessionState,
    $,
    console: {
      log: captureLog(""),
      warn: captureLog("WARN"),
      error: captureLog("ERROR"),
    },
    JSON,
    Math,
    Date,
    RegExp,
    Map,
    Set,
    Promise,
    URL,
    Buffer,
    TextEncoder,
    TextDecoder,
    Intl,
    setTimeout,
    clearTimeout,
  });

  const wrapped = `(async () => {\n${code}\n})()`;
  let timer;
  try {
    const executionPromise = vm.runInContext(wrapped, context, { timeout: timeoutMs });
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Execution timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    const result = await Promise.race([executionPromise, timeoutPromise]);

    const logSection = logs.length > 0 ? `--- logs ---\n${logs.join("\n")}\n` : "";
    const isStructured = result !== undefined && typeof result === "object" && result !== null;
    const rawResultStr =
      result === undefined ? (logs.length === 0 ? "undefined" : "") : typeof result === "string" ? result : JSON.stringify(result, null, 2);
    const fullBody = `${logSection}${rawResultStr}`.trimEnd();

    const elapsedMs = Date.now() - startMs;
    const rawOutputBytes = utf8Bytes(fullBody);
    const processedBytes = Math.max(byteTracker.internalBytes, rawOutputBytes);

    let outBody = fullBody;
    let indexedLabel = null;
    const reserve = 150;
    const bodyBudget = Math.max(250, maxOutputChars - reserve);

    if (fullBody.length > maxOutputChars || (intent && fullBody.length > 0)) {
      const label = `exec:${++execSeq}-${Date.now().toString(36)}`;
      const { sourceId } = indexIntoStore(label, fullBody, Math.min(DEFAULT_CHUNK_BYTES, Math.max(512, Math.floor(bodyBudget * 0.7))));
      indexedLabel = label;

      if (intent) {
        outBody = selectChunksForBudget(sourceId, intent, bodyBudget);
      } else if (isStructured && !logSection) {
        outBody = truncateStructured(result, bodyBudget).text;
      } else if (fullBody.length > maxOutputChars) {
        outBody = selectChunksForBudget(sourceId, "", bodyBudget);
      }
    }

    const outBytes = utf8Bytes(outBody);
    const indexTag = indexedLabel ? ` | INDEXED as "${indexedLabel}"` : "";
    const guardTag =
      outBytes >= 9000
        ? " | WARN: output >=9KB risks host output.txt spill; filter in JS or lower maxOutputChars"
        : indexedLabel && !intent
          ? ` | TIP: filter in JS or query via save_token_search(source="${indexedLabel}")`
          : "";
    const finalText = `${outBody}\n[save-token | ${elapsedMs}ms | mode=${mode} | raw=${processedBytes}B | returned=${outBytes}B${indexTag}${guardTag}]`;
    const finalBytes = utf8Bytes(finalText);
    metrics.rawBytes += processedBytes;
    metrics.returnedBytes += finalBytes;
    recordMetricEvent("exec", processedBytes, finalBytes, toPosix(cwd));
    return { isError: false, text: finalText };
  } catch (err) {
    const elapsedMs = Date.now() - startMs;
    const msg = err?.stack || err?.message || String(err);
    const logPrefix = logs.length > 0 ? `--- logs ---\n${logs.join("\n")}\n` : "";
    const text = `${logPrefix}Error: ${msg}\n[save-token | ${elapsedMs}ms | mode=${mode} | failed]`;
    const errRaw = Math.max(byteTracker.internalBytes, utf8Bytes(text));
    const errRet = utf8Bytes(text);
    metrics.rawBytes += errRaw;
    metrics.returnedBytes += errRet;
    recordMetricEvent("exec_error", errRaw, errRet, toPosix(cwd));
    return { isError: true, text };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function executePoll(args = {}) {
  metrics.calls.poll += 1;
  const jobId = typeof args.jobId === "string" ? args.jobId : "";
  const rec = jobs.get(jobId);
  if (!rec) {
    return { isError: true, text: `Unknown jobId: "${jobId}"` };
  }

  if (args.kill === true) rec.kill();
  const waitMs = clampNumber(args.waitMs, 0, 30000, 0);
  if (waitMs > 0 && rec.status === "running") {
    await rec.wait(waitMs);
  }

  const intent = typeof args.intent === "string" ? args.intent.trim() : "";
  const maxOutputChars = clampNumber(args.maxOutputChars, 500, 32000, 8000);
  const { stdout, stderr } = rec.getOutput();
  let combined = [stdout, stderr ? `--- stderr ---\n${stderr}` : ""].filter(Boolean).join("\n").trim();
  const rawBytes = utf8Bytes(combined);
  if (args.compact === true && combined) {
    combined = compactOutput(combined);
  }
  const elapsedMs = (rec.finishedAt ?? Date.now()) - rec.startedAt;

  let display = combined;
  let indexedLabel = null;
  if (combined.length > maxOutputChars || (intent && combined.length > 0)) {
    const label = `job:${jobId}`;
    const { sourceId } = indexIntoStore(label, combined, Math.min(DEFAULT_CHUNK_BYTES, Math.max(512, Math.floor((maxOutputChars - 160) * 0.7))));
    indexedLabel = label;
    display = selectChunksForBudget(sourceId, intent, Math.max(250, maxOutputChars - 160));
  }

  const header = `[poll ${jobId} | status=${rec.status} | exit=${rec.exitCode} | elapsed=${elapsedMs}ms${indexedLabel ? ` | INDEXED as "${indexedLabel}"` : ""}]`;
  const finalText = display ? `${header}\n${display}` : header;
  const pollRetBytes = utf8Bytes(finalText);
  metrics.rawBytes += rawBytes;
  metrics.returnedBytes += pollRetBytes;
  recordMetricEvent("poll", rawBytes, pollRetBytes, "");
  return { isError: false, text: finalText };
}

function executeSearch(args = {}) {
  metrics.calls.search += 1;
  const queries = Array.isArray(args.queries) ? args.queries.map(String) : [];
  if (queries.length === 0) {
    return { isError: true, text: "Invalid arguments: 'queries' must be a non-empty string array." };
  }
  const source = typeof args.source === "string" && args.source.trim() ? args.source.trim() : undefined;
  const branch = typeof args.branch === "string" && args.branch.trim() ? normalizeBranch(args.branch) : undefined;
  const tags = normalizeTags(args.tags);
  const limit = clampNumber(args.limit, 1, 20, 5);
  const maxOutputChars = clampNumber(args.maxOutputChars, 500, 32000, 8000);

  const seen = new Set();
  const sections = [];
  let used = 0;

  for (const q of queries) {
    const hits = queryStore(q, { source, branch, tags, limit });
    const scopeLabel = [branch ? `branch=${branch}` : "", tags.length ? `tags=${tags.join(",")}` : ""].filter(Boolean).join(" | ");
    const lines = [`## Query: ${q}${scopeLabel ? ` [${scopeLabel}]` : ""}`];
    if (hits.length === 0) {
      lines.push(scopeLabel ? "(no matches in scope)" : "(no matches)");
    } else {
      for (const h of hits) {
        const k = `${h.sourceId}:${h.ord}`;
        if (seen.has(k)) continue;
        seen.add(k);
        const branchTag = h.branch && h.branch !== "main" ? ` | branch=${h.branch}` : "";
        const tagsPart = h.tags && h.tags.length > 0 ? ` | tags=${h.tags.join(",")}` : "";
        const head = `[${h.source} #${h.ord}${h.title ? ` | ${h.title}` : ""}${branchTag}${tagsPart} | ${h.tier}]`;
        const block = `${head}\n${h.body}`;
        if (used + block.length > maxOutputChars - 120 && sections.length > 0) break;
        lines.push(block);
        used += block.length;
      }
    }
    sections.push(lines.join("\n"));
  }

  const totalIndexedBytes = Number(db.prepare("SELECT COALESCE(SUM(bytes_total), 0) AS n FROM sources").get().n);
  const out = sections.join("\n\n").slice(0, maxOutputChars);
  const searchRetBytes = utf8Bytes(out);
  metrics.rawBytes += totalIndexedBytes;
  metrics.returnedBytes += searchRetBytes;
  recordMetricEvent("search", totalIndexedBytes, searchRetBytes, "");
  return { isError: false, text: out };
}

function stripSourceSigHeader(text) {
  return String(text || "").replace(/^<!--\s*source-sig:[^>]*-->\r?\n/, "");
}

function writeBranchProgressFile(branch, meta = {}) {
  const cleanBranch = normalizeBranch(branch);
  const progressPath = toPosix(path.join(PROGRESS_DIR, `${cleanBranch}.md`));
  if (!isSafePathWithin(progressPath, PROGRESS_DIR)) return "";

  const tags = normalizeTags(meta.tags);
  const branchMem = listMemory({ branch: cleanBranch }).slice(0, 8);
  const branchSources = db
    .prepare("SELECT label, bytes_total AS bytes, tags_json FROM sources WHERE branch = ? ORDER BY id DESC LIMIT 10")
    .all(cleanBranch)
    .map((r) => ({ label: r.label, bytes: r.bytes, tags: parseTagsJson(r.tags_json) }));

  const lines = [
    `# Progress Branch: ${cleanBranch}`,
    `- Updated: ${new Date().toISOString()}`,
    ...(meta.project ? [`- Project: ${meta.project}`] : []),
    ...(tags.length ? [`- Tags: ${tags.join(", ")}`] : []),
    ...(meta.handoffId ? [`- Latest Handoff: ${meta.handoffId} (${meta.title || ""})`] : []),
  ];

  if (meta.summaryMd) {
    lines.push("", "## Active Snapshot", clipBlock(stripSourceSigHeader(meta.summaryMd), 1300));
  }
  if (branchMem.length > 0) {
    lines.push("", "## Branch Memory (`kv_memory`)");
    for (const m of branchMem) {
      lines.push(`- \`${m.key}\`${m.tags?.length ? ` [${m.tags.join(",")}]` : ""} (${m.bytes}B)`);
    }
  }
  if (branchSources.length > 0) {
    lines.push("", "## Scoped Sources (`save_token_search`)");
    for (const s of branchSources) {
      lines.push(`- \`${s.label}\`${s.tags.length ? ` [${s.tags.join(",")}]` : ""} (${s.bytes}B)`);
    }
  }
  const sampleTagArg = tags.length ? `, tags: ${JSON.stringify(tags)}` : "";
  lines.push("", "## Quick Recall", `- \`save_token_search({ queries: ["<keyword>"], branch: "${cleanBranch}"${sampleTagArg} })\``);

  const md = capBytes(lines.join("\n").trim(), 2600).text.trimEnd() + "\n";
  fsSync.mkdirSync(PROGRESS_DIR, { recursive: true });
  fsSync.writeFileSync(progressPath, md, "utf8");
  return progressPath;
}

async function executeHandoff(args = {}) {
  metrics.calls.handoff += 1;
  const rawTitle = typeof args.title === "string" ? args.title.trim() : "";
  const convArg = typeof args.conversationId === "string" ? args.conversationId.trim() : "";
  const explicitTranscript = typeof args.transcriptPath === "string" ? args.transcriptPath.trim() : "";

  if (!rawTitle && !convArg && !explicitTranscript) {
    return { isError: true, text: "Invalid arguments: provide 'title', 'conversationId', or 'transcriptPath'." };
  }

  const isPureAuto =
    Boolean(convArg) &&
    !explicitTranscript &&
    !args.goal &&
    !(Array.isArray(args.decisions) && args.decisions.length > 0) &&
    !(Array.isArray(args.nextSteps) && args.nextSteps.length > 0) &&
    !(Array.isArray(args.openRisks) && args.openRisks.length > 0) &&
    !(Array.isArray(args.saveStateKeys) && args.saveStateKeys.length > 0);
  const maxChars = clampNumber(args.maxChars, 800, 8000, isPureAuto ? 3800 : 2400);
  const projectArg = typeof args.project === "string" ? args.project.trim() : "";
  const rawBranchArg = typeof args.branch === "string" ? args.branch.trim() : "";
  const hasExplicitBranch = rawBranchArg.length > 0 && rawBranchArg.toLowerCase() !== "auto";
  const tagsArg = normalizeTags(args.tags);

  let resolvedConv = null;
  let resolvedConvId = convArg;
  let transcriptFile = explicitTranscript;
  let convDir = "";

  if (!transcriptFile && convArg) {
    try {
      resolvedConv = resolveAntigravityConversation(convArg);
      resolvedConvId = resolvedConv.id;
      transcriptFile = resolvedConv.transcriptPath;
      convDir = resolvedConv.dirPath;
    } catch (err) {
      return { isError: true, text: err?.message || String(err) };
    }
  } else if (transcriptFile && /[\\/]\.system_generated[\\/]logs[\\/]/i.test(transcriptFile)) {
    convDir = path.dirname(path.dirname(path.dirname(transcriptFile)));
  }

  const sourceSig = resolvedConv
    ? `<!-- source-sig:${Math.trunc(resolvedConv.stat.mtimeMs)}:${resolvedConv.stat.size}:${maxChars} -->`
    : "";

  const scriptPath = toPosix(
    path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "../scripts/handoff-new-chat.mjs")
  );
  const nodeCmd = process.execPath.includes(" ") ? `"${process.execPath}"` : process.execPath;

  if (isPureAuto && args.force !== true && sourceSig && !hasExplicitBranch && tagsArg.length === 0) {
    const cachedRow = db
      .prepare("SELECT * FROM handoffs WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(resolvedConvId);
    if (cachedRow && fsSync.existsSync(cachedRow.file_path)) {
      try {
        const diskText = await fs.readFile(cachedRow.file_path, "utf8");
        const firstLine = diskText.split(/\r?\n/, 1)[0].trim();
        if (firstLine === sourceSig) {
          const cleanMd = stripSourceSigHeader(diskText).trimEnd();
          const cachedBranch = normalizeBranch(cachedRow.branch);
          const cachedTags = parseTagsJson(cachedRow.tags_json);
          const progressPath = toPosix(path.join(PROGRESS_DIR, `${cachedBranch}.md`));
          const nextChatCommand = `${nodeCmd} "${scriptPath}" --handoff "${cachedRow.file_path}" --title "${cachedRow.title.replace(/"/g, '\\"')}"`;
          const out = JSON.stringify(
            {
              handoffId: cachedRow.id,
              conversationId: resolvedConvId,
              branch: cachedBranch,
              tags: cachedTags,
              filePath: cachedRow.file_path,
              progressPath: fsSync.existsSync(progressPath) ? progressPath : "",
              bytes: cachedRow.bytes,
              estTokens: Math.round(cachedRow.bytes / 4),
              savedMemoryKeys: [],
              reusedCache: true,
              summaryMd: cleanMd,
              nextChatCommand,
            },
            null,
            2
          );
          const retBytes = utf8Bytes(out);
          const srcBytes = resolvedConv?.stat?.size || retBytes;
          metrics.returnedBytes += retBytes;
          recordMetricEvent("handoff", Math.max(srcBytes, retBytes), retBytes, cachedRow.project || projectArg);
          return { isError: false, text: out };
        }
      } catch {
        // Fall through and rebuild handoff if cached file read fails.
      }
    }
  }

  const extracted = transcriptFile
    ? await extractTranscriptFacts(transcriptFile, convDir)
    : { loaded: false, userPrompts: [], assistantReplies: [], touchedFiles: [], artifacts: [], recentErrors: [], workspace: "", firstUserPrompt: "", lastPlan: "", lastCheckpoint: "", stepCount: 0, userTurnCount: 0 };

  const title =
    rawTitle ||
    clipInline(extracted.firstUserPrompt || `Session ${resolvedConvId ? resolvedConvId.slice(0, 8) : "snapshot"}`, 72);
  const project = projectArg || extracted.workspace || "";

  const branchInfo = hasExplicitBranch
    ? { branch: normalizeBranch(rawBranchArg), inferred: false, source: "explicit" }
    : inferBranch({
        explicitBranch: args.branch,
        workspace: extracted.workspace,
        project,
        title,
        firstUserPrompt: extracted.firstUserPrompt,
        touchedFiles: extracted.touchedFiles,
      });
  const branchArg = branchInfo.branch;

  const tagInfo = inferTags({
    explicitTags: args.tags,
    touchedFiles: extracted.touchedFiles,
    title,
    firstUserPrompt: extracted.firstUserPrompt,
    recentErrors: extracted.recentErrors,
  });
  const finalTags = tagInfo.tags;

  const savedMemoryKeys = [];
  if (Array.isArray(args.saveStateKeys)) {
    for (const k of args.saveStateKeys) {
      const key = String(k);
      if (Object.prototype.hasOwnProperty.call(sessionState, key)) {
        saveMemory(key, sessionState[key], { project: projectArg, branch: branchArg, tags: finalTags });
        savedMemoryKeys.push(key);
      }
    }
  }

  const lines = [
    `# Handoff: ${title}`,
    `- Created: ${new Date().toISOString()}${extracted.stepCount ? ` | Steps: ${extracted.stepCount} | UserTurns: ${extracted.userTurnCount}` : ""}`,
    `- Branch: ${branchArg}${finalTags.length ? ` | Tags: ${finalTags.join(", ")}` : ""}`,
    ...(project ? [`- Project: ${project}`] : []),
    ...(resolvedConvId ? [`- Source Conversation: ${resolvedConvId}`] : []),
    ...(args.goal ? ["", "## Goal", String(args.goal).trim()] : []),
  ];

  const addList = (heading, arr) => {
    if (Array.isArray(arr) && arr.length > 0) {
      lines.push("", `## ${heading}`);
      for (const item of arr) lines.push(`- ${String(item).trim()}`);
    }
  };

  addList("Key Decisions", args.decisions);
  addList("Next Steps", args.nextSteps);
  addList("Open Risks", args.openRisks);

  if (savedMemoryKeys.length > 0) {
    lines.push("", "## Persisted Memory Keys (`tools.loadMemory`)");
    for (const k of savedMemoryKeys) lines.push(`- \`${k}\``);
  }
  if (extracted.userPrompts.length > 0) {
    const tailPrompts = extracted.firstUserPrompt
      ? extracted.userPrompts.filter((p) => p !== extracted.firstUserPrompt).slice(-5)
      : extracted.userPrompts.slice(-5);
    lines.push("", "## Recent User Requests");
    if (extracted.firstUserPrompt) lines.push(`- [Start] ${extracted.firstUserPrompt}`);
    for (const p of tailPrompts) lines.push(`- ${p}`);
  }
  if (extracted.assistantReplies.length > 0) {
    const latestReply = extracted.assistantReplies[extracted.assistantReplies.length - 1];
    const replyBudget = clampNumber(Math.floor(maxChars * 0.36), 450, 1400, 1100);
    lines.push("", "## Latest Conclusions & Status", clipBlock(latestReply, replyBudget));
  }
  if (extracted.lastCheckpoint || extracted.lastPlan) {
    const heading = extracted.lastCheckpoint ? "## Latest Checkpoint" : "## Latest Plan";
    lines.push("", heading, clipBlock(extracted.lastCheckpoint || extracted.lastPlan, 480));
  }
  if (extracted.touchedFiles.length > 0) {
    lines.push("", "## Touched Files");
    for (const f of extracted.touchedFiles) lines.push(`- \`${f}\``);
  }
  if (extracted.artifacts.length > 0) {
    lines.push("", "## Artifacts");
    for (const a of extracted.artifacts) lines.push(`- \`${a}\``);
  }
  if (extracted.recentErrors.length > 0) {
    lines.push("", "## Recent Errors");
    for (const e of extracted.recentErrors) lines.push(`- ${e}`);
  }

  let summaryMd = lines.join("\n").trim();
  if (utf8Bytes(summaryMd) > maxChars) {
    summaryMd = capBytes(summaryMd, Math.max(400, maxChars - 32)).text.trimEnd() + "\n\n[handoff trimmed]";
  }

  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 32) || "session";
  const handoffId = `${Date.now().toString(36)}-${slug}`;
  const filePath = toPosix(path.join(HANDOFF_DIR, `${handoffId}.md`));
  await fs.mkdir(HANDOFF_DIR, { recursive: true });
  await fs.writeFile(filePath, `${sourceSig ? `${sourceSig}\n` : ""}${summaryMd}\n`, "utf8");

  const bytes = utf8Bytes(summaryMd);
  const tagsJson = JSON.stringify(finalTags);
  db.prepare(
    `INSERT INTO handoffs(id, title, project, conversation_id, file_path, summary_md, bytes, created_at, branch, tags_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(handoffId, title, project, resolvedConvId, filePath, summaryMd, bytes, Date.now(), branchArg, tagsJson);

  indexIntoStore(`handoff:${handoffId}`, summaryMd, DEFAULT_CHUNK_BYTES, { branch: branchArg, tags: finalTags });
  const progressPath = writeBranchProgressFile(branchArg, {
    handoffId,
    title,
    project,
    tags: finalTags,
    summaryMd,
  });

  const nextChatCommand = `${nodeCmd} "${scriptPath}" --handoff "${filePath}" --title "${title.replace(/"/g, '\\"')}"`;

  const out = JSON.stringify(
    {
      handoffId,
      conversationId: resolvedConvId,
      branch: branchArg,
      branchInferred: branchInfo.inferred,
      branchSource: branchInfo.source,
      tags: finalTags,
      tagsInferred: tagInfo.inferred,
      filePath,
      progressPath,
      bytes,
      estTokens: Math.round(bytes / 4),
      savedMemoryKeys,
      reusedCache: false,
      summaryMd,
      nextChatCommand,
    },
    null,
    2
  );
  const retBytes = utf8Bytes(out);
  const srcBytes = resolvedConv?.stat?.size || retBytes;
  metrics.returnedBytes += retBytes;
  recordMetricEvent("handoff", Math.max(srcBytes, retBytes), retBytes, project);
  return { isError: false, text: out };
}

async function executeResume(args = {}) {
  metrics.calls.resume += 1;
  const convArg = typeof args.conversationId === "string" ? args.conversationId.trim() : "";
  const branchArg = typeof args.branch === "string" && args.branch.trim() ? normalizeBranch(args.branch) : "";
  const reqTags = normalizeTags(args.tags);

  const listBranchesSummary = () => {
    const hdRows = db
      .prepare(
        "SELECT id, title, project, branch, tags_json, created_at FROM handoffs ORDER BY created_at DESC LIMIT 80"
      )
      .all();
    const byBranch = new Map();
    for (const r of hdRows) {
      const b = normalizeBranch(r.branch);
      if (!byBranch.has(b)) {
        const pPath = toPosix(path.join(PROGRESS_DIR, `${b}.md`));
        byBranch.set(b, {
          branch: b,
          latestHandoffId: r.id,
          title: r.title,
          project: r.project || "",
          tags: parseTagsJson(r.tags_json),
          progressPath: fsSync.existsSync(pPath) ? pPath : "",
          updatedAt: r.created_at,
        });
      }
    }
    return [...byBranch.values()];
  };

  if (convArg) {
    let resolved;
    try {
      resolved = resolveAntigravityConversation(convArg);
    } catch (err) {
      return { isError: true, text: err?.message || String(err) };
    }

    const handoffRes = await executeHandoff({
      conversationId: resolved.id,
      ...(branchArg ? { branch: branchArg } : {}),
      ...(reqTags.length ? { tags: reqTags } : {}),
      maxChars: typeof args.maxChars === "number" ? args.maxChars : 3800,
    });
    if (handoffRes.isError) return handoffRes;

    const handoffData = JSON.parse(handoffRes.text);
    const row = db.prepare("SELECT * FROM handoffs WHERE id = ?").get(handoffData.handoffId);
    let summaryFromFile = handoffData.summaryMd;
    if (handoffData.filePath && fsSync.existsSync(handoffData.filePath)) {
      try {
        summaryFromFile = stripSourceSigHeader(await fs.readFile(handoffData.filePath, "utf8")).trimEnd();
      } catch {
        // Fallback to handoffData.summaryMd
      }
    }

    const activeBranch = normalizeBranch(row?.branch || handoffData.branch);
    const memoryKeys = listMemory({ project: (row && row.project) || undefined, branch: activeBranch });
    const recentIndexedSources = db
      .prepare("SELECT label, branch, tags_json, bytes_total AS bytes, chunk_count AS chunks FROM sources WHERE branch = ? ORDER BY id DESC LIMIT 10")
      .all(activeBranch)
      .map((s) => ({ label: s.label, branch: s.branch, tags: parseTagsJson(s.tags_json), bytes: s.bytes, chunks: s.chunks }));

    const pPath = toPosix(path.join(PROGRESS_DIR, `${activeBranch}.md`));
    const out = JSON.stringify(
      {
        layer: 2,
        autoGenerated: !handoffData.reusedCache,
        reusedCache: Boolean(handoffData.reusedCache),
        handoff: {
          id: handoffData.handoffId,
          title: row ? row.title : "",
          project: row ? row.project : "",
          branch: activeBranch,
          tags: parseTagsJson(row?.tags_json),
          conversationId: resolved.id,
          filePath: handoffData.filePath,
          progressPath: fsSync.existsSync(pPath) ? pPath : "",
          createdAt: row ? row.created_at : Date.now(),
          summaryMd: summaryFromFile,
        },
        memoryKeys,
        recentIndexedSources,
      },
      null,
      2
    );
    const retBytes = utf8Bytes(out);
    metrics.returnedBytes += retBytes;
    recordMetricEvent("resume", retBytes, retBytes, (row && row.project) || "");
    return { isError: false, text: out };
  }

  const id = typeof args.handoffId === "string" ? args.handoffId.trim() : "";

  if (!id && !branchArg) {
    // Layer 1: compact index list + virtual context branches
    const list = db
      .prepare(
        "SELECT id, title, project, branch, tags_json, conversation_id AS conversationId, bytes, created_at AS createdAt FROM handoffs ORDER BY created_at DESC LIMIT 10"
      )
      .all()
      .map((r) => ({
        id: r.id,
        title: r.title,
        project: r.project,
        branch: normalizeBranch(r.branch),
        tags: parseTagsJson(r.tags_json),
        conversationId: r.conversationId,
        bytes: r.bytes,
        createdAt: r.createdAt,
      }));
    const branches = listBranchesSummary();
    const out = JSON.stringify({ layer: 1, count: list.length, handoffs: list, branches }, null, 2);
    const retBytes = utf8Bytes(out);
    metrics.returnedBytes += retBytes;
    recordMetricEvent("resume", retBytes, retBytes, "");
    return { isError: false, text: out };
  }

  // Layer 2: full handoff summary + branch-scoped memory keys & FTS5 sources
  let row = null;
  if (branchArg && (!id || id === "latest")) {
    const candidates = db
      .prepare("SELECT * FROM handoffs WHERE branch = ? ORDER BY created_at DESC LIMIT 25")
      .all(branchArg);
    row =
      reqTags.length === 0
        ? candidates[0] || null
        : candidates.find((c) => {
            const cTags = parseTagsJson(c.tags_json);
            return reqTags.every((t) => cTags.includes(t));
          }) || null;
  } else {
    row =
      id === "latest"
        ? db.prepare("SELECT * FROM handoffs ORDER BY created_at DESC LIMIT 1").get()
        : db.prepare("SELECT * FROM handoffs WHERE id = ?").get(id);
  }

  if (!row) {
    return {
      isError: true,
      text: branchArg ? `No handoff found for branch "${branchArg}"` : `Handoff not found: "${id}"`,
    };
  }

  let summaryFromFile = row.summary_md;
  if (row.file_path && fsSync.existsSync(row.file_path)) {
    try {
      summaryFromFile = stripSourceSigHeader(await fs.readFile(row.file_path, "utf8")).trimEnd();
    } catch {
      // Fallback to DB summary_md
    }
  }

  const activeBranch = normalizeBranch(row.branch);
  const pPath = toPosix(path.join(PROGRESS_DIR, `${activeBranch}.md`));
  let progressMd = "";
  if (fsSync.existsSync(pPath)) {
    try {
      progressMd = fsSync.readFileSync(pPath, "utf8").trimEnd();
    } catch {
      progressMd = "";
    }
  }

  const memoryKeys = branchArg
    ? listMemory({ branch: activeBranch, tags: reqTags })
    : listMemory(row.project || undefined);
  const recentIndexedSources = branchArg
    ? db
        .prepare("SELECT label, branch, tags_json, bytes_total AS bytes, chunk_count AS chunks FROM sources WHERE branch = ? ORDER BY id DESC LIMIT 10")
        .all(activeBranch)
        .map((s) => ({ label: s.label, branch: s.branch, tags: parseTagsJson(s.tags_json), bytes: s.bytes, chunks: s.chunks }))
        .filter((s) => reqTags.length === 0 || reqTags.every((t) => s.tags.includes(t)))
    : db
        .prepare("SELECT label, branch, tags_json, bytes_total AS bytes, chunk_count AS chunks FROM sources ORDER BY id DESC LIMIT 10")
        .all()
        .map((s) => ({ label: s.label, branch: s.branch || "main", tags: parseTagsJson(s.tags_json), bytes: s.bytes, chunks: s.chunks }));

  const out = JSON.stringify(
    {
      layer: 2,
      handoff: {
        id: row.id,
        title: row.title,
        project: row.project,
        branch: activeBranch,
        tags: parseTagsJson(row.tags_json),
        conversationId: row.conversation_id,
        filePath: row.file_path,
        progressPath: fsSync.existsSync(pPath) ? pPath : "",
        progressMd,
        createdAt: row.created_at,
        summaryMd: summaryFromFile,
      },
      memoryKeys,
      recentIndexedSources,
    },
    null,
    2
  );
  const retBytes = utf8Bytes(out);
  metrics.returnedBytes += retBytes;
  recordMetricEvent("resume", retBytes, retBytes, row.project || "");
  return { isError: false, text: out };
}

function executeStats() {
  const stateKeys = Object.entries(sessionState).map(([key, val]) => {
    let type = typeof val;
    if (Array.isArray(val)) type = `array(${val.length})`;
    else if (val && type === "object") type = `object(${Object.keys(val).length} keys)`;
    let estBytes = 0;
    try {
      estBytes = utf8Bytes(JSON.stringify(val) ?? "");
    } catch {
      estBytes = 0;
    }
    return { key, type, estBytes };
  });

  const memoryKeys = listMemory();
  const indexedSources = db
    .prepare("SELECT label, bytes_total AS bytes, chunk_count AS chunks FROM sources ORDER BY id DESC LIMIT 30")
    .all();
  const handoffCount = Number(db.prepare("SELECT COUNT(*) AS n FROM handoffs").get().n);
  const branches = db
    .prepare("SELECT DISTINCT branch FROM handoffs UNION SELECT DISTINCT branch FROM sources")
    .all()
    .map((r) => normalizeBranch(r.branch));

  const backgroundJobs = [...jobs.values()].map((j) => ({
    jobId: j.jobId,
    status: j.status,
    exitCode: j.exitCode,
    elapsedMs: (j.finishedAt ?? Date.now()) - j.startedAt,
  }));

  const savedBytes = Math.max(0, metrics.rawBytes - metrics.returnedBytes);
  const savedPct = metrics.rawBytes > 0 ? Number(((savedBytes / metrics.rawBytes) * 100).toFixed(1)) : 0;

  let lifetime = {
    events: 0,
    rawProcessed: 0,
    returnedToContext: 0,
    savedBytes: 0,
    savedPct: 0,
    estTokensSaved: 0,
    byTool: [],
  };
  try {
    const agg = db
      .prepare(
        `SELECT COUNT(*) AS events,
                COALESCE(SUM(raw_bytes), 0) AS rawProcessed,
                COALESCE(SUM(returned_bytes), 0) AS returnedToContext,
                COALESCE(SUM(saved_bytes), 0) AS savedBytes
         FROM metrics_events`
      )
      .get();
    const rawTotal = Number(agg?.rawProcessed || 0);
    const retTotal = Number(agg?.returnedToContext || 0);
    const savedTotal = Number(agg?.savedBytes || 0);
    const byTool = db
      .prepare(
        `SELECT tool,
                COUNT(*) AS calls,
                COALESCE(SUM(raw_bytes), 0) AS rawBytes,
                COALESCE(SUM(returned_bytes), 0) AS returnedBytes,
                COALESCE(SUM(saved_bytes), 0) AS savedBytes
         FROM metrics_events
         GROUP BY tool
         ORDER BY savedBytes DESC, calls DESC`
      )
      .all()
      .map((r) => ({
        tool: r.tool,
        calls: Number(r.calls || 0),
        rawBytes: Number(r.rawBytes || 0),
        returnedBytes: Number(r.returnedBytes || 0),
        savedBytes: Number(r.savedBytes || 0),
      }));
    lifetime = {
      events: Number(agg?.events || 0),
      rawProcessed: rawTotal,
      returnedToContext: retTotal,
      savedBytes: savedTotal,
      savedPct: rawTotal > 0 ? Number(((savedTotal / rawTotal) * 100).toFixed(1)) : 0,
      estTokensSaved: Math.round(savedTotal / 4),
      byTool,
    };
  } catch {
    // Fallback to zeroed lifetime metrics if table is unavailable.
  }

  return {
    isError: false,
    text: JSON.stringify(
      {
        version: SERVER_INFO.version,
        dbPath: toPosix(DB_PATH),
        calls: metrics.calls,
        bytes: {
          rawProcessed: metrics.rawBytes,
          returnedToContext: metrics.returnedBytes,
          savedBytes,
          savedPct,
          estTokensSaved: Math.round(savedBytes / 4),
        },
        lifetime,
        stateKeys,
        memoryKeys,
        indexedSources,
        handoffCount,
        branches,
        backgroundJobs,
      },
      null,
      2
    ),
  };
}

// ── JSON-RPC 2.0 Stdio Loop ──────────────────────────────────────────

function sendResponse(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function sendError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

async function handleRequest(req) {
  if (!req || typeof req !== "object") return;
  const hasId = Object.prototype.hasOwnProperty.call(req, "id") && req.id !== null && req.id !== undefined;
  const { id, method, params } = req;
  if (!hasId) return;

  try {
    if (method === "initialize") {
      sendResponse(id, {
        protocolVersion: params?.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      return;
    }
    if (method === "ping") {
      sendResponse(id, {});
      return;
    }
    if (method === "tools/list") {
      sendResponse(id, { tools: TOOL_DEFINITIONS });
      return;
    }
    if (method === "tools/call") {
      const toolName = params?.name;
      const args = params?.arguments ?? {};
      let outcome;
      if (toolName === "save_token_exec") outcome = await executeCodeMode(args);
      else if (toolName === "save_token_poll") outcome = await executePoll(args);
      else if (toolName === "save_token_search") outcome = executeSearch(args);
      else if (toolName === "save_token_handoff") outcome = await executeHandoff(args);
      else if (toolName === "save_token_resume") outcome = await executeResume(args);
      else if (toolName === "save_token_stats") outcome = executeStats();
      else outcome = { isError: true, text: `Unknown tool: ${toolName}` };

      sendResponse(id, {
        content: [{ type: "text", text: outcome.text }],
        isError: outcome.isError,
      });
      return;
    }
    sendError(id, -32601, `Method not found: ${method}`);
  } catch (err) {
    sendError(id, -32603, err?.message || String(err));
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    process.stderr.write(`[save-token] Invalid JSON input: ${err.message}\n`);
    return;
  }
  handleRequest(parsed).catch((err) => {
    process.stderr.write(`[save-token] Unhandled error: ${err?.stack || err}\n`);
  });
});

rl.on("close", closeDbQuietly);
process.on("SIGINT", () => {
  closeDbQuietly();
  process.exit(0);
});
process.on("SIGTERM", () => {
  closeDbQuietly();
  process.exit(0);
});
