/**
 * Save Token Context HUD — Streamlined HTTP/SSE Sidecar Server.
 * Focuses exclusively on live session context telemetry, SSE updates, and 0-LLM handoffs.
 */
import { existsSync, readFileSync, watch } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONV_ID_RE, createAntigravityAdapter } from './adapters/antigravity.mjs';
import { createHandoffStore, normalizeBranch, normalizeTags } from './handoff-store.mjs';
import { createPricingStore } from './vendor/agy-powertools/pricing.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_INDEX = join(__dirname, 'public', 'index.html');
const DEFAULT_DISTILL_SCRIPT = resolve(__dirname, '..', '..', 'scripts', 'distill-chat.mjs');
const MAX_BODY_BYTES = 64 * 1024;
const SSE_DEBOUNCE_MS = 250;
const SSE_HEARTBEAT_MS = 25000;
const LIVE_PROGRESS_MIN_INTERVAL_MS = 30000;

function resolveAppDataDir() {
  if (process.env.ANTIGRAVITY_APP_DATA_DIR?.trim()) return process.env.ANTIGRAVITY_APP_DATA_DIR.trim();
  const execData = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (execData) {
    for (let dir = execData; dir !== dirname(dir); dir = dirname(dir)) {
      if (basename(dir) === 'sidecar_data') return dirname(dir);
    }
  }
  return join(homedir(), '.gemini', 'antigravity');
}

const STANDALONE_PRELOAD_SHIM = `(() => {
  const params = new URLSearchParams(window.location.search);
  const tok = params.get('token') || '';
  window.sidecar = window.sidecar || {
    conversationId: params.get('conversationId') || '',
    fetch: (url, opts = {}) => {
      if (!tok) return window.fetch(url, opts);
      const headers = new Headers(opts.headers || {});
      if (!headers.has('X-Sidecar-Token')) headers.set('X-Sidecar-Token', tok);
      return window.fetch(url, { ...opts, headers });
    },
  };
})();\n`;

let cachedPreload = null;
function resolvePreloadJs(appDataDir) {
  if (cachedPreload !== null) return cachedPreload;
  const candidates = [];
  try {
    candidates.push(join(dirname(fileURLToPath(import.meta.resolve('sidecar_sdk'))), 'preload.js'));
  } catch {}
  candidates.push(
    join(appDataDir, 'lib', 'node_modules', 'sidecar_sdk', 'preload.js'),
    join(homedir(), '.gemini', 'antigravity', 'lib', 'node_modules', 'sidecar_sdk', 'preload.js'),
    join(homedir(), '.gemini', 'config', 'node_modules', 'sidecar_sdk', 'preload.js'),
  );
  for (const p of candidates) {
    try {
      if (existsSync(p)) {
        cachedPreload = readFileSync(p, 'utf8');
        return cachedPreload;
      }
    } catch {}
  }
  cachedPreload = STANDALONE_PRELOAD_SHIM;
  return cachedPreload;
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolveBody, rejectBody) => {
    let total = 0;
    const chunks = [];
    let settled = false;

    const fail = (status, code) => {
      if (settled) return;
      settled = true;
      const err = new Error(code);
      err.status = status;
      err.code = code;
      rejectBody(err);
    };

    req.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        fail(413, 'payload_too_large');
        req.resume();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolveBody({});
        return;
      }
      try {
        resolveBody(JSON.parse(raw));
      } catch {
        const err = new Error('invalid_json');
        err.status = 400;
        err.code = 'invalid_json';
        rejectBody(err);
      }
    });

    req.on('error', (err) => {
      if (!settled) {
        settled = true;
        err.status = 400;
        rejectBody(err);
      }
    });
  });
}

