#!/usr/bin/env node
/**
 * Zero-dependency universal installer for save-token across:
 * Antigravity, Claude Code, Codex, DeepSeek Harness (dsh), Cursor, and Gemini CLI.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url));
const ALL_TARGETS = ["antigravity", "claude", "codex", "dsh", "cursor", "gemini-cli"];
const BEGIN_MARK = "# BEGIN save-token";
const END_MARK = "# END save-token";

const CORE_ITEMS = [
  "server",
  "scripts",
  "skills",
  "rules",
  "plugin.json",
  ".claude-plugin",
  ".mcp.json",
];

function toPosix(p) {
  return String(p).replace(/\\/g, "/");
}

function resolveHome() {
  return process.env.SAVE_TOKEN_HOME ? path.resolve(process.env.SAVE_TOKEN_HOME) : os.homedir();
}

function parseArgs(argv) {
  const opts = { targets: ["auto"], dryRun: false, uninstall: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--uninstall") opts.uninstall = true;
    else if (a === "--target" && argv[i + 1]) {
      opts.targets = argv[++i]
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
    }
  }
  return opts;
}

function printHelp() {
  console.log(`save-token-install — Universal installer (Node >= 22.5, zero dependencies)

Usage:
  node install.mjs [--target <list>] [--dry-run] [--uninstall]

Targets:
  auto         Detect installed harnesses (default)
  all          Install for all supported harnesses
  antigravity  ~/.gemini/config/plugins/save-token
  claude       ~/.claude/skills/save-token + ~/.claude.json
  codex        ~/.agents/skills/save-token + ~/.codex/config.toml
  dsh          ~/.agents/skills/save-token + ~/.dsh/save-token.cordis.yml
  cursor       ~/.agents/skills/save-token + ~/.cursor/mcp.json
  gemini-cli   ~/.agents/skills/save-token + ~/.gemini/settings.json`);
}

function detectTargets(home) {
  const checks = [
    ["antigravity", [path.join(home, ".gemini", "antigravity"), path.join(home, ".gemini", "config")]],
    ["claude", [path.join(home, ".claude"), path.join(home, ".claude.json")]],
    ["codex", [path.join(home, ".codex")]],
    ["dsh", [path.join(home, ".dsh")]],
    ["cursor", [path.join(home, ".cursor")]],
    ["gemini-cli", [path.join(home, ".gemini", "settings.json")]],
  ];
  return checks.filter(([, paths]) => paths.some((p) => fs.existsSync(p))).map(([name]) => name);
}

function copyTree(srcDir, dstDir, dryRun) {
  if (dryRun) return;
  fs.mkdirSync(dstDir, { recursive: true });
  fs.cpSync(srcDir, dstDir, { recursive: true, force: true });
}

function installCoreBundle(dstDir, dryRun) {
  if (dryRun) return;
  fs.mkdirSync(dstDir, { recursive: true });
  for (const item of CORE_ITEMS) {
    const src = path.join(REPO_ROOT, item);
    if (!fs.existsSync(src)) continue;
    fs.cpSync(src, path.join(dstDir, item), { recursive: true, force: true });
  }
}

function readJsonSafe(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, "utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

function writeJson(filePath, obj, dryRun) {
  if (dryRun) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function upsertJsonMcp(filePath, entry, dryRun) {
  const cfg = readJsonSafe(filePath);
  if (!cfg.mcpServers || typeof cfg.mcpServers !== "object") cfg.mcpServers = {};
  cfg.mcpServers["save-token"] = entry;
  writeJson(filePath, cfg, dryRun);
}

function removeJsonMcp(filePath, dryRun) {
  if (!fs.existsSync(filePath)) return false;
  const cfg = readJsonSafe(filePath);
  if (!cfg.mcpServers || !Object.prototype.hasOwnProperty.call(cfg.mcpServers, "save-token")) {
    return false;
  }
  delete cfg.mcpServers["save-token"];
  writeJson(filePath, cfg, dryRun);
  return true;
}

function upsertTomlBlock(filePath, nodeCmd, serverPath, dryRun) {
  const block = [
    BEGIN_MARK,
    "[mcp_servers.save-token]",
    `command = ${JSON.stringify(nodeCmd)}`,
    `args = ["--no-warnings=ExperimentalWarning", ${JSON.stringify(serverPath)}]`,
    END_MARK,
  ].join("\n");

  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  const re = new RegExp(`${BEGIN_MARK}[\\s\\S]*?${END_MARK}\\r?\\n?`, "g");
  const cleaned = existing.replace(re, "").trimEnd();
  const next = cleaned ? `${cleaned}\n\n${block}\n` : `${block}\n`;
  if (!dryRun) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, next, "utf8");
  }
}

function removeTomlBlock(filePath, dryRun) {
  if (!fs.existsSync(filePath)) return false;
  const existing = fs.readFileSync(filePath, "utf8");
  const re = new RegExp(`\\r?\\n?${BEGIN_MARK}[\\s\\S]*?${END_MARK}\\r?\\n?`, "g");
  if (!re.test(existing)) return false;
  const next = existing.replace(re, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!dryRun) {
    fs.writeFileSync(filePath, next ? next + "\n" : "", "utf8");
  }
  return true;
}

function findAgentBrowser() {
  const rawPath = process.env.PATH || process.env.Path || "";
  const dirs = rawPath.split(path.delimiter).filter(Boolean);
  if (process.platform === "darwin") {
    for (const p of ["/opt/homebrew/bin", "/usr/local/bin"]) {
      if (!dirs.includes(p)) dirs.push(p);
    }
  }
  const exts = process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, `agent-browser${ext}`);
      try {
        if (fs.statSync(candidate).isFile()) return toPosix(candidate);
      } catch {
        // ignore missing entries
      }
    }
  }
  return null;
}

function installForTargets(targets, home, opts) {
  const nodeCmd = toPosix(process.execPath);
  const coreRoot = path.join(home, ".save-token");
  const coreServer = toPosix(path.join(coreRoot, "server", "save-token-mcp.mjs"));
  const sharedSkillSrc = path.join(REPO_ROOT, "skills", "save-token");
  const sharedSkillDst = path.join(home, ".agents", "skills", "save-token");
  const actions = [];

  const needsSharedCore = targets.some((t) => t !== "antigravity") || targets.length === 0;
  if (needsSharedCore) {
    if (opts.uninstall) {
      if (fs.existsSync(coreRoot) && !opts.dryRun) fs.rmSync(coreRoot, { recursive: true, force: true });
      if (fs.existsSync(sharedSkillDst) && !opts.dryRun) fs.rmSync(sharedSkillDst, { recursive: true, force: true });
      actions.push(`Removed shared core ${toPosix(coreRoot)} & skill ${toPosix(sharedSkillDst)}`);
    } else {
      installCoreBundle(coreRoot, opts.dryRun);
      copyTree(sharedSkillSrc, sharedSkillDst, opts.dryRun);
      actions.push(`Installed shared core -> ${toPosix(coreRoot)}`);
      actions.push(`Installed shared agent skill -> ${toPosix(sharedSkillDst)}`);
    }
  }

  const jsonTargets = {
    claude: {
      configPath: path.join(home, ".claude.json"),
      entry: { type: "stdio", command: nodeCmd, args: ["--no-warnings=ExperimentalWarning", coreServer] },
      skillDst: path.join(home, ".claude", "skills", "save-token"),
    },
    cursor: {
      configPath: path.join(home, ".cursor", "mcp.json"),
      entry: { command: nodeCmd, args: ["--no-warnings=ExperimentalWarning", coreServer] },
    },
    "gemini-cli": {
      configPath: path.join(home, ".gemini", "settings.json"),
      entry: { command: nodeCmd, args: ["--no-warnings=ExperimentalWarning", coreServer] },
    },
  };

  for (const target of targets) {
    if (target === "antigravity") {
      const agyRoot = path.join(home, ".gemini", "config", "plugins", "save-token");
      if (opts.uninstall) {
        if (fs.existsSync(agyRoot) && !opts.dryRun) fs.rmSync(agyRoot, { recursive: true, force: true });
        actions.push(`[antigravity] Removed ${toPosix(agyRoot)} (reload UI Customizations if open)`);
      } else {
        installCoreBundle(agyRoot, opts.dryRun);
        const agyServer = toPosix(path.join(agyRoot, "server", "save-token-mcp.mjs"));
        writeJson(
          path.join(agyRoot, "mcp_config.json"),
          { mcpServers: { "save-token": { command: nodeCmd, args: ["--no-warnings=ExperimentalWarning", agyServer] } } },
          opts.dryRun
        );
        actions.push(`[antigravity] Installed plugin -> ${toPosix(agyRoot)}`);
      }
      continue;
    }

    if (jsonTargets[target]) {
      const spec = jsonTargets[target];
      if (opts.uninstall) {
        const removed = removeJsonMcp(spec.configPath, opts.dryRun);
        if (spec.skillDst && fs.existsSync(spec.skillDst) && !opts.dryRun) {
          fs.rmSync(spec.skillDst, { recursive: true, force: true });
        }
        actions.push(`[${target}] ${removed ? "Removed" : "Skipped"} save-token in ${toPosix(spec.configPath)}`);
      } else {
        upsertJsonMcp(spec.configPath, spec.entry, opts.dryRun);
        if (spec.skillDst) copyTree(sharedSkillSrc, spec.skillDst, opts.dryRun);
        actions.push(`[${target}] Updated ${toPosix(spec.configPath)}${spec.skillDst ? ` + ${toPosix(spec.skillDst)}` : ""}`);
      }
      continue;
    }

    if (target === "codex") {
      const codexToml = path.join(home, ".codex", "config.toml");
      if (opts.uninstall) {
        const removed = removeTomlBlock(codexToml, opts.dryRun);
        actions.push(`[codex] ${removed ? "Removed" : "Skipped"} block in ${toPosix(codexToml)}`);
      } else {
        upsertTomlBlock(codexToml, nodeCmd, coreServer, opts.dryRun);
        actions.push(`[codex] Updated ${toPosix(codexToml)} (+ shared skill ~/.agents/skills/save-token)`);
      }
      continue;
    }

    if (target === "dsh") {
      const dshDir = path.join(home, ".dsh");
      const cordisSnippet = path.join(dshDir, "save-token.cordis.yml");
      const rulesCopy = path.join(dshDir, "save-token.AGENTS.md");
      if (opts.uninstall) {
        if (!opts.dryRun) {
          fs.rmSync(cordisSnippet, { force: true });
          fs.rmSync(rulesCopy, { force: true });
        }
        actions.push(`[dsh] Removed ${toPosix(cordisSnippet)} & ${toPosix(rulesCopy)}`);
      } else {
        const yml = [
          "# Include this plugin entry inside `plugins:` of your DeepSeek Harness cordis.yml",
          "# Skill ~/.agents/skills/save-token is auto-loaded by @deepseek-ai/dsh-skill-filesystem",
          "- id: mcp-save-token",
          "  name: '@deepseek-ai/dsh-mcp-client'",
          "  enabled: true",
          "  config:",
          "    transport: stdio",
          `    command: ${JSON.stringify(nodeCmd)}`,
          "    args:",
          '      - "--no-warnings=ExperimentalWarning"',
          `      - ${JSON.stringify(coreServer)}`,
          "",
        ].join("\n");
        if (!opts.dryRun) {
          fs.mkdirSync(dshDir, { recursive: true });
          fs.writeFileSync(cordisSnippet, yml, "utf8");
          fs.copyFileSync(path.join(REPO_ROOT, "rules", "AGENTS.md"), rulesCopy);
        }
        actions.push(`[dsh] Wrote ${toPosix(cordisSnippet)} + ${toPosix(rulesCopy)}`);
      }
    }
  }

  return actions;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 5)) {
    console.error(`Error: Node.js >= 22.5.0 is required (found ${process.versions.node}) for built-in node:sqlite.`);
    process.exit(1);
  }

  const home = resolveHome();
  let targets = [];
  if (opts.targets.includes("all")) {
    targets = [...ALL_TARGETS];
  } else if (opts.targets.includes("auto")) {
    targets = detectTargets(home);
  } else {
    for (const t of opts.targets) {
      if (!ALL_TARGETS.includes(t)) {
        console.error(`Unknown target "${t}". Supported: ${ALL_TARGETS.join(", ")}, auto, all`);
        process.exit(1);
      }
      if (!targets.includes(t)) targets.push(t);
    }
  }

  const actions = installForTargets(targets, home, opts);
  const modeTag = opts.dryRun ? " (DRY RUN)" : "";
  console.log(`save-token ${opts.uninstall ? "uninstall" : "install"}${modeTag} — home: ${toPosix(home)}`);
  if (targets.length === 0) {
    console.log("No existing harness config dir detected; installed shared core + ~/.agents/skills/save-token.");
  } else {
    console.log(`Targets: ${targets.join(", ")}`);
  }
  for (const a of actions) console.log(`  - ${a}`);

  if (!opts.uninstall) {
    const ab = findAgentBrowser();
    console.log(
      ab
        ? `Optional CLI: agent-browser found at ${ab}`
        : "Optional CLI tip: run `npm install -g agent-browser` for zero-screenshot Tier-1 browser control."
    );
  }
}

main();
