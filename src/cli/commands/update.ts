import type { Command, ParsedArgs } from "../router";
import { log } from "@/utils/logger";
import { CjvibeError } from "@/utils/errors";
import { existsSync, chmodSync, renameSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import pkg from "../../../package.json";

const REPO = "MaxNoragami/cjvibe";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function detectTarget(): string {
  const os = process.platform; // "linux" | "darwin" | "win32" | ...
  const arch = process.arch;   // "x64" | "arm64" | ...

  let platform: string;
  if (os === "linux") platform = "linux";
  else if (os === "darwin") platform = "darwin";
  else throw new CjvibeError(`Unsupported OS: ${os}`, "UPDATE_ERROR", 1);

  let a: string;
  if (arch === "x64") a = "x64";
  else if (arch === "arm64") a = "arm64";
  else throw new CjvibeError(`Unsupported architecture: ${arch}`, "UPDATE_ERROR", 1);

  return `cjvibe-${platform}-${a}`;
}

async function fetchLatestTag(): Promise<string> {
  const url = `https://api.github.com/repos/${REPO}/releases/latest`;
  const res = await fetch(url, {
    headers: { "Accept": "application/vnd.github+json", "User-Agent": "cjvibe" },
  });
  if (!res.ok) {
    throw new CjvibeError(
      `Failed to fetch latest release info (HTTP ${res.status})`,
      "UPDATE_ERROR",
      1,
    );
  }
  const json = (await res.json()) as { tag_name?: string };
  if (!json.tag_name) {
    throw new CjvibeError("No releases found on GitHub.", "UPDATE_ERROR", 1);
  }
  return json.tag_name;
}

async function downloadFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { headers: { "User-Agent": "cjvibe" } });
  if (!res.ok) {
    throw new CjvibeError(
      `Download failed (HTTP ${res.status}): ${url}`,
      "UPDATE_ERROR",
      1,
    );
  }
  const buf = await res.arrayBuffer();
  await Bun.write(dest, buf);
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handleUpdate(_args: ParsedArgs): Promise<void> {
  const currentVersion = pkg.version;
  const target = detectTarget();

  log.info(`Current version : v${currentVersion}`);
  log.info("Checking for updates...");

  const latestTag = await fetchLatestTag();
  const latestVersion = latestTag.replace(/^v/, "");

  if (latestVersion === currentVersion) {
    log.success(`Already up to date (v${currentVersion}).`);
    return;
  }

  log.info(`New version available: ${latestTag}`);

  // Resolve current binary path
  const binaryPath = process.execPath;

  // Sanity check — only self-update if we look like a compiled binary
  if (binaryPath.endsWith(".ts") || binaryPath.includes("bun")) {
    log.warn(
      "Running from source (not a compiled binary). " +
      "Run `bun run build` to compile, or use the install script to install a release binary.",
    );
    return;
  }

  if (!existsSync(binaryPath)) {
    throw new CjvibeError(
      `Cannot determine binary path: ${binaryPath}`,
      "UPDATE_ERROR",
      1,
    );
  }

  const downloadUrl = `https://github.com/${REPO}/releases/download/${latestTag}/${target}`;
  const tmpPath = join(tmpdir(), `cjvibe-update-${Date.now()}`);

  log.info(`Downloading ${latestTag} (${target})...`);
  await downloadFile(downloadUrl, tmpPath);
  chmodSync(tmpPath, 0o755);

  // Atomic swap: rename old → backup, move new → old path
  const backupPath = `${binaryPath}.bak`;
  try {
    renameSync(binaryPath, backupPath);
  } catch {
    // If we can't rename (e.g. cross-device), fall through and try writing directly
  }
  renameSync(tmpPath, binaryPath);

  // Remove backup if swap succeeded
  if (existsSync(backupPath)) {
    try { unlinkSync(backupPath); } catch { /* best effort */ }
  }

  log.success(`Updated to ${latestTag}. You may need to restart your shell.`);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const updateCommand: Command = {
  name: "update",
  description: "Update cjvibe to the latest release",
  handler: handleUpdate,
};
