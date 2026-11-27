#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { compactOutput } from "./compact-engine.mjs";
import { resolveDataDir, resolveDbPath } from "./storage-paths.mjs";

function parseArgs(argv) {
  const opts = { b64: "", kind: "auto", maxChars: 6000 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--b64" && argv[i + 1]) opts.b64 = argv[++i];
    else if (a.startsWith("--b64=")) opts.b64 = a.slice(6);
    else if (a === "--kind" && argv[i + 1]) opts.kind = argv[++i];
    else if (a.startsWith("--kind=")) opts.kind = a.slice(7);
    else if (a === "--max" && argv[i + 1]) opts.maxChars = Math.max(500, Math.min(32000, Number(argv[++i]) || 6000));
    else if (a.startsWith("--max=")) opts.maxChars = Math.max(500, Math.min(32000, Number(a.slice(6)) || 6000));
  }
  return opts;
}

function recordCompactMetric(rawBytes, returnedBytes, rawText) {
  const dbPath = resolveDbPath();
  if (!existsSync(dbPath)) return "";
  let db = null;
  try {
    db = new DatabaseSync(dbPath);
    db.exec("PRAGMA busy_timeout = 150;");
    try {
      db.prepare("INSERT INTO metrics_events(ts, tool, raw_bytes, returned_bytes, project) VALUES (?, ?, ?, ?, ?)").run(
        Date.now(),
        "hook_shell",
        rawBytes,
        returnedBytes,
        process.cwd()
      );
    } catch {
      // Ignore if metrics_events table not migrated yet
    }
    if (rawBytes >= 3000) {
      try {
        const label = `shell:${Date.now().toString(36)}`;
        const row = db
          .prepare("INSERT INTO sources(label, bytes_total, chunk_count, created_at, branch, tags_json) VALUES (?, ?, 1, ?, 'main', '[\"cli\"]') RETURNING id")
          .get(label, rawBytes, Date.now());
        if (row?.id) {
          const snippet = rawText.slice(0, 12000);
          db.prepare("INSERT INTO chunks(source_id, ord, title, body) VALUES (?, 0, ?, ?)").run(Number(row.id), label, snippet);
          db.prepare("INSERT INTO chunks_tri(source_id, ord, title, body) VALUES (?, 0, ?, ?)").run(Number(row.id), label, snippet);
          return label;
        }
      } catch {
        // Fail-safe: never fail shell command on DB lock/schema mismatch
      }
    }
  } catch {
    return "";
  } finally {
    try { db?.close(); } catch {}
  }
  return "";
}

function fmtSize(bytes) {
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}

function saveTeeReceipt(rawText, originalCmd, exitCode, rawBytes, savedPct) {
  if (process.env.SAVE_TOKEN_NO_TEE === "1") return "";
  const isFailureTee = exitCode !== 0 && rawBytes >= 500;
  const isCcrReceipt = process.env.SAVE_TOKEN_TEE_ALL === "1" || (rawBytes >= 8192 && savedPct >= 50);
  if (!isFailureTee && !isCcrReceipt) return "";
  try {
    const teeDir = join(resolveDataDir(), "tee");
    mkdirSync(teeDir, { recursive: true });
    const slug =
      String(originalCmd || "cmd")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 32) || "cmd";
    const filePath = join(teeDir, `${Date.now().toString(36)}-${slug}.log`);
    writeFileSync(
      filePath,
      `# cmd: ${originalCmd}\n# exit: ${exitCode}\n# saved: ${savedPct}%\n\n${rawText}`,
      "utf8"
    );

    // Rotate: keep only 20 newest receipt logs
    try {
      const files = readdirSync(teeDir)
        .filter((f) => f.endsWith(".log"))
        .map((f) => ({ path: join(teeDir, f), mtime: statSync(join(teeDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      for (const old of files.slice(20)) {
        try { rmSync(old.path, { force: true }); } catch {}
      }
    } catch {}
    return filePath.replace(/\\/g, "/");
  } catch {
    return "";
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.b64) {
    process.stderr.write("[save-token compact-shell] Missing --b64 argument.\n");
    process.exit(2);
  }

  let originalCmd = "";
  try {
    originalCmd = Buffer.from(opts.b64, "base64").toString("utf8").trim();
  } catch {
    process.stderr.write("[save-token compact-shell] Invalid base64 command.\n");
    process.exit(2);
  }
  if (!originalCmd) {
    process.stderr.write("[save-token compact-shell] Empty command.\n");
    process.exit(2);
  }

  const childEnv = { ...process.env, SAVE_TOKEN_NO_COMPACT: "1" };
  const isWin = process.platform === "win32";
  const bin = isWin ? "powershell.exe" : "sh";
  const binArgs = isWin
    ? ["-NoProfile", "-Command", originalCmd]
    : ["-c", originalCmd];

  const res = spawnSync(bin, binArgs, {
    encoding: "utf8",
    env: childEnv,
    maxBuffer: 16 * 1024 * 1024,
  });

  if (res.error) {
    process.stderr.write(`${res.error.message || String(res.error)}\n`);
    process.exit(1);
  }

  const exitCode = typeof res.status === "number" ? res.status : 1;
  const combined = [res.stdout || "", res.stderr || ""].filter(Boolean).join(res.stdout && res.stderr && !res.stdout.endsWith("\n") ? "\n" : "");
  const rawBytes = Buffer.byteLength(combined, "utf8");
  if (!combined) process.exit(exitCode);

  const compacted = compactOutput(combined, {
    kind: opts.kind,
    commandHint: originalCmd,
    maxChars: opts.maxChars,
    cwd: process.cwd(),
  });
  const outBytes = Buffer.byteLength(compacted, "utf8");
  const savedPct = rawBytes > 0 ? Math.round((1 - outBytes / rawBytes) * 100) : 0;

  if (rawBytes < 1200 && savedPct < 15) {
    process.stdout.write(combined.endsWith("\n") ? combined : `${combined}\n`);
    process.exit(exitCode);
  }

  const teePath = saveTeeReceipt(combined, originalCmd, exitCode, rawBytes, savedPct);
  const sourceLabel = recordCompactMetric(rawBytes, outBytes, combined);
  const srcNote = sourceLabel ? ` | indexed=${sourceLabel}` : "";
  const teeNote = teePath ? ` | full=${teePath}` : "";
  const footer = `[save-token compact: ${fmtSize(rawBytes)} -> ${fmtSize(outBytes)} (-${Math.max(0, savedPct)}%) | exit=${exitCode}${srcNote}${teeNote}]`;
  process.stdout.write(`${compacted}\n${footer}\n`);
  process.exit(exitCode);
}

main();
