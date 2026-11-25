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

const SERVER_INFO = { name: "save-token", version: "1.2.0" };
const DEFAULT_CHUNK_BYTES = 1500;
const MAX_BG_STREAM_BYTES = 4 * 1024 * 1024;
const STRIPPED_ENV_KEYS = new Set([
  "NODE_OPTIONS",
  "NODE_REPL_EXTERNAL_MODULE",
  "NODE_V8_COVERAGE",
  "BUN_OPTIONS",
  "DENO_OPTIONS",
]);

function resolveDefaultDbPath() {
  if (process.env.SAVE_TOKEN_DB_PATH) return process.env.SAVE_TOKEN_DB_PATH;
  const agyDir = path.join(os.homedir(), ".gemini", "antigravity");
  if (fsSync.existsSync(agyDir)) {
    return path.join(agyDir, "plugin_data", "save-token", "store.db");
  }
  return path.join(os.homedir(), ".save-token", "store.db");
}

const DB_PATH = resolveDefaultDbPath();
const HANDOFF_DIR = path.join(path.dirname(DB_PATH), "handoffs");
const ANTIGRAVITY_BRAIN_DIR = path.join(os.homedir(), ".gemini", "antigravity", "brain");

const TOOL_DEFINITIONS = [
  {
    name: "save_token_exec",
    description:
      "Universal token-saving JS REPL across code, data, docs, static web, and CLIs: persists `state` across turns, runs ``await $`...`.compact()``, `tools.fetchText(url)`, `tools.compactOutput()`, `tools.detectClis()`, `tools.saveMemory`/`loadMemory`, `tools.*`, and indexes large output into SQLite FTS5+Trigram.",
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
      "Check, wait for, or kill background jobs started via `tools.spawnBg(cmd)` with optional RTK compaction (`compact`) and FTS5 `intent` filtering.",
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
      "Query large outputs and indexed sources stored in persistent SQLite (Porter BM25 + Trigram) across current and previous sessions.",
    inputSchema: {
      type: "object",
      properties: {
        queries: { type: "array", items: { type: "string" }, description: "Search queries." },
        source: { type: "string", description: "Optional source label filter (e.g. 'exec:1', 'handoff:...')." },
        limit: { type: "number", default: 5, description: "Max chunks per query (1..20)." },
        maxOutputChars: { type: "number", default: 8000, description: "Output character cap (500..32000)." },
      },
      required: ["queries"],
    },
  },
  {
    name: "save_token_handoff",
    description:
      "Build a zero-LLM session handoff snapshot: optionally extracts prompts/touched files/errors from a transcript, persists chosen `state` keys into SQLite `kv_memory`, and writes a compact `.md` file for starting a fresh chat.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title for the handoff snapshot." },
        conversationId: { type: "string", description: "Optional Antigravity conversationId to extract recent user prompts, touched files, and errors." },
        transcriptPath: { type: "string", description: "Optional explicit path to transcript_full.jsonl." },
        project: { type: "string", description: "Optional project name or path." },
        goal: { type: "string", description: "Current primary goal." },
        decisions: { type: "array", items: { type: "string" }, description: "Key technical decisions." },
        nextSteps: { type: "array", items: { type: "string" }, description: "Ordered remaining next steps." },
        openRisks: { type: "array", items: { type: "string" }, description: "Open issues or caveats." },
        saveStateKeys: { type: "array", items: { type: "string" }, description: "Keys from `state` to persist into kv_memory." },
        maxChars: { type: "number", default: 2400, description: "Max characters for handoff Markdown (800..6000)." },
      },
      required: ["title"],
    },
  },
  {
    name: "save_token_resume",
    description:
      "3-layer progressive disclosure resume from previous sessions: omit `handoffId` for a compact list; pass `'latest'` or `<id>` for summary, `memoryKeys`, and `indexedSources`.",
    inputSchema: {
      type: "object",
      properties: {
        handoffId: { type: "string", description: "Omit for compact list; pass 'latest' or exact handoffId to load details." },
      },
    },
  },
  {
    name: "save_token_stats",
    description:
      "Report real byte/token savings (`rawProcessed` vs `returnedToContext`), active `state` keys, persisted `kv_memory`, FTS5 sources, handoffs, and background jobs.",
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

function initDb() {
  fsSync.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fsSync.mkdirSync(HANDOFF_DIR, { recursive: true });
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

// ── RTK-style Output Compaction & HTML Text Extraction ───────────────

function stripAnsi(s) {
  return String(s)
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "");
}

function compactOutput(raw, kind = "auto") {
  const cleaned = stripAnsi(raw).replace(/\r\n/g, "\n");
  // Resolve terminal carriage-return progress overwrites by keeping text after last \r per line
  const rawLines = cleaned.split("\n").map((ln) => {
    const idx = ln.lastIndexOf("\r");
    return idx >= 0 ? ln.slice(idx + 1) : ln;
  });

  let detected = kind;
  if (detected === "auto") {
    const sample = rawLines.slice(0, 40).join("\n");
    if (/^\s*(?:M|A|D|R|\?\?)\s+\S/m.test(sample) && rawLines.length > 12) detected = "git-status";
    else if (/(?:PASS|FAIL|AssertionError|ERR!|Tests?:|passed|failed)/i.test(sample)) detected = "test";
    else detected = "generic";
  }

  const out = [];
  let blankRun = 0;
  let i = 0;

  if (detected === "test") {
    let passSkipped = 0;
    const flushPass = () => {
      if (passSkipped > 0) {
        out.push(`... [collapsed ${passSkipped} passing/progress lines]`);
        passSkipped = 0;
      }
    };
    for (const ln of rawLines) {
      const trimmed = ln.trim();
      const isImportant =
        /(?:fail|error|err!|warn|exception|assert|fatal|traceback|summary|tests?:|total:|passed|failed|exit code)/i.test(
          trimmed
        );
      const isPassOrNoise =
        !isImportant &&
        (/^(?:PASS|ok\s+\d+|✓|✔|\.\s*$)/i.test(trimmed) || /^\s*at\s+node:internal/.test(trimmed));
      if (isPassOrNoise) {
        passSkipped += 1;
        continue;
      }
      flushPass();
      if (trimmed === "") {
        blankRun += 1;
        if (blankRun <= 1) out.push("");
      } else {
        blankRun = 0;
        out.push(ln);
      }
    }
    flushPass();
    return out.join("\n").trim();
  }

  while (i < rawLines.length) {
    const cur = rawLines[i];
    if (cur.trim() === "") {
      blankRun += 1;
      if (blankRun <= 1) out.push("");
      i += 1;
      continue;
    }
    blankRun = 0;
    let rep = 1;
    while (i + rep < rawLines.length && rawLines[i + rep] === cur) {
      rep += 1;
    }
    if (rep > 2) {
      out.push(`${cur} ... (x${rep} repeats)`);
      i += rep;
    } else {
      out.push(cur);
      i += 1;
    }
  }
  return out.join("\n").trim();
}

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

function indexIntoStore(label, text, maxChunkBytes = DEFAULT_CHUNK_BYTES) {
  const cleanLabel = String(label);
  const chunks = chunkText(text, maxChunkBytes);
  const bytesTotal = utf8Bytes(String(text));

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
        "INSERT INTO sources(label, bytes_total, chunk_count, created_at) VALUES (?, ?, ?, ?) RETURNING id"
      )
      .get(cleanLabel, bytesTotal, chunks.length, Date.now());
    const sourceId = Number(row.id);

    const insChunk = db.prepare("INSERT INTO chunks(source_id, ord, title, body) VALUES (?, ?, ?, ?)");
    const insTri = db.prepare("INSERT INTO chunks_tri(source_id, ord, title, body) VALUES (?, ?, ?, ?)");
    for (const c of chunks) {
      insChunk.run(sourceId, c.ord, c.title, c.text);
      insTri.run(sourceId, c.ord, c.title, c.text);
    }
    db.exec("COMMIT");
    return { sourceId, label: cleanLabel, chunkCount: chunks.length, bytesTotal };
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

function queryStore(query, { source, limit = 5, sourceId } = {}) {
  const lim = clampNumber(limit, 1, 20, 5);
  const { porterAnd, porterOr, trigramAnd, trigramOr } = buildFtsMatches(query);
  const seen = new Set();
  const hits = [];

  const addRows = (rows, tier) => {
    for (const r of rows) {
      const k = `${r.source_id}:${r.ord}`;
      if (seen.has(k)) continue;
      seen.add(k);
      hits.push({
        sourceId: Number(r.source_id),
        source: r.label,
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
          `SELECT c.source_id, c.ord, c.title, c.body, s.label,
                  -bm25(chunks, 0, 0, 1.0, 1.0) AS score
           FROM chunks c
           JOIN sources s ON s.id = c.source_id
           WHERE chunks MATCH ?
             AND (? IS NULL OR s.label = ?)
             AND (? IS NULL OR c.source_id = ?)
           ORDER BY score DESC, c.source_id DESC, c.ord ASC
           LIMIT ?`
        )
        .all(expr, source ?? null, source ?? null, sourceId ?? null, sourceId ?? null, lim);
    } catch {
      return [];
    }
  };

  const runTrigram = (expr) => {
    if (!expr) return [];
    try {
      return db
        .prepare(
          `SELECT t.source_id, t.ord, t.title, t.body, s.label,
                  -bm25(chunks_tri, 0, 0, 1.0, 1.0) AS score
           FROM chunks_tri t
           JOIN sources s ON s.id = t.source_id
           WHERE chunks_tri MATCH ?
             AND (? IS NULL OR s.label = ?)
             AND (? IS NULL OR t.source_id = ?)
           ORDER BY score DESC, t.source_id DESC, t.ord ASC
           LIMIT ?`
        )
        .all(expr, source ?? null, source ?? null, sourceId ?? null, sourceId ?? null, lim);
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
  const json = JSON.stringify(value);
  const bytes = utf8Bytes(json);
  db.prepare(
    `INSERT INTO kv_memory(key, project, value_json, bytes, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET project=excluded.project, value_json=excluded.value_json, bytes=excluded.bytes, updated_at=excluded.updated_at`
  ).run(cleanKey, project, json, bytes, Date.now());
  return { key: cleanKey, project, bytes };
}

function loadMemory(key) {
  const row = db.prepare("SELECT value_json FROM kv_memory WHERE key = ?").get(String(key));
  if (!row) return undefined;
  return JSON.parse(row.value_json);
}

function listMemory(project) {
  const p = project ? String(project) : null;
  return db
    .prepare(
      `SELECT key, project, bytes, updated_at FROM kv_memory
       WHERE (? IS NULL OR project = ?)
       ORDER BY updated_at DESC`
    )
    .all(p, p);
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
          return compactOutput([res.stdout, res.stderr].filter(Boolean).join("\n"), kind);
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

  function index(label, text) {
    const info = indexIntoStore(label, String(text));
    return { source: info.label, chunks: info.chunkCount, bytes: info.bytesTotal };
  }

  function search(queries, opts = {}) {
    const list = Array.isArray(queries) ? queries : [queries];
    const limit = opts.limit ?? 5;
    const seen = new Set();
    const hits = [];
    for (const q of list) {
      for (const h of queryStore(q, { source: opts.source, limit })) {
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
      grep,
      shell,
      write,
      edit,
      replace,
      batchReplace,
      compactOutput,
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

function stripWrapperTags(text) {
  return String(text)
    .replace(/<voice_instructions>[\s\S]*?<\/voice_instructions>/gi, "")
    .replace(/<talker_agent_context>[\s\S]*?<\/talker_agent_context>/gi, "")
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, "")
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, "")
    .replace(/<\/?USER_REQUEST>/gi, "")
    .replace(/\s+/g, " ")
    .trim();
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

async function extractTranscriptFacts(transcriptFile) {
  const userPrompts = [];
  const seenPrompts = new Set();
  const touchedFiles = new Set();
  const recentErrors = [];

  const pushPrompt = (txt) => {
    const val = String(txt || "").trim().slice(0, 180);
    if (!val || seenPrompts.has(val)) return;
    seenPrompts.add(val);
    userPrompts.push(val);
  };

  let raw;
  try {
    raw = await fs.readFile(transcriptFile, "utf8");
  } catch {
    return { userPrompts: [], touchedFiles: [], recentErrors: [], loaded: false };
  }

  const lines = raw.trim().split(/\r?\n/).filter(Boolean);
  for (const ln of lines) {
    let o;
    try {
      o = JSON.parse(ln);
    } catch {
      continue;
    }
    const content = typeof o.content === "string" ? o.content : JSON.stringify(o);
    if (o.type === "USER_INPUT") {
      for (const u of extractVoiceUserUtterances(content)) pushPrompt(u);
      pushPrompt(stripWrapperTags(content));
    } else if (o.type === "ERROR_MESSAGE") {
      recentErrors.push(content.replace(/\s+/g, " ").slice(0, 180));
    } else if (o.type === "GENERIC") {
      if (/Created file|Made \d+ replacement|write_file|edit_file/i.test(content)) {
        const matches = content.match(/(?:[A-Za-z]:[\\/]|\/(?:Users|home|opt|etc|tmp|var)\/)[^\s"'`<>]+/g) || [];
        for (const m of matches) touchedFiles.add(toPosix(m));
      }
    }
  }

  return {
    loaded: true,
    userPrompts: userPrompts.slice(-5),
    touchedFiles: [...touchedFiles].slice(-12),
    recentErrors: recentErrors.slice(-3),
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

    const indexTag = indexedLabel ? ` | INDEXED as "${indexedLabel}"` : "";
    const finalText = `${outBody}\n[save-token | ${elapsedMs}ms | mode=${mode} | raw=${processedBytes}B | returned=${utf8Bytes(outBody)}B${indexTag}]`;
    metrics.rawBytes += processedBytes;
    metrics.returnedBytes += utf8Bytes(finalText);
    return { isError: false, text: finalText };
  } catch (err) {
    const elapsedMs = Date.now() - startMs;
    const msg = err?.stack || err?.message || String(err);
    const logPrefix = logs.length > 0 ? `--- logs ---\n${logs.join("\n")}\n` : "";
    const text = `${logPrefix}Error: ${msg}\n[save-token | ${elapsedMs}ms | mode=${mode} | failed]`;
    metrics.rawBytes += Math.max(byteTracker.internalBytes, utf8Bytes(text));
    metrics.returnedBytes += utf8Bytes(text);
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
  metrics.rawBytes += rawBytes;
  metrics.returnedBytes += utf8Bytes(finalText);
  return { isError: false, text: finalText };
}

function executeSearch(args = {}) {
  metrics.calls.search += 1;
  const queries = Array.isArray(args.queries) ? args.queries.map(String) : [];
  if (queries.length === 0) {
    return { isError: true, text: "Invalid arguments: 'queries' must be a non-empty string array." };
  }
  const source = typeof args.source === "string" && args.source.trim() ? args.source.trim() : undefined;
  const limit = clampNumber(args.limit, 1, 20, 5);
  const maxOutputChars = clampNumber(args.maxOutputChars, 500, 32000, 8000);

  const seen = new Set();
  const sections = [];
  let used = 0;

  for (const q of queries) {
    const hits = queryStore(q, { source, limit });
    const lines = [`## Query: ${q}`];
    if (hits.length === 0) {
      lines.push("(no matches)");
    } else {
      for (const h of hits) {
        const k = `${h.sourceId}:${h.ord}`;
        if (seen.has(k)) continue;
        seen.add(k);
        const head = `[${h.source} #${h.ord}${h.title ? ` | ${h.title}` : ""} | ${h.tier}]`;
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
  metrics.rawBytes += totalIndexedBytes;
  metrics.returnedBytes += utf8Bytes(out);
  return { isError: false, text: out };
}

async function executeHandoff(args = {}) {
  metrics.calls.handoff += 1;
  const title = typeof args.title === "string" && args.title.trim() ? args.title.trim() : "";
  if (!title) {
    return { isError: true, text: "Invalid arguments: 'title' is required." };
  }

  const maxChars = clampNumber(args.maxChars, 800, 6000, 2400);
  const project = typeof args.project === "string" ? args.project.trim() : "";
  const convId = typeof args.conversationId === "string" ? args.conversationId.trim() : "";
  const explicitTranscript = typeof args.transcriptPath === "string" ? args.transcriptPath.trim() : "";

  const savedMemoryKeys = [];
  if (Array.isArray(args.saveStateKeys)) {
    for (const k of args.saveStateKeys) {
      const key = String(k);
      if (Object.prototype.hasOwnProperty.call(sessionState, key)) {
        saveMemory(key, sessionState[key], { project });
        savedMemoryKeys.push(key);
      }
    }
  }

  let transcriptFile = explicitTranscript;
  if (!transcriptFile && convId) {
    transcriptFile = path.join(ANTIGRAVITY_BRAIN_DIR, convId, ".system_generated", "logs", "transcript_full.jsonl");
  }
  const extracted = transcriptFile
    ? await extractTranscriptFacts(transcriptFile)
    : { userPrompts: [], touchedFiles: [], recentErrors: [], loaded: false };

  const lines = [
    `# Handoff: ${title}`,
    `- Created: ${new Date().toISOString()}`,
    ...(project ? [`- Project: ${project}`] : []),
    ...(convId ? [`- Source Conversation: ${convId}`] : []),
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
    lines.push("", "## Recent User Requests");
    for (const p of extracted.userPrompts) lines.push(`- ${p}`);
  }
  if (extracted.touchedFiles.length > 0) {
    lines.push("", "## Touched Files");
    for (const f of extracted.touchedFiles) lines.push(`- \`${f}\``);
  }
  if (extracted.recentErrors.length > 0) {
    lines.push("", "## Recent Errors");
    for (const e of extracted.recentErrors) lines.push(`- ${e}`);
  }

  let summaryMd = lines.join("\n").trim();
  if (summaryMd.length > maxChars) {
    summaryMd = capBytes(summaryMd, Math.max(400, maxChars - 32)).text + "\n\n[handoff trimmed]";
  }

  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32) || "session";
  const handoffId = `${Date.now().toString(36)}-${slug}`;
  const filePath = toPosix(path.join(HANDOFF_DIR, `${handoffId}.md`));
  await fs.mkdir(HANDOFF_DIR, { recursive: true });
  await fs.writeFile(filePath, summaryMd + "\n", "utf8");

  const bytes = utf8Bytes(summaryMd);
  db.prepare(
    `INSERT INTO handoffs(id, title, project, conversation_id, file_path, summary_md, bytes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(handoffId, title, project, convId, filePath, summaryMd, bytes, Date.now());

  indexIntoStore(`handoff:${handoffId}`, summaryMd);

  const scriptPath = toPosix(
    path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "../scripts/handoff-new-chat.mjs")
  );
  const nodeCmd = process.execPath.includes(" ") ? `"${process.execPath}"` : process.execPath;
  const nextChatCommand = `${nodeCmd} "${scriptPath}" --handoff "${filePath}" --title "${title.replace(/"/g, '\\"')}"`;

  const out = JSON.stringify(
    {
      handoffId,
      filePath,
      bytes,
      estTokens: Math.round(bytes / 4),
      savedMemoryKeys,
      summaryMd,
      nextChatCommand,
    },
    null,
    2
  );
  metrics.returnedBytes += utf8Bytes(out);
  return { isError: false, text: out };
}

function executeResume(args = {}) {
  metrics.calls.resume += 1;
  const id = typeof args.handoffId === "string" ? args.handoffId.trim() : "";

  if (!id) {
    // Layer 1: compact index list
    const list = db
      .prepare(
        "SELECT id, title, project, bytes, created_at AS createdAt FROM handoffs ORDER BY created_at DESC LIMIT 10"
      )
      .all();
    const out = JSON.stringify({ layer: 1, count: list.length, handoffs: list }, null, 2);
    metrics.returnedBytes += utf8Bytes(out);
    return { isError: false, text: out };
  }

  // Layer 2: full handoff summary + memory keys + recent FTS5 sources
  const row =
    id === "latest"
      ? db.prepare("SELECT * FROM handoffs ORDER BY created_at DESC LIMIT 1").get()
      : db.prepare("SELECT * FROM handoffs WHERE id = ?").get(id);

  if (!row) {
    return { isError: true, text: `Handoff not found: "${id}"` };
  }

  const memoryKeys = listMemory(row.project || undefined);
  const recentIndexedSources = db
    .prepare("SELECT label, bytes_total AS bytes, chunk_count AS chunks FROM sources ORDER BY id DESC LIMIT 10")
    .all();

  const out = JSON.stringify(
    {
      layer: 2,
      handoff: {
        id: row.id,
        title: row.title,
        project: row.project,
        filePath: row.file_path,
        createdAt: row.created_at,
        summaryMd: row.summary_md,
      },
      memoryKeys,
      recentIndexedSources,
    },
    null,
    2
  );
  metrics.returnedBytes += utf8Bytes(out);
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

  const backgroundJobs = [...jobs.values()].map((j) => ({
    jobId: j.jobId,
    status: j.status,
    exitCode: j.exitCode,
    elapsedMs: (j.finishedAt ?? Date.now()) - j.startedAt,
  }));

  const savedBytes = Math.max(0, metrics.rawBytes - metrics.returnedBytes);
  const savedPct = metrics.rawBytes > 0 ? Number(((savedBytes / metrics.rawBytes) * 100).toFixed(1)) : 0;

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
        stateKeys,
        memoryKeys,
        indexedSources,
        handoffCount,
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
      else if (toolName === "save_token_resume") outcome = executeResume(args);
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
