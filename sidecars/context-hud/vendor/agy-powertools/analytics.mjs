import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { readDatabase } from './database.mjs';
import { isBufferedTailFlush, resolveRequestSpeed } from './dashboard.mjs';

function buildTranscriptRequests(steps, conversationId) {
  if (!Array.isArray(steps) || !steps.length) return [];
  const reqs = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (!s || (s.type !== 'PLANNER_RESPONSE' && s.type !== 'ERROR_MESSAGE')) continue;
    const inTok = Number(s.input_tokens || 0);
    const cacheTok = Number(s.cache_read_tokens || 0);
    const outTok = Number(s.output_tokens || 0);
    const thinkTok = Number(s.thinking_tokens || 0);
    const model = s.model || '';
    if (!model && !inTok && !cacheTok && !outTok && s.type !== 'ERROR_MESSAGE') continue;
    const ts = s.created_at ? Date.parse(s.created_at) : null;
    const totalIn = inTok + cacheTok;
    reqs.push({
      stepIndex: s.step_index ?? i,
      id: `transcript-${conversationId}-${s.step_index ?? i}`,
      conversationId,
      timestampMs: Number.isFinite(ts) ? ts : null,
      model,
      role: '',
      inputTokens: inTok,
      cacheReadTokens: cacheTok,
      outputTokens: outTok,
      cacheHitPercent: totalIn > 0 ? Number(((cacheTok / totalIn) * 100).toFixed(1)) : null,
      thinkingTokens: thinkTok,
      responseTokens: Math.max(0, outTok - thinkTok),
      ttftMs: null,
      streamingMs: null,
      durationMs: null,
      tpsDurationMs: null,
      tps: null,
      wholeTps: null,
      tpsMode: 'transcript',
      error: s.type === 'ERROR_MESSAGE' ? (s.content || 'error') : '',
      status: s.type === 'ERROR_MESSAGE' ? 'error' : outTok > 0 ? 'success' : 'recorded',
      retries: 0,
      retryErrors: [],
    });
  }
  return reqs;
}

const DASHBOARD_CACHE_TTL_MS = 30000;
const CLI_APP_DIR_NAME = 'antigravity-cli';
const DESKTOP_APP_DIR_NAME = 'antigravity';

export function requestEvents(database, conversationId, steps = null) {
  const generations = (database?.generations || []).filter(g => g.modelName || g.error || g.outputTokens);
  if (!generations.length && Array.isArray(steps) && steps.length) {
    return buildTranscriptRequests(steps, conversationId);
  }
  const knownExecutionEnum = generations.find(g => g.executionModelEnum)?.executionModelEnum || null;
  return generations.map(g => {
    const times = g.stepIndices.map(index => database.times.get(index)).filter(Boolean);
    const created = times.map(t => t.createdMs).filter(Number.isFinite);
    const timestampMs = created.length ? Math.min(...created) : null;
    const role = g.role || (knownExecutionEnum && g.modelEnum ? (g.modelEnum === knownExecutionEnum ? 'execution' : 'planner') : '');
    // Exclude TTFT for genuine streamed responses so slow prefill/queueing doesn't distort decode speed,
    // while keeping whole-request fallback for buffered providers and extreme short-tail buffered flushes.
    const { durationMs, tpsDurationMs, tps, wholeTps, tpsMode } = resolveRequestSpeed({
      outputTokens: g.outputTokens,
      ttftMs: g.ttftMs,
      streamingMs: g.streamingMs
    });
    const stepIndex = g.stepIndices.reduce((first, index) => Number.isInteger(index) && (first == null || index < first) ? index : first, null);
    return { stepIndex, id: g.requestId || `${g.executionId}:${g.index}:${timestampMs}:${g.modelName}`, conversationId, timestampMs,
      model: g.modelName, role, inputTokens: g.inputTokens, cacheReadTokens: g.cacheReadTokens, outputTokens: g.outputTokens,
      cacheHitPercent: g.inputTokens + g.cacheReadTokens > 0 ? Number((g.cacheReadTokens / (g.inputTokens + g.cacheReadTokens) * 100).toFixed(1)) : null,
      thinkingTokens: g.thinkingTokens, responseTokens: g.responseTokens, ttftMs: g.ttftMs, streamingMs: g.streamingMs,
      durationMs, tpsDurationMs, tps, wholeTps, tpsMode,
      error: g.error || '', status: g.error ? 'error' : g.outputTokens > 0 ? 'success' : 'recorded', retries: g.retries, retryErrors:g.retryErrors||[] };
  });
}