export function createHudServer(options = {}) {
  const bindHost = options.host || '127.0.0.1';
  const port = options.port ?? parseInt(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || process.env.PORT || '4195', 10);
  const uiToken = options.uiToken ?? (process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || '');
  const appDataDir = options.appDataDir || resolveAppDataDir();
  const pluginDataDir = options.pluginDataDir || join(appDataDir, 'plugin_data', 'save-token');
  const dbPath = options.dbPath || process.env.SAVE_TOKEN_DB_PATH || join(pluginDataDir, 'store.db');
  const handoffDir = options.handoffDir || join(dirname(dbPath), 'handoffs');
  const distillScriptPath = options.distillScriptPath || DEFAULT_DISTILL_SCRIPT;

  const pricingStore = createPricingStore(pluginDataDir);
  const handoffStore = createHandoffStore({ dbPath, handoffDir, progressDir: options.progressDir });
  const adapter = createAntigravityAdapter({ appDataDir, pluginDataDir, pricingStore, distillScriptPath });

  const sseClients = new Set();
  const liveProgressState = new Map();

  async function refreshLiveProgress(convId, branch, tags = [], force = false) {
    if (!convId || !CONV_ID_RE.test(convId)) return null;
    const cleanBranch = normalizeBranch(branch);
    const key = `${convId}:${cleanBranch}`;
    const prev = liveProgressState.get(key) || { inFlight: false, lastRunAt: 0, lastSig: '' };
    if (prev.inFlight) return null;
    if (!force && Date.now() - prev.lastRunAt < LIVE_PROGRESS_MIN_INTERVAL_MS) return null;
    prev.inFlight = true;
    liveProgressState.set(key, prev);
    try {
      const distilled = await adapter.createDistilledSummary({ conversationId: convId, maxChars: 2400 });
      if (!force && distilled.sourceSig === prev.lastSig) return null;
      const res = handoffStore.syncLiveProgress({
        branch: cleanBranch,
        conversationId: convId,
        title: distilled.title,
        project: distilled.project,
        summaryMd: distilled.summaryMd,
        tags,
      });
      prev.lastSig = distilled.sourceSig;
      prev.lastRunAt = Date.now();
      return res;
    } catch {
      return null;
    } finally {
      prev.inFlight = false;
    }
  }

  function isAuthorized(req, url) {
    if (!uiToken) return true;
    const headerTok = String(req.headers['x-antigravity-sidecar-token'] || req.headers['x-sidecar-token'] || '').trim();
    const auth = String(req.headers.authorization || '');
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const qTok = String(url.searchParams.get('token') || '').trim();
    return headerTok === uiToken || bearer === uiToken || qTok === uiToken;
  }

  function formatSse(event, payload) {
    return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  }

  function emitUpdate(scope = 'session', extra = {}) {
    const msg = formatSse('update', { scope, ts: Date.now(), ...extra });
    for (const client of sseClients) {
      if (!client.res.writableEnded) {
        try {
          client.res.write(msg);
        } catch {
          client.cleanup();
        }
      }
    }
  }

  function openSseStream(req, res, convId, branch = 'main', tags = []) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const cleanBranch = normalizeBranch(branch);
    res.write(formatSse('connected', { provider: adapter.provider, conversationId: convId || null, branch: cleanBranch, ts: Date.now() }));

    const watchers = [];
    let debounceTimer = null;
    let closed = false;

    const triggerLocalUpdate = (scope, isTranscriptChange = false) => {
      if (closed) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        if (closed) return;
        if (isTranscriptChange && convId) {
          refreshLiveProgress(convId, cleanBranch, tags, false).catch(() => {});
        }
        if (!res.writableEnded) {
          try {
            res.write(formatSse('update', { scope, branch: cleanBranch, ts: Date.now() }));
          } catch {
            cleanup();
          }
        }
      }, SSE_DEBOUNCE_MS);
      debounceTimer.unref?.();
    };

    for (const t of adapter.getWatchTargets(convId)) {
      try {
        const w = watch(t.dir, (_ev, fname) => {
          const name = fname ? String(fname) : '';
          if (!name || t.match(name)) {
            triggerLocalUpdate('session', /^transcript/i.test(name));
          }
        });
        w.on('error', () => {});
        watchers.push(w);
      } catch {
        // Fallback polling in UI covers unwatched targets.
      }
    }

    const heartbeat = setInterval(() => {
      if (!closed && !res.writableEnded) {
        try {
          res.write(': ping\n\n');
        } catch {
          cleanup();
        }
      }
    }, SSE_HEARTBEAT_MS);
    heartbeat.unref?.();

    const client = { res, cleanup };

    function cleanup() {
      if (closed) return;
      closed = true;
      sseClients.delete(client);
      if (debounceTimer) clearTimeout(debounceTimer);
      clearInterval(heartbeat);
      for (const w of watchers) {
        try { w.close(); } catch {}
      }
      if (!res.writableEnded) {
        try { res.end(); } catch {}
      }
    }

    sseClients.add(client);
    req.on('close', cleanup);
    res.on('close', cleanup);
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${bindHost}:${port || 4195}`);
    const pathname = url.pathname;

    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      try {
        const html = readFileSync(PUBLIC_INDEX, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(html);
      } catch (err) {
        sendJson(res, 500, { error: err?.message || 'index_read_failed' });
      }
      return;
    }

    if (req.method === 'GET' && pathname === '/preload.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(resolvePreloadJs(appDataDir));
      return;
    }

    if (req.method === 'GET' && pathname === '/api/health') {
      const addr = server.address();
      const actualPort = addr && typeof addr === 'object' ? addr.port : port;
      sendJson(res, 200, {
        ok: true,
        provider: adapter.provider,
        pid: process.pid,
        port: actualPort,
        appDataDir,
        dbPath: handoffStore.dbPath,
      });
      return;
    }

    if (!isAuthorized(req, url)) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/events') {
      const reqId = String(url.searchParams.get('id') || '').trim();
      const targetId = reqId && CONV_ID_RE.test(reqId) ? reqId : adapter.listSessions()[0]?.conversationId || '';
      const branch = normalizeBranch(url.searchParams.get('branch') || 'main');
      const tags = normalizeTags(url.searchParams.get('tags') || '');
      openSseStream(req, res, targetId, branch, tags);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/branches') {
      try {
        sendJson(res, 200, { branches: handoffStore.listBranches(15) });
      } catch (err) {
        sendJson(res, 500, { error: err?.message || 'branches_failed' });
      }
      return;
    }

    if (req.method === 'GET' && pathname === '/api/sessions') {
      try {
        sendJson(res, 200, { provider: adapter.provider, sessions: adapter.listSessions() });
      } catch (err) {
        sendJson(res, 500, { error: err?.message || 'sessions_failed' });
      }
      return;
    }

    if (req.method === 'GET' && pathname === '/api/session') {
      try {
        let targetId = String(url.searchParams.get('id') || '').trim();
        if (!targetId) {
          targetId = adapter.listSessions()[0]?.conversationId || '';
        }
        if (!targetId || !CONV_ID_RE.test(targetId)) {
          sendJson(res, 404, { error: 'conversation_not_found' });
          return;
        }
        sendJson(res, 200, adapter.getSession(targetId));
      } catch (err) {
        sendJson(res, 500, { error: err?.message || 'session_parse_failed' });
      }
      return;
    }

    if (req.method === 'GET' && pathname === '/api/burn') {
      try {
        const force = url.searchParams.get('force') === '1';
        sendJson(res, 200, adapter.getQuotaBurn({ force }));
      } catch (err) {
        sendJson(res, 500, { error: err?.message || 'burn_failed' });
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/api/handoff') {
      try {
        const body = await readJsonBody(req, MAX_BODY_BYTES);
        let convId = typeof body.conversationId === 'string' ? body.conversationId.trim() : '';
        if (!convId) {
          convId = adapter.listSessions()[0]?.conversationId || '';
        }
        if (!convId || !CONV_ID_RE.test(convId)) {
          sendJson(res, 400, { error: 'invalid_conversation_id' });
          return;
        }
        const branch = typeof body.branch === 'string' && body.branch.trim() ? normalizeBranch(body.branch) : '';
        const tags = normalizeTags(body.tags);
        const maxChars = typeof body.maxChars === 'number' ? body.maxChars : 3800;
        const distilled = await adapter.createDistilledSummary({ conversationId: convId, maxChars });
        const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 120) : distilled.title;
        const saved = handoffStore.saveHandoff({
          conversationId: convId,
          title,
          project: distilled.project,
          branch,
          tags,
          summaryMd: distilled.summaryMd,
          sourceSig: distilled.sourceSig,
        });
        emitUpdate('session', { action: 'handoff_created', handoffId: saved.handoffId, branch: saved.branch });
        sendJson(res, 201, saved);
      } catch (err) {
        const status =
          err?.status ||
          (err?.code === 'INVALID_CONVERSATION_ID' ? 400 : err?.code === 'NOT_FOUND' ? 404 : 500);
        sendJson(res, status, { error: err?.message || 'handoff_failed' });
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/api/progress') {
      try {
        const body = await readJsonBody(req, MAX_BODY_BYTES);
        let convId = typeof body.conversationId === 'string' ? body.conversationId.trim() : '';
        if (!convId) {
          convId = adapter.listSessions()[0]?.conversationId || '';
        }
        if (!convId || !CONV_ID_RE.test(convId)) {
          sendJson(res, 400, { error: 'invalid_conversation_id' });
          return;
        }
        const branch = typeof body.branch === 'string' && body.branch.trim() ? normalizeBranch(body.branch) : '';
        const tags = normalizeTags(body.tags);
        const distilled = await adapter.createDistilledSummary({ conversationId: convId, maxChars: 2400 });
        const updated = handoffStore.syncLiveProgress({
          branch,
          conversationId: convId,
          title: distilled.title,
          project: distilled.project,
          summaryMd: distilled.summaryMd,
          tags,
        });
        emitUpdate('session', { action: 'progress_synced', branch: updated.branch });
        sendJson(res, 200, updated);
      } catch (err) {
        const status =
          err?.status ||
          (err?.code === 'INVALID_CONVERSATION_ID' ? 400 : err?.code === 'NOT_FOUND' ? 404 : 500);
        sendJson(res, status, { error: err?.message || 'progress_sync_failed' });
      }
      return;
    }

    sendJson(res, 404, { error: 'not_found' });
  });

  function listen() {
    return new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(port, bindHost, () => {
        server.removeListener('error', rejectListen);
        const addr = server.address();
        resolveListen(addr && typeof addr === 'object' ? addr.port : port);
      });
    });
  }

  function close() {
    for (const c of [...sseClients]) c.cleanup();
    return new Promise((resolveClose) => {
      server.close(() => {
        handoffStore.close();
        resolveClose();
      });
    });
  }

  return { server, listen, close, emitUpdate, handoffStore, adapter };
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isEntrypoint) {
  const hud = createHudServer();
  hud.listen().then((actualPort) => {
    console.log(`[save-token:context-hud] listening on 127.0.0.1:${actualPort}`);
  });

  const shutdown = () => {
    hud.close().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
