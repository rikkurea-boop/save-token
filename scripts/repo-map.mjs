/**
 * Zero-LLM Personalized PageRank Repo Map (Aider-inspired, pure Node.js).
 * Builds a dependency graph across source files and returns a dense architectural map
 * ranked around active/focus files within a strict character budget.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, posix as pathPosix, resolve } from "node:path";
import { extractOutline } from "./code-outline.mjs";

const CODE_EXTS = new Set([
  ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts",
  ".py", ".go", ".rs", ".java", ".cs", ".cpp", ".cc", ".c", ".h", ".hpp", ".php",
]);

const DEFAULT_IGNORES = new Set([
  ".git", "node_modules", "dist", "build", "coverage", ".next", ".nuxt",
  "target", "vendor", "__pycache__", ".venv", "venv", "brain",
  "tempmediaStorage", ".system_generated", "browser_sandbox",
]);

const MAX_READ_BYTES = 512 * 1024;

function toPosix(p) {
  return String(p || "").replace(/\\/g, "/");
}

function walkSourceFiles(rootDir, { maxFiles = 500, ignore = [] } = {}) {
  const ignoreSet = new Set([...DEFAULT_IGNORES, ...ignore.map((x) => String(x || "").trim()).filter(Boolean)]);
  const files = [];

  function visit(absDir, relDir) {
    if (files.length >= maxFiles) return;
    let entries = [];
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      if (files.length >= maxFiles) break;
      if (ignoreSet.has(ent.name)) continue;
      const absPath = join(absDir, ent.name);
      const relPath = relDir ? `${relDir}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        visit(absPath, relPath);
      } else if (ent.isFile()) {
        const ext = extname(ent.name).toLowerCase();
        if (!CODE_EXTS.has(ext)) continue;
        try {
          const st = statSync(absPath);
          if (st.size <= MAX_READ_BYTES) {
            files.push({ absPath, relPath: toPosix(relPath), size: st.size });
          }
        } catch {
          // Skip unreadable files
        }
      }
    }
  }

  visit(rootDir, "");
  return files;
}

function resolveRelativeTarget(fromRel, spec, fileSet) {
  const cleanSpec = String(spec || "").split(/[?#]/)[0].trim();
  if (!cleanSpec) return "";
  const baseDir = pathPosix.dirname(fromRel);
  const joined = pathPosix.normalize(baseDir === "." ? cleanSpec : `${baseDir}/${cleanSpec}`);
  if (joined.startsWith("../")) return "";

  const candidates = [joined];
  for (const ext of [".mjs", ".js", ".ts", ".tsx", ".jsx", ".cjs", ".mts", ".cts", ".py", ".rs", ".go"]) {
    candidates.push(`${joined}${ext}`);
    candidates.push(`${joined}/index${ext}`);
  }
  candidates.push(`${joined}/mod.rs`, `${joined}/__init__.py`);

  for (const c of candidates) {
    if (fileSet.has(c)) return c;
  }
  return "";
}

function extractImports(content, relPath, fileSet) {
  const targets = new Set();
  const ext = extname(relPath).toLowerCase();

  if ([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts"].includes(ext)) {
    const jsRe = /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']|(?:require|import)\s*\(\s*["']([^"']+)["']\s*\)/g;
    let m;
    while ((m = jsRe.exec(content)) !== null) {
      const spec = m[1] || m[2] || "";
      if (!spec.startsWith(".")) continue;
      const resolved = resolveRelativeTarget(relPath, spec, fileSet);
      if (resolved && resolved !== relPath) targets.add(resolved);
    }
  } else if (ext === ".py") {
    const pyRe = /^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.,\s]+))/gm;
    let m;
    while ((m = pyRe.exec(content)) !== null) {
      const raw = (m[1] || m[2] || "").split(",")[0].trim().split(/\s+/)[0];
      if (!raw) continue;
      if (raw.startsWith(".")) {
        const dots = raw.match(/^\.+/)?.[0].length || 1;
        const mod = raw.slice(dots).replace(/\./g, "/");
        let dir = pathPosix.dirname(relPath);
        for (let k = 1; k < dots; k += 1) dir = pathPosix.dirname(dir);
        const relSpec = `./${mod || ""}`;
        const fromBase = dir === "." ? "x" : `${dir}/x`;
        const resolved = resolveRelativeTarget(fromBase, relSpec, fileSet);
        if (resolved && resolved !== relPath) targets.add(resolved);
      } else {
        const modPath = raw.replace(/\./g, "/");
        for (const c of [`${modPath}.py`, `${modPath}/__init__.py`]) {
          if (fileSet.has(c) && c !== relPath) targets.add(c);
        }
      }
    }
  } else if (ext === ".rs") {
    const rsRe = /^\s*(?:pub\s+)?mod\s+([A-Za-z_]\w*)\s*;/gm;
    let m;
    while ((m = rsRe.exec(content)) !== null) {
      const resolved = resolveRelativeTarget(relPath, `./${m[1]}`, fileSet);
      if (resolved && resolved !== relPath) targets.add(resolved);
    }
  }

  return [...targets];
}

/**
 * Build a Personalized PageRank structural repository map with 0 LLM tokens.
 */