export function resolveUsageDataDirs(appDataDir, options = {}) {
  const resolvedPrimaryDir = typeof appDataDir === 'string' && appDataDir.trim() ? resolve(appDataDir.trim()) : '';
  if (!resolvedPrimaryDir) return [];
  const candidateDirs = [resolvedPrimaryDir];
  if (options?.includeCli !== false) {
    const env = options?.env || process.env;
    if (typeof options?.cliDataDir === 'string') {
      if (options.cliDataDir.trim()) candidateDirs.push(resolve(options.cliDataDir.trim()));
    } else if (typeof env?.ANTIGRAVITY_CLI_DATA_DIR === 'string') {
      if (env.ANTIGRAVITY_CLI_DATA_DIR.trim()) candidateDirs.push(resolve(env.ANTIGRAVITY_CLI_DATA_DIR.trim()));
    } else if (basename(resolvedPrimaryDir).toLowerCase() === DESKTOP_APP_DIR_NAME) {
      candidateDirs.push(join(dirname(resolvedPrimaryDir), CLI_APP_DIR_NAME));
    }
  }
  if (Array.isArray(options?.extraDirs)) {
    for (const extraDir of options.extraDirs) {
      if (typeof extraDir === 'string' && extraDir.trim()) candidateDirs.push(resolve(extraDir.trim()));
    }
  }
  const seenKeys = new Set();
  const dataDirs = [];
  for (const dataDir of candidateDirs) {
    const normalizedDirKey = process.platform === 'win32' ? dataDir.toLowerCase() : dataDir;
    if (!seenKeys.has(normalizedDirKey)) {
      seenKeys.add(normalizedDirKey);
      dataDirs.push(dataDir);
    }
  }
  return dataDirs;
}

let cache;
const fileEventsCache = new Map();
let fileCacheKey = '';

function dbStamp(dbPath) {
  return [dbPath, `${dbPath}-wal`].map(p => {
    try {
      const s = statSync(p);
      return `${s.mtimeMs}:${s.size}`;
    } catch {
      return '';
    }
  }).join('|');
}

const ARCHIVE_RETENTION_MS = 90 * 86400000;
const ARCHIVE_MAX_REQUESTS = 20000;

function normalizeArchivedEvent(record) {
  if (!record) return record;
  const isStreamTimed = record.tpsMode === 'stream' || (
    record.tpsMode == null &&
    record.tpsDurationMs != null &&
    record.streamingMs != null &&
    record.tpsDurationMs === record.streamingMs
  );
  if (!isStreamTimed) return record;
  const durationMs = record.durationMs != null
    ? record.durationMs
    : (record.ttftMs != null && record.streamingMs != null ? record.ttftMs + record.streamingMs : null);
  if (!isBufferedTailFlush(record.outputTokens, record.streamingMs, durationMs)) return record;
  const speed = resolveRequestSpeed({
    outputTokens: record.outputTokens,
    ttftMs: record.ttftMs,
    streamingMs: record.streamingMs,
    durationMs
  });
  return {
    ...record,
    durationMs: speed.durationMs,
    tpsDurationMs: speed.tpsDurationMs,
    tps: speed.tps,
    wholeTps: record.wholeTps ?? speed.wholeTps,
    tpsMode: speed.tpsMode
  };
}

