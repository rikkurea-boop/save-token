/**
 * RTK-grade + Caveman-grade deterministic CLI & structured data compressor (zero dependencies).
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";

export function stripAnsi(text) {
  return String(text ?? "")
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "");
}

export function detectCompactKind(rawLines, commandHint = "") {
  const hint = String(commandHint || "").trim();
  if (hint) {
    if (/^\s*git\s+status\b/i.test(hint)) return "git-status";
    if (/^\s*git\s+diff\b/i.test(hint)) return "git-diff";
    if (/^\s*git\s+log\b/i.test(hint)) return "git-log";
    if (/\b(?:vitest|jest|pytest|cargo\s+test|go\s+test|dotnet\s+test|(?:npm|pnpm|yarn)\s+(?:run\s+)?test)\b/i.test(hint) || /--test\b/i.test(hint)) {
      return "test";
    }
    if (/\b(?:tsc|eslint|ruff|mypy|flake8|vite|webpack|cargo\s+(?:build|check|clippy)|(?:npm|pnpm|yarn)\s+run\s+(?:build|lint|typecheck))\b/i.test(hint)) {
      return "build-lint";
    }
    if (/\b(?:npm|pnpm|yarn)\s+(?:install|ci)\b|\bpip3?\s+install\b/i.test(hint)) {
      return "install";
    }
    if (/\b(?:docker(?:\s+compose)?\s+logs|kubectl\s+logs)\b/i.test(hint)) {
      return "docker-logs";
    }
  }

  const headSample = rawLines.slice(0, 40);
  const tailSample = rawLines.length > 40 ? rawLines.slice(-15) : [];
  const sample = [...headSample, ...tailSample].join("\n");
  if (/^diff --git\s/m.test(sample)) return "git-diff";
  if (/^commit\s+[0-9a-f]{7,40}\b/m.test(sample) && /^Date:\s+/m.test(sample)) return "git-log";
  if (/^\s*(?:M|A|D|R|\?\?)\s+\S/m.test(sample) && rawLines.length > 6) return "git-status";
  if (/(?:PASS|FAIL|AssertionError|ERR!|Tests?:|passed|failed)/i.test(sample) || /^(?:\s*(?:ok\s+\d+|✓|✔)\b.*(?:\r?\n|$)){3,}/im.test(sample)) return "test";
  if (/(?:error TS\d+|eslint|warning\[|error\[E\d+\]|\d+\s+errors?\s+generated)/i.test(sample)) return "build-lint";
  if (/(?:added \d+ packages|Successfully installed|Resolving dependencies|Fetching metadata)/i.test(sample)) return "install";
  const searchMatchCount = headSample.filter((ln) => /^(?:[A-Za-z]:)?[^\s:][^:]*:\d+:/.test(ln.trim())).length;
  if (searchMatchCount >= 8) return "search";
  return "generic";
}

function compactGitStatus(rawLines) {
  const out = [];
  const entries = [];
  for (const ln of rawLines) {
    const t = ln.trim();
    if (!t) continue;
    if (/^\(use "git /i.test(t) || /^Changes (?:to be committed|not staged)|^Untracked files:/i.test(t)) continue;
    const m = ln.match(/^\s*([MADRCU?!]{1,2}|modified:|new file:|deleted:|renamed:)\s+(.+)$/);
    if (m) {
      entries.push({ code: m[1].replace(":", ""), file: m[2].trim() });
    } else if (/^On branch\b|^Your branch\b|^HEAD detached\b|^nothing to commit/i.test(t)) {
      out.push(t);
    } else if (entries.length === 0) {
      out.push(ln);
    }
  }
  if (entries.length === 0) return rawLines.join("\n").trim();

  if (entries.length <= 15) {
    for (const e of entries) out.push(`${e.code} ${e.file}`);
    return out.join("\n").trim();
  }

  const byCode = new Map();
  for (const e of entries) {
    if (!byCode.has(e.code)) byCode.set(e.code, []);
    byCode.get(e.code).push(e.file);
  }
  out.push(`Summary: ${entries.length} changed files`);
  for (const [code, files] of byCode.entries()) {
    const shown = files.slice(0, 8).join(", ");
    const extra = files.length > 8 ? ` (+${files.length - 8} more)` : "";
    out.push(`[${code}] (${files.length}): ${shown}${extra}`);
  }
  return out.join("\n").trim();
}

function compactGitDiff(rawLines, maxChars = 0) {
  const files = [];
  let cur = null;
  for (const ln of rawLines) {
    if (ln.startsWith("diff --git ")) {
      if (cur) files.push(cur);
      const m = ln.match(/^diff --git a\/(.+?) b\/(.+)$/);
      cur = { header: ln, name: m ? m[2] : ln.slice(11), adds: 0, dels: 0, hunks: [] };
      continue;
    }
    if (!cur) continue;
    if (ln.startsWith("@@")) {
      cur.hunks.push(ln);
    } else if (ln.startsWith("+") && !ln.startsWith("+++")) {
      cur.adds += 1;
      if (cur.hunks.length <= 20) cur.hunks.push(ln);
    } else if (ln.startsWith("-") && !ln.startsWith("---")) {
      cur.dels += 1;
      if (cur.hunks.length <= 20) cur.hunks.push(ln);
    }
  }
  if (cur) files.push(cur);
  if (files.length === 0) return rawLines.join("\n").trim();

  const totalAdd = files.reduce((s, f) => s + f.adds, 0);
  const totalDel = files.reduce((s, f) => s + f.dels, 0);
  const summaryLines = [
    `Diff summary: ${files.length} file(s), +${totalAdd} -${totalDel}`,
    ...files.map((f) => `- ${f.name} (+${f.adds} -${f.dels})`),
  ];

  const detailLines = [];
  for (const f of files) {
    detailLines.push(`--- ${f.name} (+${f.adds} -${f.dels}) ---`);
    detailLines.push(...f.hunks.slice(0, 18));
    if (f.hunks.length > 18) detailLines.push(`... [${f.hunks.length - 18} more diff lines in ${f.name}]`);
  }

  const full = `${summaryLines.join("\n")}\n\n${detailLines.join("\n")}`.trim();
  if (maxChars > 0 && full.length > maxChars) {
    const budget = Math.max(200, maxChars - summaryLines.join("\n").length - 40);
    if (budget < 300) return summaryLines.join("\n").trim();
    return `${summaryLines.join("\n")}\n\n${detailLines.join("\n").slice(0, budget)}\n... [diff hunks truncated; file list above complete]`.trim();
  }
  return full;
}

function compactGitLog(rawLines) {
  const commits = [];
  let cur = null;
  for (const ln of rawLines) {
    const cm = ln.match(/^commit\s+([0-9a-f]{7,40})(.*)$/i);
    if (cm) {
      if (cur) commits.push(cur);
      cur = { hash: cm[1].slice(0, 8), author: "", date: "", msg: [] };
      continue;
    }
    if (!cur) continue;
    if (ln.startsWith("Author:")) {
      cur.author = ln.slice(7).replace(/<[^>]+>/g, "").trim();
    } else if (ln.startsWith("Date:")) {
      cur.date = ln.slice(5).trim().slice(0, 16);
    } else if (ln.trim()) {
      cur.msg.push(ln.trim());
    }
  }
  if (cur) commits.push(cur);
  if (commits.length === 0) return rawLines.join("\n").trim();

  const shown = commits.slice(0, 40).map((c) => {
    const subj = c.msg[0] || "(no message)";
    return `${c.hash}${c.date ? ` | ${c.date}` : ""}${c.author ? ` | ${c.author}` : ""}: ${subj}`;
  });
  if (commits.length > 40) shown.push(`... [${commits.length - 40} older commits omitted]`);
  return shown.join("\n");
}

function compactTestOutput(rawLines) {
  const out = [];
  let blankRun = 0;
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

function compactBuildOrInstall(rawLines, mode) {
  const out = [];
  const seenDiag = new Set();
  let skippedNoise = 0;
  for (const ln of rawLines) {
    const t = ln.trim();
    if (!t) continue;
    const isNoise = mode === "install"
      ? /^(?:idealTree|reify:|http fetch|npm warn deprecated|Downloading|Installing|Collecting|Using cached|Building wheel)/i.test(t)
      : /^(?:compiling|checking|building|bundling|transforming|rendering chunks|\[\d+\/\d+\])\b/i.test(t);
    if (isNoise && !/(?:error|err!|fatal|vulnerabilit)/i.test(t)) {
      skippedNoise += 1;
      continue;
    }
    if (/error\s+TS\d+|^\s*\d+:\d+\s+(?:error|warning)/i.test(t)) {
      const key = t.replace(/\s+/g, " ");
      if (seenDiag.has(key)) {
        skippedNoise += 1;
        continue;
      }
      seenDiag.add(key);
    }
    out.push(ln);
  }
  if (skippedNoise > 0 && out.length > 0) {
    out.unshift(`... [filtered ${skippedNoise} progress/duplicate lines]`);
  }
  return (out.length ? out : rawLines).join("\n").trim();
}

function compactGenericOrLogs(rawLines, isLogs = false) {
  const out = [];
  let blankRun = 0;
  let i = 0;
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
  if (isLogs && out.length > 120) {
    const important = [];
    const seen = new Set();
    out.forEach((ln, idx) => {
      if (/(?:error|warn|fatal|exception|panic|traceback)/i.test(ln) && !seen.has(idx)) {
        seen.add(idx);
        important.push(`[L${idx + 1}] ${ln}`);
      }
    });
    const head = out.slice(0, 25);
    const tail = out.slice(-45);
    return [
      ...head,
      `\n... [collapsed ${out.length - 70} middle log lines; ${important.length} error/warn highlights] ...`,
      ...important.slice(0, 30),
      `\n--- tail ---`,
      ...tail,
    ].join("\n").trim();
  }
  return out.join("\n").trim();
}

function capMiddle(text, maxChars) {
  if (!maxChars || text.length <= maxChars) return text;
  const headCap = Math.floor(maxChars * 0.45);
  const tailCap = Math.max(120, maxChars - headCap - 70);
  const omitted = text.length - headCap - tailCap;
  return `${text.slice(0, headCap).trimEnd()}\n... [trimmed ${omitted} chars] ...\n${text.slice(-tailCap).trimStart()}`;
}

function compactSearchOutput(rawLines) {
  const byFile = new Map();
  const extra = [];
  for (const ln of rawLines) {
    const m = ln.match(/^((?:[A-Za-z]:)?[^:\r\n]+?):(\d+):(.*)$/);
    if (m) {
      const fp = m[1].trim();
      if (!byFile.has(fp)) byFile.set(fp, []);
      byFile.get(fp).push({ line: m[2], text: m[3].trim() });
    } else if (ln.trim()) {
      extra.push(ln.trim());
    }
  }
  if (byFile.size === 0) return rawLines.join("\n").trim();

  let totalMatches = 0;
  for (const arr of byFile.values()) totalMatches += arr.length;
  const out = [`Search summary: ${totalMatches} matches across ${byFile.size} file(s)`];
  let shownFiles = 0;
  for (const [fp, items] of byFile.entries()) {
    if (shownFiles >= 30) {
      out.push(`... [${byFile.size - shownFiles} more files omitted]`);
      break;
    }
    shownFiles += 1;
    out.push(`- ${fp} (${items.length}):`);
    for (const it of items.slice(0, 6)) {
      const clipTxt = it.text.length > 140 ? `${it.text.slice(0, 139)}…` : it.text;
      out.push(`  L${it.line}: ${clipTxt}`);
    }
    if (items.length > 6) out.push(`  ... [+${items.length - 6} more matches in ${fp}]`);
  }
  if (extra.length > 0 && extra.length <= 4) out.push(...extra);
  return out.join("\n").trim();
}

function compileRuleRe(pat, flags = "i") {
  if (!pat) return null;
  try {
    return pat instanceof RegExp ? pat : new RegExp(String(pat), flags);
  } catch {
    return null;
  }
}

/**
 * Load 3-tier custom filter rules (project .save-token/filters.json -> pluginData/filters.json).
 * Fail-open: malformed or missing files are silently ignored.
 */
