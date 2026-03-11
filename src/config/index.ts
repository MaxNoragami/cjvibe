import { join } from "node:path";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { ConfigError } from "@/utils/errors";
import type { Config, ConfluenceConfig } from "./types";
export type { Config, ConfluenceConfig };

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const CONFIG_DIR = join(homedir(), ".config", "cjvibe");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function ensureConfigDir(): Promise<void> {
  if (!existsSync(CONFIG_DIR)) {
    await mkdir(CONFIG_DIR, { recursive: true });
  }
}

async function readRaw(): Promise<Config> {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    const raw = await readFile(CONFIG_FILE, "utf-8");
    return JSON.parse(raw) as Config;
  } catch {
    throw new ConfigError(
      `Failed to parse config file at ${CONFIG_FILE}. ` +
        "It may be corrupted. Run `cjvibe config reset` to start fresh.",
    );
  }
}

async function writeRaw(config: Config): Promise<void> {
  await ensureConfigDir();
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Load the full config from disk. Returns empty object if not yet created. */
export async function loadConfig(): Promise<Config> {
  return readRaw();
}

/** Persist the full config to disk. */
export async function saveConfig(config: Config): Promise<void> {
  await writeRaw(config);
}

/** Merge a partial update into the stored config. */
export async function patchConfig(partial: Partial<Config>): Promise<Config> {
  const current = await readRaw();
  const updated: Config = { ...current, ...partial };
  await writeRaw(updated);
  return updated;
}

/** Delete all stored config. */
export async function resetConfig(): Promise<void> {
  await writeRaw({});
}

/** Read a specific section, throwing `ConfigError` if it is absent. */
export async function requireSection<K extends keyof Config>(
  key: K,
): Promise<NonNullable<Config[K]>> {
  const config = await readRaw();
  const section = config[key];
  if (!section) {
    throw new ConfigError(
      `No "${key}" config found. Run \`cjvibe ${key} init\` to configure it.`,
    );
  }
  return section as NonNullable<Config[K]>;
}

/** Return the path to the config file (useful for user-facing messages). */
export function configFilePath(): string {
  return CONFIG_FILE;
}
