import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Resolve cross-platform SQLite database path:
 * 1) SAVE_TOKEN_DB_PATH
 * 2) PLUGIN_DATA/store.db
 * 3) Antigravity plugin_data if .gemini/antigravity exists (backward-compatible)
 * 4) Universal ~/.save-token/data/store.db
 */
export function resolveDbPath(env = process.env) {
  if (env?.SAVE_TOKEN_DB_PATH?.trim()) return env.SAVE_TOKEN_DB_PATH.trim();
  if (env?.PLUGIN_DATA?.trim()) return join(env.PLUGIN_DATA.trim(), "store.db");
  const home = env?.SAVE_TOKEN_HOME?.trim() || homedir();
  const agyDir = join(home, ".gemini", "antigravity");
  const agyDb = join(agyDir, "plugin_data", "save-token", "store.db");
  if (existsSync(agyDb) || existsSync(agyDir)) {
    return agyDb;
  }
  return join(home, ".save-token", "data", "store.db");
}

/** Resolve base runtime data directory for handoffs, progress, tee logs, and caches. */
export function resolveDataDir(env = process.env) {
  return dirname(resolveDbPath(env));
}