export function loadCustomFilters(cwd = "", pluginDataDir = "") {
  const candidates = [];
  if (cwd) candidates.push(join(cwd, ".save-token", "filters.json"));
  if (process.env.SAVE_TOKEN_FILTERS_PATH?.trim()) {
    candidates.push(process.env.SAVE_TOKEN_FILTERS_PATH.trim());
  }
  const userDir =
    pluginDataDir ||
    process.env.PLUGIN_DATA?.trim() ||
    join(homedir(), ".gemini", "antigravity", "plugin_data", "save-token");
  candidates.push(join(userDir, "filters.json"));

  const out = [];
  for (const fp of candidates) {
    if (!fp || !existsSync(fp)) continue;
    try {
      const parsed = JSON.parse(readFileSync(fp, "utf8"));
      const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.rules) ? parsed.rules : [];
      for (const r of arr) {
        if (r && typeof r === "object" && r.match_command) out.push(r);
      }
    } catch {
      // Fail-open on malformed custom filter file.
    }
  }
  return out;
}

/**
 * RTK-style 8-stage deterministic filter pipeline with `match_output` + `unless` error guard.
 */
export function applyFilterRules(text, commandHint = "", rules = []) {
  const raw = String(text ?? "");
  const hint = String(commandHint || "").trim();
  if (!hint || !Array.isArray(rules) || rules.length === 0) {
    return { matched: false, text: raw };
  }

  let matchedRule = null;
  for (const r of rules) {
    const cmdRe = compileRuleRe(r?.match_command, "i");
    if (cmdRe && cmdRe.test(hint)) {
      matchedRule = r;
      break;
    }
  }
  if (!matchedRule) return { matched: false, text: raw };

  let cur = matchedRule.strip_ansi === false ? raw : stripAnsi(raw);
  cur = cur.replace(/\r\n/g, "\n");

  // Stage 2: line-by-line regex replace
  if (Array.isArray(matchedRule.replace) && matchedRule.replace.length > 0) {
    const subs = matchedRule.replace
      .map((item) => {
        const re = compileRuleRe(item?.pattern, item?.flags || "g");
        return re ? [re, String(item?.to ?? "")] : null;
      })
      .filter(Boolean);
    if (subs.length > 0) {
      cur = cur
        .split("\n")
        .map((ln) => subs.reduce((acc, [re, to]) => acc.replace(re, to), ln))
        .join("\n");
    }
  }

  // Stage 3: short-circuit match_output with `unless` safety guard
  if (Array.isArray(matchedRule.match_output)) {
    for (const ruleHit of matchedRule.match_output) {
      const patRe = compileRuleRe(ruleHit?.pattern, "i");
      if (!patRe || !patRe.test(cur)) continue;
      const unlessRe = compileRuleRe(ruleHit?.unless, "i");
      if (unlessRe && unlessRe.test(cur)) continue;
      return {
        matched: true,
        shortCircuited: true,
        rule: String(matchedRule.name || matchedRule.match_command),
        text: String(ruleHit?.message ?? "").trim(),
      };
    }
  }

  let lines = cur.split("\n");

  // Stage 4: keep_lines / strip_lines
  if (Array.isArray(matchedRule.keep_lines) && matchedRule.keep_lines.length > 0) {
    const keepers = matchedRule.keep_lines.map((p) => compileRuleRe(p, "i")).filter(Boolean);
    if (keepers.length > 0) lines = lines.filter((ln) => keepers.some((re) => re.test(ln)));
  } else if (Array.isArray(matchedRule.strip_lines) && matchedRule.strip_lines.length > 0) {
    const droppers = matchedRule.strip_lines.map((p) => compileRuleRe(p, "i")).filter(Boolean);
    if (droppers.length > 0) lines = lines.filter((ln) => !droppers.some((re) => re.test(ln)));
  }

  // Stage 5: truncate_lines_at
  const lineMax = Number(matchedRule.truncate_lines_at);
  if (Number.isFinite(lineMax) && lineMax >= 20) {
    const cap = Math.trunc(lineMax);
    lines = lines.map((ln) => (ln.length > cap ? `${ln.slice(0, cap - 1)}…` : ln));
  }

  // Stage 6: head_lines + tail_lines
  const headN = Number(matchedRule.head_lines) > 0 ? Math.trunc(Number(matchedRule.head_lines)) : 0;
  const tailN = Number(matchedRule.tail_lines) > 0 ? Math.trunc(Number(matchedRule.tail_lines)) : 0;
  if ((headN > 0 || tailN > 0) && lines.length > headN + tailN + 1) {
    const omitted = lines.length - headN - tailN;
    const headPart = headN > 0 ? lines.slice(0, headN) : [];
    const tailPart = tailN > 0 ? lines.slice(-tailN) : [];
    lines = [...headPart, `... [omitted ${omitted} lines] ...`, ...tailPart];
  }

  // Stage 7: max_lines
  const absMax = Number(matchedRule.max_lines);
  if (Number.isFinite(absMax) && absMax > 0 && lines.length > absMax) {
    const omitted = lines.length - Math.trunc(absMax);
    lines = [...lines.slice(0, Math.trunc(absMax)), `... [capped ${omitted} more lines]`];
  }

  // Stage 8: on_empty
  let out = lines.join("\n").trim();
  if (!out && matchedRule.on_empty) out = String(matchedRule.on_empty);
  return { matched: true, rule: String(matchedRule.name || matchedRule.match_command), text: out };
}

