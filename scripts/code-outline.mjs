import { extname } from "node:path";

const JS_KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "else", "return", "throw", "typeof", "await", "new",
]);

function detectLanguage(filePath) {
  const ext = extname(String(filePath || "")).toLowerCase();
  if ([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts"].includes(ext)) return "js";
  if (ext === ".py") return "python";
  if (ext === ".rs") return "rust";
  if (ext === ".go") return "go";
  if ([".java", ".cs", ".cpp", ".cc", ".c", ".h", ".hpp", ".php"].includes(ext)) return "clike";
  if ([".md", ".markdown"].includes(ext)) return "markdown";
  if (ext === ".json") return "json";
  return "generic";
}

function scanBraceBlockEnd(lines, startIdx) {
  let depth = 0;
  let started = false;
  let inBlockComment = false;

  for (let idx = startIdx; idx < lines.length; idx += 1) {
    const ln = lines[idx];
    let quote = "";
    let escaped = false;
    for (let i = 0; i < ln.length; i += 1) {
      const ch = ln[i];
      const next = ln[i + 1] || "";

      if (inBlockComment) {
        if (ch === "*" && next === "/") {
          inBlockComment = false;
          i += 1;
        }
        continue;
      }
      if (quote) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === quote) {
          quote = "";
        }
        continue;
      }
      if (ch === "/" && next === "/") break;
      if (ch === "/" && next === "*") {
        inBlockComment = true;
        i += 1;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === "`") {
        quote = ch;
        continue;
      }
      if (ch === "{") {
        depth += 1;
        started = true;
      } else if (ch === "}") {
        depth -= 1;
        if (started && depth <= 0) return idx + 1;
      }
    }
    if (!started && idx > startIdx + 2 && /;\s*$/.test(ln)) {
      return idx + 1;
    }
  }
  return started ? lines.length : startIdx + 1;
}

