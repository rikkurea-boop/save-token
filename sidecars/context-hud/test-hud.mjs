/**
 * Verification suite for the streamlined vertical Save Token Context HUD.
 * Checks auth, removed routes (404), 70-80% handoff threshold, compact session telemetry,
 * 0-LLM POST /api/handoff + FTS5 persistence, and SSE real-time updates.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createHudServer } from './main.mjs';

function hasChinese(str) {
  return /[\u4e00-\u9fff]/.test(String(str || ''));
}

async function reqJson(baseUrl, path, { method = 'GET', token = '', headers = {}, body } = {}) {
  const h = { ...headers };
  if (token) h['X-Sidecar-Token'] = token;
  if (body !== undefined && !h['Content-Type']) h['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

function openSseClient(url) {
  return new Promise((resolve, reject) => {
    const events = [];
    const req = http.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`SSE unexpected status ${res.statusCode}`));
        return;
      }
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', (chunk) => {
        buf += chunk;
        const frames = buf.split('\n\n');
        buf = frames.pop() || '';
        for (const frame of frames) {
          const lines = frame.split('\n');
          let event = 'message';
          let data = '';
          for (const ln of lines) {
            if (ln.startsWith('event:')) event = ln.slice(6).trim();
            else if (ln.startsWith('data:')) data += ln.slice(5).trim();
          }
          if (data) {
            try {
              events.push({ event, data: JSON.parse(data) });
            } catch {
              events.push({ event, data });
            }
          }
        }
      });
      resolve({
        events,
        waitFor(eventName, timeoutMs = 4000) {
          const existing = events.find((e) => e.event === eventName);
          if (existing) return Promise.resolve(existing);
          return new Promise((resWait, rejWait) => {
            const started = Date.now();
            const timer = setInterval(() => {
              const found = events.find((e) => e.event === eventName);
              if (found) {
                clearInterval(timer);
                resWait(found);
              } else if (Date.now() - started > timeoutMs) {
                clearInterval(timer);
                rejWait(new Error(`Timed out waiting for SSE event "${eventName}"`));
              }
            }, 40);
            timer.unref();
          });
        },
        close() {
          req.destroy();
          res.destroy();
        },
      });
    });
    req.on('error', reject);
  });
}

async function main() {
  const tempRoot = mkdtempSync(join(tmpdir(), 'save-token-hud-slim-'));
  const appDataDir = join(tempRoot, 'appData');
  const pluginDataDir = join(appDataDir, 'plugin_data', 'save-token');
  const dbPath = join(pluginDataDir, 'store.db');
  const handoffDir = join(pluginDataDir, 'handoffs');
  const convId = 'b1c2d3e4-1111-2222-3333-444455556666';
  const convHighId = 'c2d3e4f5-1111-2222-3333-444455557777';
  const logsDir = join(appDataDir, 'brain', convId, '.system_generated', 'logs');
  const logsHighDir = join(appDataDir, 'brain', convHighId, '.system_generated', 'logs');
  mkdirSync(logsDir, { recursive: true });
  mkdirSync(logsHighDir, { recursive: true });
  mkdirSync(join(appDataDir, 'conversations'), { recursive: true });
  mkdirSync(pluginDataDir, { recursive: true });

  const nowMs = Date.now();
  const archiveConvId = 'd3e4f5a6-1111-2222-3333-444455558888';
  const burnArchive = [
    {
      id: 'burn-rec-5h',
      conversationId: archiveConvId,
      timestampMs: nowMs - 3600 * 1000,
      model: 'gemini-4-neon',
      inputTokens: 150000,
      cacheReadTokens: 0,
      outputTokens: 1200,
      thinkingTokens: 200,
      retryErrors: [],
    },
    {
      id: 'burn-rec-2d',
      conversationId: archiveConvId,
      timestampMs: nowMs - 2 * 86400 * 1000,
      model: 'gemini-4-hydrogen',
      inputTokens: 5000,
      cacheReadTokens: 95000,
      outputTokens: 800,
      thinkingTokens: 100,
      retryErrors: [],
    },
    {
      id: 'burn-rec-10d',
      conversationId: archiveConvId,
      timestampMs: nowMs - 10 * 86400 * 1000,
      model: 'gemini-4-neon',
      inputTokens: 90000,
      cacheReadTokens: 0,
      outputTokens: 500,
      thinkingTokens: 0,
      retryErrors: [],
    },
  ];
  writeFileSync(join(pluginDataDir, 'usage-history-cache.json'), JSON.stringify(burnArchive), 'utf8');

  const t0 = Date.now() - 120 * 1000;
  const t1 = t0 + 5 * 1000;
  const t2 = t1 + 10 * 1000;

  // Session 1: 181k tokens (should NOT warn for handoff on 1M context window)
  const transcript181k = [
    {
      step_index: 0,
      source: 'USER',
      type: 'USER_INPUT',
      created_at: new Date(t0).toISOString(),
      content: '<USER_REQUEST>Kiểm tra ngưỡng handoff 181k trên cửa sổ 1M</USER_REQUEST>',
    },
    {
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: new Date(t0 + 1000).toISOString(),
      model: 'gemini-3-flash',
      input_tokens: 11000,
      cache_read_tokens: 170000,
      output_tokens: 450,
      content: 'Đang chạy tool.',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm test' } }],
    },
    {
      step_index: 2,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      created_at: new Date(t1).toISOString(),
      content: `Created At: ${new Date(t1).toISOString()}\nCompleted At: ${new Date(t1 + 800).toISOString()}\nPASS`,
    },
  ];
  for (const fname of ['transcript.jsonl', 'transcript_full.jsonl']) {
    writeFileSync(join(logsDir, fname), transcript181k.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8');
  }

  // Session 2: 750k tokens (>= 70-80% threshold when maxTokens unavailable or 1M)
  const transcript750k = [
    {
      step_index: 0,
      source: 'USER',
      type: 'USER_INPUT',
      created_at: new Date(t2).toISOString(),
      content: '<USER_REQUEST>Phiên nặng 750k cần cảnh báo handoff</USER_REQUEST>',
    },
    {
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: new Date(t2 + 1000).toISOString(),
      model: 'gemini-pro-orchestrator-neon',
      input_tokens: 50000,
      cache_read_tokens: 700000,
      output_tokens: 600,
      content: 'Đã xử lý xong.',
    },
  ];
  for (const fname of ['transcript.jsonl', 'transcript_full.jsonl']) {
    writeFileSync(join(logsHighDir, fname), transcript750k.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8');
  }

  const UI_TOKEN = 'hud-test-secret';
  const sidecarCalls = [];
  const hud = createHudServer({
    port: 0,
    uiToken: UI_TOKEN,
    appDataDir,
    pluginDataDir,
    dbPath,
    handoffDir,
    agentApiRunner: async (args, runnerOpts = {}) => {
      sidecarCalls.push({ args, runnerOpts });
      if (args[0] === 'get-conversation-metadata') {
        return { response: { conversationMetadata: { metadata: { projectId: 'proj-test' } } } };
      }
      return { conversationId: 'e4f5a6b7-1111-2222-3333-444455559999' };
    },
  });

  let sseClient = null;
  try {
    const actualPort = await hud.listen();
    const baseUrl = `http://127.0.0.1:${actualPort}`;

    // 1. Auth & Health & Index HTML check
    const h = await reqJson(baseUrl, '/api/health');
    assert.equal(h.status, 200);
    assert.equal(h.json.ok, true);
    assert.equal(h.json.provider, 'antigravity');

    const unauth = await reqJson(baseUrl, '/api/sessions');
    assert.equal(unauth.status, 401);

    const htmlRes = await fetch(`${baseUrl}/`);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    for (const forbidden of ['tab-overview', 'tab-hub', 'sparkCtxSvg', 'diagBox', 'subagentsCard', 'class="legend"']) {
      assert.equal(html.includes(forbidden), false, `Removed UI fragment still present: ${forbidden}`);
    }
    assert.equal(hasChinese(html), false, 'HTML should not contain Chinese text');
    assert.equal(html.includes('copyCompactBtn'), true, 'Expected copyCompactBtn in HUD HTML');
    assert.equal(html.includes('burnCard'), true, 'Expected burnCard in HUD HTML');
    assert.equal(html.includes('cacheWarmthBadge'), true, 'Expected cacheWarmthBadge in HUD HTML');
    assert.equal(html.includes('startConversation'), true, 'Expected startConversation in HUD HTML');
    assert.equal(html.includes('toggleConversation'), true, 'Expected toggleConversation in HUD HTML');

    const unauthBurn = await reqJson(baseUrl, '/api/burn');
    assert.equal(unauthBurn.status, 401);
    const burnRes = await reqJson(baseUrl, '/api/burn?force=1', { token: UI_TOKEN });
    assert.equal(burnRes.status, 200);
    assert.equal(hasChinese(JSON.stringify(burnRes.json)), false);
    assert.equal(burnRes.json.window5h.requests, 1);
    assert.equal(burnRes.json.window5h.uncachedInputTokens, 150000);
    assert.equal(burnRes.json.window5h.cacheReadTokens, 0);
    assert.equal(burnRes.json.window5h.coldSwitches, 1);
    assert.ok(burnRes.json.window5h.weightedBurnTokens > 150000);
    const sp5 = burnRes.json.window5h.burnSplit;
    assert.ok(sp5 && Math.abs(sp5.uncachedInputSharePct + sp5.cacheReadSharePct + sp5.outputSharePct - 100) <= 0.3);
    assert.equal(burnRes.json.window7d.requests, 2);
    assert.equal(burnRes.json.window7d.uncachedInputTokens, 155000);
    assert.equal(burnRes.json.window7d.cacheReadTokens, 95000);
    assert.equal(burnRes.json.window7d.coldSwitches, 1);

    // 2. Sessions, 181k ok vs 750k warn threshold, removed payload keys
    const sessList = await reqJson(baseUrl, '/api/sessions', { token: UI_TOKEN });
    assert.equal(sessList.status, 200);
    assert.equal(sessList.json.sessions.length, 2);
    assert.equal(hasChinese(JSON.stringify(sessList.json)), false);

    const s181 = await reqJson(baseUrl, `/api/session?id=${convId}`, { token: UI_TOKEN });
    assert.equal(s181.status, 200);
    assert.equal(hasChinese(JSON.stringify(s181.json)), false);
    assert.equal(s181.json.handoffAdvice.level, 'ok');
    assert.equal(s181.json.handoffAdvice.recommended, false);
    assert.equal(s181.json.switchAdvice.shouldCompactBeforeSwitch, true);
    assert.ok(s181.json.switchAdvice.savedPercent >= 80, `Expected savedPercent >= 80, got ${s181.json.switchAdvice.savedPercent}`);
    assert.ok(['warm', 'cooling', 'cold'].includes(s181.json.cacheWarmth?.status));
    assert.equal(s181.json.cacheWarmth.ttlSeconds, 300);
    assert.equal(s181.json.cacheWarmth.riskTokens, 181000);
    for (const removedKey of ['diagnostics', 'coldSpikesCount', 'anomaliesCount', 'series', 'subagents', 'tokenSplit', 'timeSplit']) {
      assert.equal(Object.hasOwn(s181.json, removedKey), false, `Removed API field still present: ${removedKey}`);
    }
    assert.ok(s181.json.recentRequests.length >= 1 && s181.json.recentRequests[0].shortModel);
    assert.ok(s181.json.topTools.some((t) => t.toolName === 'run_command'));

    const s750 = await reqJson(baseUrl, `/api/session?id=${convHighId}`, { token: UI_TOKEN });
    assert.equal(s750.status, 200);
    assert.equal(s750.json.handoffAdvice.level, 'warn');
    assert.equal(s750.json.handoffAdvice.recommended, true);
    console.log('PASS HUD 1-2: Slim UI/API, removed features absent, 181k ok vs 750k warn');

    // 3. Removed endpoints must return 404
    for (const gone of ['/api/overview', '/api/hub/summary', '/api/hub/handoffs', '/api/hub/search?q=test', '/api/hub/memory']) {
      const r = await reqJson(baseUrl, gone, { token: UI_TOKEN });
      assert.equal(r.status, 404, `Expected 404 for removed route ${gone}, got ${r.status}`);
    }
    console.log('PASS HUD 3: Removed /api/overview & /api/hub/* routes return 404');

    // 4. POST /api/handoff + SSE update + DB verification
    const badId = await reqJson(baseUrl, '/api/handoff', {
      method: 'POST',
      token: UI_TOKEN,
      body: { conversationId: '../../etc/passwd' },
    });
    assert.equal(badId.status, 400);

    const bigBody = await reqJson(baseUrl, '/api/handoff', {
      method: 'POST',
      token: UI_TOKEN,
      body: JSON.stringify({ conversationId: convId, title: 'X'.repeat(70000) }),
    });
    assert.equal(bigBody.status, 413);

    sseClient = await openSseClient(`${baseUrl}/api/events?id=${convId}&token=${encodeURIComponent(UI_TOKEN)}`);
    const connectedEv = await sseClient.waitFor('connected');
    assert.equal(connectedEv.data.provider, 'antigravity');

    const createdHd = await reqJson(baseUrl, '/api/handoff', {
      method: 'POST',
      token: UI_TOKEN,
      body: { conversationId: convId, branch: 'cache-opt', tags: ['hud', 'sse'], maxChars: 3800 },
    });
    assert.equal(createdHd.status, 201);
    assert.ok(createdHd.json.handoffId);
    assert.equal(createdHd.json.branch, 'cache-opt');
    assert.deepEqual(createdHd.json.tags, ['hud', 'sse']);
    assert.equal(existsSync(createdHd.json.filePath), true);
    assert.equal(existsSync(createdHd.json.progressPath), true);
    assert.ok(readFileSync(createdHd.json.filePath, 'utf8').includes('181k'));
    assert.ok(readFileSync(createdHd.json.progressPath, 'utf8').includes('Progress Branch: cache-opt'));

    const updateEv = await sseClient.waitFor('update');
    assert.equal(updateEv.data.action, 'handoff_created');
    sseClient.close();
    sseClient = null;

    const branchRes = await reqJson(baseUrl, '/api/branches', { token: UI_TOKEN });
    assert.equal(branchRes.status, 200);
    assert.ok(branchRes.json.branches.some((b) => b.branch === 'cache-opt'));

    // POST /api/progress with traversal branch gets safely normalized into progress/
    const progRes = await reqJson(baseUrl, '/api/progress', {
      method: 'POST',
      token: UI_TOKEN,
      body: { conversationId: convId, branch: '../../evil_branch', tags: ['live'] },
    });
    assert.equal(progRes.status, 200);
    assert.equal(progRes.json.branch, 'evil_branch');
    assert.equal(existsSync(progRes.json.progressPath), true);

    // Verify DB handoffs + FTS5 index compatibility with save_token_resume
    const checkDb = new DatabaseSync(dbPath, { readOnly: true });
    const hdRow = checkDb.prepare('SELECT id, branch, tags_json FROM handoffs WHERE id = ?').get(createdHd.json.handoffId);
    const srcRow = checkDb.prepare('SELECT id, branch FROM sources WHERE label = ?').get(`handoff:${createdHd.json.handoffId}`);
    checkDb.close();
    assert.ok(hdRow && hdRow.branch === 'cache-opt' && srcRow && srcRow.branch === 'cache-opt', 'Expected branch-scoped handoff and FTS5 source in store.db');

    // Auto-infer branch & tags when omitted on POST /api/handoff
    const autoHd = await reqJson(baseUrl, '/api/handoff', {
      method: 'POST',
      token: UI_TOKEN,
      body: { conversationId: convId, title: 'Fix HUD cache miss latency', maxChars: 3800 },
    });
    assert.equal(autoHd.status, 201);
    assert.notEqual(autoHd.json.branch, 'main');
    assert.ok(Array.isArray(autoHd.json.tags) && autoHd.json.tags.length > 0);

    console.log('PASS HUD 4-5: 0-LLM POST /api/handoff, auto branch/tags, live /api/progress, FTS5 & SSE');

    // 6. Sidecar SDK routes (/_sidecar/new-conversation & /_sidecar/get-conversation-metadata)
    const unauthSidecar = await reqJson(baseUrl, '/_sidecar/new-conversation', {
      method: 'POST',
      body: { message: 'hello' },
    });
    assert.equal(unauthSidecar.status, 401);

    const sidecarNew = await reqJson(baseUrl, '/_sidecar/new-conversation', {
      method: 'POST',
      token: UI_TOKEN,
      body: { message: 'Tiep noi...', title: 'Test', model: 'flash', projectId: 'proj-test' },
    });
    assert.equal(sidecarNew.status, 200);
    assert.equal(sidecarNew.json.conversationId, 'e4f5a6b7-1111-2222-3333-444455559999');
    const newCall = sidecarCalls.find((c) => c.args[0] === 'new-conversation');
    assert.ok(newCall, 'Expected mocked agentapi new-conversation call');
    assert.equal(newCall.args.includes('--model'), true);
    assert.equal(newCall.args.includes('flash'), true);
    assert.equal(newCall.args.includes('--title'), true);
    assert.equal(newCall.args.includes('Test'), true);
    assert.equal(newCall.runnerOpts.projectId, 'proj-test');

    const sidecarMeta = await reqJson(baseUrl, '/_sidecar/get-conversation-metadata', {
      method: 'POST',
      token: UI_TOKEN,
      body: { conversationId: convId },
    });
    assert.equal(sidecarMeta.status, 200);
    assert.equal(sidecarMeta.json?.response?.conversationMetadata?.metadata?.projectId, 'proj-test');

    console.log('PASS HUD 6: /_sidecar/new-conversation, /_sidecar/get-conversation-metadata & UI conversation switch');
    console.log('ALL HUD TESTS PASSED');
  } finally {
    if (sseClient) sseClient.close();
    await hud.close();
    try {
      rmSync(tempRoot, { recursive: true, force: true });
    } catch {}
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
