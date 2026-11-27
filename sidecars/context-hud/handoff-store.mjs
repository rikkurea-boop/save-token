/**
 * Shared Branch + Progress + Handoff Store for Save Token HUD.
 * Keeps `progress/<branch>.md`, `handoffs` table, and FTS5 scoped sources synchronized in shared store.db.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  inferBranch,
  inferTags,
  normalizeBranch as sharedNormalizeBranch,
  normalizeTags as sharedNormalizeTags,
} from '../../scripts/context-meta.mjs';

const HANDOFF_ID_RE = /^[a-z0-9][a-z0-9_-]{1,96}$/i;
const DEFAULT_CHUNK_BYTES = 2400;

function toPosix(p) {
  return String(p || '').replace(/\\/g, '/');
}

function utf8Bytes(str) {
  return Buffer.byteLength(String(str ?? ''), 'utf8');
}

export function normalizeBranch(raw) {
  return sharedNormalizeBranch(raw, 'main');
}

export function normalizeTags(raw) {
  return sharedNormalizeTags(raw);
}

function extractTouchedFilesFromSummary(summaryMd) {
  const files = [];
  const seen = new Set();
  const re = /^\s*-\s+`([^`\r\n]+)`/gm;
  let m;
  while ((m = re.exec(String(summaryMd || ''))) !== null) {
    const fp = m[1].trim();
    if (!fp || (!fp.includes('/') && !fp.includes('\\') && !fp.includes('.'))) continue;
    if (seen.has(fp)) continue;
    seen.add(fp);
    files.push(fp);
    if (files.length >= 25) break;
  }
  return files;
}

function parseTagsJson(raw) {
  try {
    const parsed = JSON.parse(String(raw || '[]'));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function isSafePathWithin(targetPath, baseDir) {
  if (!targetPath || !baseDir) return false;
  const norm = (p) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
  const rel = relative(norm(baseDir), norm(targetPath));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function stripSourceSigHeader(text) {
  return String(text || '').replace(/^<!--\s*source-sig:[^>]*-->\r?\n/, '');
}

function capBytes(text, maxBytes) {
  const s = String(text ?? '');
  if (utf8Bytes(s) <= maxBytes) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (utf8Bytes(s.slice(0, mid)) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return s.slice(0, lo);
}

function chunkMarkdown(text, maxChunkBytes = DEFAULT_CHUNK_BYTES) {
  const cap = Math.max(512, Math.min(8000, Number(maxChunkBytes) || DEFAULT_CHUNK_BYTES));
  const lines = String(text ?? '').split(/\r?\n/);
  const blocks = [];
  let curTitle = '';
  let curLines = [];

  for (const ln of lines) {
    const heading = ln.match(/^#{1,4}\s+(.+)$/);
    if (heading) {
      if (curLines.length) {
        blocks.push({ title: curTitle, text: curLines.join('\n').trim() });
        curLines = [];
      }
      curTitle = heading[1].trim().slice(0, 120);
      curLines.push(ln);
    } else {
      curLines.push(ln);
    }
  }
  if (curLines.length) {
    blocks.push({ title: curTitle, text: curLines.join('\n').trim() });
  }

  const chunks = [];
  let buf = '';
  let bufTitle = '';

  const flushBuf = () => {
    if (!buf.trim()) return;
    if (utf8Bytes(buf) <= cap) {
      chunks.push({ ord: chunks.length, title: bufTitle, text: buf });
      buf = '';
      return;
    }
    let acc = '';
    for (const ln of buf.split('\n')) {
      const candidate = acc ? `${acc}\n${ln}` : ln;
      if (utf8Bytes(candidate) <= cap) {
        acc = candidate;
      } else {
        if (acc) {
          chunks.push({ ord: chunks.length, title: bufTitle, text: acc });
          acc = '';
        }
        let rest = ln;
        while (utf8Bytes(rest) > cap) {
          const piece = capBytes(rest, cap) || rest.slice(0, 1);
          chunks.push({ ord: chunks.length, title: bufTitle, text: piece });
          rest = rest.slice(piece.length);
        }
        acc = rest;
      }
    }
    if (acc) chunks.push({ ord: chunks.length, title: bufTitle, text: acc });
    buf = '';
  };

  for (const b of blocks) {
    if (!b.text) continue;
    if (buf && b.title !== bufTitle) flushBuf();
    bufTitle = b.title;
    const candidate = buf ? `${buf}\n\n${b.text}` : b.text;
    if (utf8Bytes(candidate) <= cap) {
      buf = candidate;
    } else {
      flushBuf();
      buf = b.text;
      if (utf8Bytes(buf) > cap) flushBuf();
    }
  }
  flushBuf();
  if (chunks.length === 0) chunks.push({ ord: 0, title: '', text: '' });
  return chunks;
}

function ensureColumn(conn, table, column, defSql) {
  const cols = conn.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    conn.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${defSql}`);
  }
}

export function createHandoffStore({ dbPath, handoffDir, progressDir }) {
  const resolvedDbPath = resolve(dbPath);
  const resolvedHandoffDir = resolve(handoffDir || join(dirname(resolvedDbPath), 'handoffs'));
  const resolvedProgressDir = resolve(progressDir || join(dirname(resolvedDbPath), 'progress'));
  mkdirSync(dirname(resolvedDbPath), { recursive: true });
  mkdirSync(resolvedHandoffDir, { recursive: true });
  mkdirSync(resolvedProgressDir, { recursive: true });

  const db = new DatabaseSync(resolvedDbPath);
  db.exec(`
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
  ensureColumn(db, 'sources', 'branch', "TEXT NOT NULL DEFAULT 'main'");
  ensureColumn(db, 'sources', 'tags_json', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, 'kv_memory', 'branch', "TEXT NOT NULL DEFAULT 'main'");
  ensureColumn(db, 'kv_memory', 'tags_json', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, 'handoffs', 'branch', "TEXT NOT NULL DEFAULT 'main'");
  ensureColumn(db, 'handoffs', 'tags_json', "TEXT NOT NULL DEFAULT '[]'");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sources_branch ON sources(branch);
    CREATE INDEX IF NOT EXISTS idx_handoffs_branch_ts ON handoffs(branch, created_at);
  `);

  function writeProgressFile(branch, meta = {}) {
    const cleanBranch = normalizeBranch(branch);
    const progressPath = toPosix(join(resolvedProgressDir, `${cleanBranch}.md`));
    if (!isSafePathWithin(progressPath, resolvedProgressDir)) {
      throw new Error('unsafe_progress_path');
    }

    const tags = normalizeTags(meta.tags);
    const branchSources = db
      .prepare('SELECT label, bytes_total AS bytes, tags_json FROM sources WHERE branch = ? ORDER BY id DESC LIMIT 10')
      .all(cleanBranch)
      .map((r) => ({ label: r.label, bytes: r.bytes, tags: parseTagsJson(r.tags_json) }));

    const lines = [
      `# Progress Branch: ${cleanBranch}`,
      `- Updated: ${new Date().toISOString()}`,
      ...(meta.project ? [`- Project: ${meta.project}`] : []),
      ...(tags.length ? [`- Tags: ${tags.join(', ')}`] : []),
      ...(meta.handoffId ? [`- Latest Handoff: ${meta.handoffId} (${meta.title || ''})`] : []),
      ...(meta.conversationId ? [`- Source Conversation: ${meta.conversationId}`] : []),
    ];

    if (meta.summaryMd) {
      lines.push('', '## Active Snapshot', capBytes(stripSourceSigHeader(meta.summaryMd), 1400));
    }
    if (branchSources.length > 0) {
      lines.push('', '## Scoped Sources (`save_token_search`)');
      for (const s of branchSources) {
        lines.push(`- \`${s.label}\`${s.tags.length ? ` [${s.tags.join(',')}]` : ''} (${s.bytes}B)`);
      }
    }
    const sampleTagArg = tags.length ? `, tags: ${JSON.stringify(tags)}` : '';
    lines.push('', '## Quick Recall', `- \`save_token_search({ queries: ["<keyword>"], branch: "${cleanBranch}"${sampleTagArg} })\``);

    const md = capBytes(lines.join('\n').trim(), 2600).trimEnd() + '\n';
    mkdirSync(resolvedProgressDir, { recursive: true });
    writeFileSync(progressPath, md, 'utf8');
    return progressPath;
  }

  function saveHandoff({ conversationId = '', title = '', project = '', branch = '', tags = [], summaryMd = '', sourceSig = '', touchedFiles = null }) {
    const cleanSummary = stripSourceSigHeader(String(summaryMd || '')).trim();
    if (!cleanSummary) {
      throw new Error('empty_handoff_summary');
    }
    const cleanTitle =
      String(title || '').trim() || (conversationId ? `Phiên ${conversationId.slice(0, 8)}` : 'Session snapshot');
    const filesForInfer = Array.isArray(touchedFiles) && touchedFiles.length > 0
      ? touchedFiles
      : extractTouchedFilesFromSummary(cleanSummary);
    const branchInfo = inferBranch({
      explicitBranch: branch,
      project,
      title: cleanTitle,
      touchedFiles: filesForInfer,
    });
    const cleanBranch = branchInfo.branch;
    const tagInfo = inferTags({
      explicitTags: tags,
      touchedFiles: filesForInfer,
      title: cleanTitle,
    });
    const cleanTags = tagInfo.tags;
    const tagsJson = JSON.stringify(cleanTags);
    const slug =
      cleanTitle
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 32) || 'session';
    let handoffId = `${Date.now().toString(36)}-${slug}`;
    if (!HANDOFF_ID_RE.test(handoffId)) {
      handoffId = `hd-${Date.now().toString(36)}`;
    }
    const filePath = toPosix(join(resolvedHandoffDir, `${handoffId}.md`));
    if (!isSafePathWithin(filePath, resolvedHandoffDir)) {
      throw new Error('unsafe_handoff_path');
    }

    mkdirSync(resolvedHandoffDir, { recursive: true });
    writeFileSync(filePath, `${sourceSig ? `${sourceSig}\n` : ''}${cleanSummary}\n`, 'utf8');

    const bytes = utf8Bytes(cleanSummary);
    const createdAt = Date.now();
    const label = `handoff:${handoffId}`;
    const chunks = chunkMarkdown(cleanSummary, DEFAULT_CHUNK_BYTES);

    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(
        `INSERT INTO handoffs(id, title, project, conversation_id, file_path, summary_md, bytes, created_at, branch, tags_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(handoffId, cleanTitle, String(project || ''), String(conversationId || ''), filePath, cleanSummary, bytes, createdAt, cleanBranch, tagsJson);

      const existing = db.prepare('SELECT id FROM sources WHERE label = ?').get(label);
      if (existing) {
        db.prepare('DELETE FROM chunks WHERE source_id = ?').run(existing.id);
        db.prepare('DELETE FROM chunks_tri WHERE source_id = ?').run(existing.id);
        db.prepare('DELETE FROM sources WHERE id = ?').run(existing.id);
      }
      const row = db
        .prepare('INSERT INTO sources(label, bytes_total, chunk_count, created_at, branch, tags_json) VALUES (?, ?, ?, ?, ?, ?) RETURNING id')
        .get(label, bytes, chunks.length, createdAt, cleanBranch, tagsJson);
      const sourceId = Number(row.id);

      const insChunk = db.prepare('INSERT INTO chunks(source_id, ord, title, body) VALUES (?, ?, ?, ?)');
      const insTri = db.prepare('INSERT INTO chunks_tri(source_id, ord, title, body) VALUES (?, ?, ?, ?)');
      for (const c of chunks) {
        insChunk.run(sourceId, c.ord, c.title, c.text);
        insTri.run(sourceId, c.ord, c.title, c.text);
      }
      db.exec('COMMIT');
    } catch (err) {
      if (db.isTransaction) {
        try { db.exec('ROLLBACK'); } catch {}
      }
      throw err;
    }

    const progressPath = writeProgressFile(cleanBranch, {
      handoffId,
      title: cleanTitle,
      project,
      conversationId,
      tags: cleanTags,
      summaryMd: cleanSummary,
    });

    return {
      handoffId,
      conversationId: String(conversationId || ''),
      branch: cleanBranch,
      tags: cleanTags,
      title: cleanTitle,
      project: String(project || ''),
      filePath,
      progressPath,
      bytes,
      estTokens: Math.round(bytes / 4),
      createdAt,
      summaryMd: cleanSummary,
      resumeCommand: `save_token_resume({ handoffId: "${handoffId}" })`,
      resumeByBranchCommand: `save_token_resume({ branch: "${cleanBranch}" })`,
      resumeByConvCommand: conversationId
        ? `save_token_resume({ conversationId: "${conversationId}", branch: "${cleanBranch}" })`
        : `save_token_resume({ branch: "${cleanBranch}" })`,
    };
  }

  function syncLiveProgress({ branch = '', conversationId = '', title = '', project = '', summaryMd = '', tags = [], touchedFiles = null }) {
    const filesForInfer = Array.isArray(touchedFiles) && touchedFiles.length > 0
      ? touchedFiles
      : extractTouchedFilesFromSummary(summaryMd);
    const cleanBranch = inferBranch({
      explicitBranch: branch,
      project,
      title,
      touchedFiles: filesForInfer,
    }).branch;
    const cleanTags = inferTags({
      explicitTags: tags,
      touchedFiles: filesForInfer,
      title,
    }).tags;
    const progressPath = writeProgressFile(cleanBranch, {
      title,
      project,
      conversationId,
      tags: cleanTags,
      summaryMd,
    });
    return { branch: cleanBranch, tags: cleanTags, progressPath, updatedAt: Date.now() };
  }

  function listBranches(limit = 15) {
    const lim = Math.min(50, Math.max(1, Math.trunc(Number(limit) || 15)));
    const rows = db
      .prepare('SELECT branch, title, tags_json, created_at FROM handoffs ORDER BY created_at DESC LIMIT 80')
      .all();
    const map = new Map();
    for (const r of rows) {
      const b = normalizeBranch(r.branch);
      if (!map.has(b)) {
        const pPath = toPosix(join(resolvedProgressDir, `${b}.md`));
        map.set(b, {
          branch: b,
          title: r.title || '',
          tags: new Set(parseTagsJson(r.tags_json)),
          progressPath: existsSync(pPath) ? pPath : '',
          updatedAt: Number(r.created_at || 0),
        });
      } else {
        for (const t of parseTagsJson(r.tags_json)) map.get(b).tags.add(t);
      }
    }
    for (const s of db.prepare('SELECT branch, tags_json FROM sources ORDER BY id DESC LIMIT 80').all()) {
      const b = normalizeBranch(s.branch);
      if (!map.has(b)) {
        const pPath = toPosix(join(resolvedProgressDir, `${b}.md`));
        map.set(b, {
          branch: b,
          title: '',
          tags: new Set(parseTagsJson(s.tags_json)),
          progressPath: existsSync(pPath) ? pPath : '',
          updatedAt: 0,
        });
      } else {
        for (const t of parseTagsJson(s.tags_json)) map.get(b).tags.add(t);
      }
    }
    return [...map.values()]
      .slice(0, lim)
      .map((item) => ({
        branch: item.branch,
        title: item.title,
        tags: [...item.tags],
        progressPath: item.progressPath,
        updatedAt: item.updatedAt,
      }));
  }

  function close() {
    try {
      db.close();
    } catch {
      // Ignore already-closed DB.
    }
  }

  return {
    dbPath: resolvedDbPath,
    handoffDir: resolvedHandoffDir,
    progressDir: resolvedProgressDir,
    saveHandoff,
    syncLiveProgress,
    listBranches,
    close,
  };
}