function mergeUsageArchive(dataDir, parsedIds, liveEvents, now) {
  const directory = join(dataDir, 'plugin_data', 'save-token');
  const path = join(directory, 'usage-history-cache.json');
  let previous = '', archived = [];
  try {
    previous = readFileSync(path, 'utf8');
    const records = JSON.parse(previous);
    if (Array.isArray(records)) archived = records.filter(r => r && typeof r.id === 'string' &&
      typeof r.conversationId === 'string' && Array.isArray(r.retryErrors)).map(normalizeArchivedEvent);
  } catch { /* A missing or invalid archive can be rebuilt from live files. */ }
  const cutoff = now - ARCHIVE_RETENTION_MS;
  const retained = archived.filter(r => r.timestampMs >= cutoff && !parsedIds.has(r.conversationId));
  const records = liveEvents.filter(r => r.timestampMs >= cutoff).concat(retained)
    .sort((a, b) => b.timestampMs - a.timestampMs).slice(0, ARCHIVE_MAX_REQUESTS);
  const serialized = JSON.stringify(records);
  if ((previous || records.length) && previous !== serialized) {
    const temp = join(directory, 'usage-history-' + randomUUID() + '.tmp');
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeFileSync(temp, serialized, { flag: 'wx', mode: 0o600 });
      renameSync(temp, path);
    } catch { /* Live statistics remain available on read-only profiles. */ }
    finally { try { rmSync(temp, { force: true }); } catch {} }
  }
  return records.filter(r => !parsedIds.has(r.conversationId));
}

export function usageDashboard(appDataDir, options = {}) {
  const force = options?.force === true;
  const dataDirs = resolveUsageDataDirs(appDataDir, options);
  const cacheKey = dataDirs.join('\0');
  if (!force && cache?.dir === cacheKey && Date.now() - cache.at < DASHBOARD_CACHE_TTL_MS) return cache.value;
  if (fileCacheKey !== cacheKey) {
    fileEventsCache.clear();
    fileCacheKey = cacheKey;
  }
  const activeFiles = new Set();
  const unique = new Map();
  const archivedEvents = [];
  const parsedConversations = new Set();
  for (const dataDir of dataDirs) {
    const parsedIds = new Set();
    const liveEvents = [];
    const convDir = join(dataDir, 'conversations');
    let files = [];
    try { files = readdirSync(convDir).filter(name => /^[\w-]+\.db$/.test(name)); } catch {}
    for (const file of files) {
      const databasePath = join(convDir, file);
      activeFiles.add(databasePath);
      const id = file.slice(0, -3);
      const stamp = dbStamp(databasePath);
      let cached = fileEventsCache.get(databasePath);
      if (force || !cached || cached.stamp !== stamp) {
        const db = readDatabase(dataDir, id, { force });
        if (!db) continue;
        cached = { stamp, events: requestEvents(db, id) };
        fileEventsCache.set(databasePath, cached);
      }
      parsedIds.add(id);
      parsedConversations.add(id);
      for (const event of cached.events) {
        liveEvents.push(event);
        if (!unique.has(event.id)) unique.set(event.id, event);
      }
    }
    archivedEvents.push(...mergeUsageArchive(dataDir, parsedIds, liveEvents, Date.now()));
  }
  for (const event of archivedEvents) {
    if (!parsedConversations.has(event.conversationId) && !unique.has(event.id)) unique.set(event.id, event);
  }
  for (const cachedPath of fileEventsCache.keys()) {
    if (!activeFiles.has(cachedPath)) fileEventsCache.delete(cachedPath);
  }
  const requests = [...unique.values()].sort((a,b) => (b.timestampMs || 0) - (a.timestampMs || 0));
  const days = new Map();
  for (const r of requests) {
    if (!r.timestampMs) continue;
    const date = new Date(r.timestampMs);
    const key = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
    if (!days.has(key)) days.set(key, { date: key, requests: 0, tokens: 0 });
    const day = days.get(key); day.requests++; day.tokens += r.inputTokens + r.cacheReadTokens + r.outputTokens;
  }
  const errors=requests.flatMap(r=>[...(r.error?[r]:[]),...r.retryErrors.filter(error=>error&&String(error).trim()&&error!==r.error).map((error,index)=>({...r,id:`${r.id}:retry:${index}`,status:'error',error}))]);
  const value = { requests, totalRequests: requests.length, errors, totalErrors:errors.length, days:[...days.values()], updatedAtMs:Date.now() };
  cache = { dir: cacheKey, at: Date.now(), value }; return value;
}