function outlineJs(lines) {
  const symbols = [];
  let depth = 0;
  let inBlockComment = false;

  for (let idx = 0; idx < lines.length; idx += 1) {
    const raw = lines[idx];
    const trimmed = raw.trim();
    const lineNo = idx + 1;

    if (depth === 0 && trimmed && !trimmed.startsWith("//") && !trimmed.startsWith("/*")) {
      let m;
      if ((m = trimmed.match(/^(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/))) {
        symbols.push({ kind: "function", name: m[1], line: lineNo, endLine: scanBraceBlockEnd(lines, idx), signature: trimmed.slice(0, 120) });
      } else if ((m = trimmed.match(/^(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/))) {
        symbols.push({ kind: "class", name: m[1], line: lineNo, endLine: scanBraceBlockEnd(lines, idx), signature: trimmed.slice(0, 120) });
      } else if ((m = trimmed.match(/^(?:export\s+)?(interface|type|enum)\s+([A-Za-z_$][\w$]*)/))) {
        symbols.push({ kind: m[1], name: m[2], line: lineNo, endLine: scanBraceBlockEnd(lines, idx), signature: trimmed.slice(0, 120) });
      } else if ((m = trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/))) {
        symbols.push({ kind: "function", name: m[1], line: lineNo, endLine: scanBraceBlockEnd(lines, idx), signature: trimmed.slice(0, 120) });
      }
    } else if (depth === 1 && trimmed && !trimmed.startsWith("//") && !trimmed.startsWith("/*")) {
      const mm = trimmed.match(/^(?:(?:public|private|protected|static|readonly|async|override|get|set)\s+)*([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*(?::\s*[^\{]+)?\{/);
      if (mm && !JS_KEYWORDS.has(mm[1])) {
        symbols.push({ kind: "method", name: mm[1], line: lineNo, endLine: scanBraceBlockEnd(lines, idx), signature: trimmed.slice(0, 120) });
      }
    }

    let quote = "";
    let escaped = false;
    for (let i = 0; i < raw.length; i += 1) {
      const ch = raw[i];
      const next = raw[i + 1] || "";
      if (inBlockComment) {
        if (ch === "*" && next === "/") { inBlockComment = false; i += 1; }
        continue;
      }
      if (quote) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === quote) quote = "";
        continue;
      }
      if (ch === "/" && next === "/") break;
      if (ch === "/" && next === "*") { inBlockComment = true; i += 1; continue; }
      if (ch === "'" || ch === '"' || ch === "`") { quote = ch; continue; }
      if (ch === "{") depth += 1;
      else if (ch === "}") depth = Math.max(0, depth - 1);
    }
  }
  return symbols;
}

function outlinePython(lines) {
  const symbols = [];
  for (let idx = 0; idx < lines.length; idx += 1) {
    const raw = lines[idx];
    const m = raw.match(/^(\s*)(?:(async\s+def|def|class)\s+([A-Za-z_]\w*)\b.*)$/);
    if (!m) continue;
    const indent = m[1].length;
    const kind = m[2] === "class" ? "class" : indent > 0 ? "method" : "function";
    const name = m[3];
    let endLine = idx + 1;
    for (let j = idx + 1; j < lines.length; j += 1) {
      const t = lines[j].trim();
      if (!t || t.startsWith("#")) continue;
      const curIndent = lines[j].match(/^(\s*)/)[1].length;
      if (curIndent <= indent) break;
      endLine = j + 1;
    }
    symbols.push({ kind, name, line: idx + 1, endLine, signature: raw.trim().slice(0, 120) });
  }
  return symbols;
}

function outlineBraceLang(lines, lang) {
  const symbols = [];
  const patterns = lang === "rust"
    ? [
        [/^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, "function"],
        [/^(?:pub(?:\([^)]*\))?\s+)?(struct|enum|trait|mod)\s+([A-Za-z_]\w*)/, null],
        [/^impl(?:<[^>]+>)?\s+([A-Za-z_][\w:<>]*)/, "impl"],
      ]
    : lang === "go"
      ? [
          [/^func\s+(?:\([^)]+\)\s*)?([A-Za-z_]\w*)\s*\(/, "function"],
          [/^type\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b/, "type"],
        ]
      : [
          [/^(?:(?:public|private|protected|internal|abstract|final|static)\s+)*(class|interface|struct|enum)\s+([A-Za-z_]\w*)/, null],
          [/^(?:(?:public|private|protected|static|virtual|override|async|inline)\s+)*[\w:<>\[\]*&]+\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:const\s*)?\{/, "function"],
        ];

  for (let idx = 0; idx < lines.length; idx += 1) {
    const trimmed = lines[idx].trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*")) continue;
    for (const [re, kindOrNull] of patterns) {
      const m = trimmed.match(re);
      if (!m) continue;
      const kind = kindOrNull || m[1];
      const name = kindOrNull ? m[1] : m[2];
      if (!name || JS_KEYWORDS.has(name)) break;
      symbols.push({ kind, name, line: idx + 1, endLine: scanBraceBlockEnd(lines, idx), signature: trimmed.slice(0, 120) });
      break;
    }
  }
  return symbols;
}

function outlineMarkdown(lines) {
  const headings = [];
  for (let idx = 0; idx < lines.length; idx += 1) {
    const m = lines[idx].match(/^(#{1,4})\s+(.+?)\s*$/);
    if (m) headings.push({ level: m[1].length, name: m[2], line: idx + 1 });
  }
  return headings.map((h, i) => {
    let endLine = lines.length;
    for (let j = i + 1; j < headings.length; j += 1) {
      if (headings[j].level <= h.level) {
        endLine = headings[j].line - 1;
        break;
      }
    }
    return { kind: `h${h.level}`, name: h.name, line: h.line, endLine, signature: `${"#".repeat(h.level)} ${h.name}` };
  });
}

function outlineJson(content, lines) {
  try {
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return [{ kind: Array.isArray(parsed) ? "array" : typeof parsed, name: "$root", line: 1, endLine: lines.length, signature: Array.isArray(parsed) ? `array(${parsed.length})` : String(typeof parsed) }];
    }
    const keys = Object.keys(parsed);
    return keys.map((k) => {
      const val = parsed[k];
      const desc = Array.isArray(val)
        ? `array(${val.length})`
        : val && typeof val === "object"
          ? `object(${Object.keys(val).length})`
          : typeof val;
      const escapedKey = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`"${escapedKey}"\\s*:`);
      const idx = lines.findIndex((ln) => re.test(ln));
      const line = idx >= 0 ? idx + 1 : 1;
      return { kind: desc, name: k, line, endLine: line, signature: `"${k}": ${desc}` };
    });
  } catch {
    return [];
  }
}

/** Extract structural symbol outline (functions, classes, headings, JSON keys) without full file read. */
export function extractOutline(content, filePath = "", opts = {}) {
  const text = String(content ?? "");
  const lines = text.split(/\r?\n/);
  const lang = detectLanguage(filePath);
  const maxSymbols = Math.min(300, Math.max(10, Number(opts.maxSymbols) || 120));

  let symbols = [];
  if (lang === "js") symbols = outlineJs(lines);
  else if (lang === "python") symbols = outlinePython(lines);
  else if (lang === "rust" || lang === "go" || lang === "clike") symbols = outlineBraceLang(lines, lang);
  else if (lang === "markdown") symbols = outlineMarkdown(lines);
  else if (lang === "json") symbols = outlineJson(text, lines);

  return {
    language: lang,
    totalLines: lines.length,
    totalBytes: Buffer.byteLength(text, "utf8"),
    totalSymbols: symbols.length,
    truncated: symbols.length > maxSymbols,
    symbols: symbols.slice(0, maxSymbols),
  };
}

/** Slice the exact line range of a named symbol from file content. */
export function extractSymbolSlice(content, filePath, symbolName, opts = {}) {
  const target = String(symbolName || "").trim();
  if (!target) return { found: false, matches: [] };

  const text = String(content ?? "");
  const lines = text.split(/\r?\n/);
  const { symbols, language } = extractOutline(text, filePath, { maxSymbols: 500 });
  const targetLower = target.toLowerCase();

  let matches = symbols.filter((s) => s.name === target);
  if (matches.length === 0) matches = symbols.filter((s) => s.name.toLowerCase() === targetLower);
  if (matches.length === 0) matches = symbols.filter((s) => s.name.toLowerCase().includes(targetLower));

  if (matches.length === 0) return { found: false, language, matches: [] };

  const chosen = matches[0];
  const ctx = Math.max(0, Math.min(20, Number(opts.contextLines ?? 2)));
  const maxLines = Math.max(10, Math.min(500, Number(opts.maxLines ?? 250)));

  const startLine = Math.max(1, chosen.line - ctx);
  const rawEnd = Math.min(lines.length, chosen.endLine + ctx);
  const cappedEnd = Math.min(rawEnd, startLine + maxLines - 1);
  const numbered = lines
    .slice(startLine - 1, cappedEnd)
    .map((ln, i) => `${startLine + i}: ${ln}`)
    .join("\n");

  return {
    found: true,
    language,
    symbol: chosen,
    startLine,
    endLine: cappedEnd,
    truncated: cappedEnd < rawEnd,
    otherMatches: matches.slice(1, 8).map((m) => ({ name: m.name, kind: m.kind, line: m.line })),
    code: numbered,
  };
}