function computeArrayInvariants(items) {
  const keyCounts = new Map();
  const numStats = new Map();
  const enumStats = new Map();
  const nullCounts = {};

  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    for (const [k, v] of Object.entries(item)) {
      keyCounts.set(k, (keyCounts.get(k) || 0) + 1);
      if (v === null || v === undefined) {
        nullCounts[k] = (nullCounts[k] || 0) + 1;
      } else if (typeof v === "number" && Number.isFinite(v)) {
        const cur = numStats.get(k) || { min: v, max: v };
        if (v < cur.min) cur.min = v;
        if (v > cur.max) cur.max = v;
        numStats.set(k, cur);
      } else if (typeof v === "string" || typeof v === "boolean") {
        let map = enumStats.get(k);
        if (!map) {
          map = new Map();
          enumStats.set(k, map);
        }
        if (map.size <= 8) {
          const sv = String(v).slice(0, 48);
          map.set(sv, (map.get(sv) || 0) + 1);
        }
      }
    }
  }

  const numericRanges = {};
  for (const [k, st] of numStats.entries()) numericRanges[k] = st;
  const smallEnums = {};
  for (const [k, map] of enumStats.entries()) {
    if (map.size >= 1 && map.size <= 6 && items.length >= 3) {
      smallEnums[k] = [...map.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([val, count]) => `${val}(${count})`);
    }
  }

  return {
    omitted: items.length,
    sampleKeys: [...keyCounts.keys()].slice(0, 12),
    ...(Object.keys(numericRanges).length ? { numericRanges } : {}),
    ...(Object.keys(smallEnums).length ? { smallEnums } : {}),
    ...(Object.keys(nullCounts).length ? { nullCounts } : {}),
  };
}

