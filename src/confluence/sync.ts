/**
 * sync.ts — Manages local GCM file sync state (manifest, hashing, diff detection).
 *
 * The sync manifest lives alongside the .gcm files at `<pagesDir>/.cjvibe-sync.json`.
 * It records the page ID, version, title, and SHA-256 hash of each synced file.
 */

import { join } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { SyncManifest, SyncManifestEntry } from "@/config/types";

const MANIFEST_FILE = ".cjvibe-sync.json";

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

export async function hashContent(content: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(content);
  return hasher.digest("hex");
}

// ---------------------------------------------------------------------------
// Manifest I/O
// ---------------------------------------------------------------------------

function manifestPath(pagesDir: string): string {
  return join(pagesDir, MANIFEST_FILE);
}

export async function loadManifest(pagesDir: string): Promise<SyncManifest | null> {
  const path = manifestPath(pagesDir);
  if (!existsSync(path)) return null;
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as SyncManifest;
  } catch {
    return null;
  }
}

export async function saveManifest(
  pagesDir: string,
  manifest: SyncManifest,
): Promise<void> {
  if (!existsSync(pagesDir)) {
    await mkdir(pagesDir, { recursive: true });
  }
  const path = manifestPath(pagesDir);
  await writeFile(path, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Manifest helpers
// ---------------------------------------------------------------------------

export function findEntry(
  manifest: SyncManifest | null,
  pageId: string,
): SyncManifestEntry | undefined {
  return manifest?.pages.find((e) => e.pageId === pageId);
}

export function upsertEntry(
  manifest: SyncManifest,
  entry: SyncManifestEntry,
): void {
  const idx = manifest.pages.findIndex((e) => e.pageId === entry.pageId);
  if (idx !== -1) {
    manifest.pages[idx] = entry;
  } else {
    manifest.pages.push(entry);
  }
}

// ---------------------------------------------------------------------------
// Diff detection
// ---------------------------------------------------------------------------

/**
 * Check if a local .gcm file has changed since last sync.
 * Returns true if the file content differs from the manifest hash.
 */
export async function hasLocalChanges(
  pagesDir: string,
  entry: SyncManifestEntry,
): Promise<boolean> {
  const filePath = join(pagesDir, entry.file);
  if (!existsSync(filePath)) return false; // file deleted — not a "change" for push
  const content = await readFile(filePath, "utf-8");
  const currentHash = await hashContent(content);
  return currentHash !== entry.hash;
}

/**
 * Sanitize a page title into a safe filename.
 * Replaces characters that are invalid in filenames.
 */
export function titleToFilename(title: string): string {
  return title
    .replace(/[/\\:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}
