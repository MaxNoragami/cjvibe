#!/usr/bin/env bun
/**
 * scripts/bump.ts
 *
 * Usage:
 *   bun run bump         # patch  (default)
 *   bun run bump:patch
 *   bun run bump:minor
 *   bun run bump:major
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

type ReleaseType = "patch" | "minor" | "major";

function bumpVersion(current: string, type: ReleaseType): string {
  const parts = current.split(".").map(Number);
  if (parts.length !== 3 || parts.some(isNaN))
    throw new Error(`Invalid semver: ${current}`);

  const [major, minor, patch] = parts as [number, number, number];

  switch (type) {
    case "major": return `${major + 1}.0.0`;
    case "minor": return `${major}.${minor + 1}.0`;
    case "patch": return `${major}.${minor}.${patch + 1}`;
  }
}

async function run() {
  const releaseType: ReleaseType =
    (["patch", "minor", "major"] as const).find(
      (t) => process.argv.includes(t),
    ) ?? "patch";

  const pkgPath = join(import.meta.dir, "../package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const oldVersion: string = pkg.version;
  const newVersion = bumpVersion(oldVersion, releaseType);

  pkg.version = newVersion;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

  console.log(`  ${oldVersion} → ${newVersion}`);

  // git commit + tag
  const tag = `v${newVersion}`;
  const msg = `chore: bump ${tag}`;

  const commit = Bun.spawnSync(["git", "commit", "-am", msg]);
  if (commit.exitCode !== 0) {
    console.error(new TextDecoder().decode(commit.stderr));
    process.exit(1);
  }

  const tagCmd = Bun.spawnSync(["git", "tag", tag]);
  if (tagCmd.exitCode !== 0) {
    console.error(new TextDecoder().decode(tagCmd.stderr));
    process.exit(1);
  }

  console.log(`  tagged ${tag}`);
  console.log(`  run: git push --follow-tags`);
}

await run();