function shrinkJsonNodeInvariants(node, { headCount = 3, tailCount = 2, minArrayLen = 12, maxDepth = 3 } = {}, depth = 0) {
  if (Array.isArray(node)) {
    const alreadyElided = node.some((el) => el && typeof el === "object" && Object.hasOwn(el, "__elided__"));
    if (alreadyElided) return node;
    if (node.length < minArrayLen) {
      return depth < maxDepth
        ? node.map((el) => shrinkJsonNodeInvariants(el, { headCount, tailCount, minArrayLen, maxDepth }, depth + 1))
        : node;
    }
    const h = Math.min(headCount, node.length);
    const t = Math.min(tailCount, Math.max(0, node.length - h));
    const omitted = node.slice(h, node.length - t);
    const marker = {
      __elided__: omitted.length,
      __invariants__: {
        total: node.length,
        ...computeArrayInvariants(omitted),
      },
    };
    const recurse = (el) =>
      depth < maxDepth ? shrinkJsonNodeInvariants(el, { headCount, tailCount, minArrayLen, maxDepth }, depth + 1) : el;
    return [...node.slice(0, h).map(recurse), marker, ...node.slice(node.length - t).map(recurse)];
  }
  if (node && typeof node === "object" && depth < maxDepth) {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      out[k] = shrinkJsonNodeInvariants(v, { headCount, tailCount, minArrayLen, maxDepth }, depth + 1);
    }
    return out;
  }
  return node;
}