export function buildRepoMap(rootDir, opts = {}) {
  const absRoot = resolve(String(rootDir || "."));
  const maxFiles = Math.max(10, Math.min(2000, Number(opts.maxFiles) || 500));
  const maxChars = Math.max(600, Math.min(24000, Number(opts.maxChars) || 4800));
  const maxSymbolsPerFile = Math.max(1, Math.min(16, Number(opts.maxSymbolsPerFile) || 6));

  const entries = walkSourceFiles(absRoot, { maxFiles, ignore: Array.isArray(opts.ignore) ? opts.ignore : [] });
  if (entries.length === 0) {
    return {
      rootDir: toPosix(absRoot),
      totalFiles: 0,
      edgeCount: 0,
      shownFiles: 0,
      truncated: false,
      files: [],
      text: `# Repo Map (0 source files in ${toPosix(absRoot)})`,
    };
  }

  const fileSet = new Set(entries.map((e) => e.relPath));
  const idxByPath = new Map(entries.map((e, idx) => [e.relPath, idx]));
  const contents = new Array(entries.length).fill("");
  const outgoing = entries.map(() => new Set());
  const incoming = entries.map(() => new Set());
  let edgeCount = 0;

  for (let i = 0; i < entries.length; i += 1) {
    let txt = "";
    try {
      txt = readFileSync(entries[i].absPath, "utf8");
    } catch {
      continue;
    }
    contents[i] = txt;
    for (const target of extractImports(txt, entries[i].relPath, fileSet)) {
      const j = idxByPath.get(target);
      if (j == null || j === i || outgoing[i].has(j)) continue;
      outgoing[i].add(j);
      incoming[j].add(i);
      edgeCount += 1;
    }
  }

  // Personalized PageRank setup
  const rawFocus = Array.isArray(opts.focusFiles) ? opts.focusFiles : [];
  const focusIdx = new Set();
  for (const rf of rawFocus) {
    const norm = toPosix(String(rf || "").trim()).replace(/^\.\//, "").replace(/\/+$/, "");
    if (!norm) continue;
    if (idxByPath.has(norm)) {
      focusIdx.add(idxByPath.get(norm));
      continue;
    }
    for (const e of entries) {
      if (norm.endsWith(`/${e.relPath}`) || e.relPath.endsWith(`/${norm}`) || e.relPath === norm) {
        focusIdx.add(idxByPath.get(e.relPath));
      }
    }
  }

  const neighborIdx = new Set();
  for (const fi of focusIdx) {
    for (const o of outgoing[fi]) if (!focusIdx.has(o)) neighborIdx.add(o);
    for (const inc of incoming[fi]) if (!focusIdx.has(inc)) neighborIdx.add(inc);
  }

  const n = entries.length;
  const p = new Float64Array(n);
  if (focusIdx.size > 0) {
    let sum = 0;
    for (let i = 0; i < n; i += 1) {
      const w = focusIdx.has(i) ? 10 : neighborIdx.has(i) ? 3 : 0.2;
      p[i] = w;
      sum += w;
    }
    for (let i = 0; i < n; i += 1) p[i] /= sum;
  } else {
    p.fill(1 / n);
  }

  let rank = Float64Array.from(p);
  const d = 0.85;
  for (let iter = 0; iter < 12; iter += 1) {
    const next = new Float64Array(n);
    let danglingMass = 0;
    for (let i = 0; i < n; i += 1) {
      next[i] = (1 - d) * p[i];
      if (outgoing[i].size === 0) danglingMass += rank[i];
    }
    for (let i = 0; i < n; i += 1) {
      if (danglingMass > 0) next[i] += d * danglingMass * p[i];
      const deg = outgoing[i].size;
      if (deg === 0) continue;
      const share = (d * rank[i]) / deg;
      for (const j of outgoing[i]) next[j] += share;
    }
    rank = next;
  }

  const ordered = entries
    .map((e, i) => ({
      idx: i,
      path: e.relPath,
      score: Number(rank[i].toFixed(4)),
      inDegree: incoming[i].size,
      outDegree: outgoing[i].size,
      isFocus: focusIdx.has(i),
    }))
    .sort(
      (a, b) =>
        Number(b.isFocus) - Number(a.isFocus) ||
        b.score - a.score ||
        b.inDegree - a.inDegree ||
        a.path.localeCompare(b.path)
    );

  const focusNote = focusIdx.size > 0 ? ` | focus=${[...focusIdx].map((i) => entries[i].relPath).slice(0, 3).join(", ")}` : "";
  const lines = [`# Repo Map (${n} files, ${edgeCount} import edges${focusNote})`];
  let usedChars = lines[0].length;
  const shown = [];
  let truncated = false;

  for (const item of ordered) {
    const outInfo = extractOutline(contents[item.idx], item.path, { maxSymbols: 32 });
    const symList = (outInfo.symbols || [])
      .slice(0, maxSymbolsPerFile)
      .map((s) => `${s.kind}:${s.name}@L${s.line}`);
    const head = `- ${item.path} [rank=${item.score}, in=${item.inDegree}, out=${item.outDegree}]`;
    const body = symList.length ? `${head}\n  symbols: ${symList.join(", ")}` : head;

    if (usedChars + body.length + 1 > maxChars - 40 && shown.length > 0) {
      truncated = true;
      break;
    }
    lines.push(body);
    usedChars += body.length + 1;
    shown.push({
      path: item.path,
      score: item.score,
      inDegree: item.inDegree,
      outDegree: item.outDegree,
      symbols: (outInfo.symbols || []).slice(0, maxSymbolsPerFile).map((s) => s.name),
    });
  }

  if (truncated) {
    lines.push(`... [+${ordered.length - shown.length} lower-ranked files omitted]`);
  }

  return {
    rootDir: toPosix(absRoot),
    totalFiles: n,
    edgeCount,
    shownFiles: shown.length,
    truncated,
    files: shown,
    text: lines.join("\n"),
  };
}
