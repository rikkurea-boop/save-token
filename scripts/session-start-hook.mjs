#!/usr/bin/env node
/**
 * Antigravity SessionStart Hook (0-LLM):
 * Reads virtual context branches & tags from shared store.db and injects a tiny (<900 chars)
 * pointer into fresh sessions so successor models use scoped external cache instead of re-reading raw history.
 * Always exits 0 with valid JSON (`{}` on empty/missing/error) so session startup is never blocked.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { resolveDbPath } from './storage-paths.mjs';

function toPosix(p) {
  return String(p || '').replace(/\\/g, '/');
}

function readStdinSafe(timeoutMs = 250) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve({});
      return;
    }
    let buf = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        resolve(buf.trim() ? JSON.parse(buf) : {});
      } catch {
        resolve({});
      }
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      if (buf.length < 32768) buf += chunk;
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
    process.stdin.resume();
  });
}

function parseTags(raw) {
  try {
    const arr = JSON.parse(String(raw || '[]'));
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch {
    return [];
  }
}

function normPath(p) {
  const s = toPosix(String(p || '').trim()).replace(/\/+$/, '');
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

export function buildSessionStartOutput(input = {}, env = process.env) {
  const dbPath = resolveDbPath(env);
  if (!existsSync(dbPath)) {
    return {};
  }

  const workspaceHints = new Set(
    [
      ...(Array.isArray(input.workspacePaths) ? input.workspacePaths : []),
      ...(input.cwd ? [input.cwd] : []),
    ]
      .map(normPath)
      .filter(Boolean)
  );

  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 1500;');

    const hasBranchCol = db
      .prepare("PRAGMA table_info(handoffs)")
      .all()
      .some((c) => c.name === 'branch');

    const rows = hasBranchCol
      ? db
          .prepare(
            "SELECT id, title, project, branch, tags_json, summary_md, created_at FROM handoffs ORDER BY created_at DESC LIMIT 40"
          )
          .all()
      : db
          .prepare("SELECT id, title, project, 'main' AS branch, '[]' AS tags_json, summary_md, created_at FROM handoffs ORDER BY created_at DESC LIMIT 20")
          .all();

    if (!rows.length) {
      return {};
    }

    const byBranch = new Map();
    for (const r of rows) {
      const b = String(r.branch || 'main').trim() || 'main';
      if (!byBranch.has(b)) {
        const projNorm = normPath(r.project);
        const matchesWorkspace = projNorm && workspaceHints.size > 0 && [...workspaceHints].some((w) => projNorm.includes(w) || w.includes(projNorm));
        byBranch.set(b, {
          branch: b,
          title: String(r.title || '').slice(0, 48),
          tags: new Set(parseTags(r.tags_json)),
          summaryMd: String(r.summary_md || ''),
          createdAt: Number(r.created_at || 0),
          matchesWorkspace: Boolean(matchesWorkspace),
        });
      } else {
        for (const t of parseTags(r.tags_json)) byBranch.get(b).tags.add(t);
      }
    }

    const srcHasBranch = db
      .prepare("PRAGMA table_info(sources)")
      .all()
      .some((c) => c.name === 'branch');
    if (srcHasBranch) {
      for (const s of db.prepare('SELECT branch, tags_json FROM sources ORDER BY id DESC LIMIT 60').all()) {
        const b = String(s.branch || 'main').trim() || 'main';
        const entry = byBranch.get(b);
        if (entry) {
          for (const t of parseTags(s.tags_json)) entry.tags.add(t);
        }
      }
    }

    const ranked = [...byBranch.values()]
      .sort((a, b) => Number(b.matchesWorkspace) - Number(a.matchesWorkspace) || b.createdAt - a.createdAt)
      .slice(0, 5);

    const progressDir = toPosix(join(dirname(dbPath), 'progress'));
    const branchLines = ranked.map((b) => {
      const tagsList = [...b.tags].slice(0, 6);
      const pFile = `${progressDir}/${b.branch}.md`;
      const pHint = existsSync(pFile) ? ` -> ${pFile}` : '';
      return `- ${b.branch}${tagsList.length ? ` [${tagsList.join(',')}]` : ''}${b.title ? `: ${b.title}` : ''}${pHint}`;
    });

    const parts = [
      '[Save Token External Cache] Co ngu canh ngoai luu theo nhanh/nhan (0-LLM):',
      ...branchLines,
      'Dung save_token_resume({ branch }) hoac save_token_search({ queries, branch, tags }) de nap dung nhanh can thiet thay vi doc lai lich su cu.',
    ];

    const top = ranked[0];
    const autoLoadMin = Math.max(5, Number(env.SAVE_TOKEN_AUTOLOAD_MINUTES) || 45);
    const ageMs = Date.now() - (top?.createdAt || 0);
    const isFreshWorkspace = top?.matchesWorkspace && ageMs >= 0 && ageMs <= autoLoadMin * 60 * 1000;
    const isRecentAutoSwitch = (top?.tags.has('idle-auto') || top?.tags.has('auto-switch')) && ageMs >= 0 && ageMs <= 15 * 60 * 1000;
    if (top && top.summaryMd && (isFreshWorkspace || isRecentAutoSwitch)) {
      const topTags = [...top.tags].slice(0, 6).join(',');
      const snap = top.summaryMd.replace(/\r\n/g, '\n').trim().slice(0, 1600);
      parts.push('', `[Auto-Loaded Snapshot: ${top.branch}${topTags ? ` (${topTags})` : ''}]`, snap);
    }

    const msg = parts.join('\n').slice(0, 2600);
    const isStandardHook =
      input?.hook_event_name === 'SessionStart' ||
      (Boolean(input?.session_id) && !Array.isArray(input?.workspacePaths));
    if (isStandardHook) {
      return {
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: msg,
        },
      };
    }
    return {
      injectSteps: [{ systemMessage: { systemMessage: msg } }],
    };
  } catch {
    return {};
  } finally {
    try { db?.close(); } catch {}
  }
}

async function main() {
  const input = await readStdinSafe();
  const out = buildSessionStartOutput(input, process.env);
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

const isEntry =
  process.argv[1] &&
  toPosix(resolve(process.argv[1])).toLowerCase() === toPosix(resolve(fileURLToPath(import.meta.url))).toLowerCase();

if (isEntry) {
  main().catch(() => {
    process.stdout.write('{}\n');
    process.exit(0);
  });
}