function splitDelimitedRow(line, sep) {
  if (sep === "\t") return line.split("\t").map((s) => s.trim());
  const cells = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === sep && !inQuotes) {
      cells.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  return cells;
}

function summarizeDelimitedTable(text, sep) {
  const lines = text.split(/\r?\n/).filter((ln) => ln.trim() !== "");
  if (lines.length < 15) return text;
  const headers = splitDelimitedRow(lines[0], sep);
  const colCount = headers.length;
  if (colCount < 2) return text;

  const dataRows = lines.slice(1);
  const colStats = headers.slice(0, 12).map((h) => ({ name: h, nums: [], vals: new Map() }));
  const flaggedLines = [];

  for (let rIdx = 0; rIdx < dataRows.length; rIdx += 1) {
    const row = splitDelimitedRow(dataRows[rIdx], sep);
    if (/\b(?:error|fail|failed|fatal|nan|exception)\b/i.test(dataRows[rIdx]) && flaggedLines.length < 5) {
      flaggedLines.push(`[L${rIdx + 2}] ${dataRows[rIdx].slice(0, 180)}`);
    }
    for (let c = 0; c < Math.min(colCount, 12); c += 1) {
      const val = row[c] ?? "";
      const st = colStats[c];
      if (val !== "" && !Number.isNaN(Number(val))) {
        st.nums.push(Number(val));
      } else if (val !== "" && st.vals.size <= 16) {
        st.vals.set(val.slice(0, 40), (st.vals.get(val.slice(0, 40)) || 0) + 1);
      }
    }
  }

  const statLines = colStats.map((st) => {
    if (st.nums.length > 0 && st.vals.size === 0) {
      let min = st.nums[0];
      let max = st.nums[0];
      for (const n of st.nums) {
        if (n < min) min = n;
        if (n > max) max = n;
      }
      return `- ${st.name}: num [${min}..${max}] (${st.nums.length})`;
    }
    const topVals = [...st.vals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([v, cnt]) => `${v}(${cnt})`)
      .join(", ");
    return `- ${st.name}: ${st.vals.size > 16 ? "16+" : st.vals.size} uniq${topVals ? ` [${topVals}]` : ""}`;
  });

  const out = [
    `Tabular summary: ${dataRows.length} rows, ${colCount} columns (${headers.join(", ")})`,
    "Columns:",
    ...statLines,
    "Head (5):",
    ...dataRows.slice(0, 5),
    ...(flaggedLines.length ? ["Flagged lines:", ...flaggedLines] : []),
    "Tail (3):",
    ...dataRows.slice(-3),
  ];
  return out.join("\n").trim();
}

/**
 * Caveman-grade structural compressor for large JSON arrays and CSV/TSV datasets.
 * Always returns valid JSON for JSON inputs (idempotent) and schema+invariants summary for CSV/TSV.
 */
export function compactStructuredData(raw, opts = {}) {
  const kind = String(opts?.kind || "auto").toLowerCase();
  const isObjInput = raw !== null && typeof raw === "object";
  const rawText = isObjInput ? JSON.stringify(raw, null, 2) : String(raw ?? "");
  const trimmed = rawText.trim();

  if (kind === "json" || (kind === "auto" && (isObjInput || /^[\[{]/.test(trimmed)))) {
    try {
      const parsed = isObjInput ? raw : JSON.parse(trimmed);
      const shrunk = shrinkJsonNodeInvariants(parsed, opts);
      return JSON.stringify(shrunk, null, 2);
    } catch {
      if (kind === "json") return rawText;
    }
  }

  if (kind === "csv" || kind === "tsv" || kind === "auto") {
    const sample = trimmed.split(/\r?\n/).slice(0, 8);
    if (sample.length >= 6) {
      const tabCols = sample[0].split("\t").length;
      if (tabCols >= 2 && sample.every((ln) => ln.split("\t").length === tabCols)) {
        return summarizeDelimitedTable(trimmed, "\t");
      }
      const commaCols = splitDelimitedRow(sample[0], ",").length;
      if (commaCols >= 2 && sample.filter((ln) => splitDelimitedRow(ln, ",").length === commaCols).length >= 5) {
        return summarizeDelimitedTable(trimmed, ",");
      }
    }
  }

  return rawText;
}

/**
 * RTK-style string-aware source comment stripper (never corrupts `"""` Python strings or string literals).
 */
export function stripSourceComments(code, filePath = "") {
  const text = String(code ?? "").replace(/\r\n/g, "\n");
  const ext = extname(String(filePath || "")).toLowerCase();
  const isPython = ext === ".py" || ext === ".pyw";

  let out = "";
  let i = 0;
  const n = text.length;

  if (isPython) {
    let quote = "";
    let triple = false;
    while (i < n) {
      const ch = text[i];
      if (quote) {
        if (triple) {
          if (text.slice(i, i + 3) === quote.repeat(3)) {
            out += text.slice(i, i + 3);
            i += 3;
            quote = "";
            triple = false;
            continue;
          }
          out += ch;
          i += 1;
          continue;
        }
        if (ch === "\\" && i + 1 < n) {
          out += text.slice(i, i + 2);
          i += 2;
          continue;
        }
        if (ch === quote) quote = "";
        out += ch;
        i += 1;
        continue;
      }

      if ((ch === '"' || ch === "'") && text.slice(i, i + 3) === ch.repeat(3)) {
        quote = ch;
        triple = true;
        out += text.slice(i, i + 3);
        i += 3;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        triple = false;
        out += ch;
        i += 1;
        continue;
      }
      if (ch === "#") {
        while (i < n && text[i] !== "\n") i += 1;
        out = out.replace(/[ \t]+$/, "");
        continue;
      }
      out += ch;
      i += 1;
    }
  } else {
    let quote = "";
    let inBlock = false;
    while (i < n) {
      const ch = text[i];
      const next = text[i + 1] || "";
      if (inBlock) {
        if (ch === "*" && next === "/") {
          inBlock = false;
          i += 2;
          continue;
        }
        if (ch === "\n") out += "\n";
        i += 1;
        continue;
      }
      if (quote) {
        if (ch === "\\" && i + 1 < n) {
          out += text.slice(i, i + 2);
          i += 2;
          continue;
        }
        if (ch === quote) quote = "";
        out += ch;
        i += 1;
        continue;
      }
      if (ch === "/" && next === "*") {
        inBlock = true;
        i += 2;
        continue;
      }
      if (ch === "/" && next === "/") {
        while (i < n && text[i] !== "\n") i += 1;
        out = out.replace(/[ \t]+$/, "");
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch;
        out += ch;
        i += 1;
        continue;
      }
      out += ch;
      i += 1;
    }
  }

  return out.replace(/\n{3,}/g, "\n\n").trim();
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isToonPrimitive(v) {
  return v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

function formatToonScalar(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "null";
  if (typeof v === "boolean") return String(v);
  const s = String(v);
  if (
    s === "" ||
    /^\s|\s$/.test(s) ||
    /[,:\n\r"\\#\[\]{}]/.test(s) ||
    s === "null" ||
    s === "true" ||
    s === "false" ||
    /^-?\d+(?:\.\d+)?$/.test(s)
  ) {
    return JSON.stringify(s);
  }
  return s;
}

function detectUniformObjectKeys(arr) {
  if (!Array.isArray(arr) || arr.length < 2 || !arr.every(isPlainObject)) return null;
  const keys = Object.keys(arr[0]);
  if (keys.length === 0) return null;
  for (const row of arr) {
    const rKeys = Object.keys(row);
    if (rKeys.length !== keys.length) return null;
    for (const k of keys) {
      if (!Object.prototype.hasOwnProperty.call(row, k) || !isToonPrimitive(row[k])) {
        return null;
      }
    }
  }
  return keys;
}

/**
 * Lossless TOON (Token-Oriented Object Notation) encoder for uniform JSON arrays and nested objects.
 * Zero external dependencies.
 */
export function encodeToon(value, opts = {}) {
  const maxRows = Math.max(1, Number(opts?.maxRows) || 200);
  const maxDepth = Math.max(2, Number(opts?.maxDepth) || 6);
  const indentSize = Math.max(1, Number(opts?.indent) || 2);

  let target = value;
  if (typeof value === "string" && opts?.parseJson !== false) {
    const t = value.trim();
    if (/^[\[{]/.test(t)) {
      try {
        target = JSON.parse(t);
      } catch {
        target = value;
      }
    }
  }

  function emitNode(node, keyPrefix, depth) {
    const pad = " ".repeat(depth * indentSize);
    const childPad = " ".repeat((depth + 1) * indentSize);

    if (isToonPrimitive(node)) {
      const scalar = formatToonScalar(node);
      return keyPrefix ? `${pad}${keyPrefix}: ${scalar}` : `${pad}${scalar}`;
    }

    if (depth >= maxDepth) {
      const fallback = JSON.stringify(node);
      return keyPrefix ? `${pad}${keyPrefix}: ${fallback}` : `${pad}${fallback}`;
    }

    if (Array.isArray(node)) {
      if (node.length === 0) {
        return keyPrefix ? `${pad}${keyPrefix}[0]:` : `${pad}[0]:`;
      }
      const uniformKeys = detectUniformObjectKeys(node);
      if (uniformKeys) {
        const header = `${pad}${keyPrefix || ""}[${node.length}]{${uniformKeys.join(",")}}:`;
        const lines = [header];
        for (const row of node.slice(0, maxRows)) {
          lines.push(`${childPad}${uniformKeys.map((k) => formatToonScalar(row[k])).join(",")}`);
        }
        if (node.length > maxRows) {
          lines.push(`${childPad}# ... (+${node.length - maxRows} more rows)`);
        }
        return lines.join("\n");
      }

      if (node.length <= 12 && node.every(isToonPrimitive)) {
        return `${pad}${keyPrefix || ""}[${node.length}]: ${node.map(formatToonScalar).join(",")}`;
      }

      const lines = [`${pad}${keyPrefix || ""}[${node.length}]:`];
      for (const item of node.slice(0, maxRows)) {
        if (isToonPrimitive(item)) {
          lines.push(`${childPad}- ${formatToonScalar(item)}`);
        } else if (isPlainObject(item)) {
          const entries = Object.entries(item);
          if (entries.length === 0) {
            lines.push(`${childPad}- {}`);
          } else {
            const [firstKey, firstVal] = entries[0];
            if (isToonPrimitive(firstVal)) {
              lines.push(`${childPad}- ${firstKey}: ${formatToonScalar(firstVal)}`);
            } else {
              lines.push(`${childPad}- ${firstKey}:`);
              lines.push(emitNode(firstVal, "", depth + 2));
            }
            for (const [k, v] of entries.slice(1)) {
              lines.push(emitNode(v, k, depth + 2));
            }
          }
        } else {
          lines.push(`${childPad}- ${JSON.stringify(item)}`);
        }
      }
      if (node.length > maxRows) {
        lines.push(`${childPad}# ... (+${node.length - maxRows} more items)`);
      }
      return lines.join("\n");
    }

    if (isPlainObject(node)) {
      const entries = Object.entries(node);
      if (entries.length === 0) {
        return keyPrefix ? `${pad}${keyPrefix}: {}` : `${pad}{}`;
      }
      const lines = [];
      const nextDepth = keyPrefix ? depth + 1 : depth;
      if (keyPrefix) lines.push(`${pad}${keyPrefix}:`);
      for (const [k, v] of entries) {
        lines.push(emitNode(v, k, nextDepth));
      }
      return lines.join("\n");
    }

    const s = String(node);
    return keyPrefix ? `${pad}${keyPrefix}: ${s}` : `${pad}${s}`;
  }

  return emitNode(target, "", 0);
}

/**
 * Compress noisy CLI / log / git / test output deterministically.
 * @param {string} raw
 * @param {string|{kind?:string, commandHint?:string, maxChars?:number, cwd?:string, customRules?:Array}} optsOrKind
 */
export function compactOutput(raw, optsOrKind = "auto") {
  const opts = typeof optsOrKind === "string" ? { kind: optsOrKind } : (optsOrKind || {});
  const customRules = Array.isArray(opts.customRules)
    ? opts.customRules
    : opts.cwd
      ? loadCustomFilters(opts.cwd, opts.pluginDataDir)
      : [];
  if (customRules.length > 0 && opts.commandHint) {
    const filtered = applyFilterRules(raw, opts.commandHint, customRules);
    if (filtered.matched) {
      return opts.maxChars > 0 ? capMiddle(filtered.text, opts.maxChars) : filtered.text;
    }
  }

  const cleaned = stripAnsi(raw).replace(/\r\n/g, "\n");
  const rawLines = cleaned.split("\n").map((ln) => {
    const idx = ln.lastIndexOf("\r");
    return idx >= 0 ? ln.slice(idx + 1) : ln;
  });

  const detected = !opts.kind || opts.kind === "auto"
    ? detectCompactKind(rawLines, opts.commandHint)
    : opts.kind;

  let result;
  if (detected === "git-status") result = compactGitStatus(rawLines);
  else if (detected === "git-diff") result = compactGitDiff(rawLines, opts.maxChars || 0);
  else if (detected === "git-log") result = compactGitLog(rawLines);
  else if (detected === "test") result = compactTestOutput(rawLines);
  else if (detected === "build-lint") result = compactBuildOrInstall(rawLines, "build");
  else if (detected === "install") result = compactBuildOrInstall(rawLines, "install");
  else if (detected === "search") result = compactSearchOutput(rawLines);
  else if (detected === "docker-logs") result = compactGenericOrLogs(rawLines, true);
  else result = compactGenericOrLogs(rawLines, false);

  return opts.maxChars > 0 ? capMiddle(result, opts.maxChars) : result;
}
