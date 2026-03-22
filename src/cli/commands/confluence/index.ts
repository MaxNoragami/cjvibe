import type { Command, ParsedArgs } from "@/cli/router";
import { log } from "@/utils/logger";
import { configFilePath, loadConfig, patchConfig, requireSection } from "@/config";
import type { PageTreeNode, PageVersion } from "@/confluence/types";
import type { SyncManifest } from "@/config/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Natural-sort comparator: "WP2" < "WP10", "WP1.1" < "WP1.2".
 * Falls back to lexicographic for purely alphabetic strings.
 */
function naturalCompare(a: string, b: string): number {
  const re = /(\d+)/g;
  const aParts = a.split(re);
  const bParts = b.split(re);
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const ap = aParts[i] ?? "";
    const bp = bParts[i] ?? "";
    const an = Number(ap);
    const bn = Number(bp);
    if (!isNaN(an) && !isNaN(bn)) {
      if (an !== bn) return an - bn;
    } else {
      const cmp = ap.localeCompare(bp);
      if (cmp !== 0) return cmp;
    }
  }
  return 0;
}

const BOLD  = "\x1b[1m";
const DIM   = "\x1b[2m";
const RESET = "\x1b[0m";

// Colors cycled per depth level: cyan → green → yellow → magenta → blue → red …
const DEPTH_COLORS = [
  "\x1b[36m", // 0  cyan
  "\x1b[32m", // 1  green
  "\x1b[33m", // 2  yellow
  "\x1b[35m", // 3  magenta
  "\x1b[34m", // 4  blue
  "\x1b[31m", // 5  red
];

function depthColor(depth: number): string {
  return DEPTH_COLORS[depth % DEPTH_COLORS.length]!;
}

/**
 * Recursively print children with proper ├─ / └─ / │ connectors.
 * Each depth level gets its own colour applied to the connector + [ID].
 */
function printTree(
  nodes: PageTreeNode[],
  linePrefix = "",
  showUrls = false,
  depth = 1,
): void {
  const color  = depthColor(depth);
  const sorted = [...nodes].sort((a, b) => naturalCompare(a.title, b.title));
  for (let i = 0; i < sorted.length; i++) {
    const node    = sorted[i]!;
    const isLast  = i === sorted.length - 1;
    const connector = isLast ? "└─ " : "├─ ";
    const guide     = isLast ? "   " : "│  ";

    process.stdout.write(
      `${linePrefix}${color}${connector}${BOLD}[${node.id}]${RESET}` +
      `${DIM} v${node.version}${RESET} — ${node.title}\n`,
    );
    if (showUrls) {
      process.stdout.write(`${linePrefix}${guide}${DIM}${node.webUrl}${RESET}\n`);
    }
    if (node.children.length > 0) {
      printTree(node.children, linePrefix + guide, showUrls, depth + 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Subcommand handlers
// ---------------------------------------------------------------------------

/** `cjvibe confluence init` — interactively configure Confluence credentials */
async function handleInit(args: ParsedArgs): Promise<void> {
  const { select } = await import("@/utils/select");
  const { ConfluenceClient } = await import("@/confluence/client");

  log.section("Confluence Setup");
  log.info("Credentials will be saved to:");
  log.dim(configFilePath());
  log.plain("");

  // ── Step 1: credentials (plain text prompts) ─────────────────────────────
  const baseUrl = prompt("Confluence base URL (e.g. http://wiki.example.com):")?.trim();
  const username = prompt("Username / email:")?.trim();
  const token    = prompt("Personal access token (PAT):")?.trim();

  if (!baseUrl || !username || !token) {
    log.error("Base URL, username, and token are all required.");
    process.exit(1);
  }

  // Bearer is always correct for self-hosted PATs
  const client = new ConfluenceClient({ baseUrl, username, token, authMethod: "bearer" });

  // ── Step 2: verify connectivity ──────────────────────────────────────────
  log.plain("\nVerifying connection...");
  let spacesResult: Awaited<ReturnType<typeof client.listSpaces>>;
  try {
    spacesResult = await client.listSpaces(100);
    log.success(`Connected — ${spacesResult.results.length} space(s) found.\n`);
  } catch (err) {
    const { toMessage } = await import("@/utils/errors");
    log.error(`Connection failed: ${toMessage(err)}`);
    log.dim("Check your base URL, username, and PAT.");
    process.exit(1);
  }

  // ── Step 3: pick default space ───────────────────────────────────────────
  let defaultSpace: string | null = null;

  const spaceFlag = args.flags["space"];
  if (spaceFlag) {
    // Non-interactive: --space=KEY
    const key = String(spaceFlag);
    const match = spacesResult.results.find((s) => s.key === key);
    if (!match) {
      log.error(`Space "${key}" not found. Available: ${spacesResult.results.map((s) => s.key).join(", ")}`);
      process.exit(1);
    }
    defaultSpace = key;
    log.success(`Default space: ${defaultSpace}\n`);
  } else {
    const spaceItems = spacesResult.results.map((s) => ({
      label: `${s.key.padEnd(14)} ${s.name}  [${s.type}]`,
      value: s.key,
    }));

    defaultSpace = await select(spaceItems, {
      title: "Default space (used when --space is omitted):",
      pageSize: 14,
    });

    if (!defaultSpace) {
      log.warn("No space selected — skipping default space.");
    } else {
      log.success(`Default space: ${defaultSpace}\n`);
    }
  }

  // ── Step 4: pick root page ───────────────────────────────────────────────
  let rootPageId: string | undefined;

  const rootFlag = args.flags["root-page"];
  if (rootFlag) {
    // Non-interactive: --root-page=ID
    rootPageId = String(rootFlag);
    log.success(`Root page ID: ${rootPageId}\n`);
  } else if (defaultSpace) {
    log.plain("Fetching top-level pages for root page selection...");

    try {
      // Get the space homepage, then its direct children
      const homepageId = await client.getSpaceHomepageId(defaultSpace);
      const topPages   = homepageId
        ? await client.getChildren(homepageId)
        : (await client.listPages(defaultSpace, 100)).results;

      if (topPages.length === 0) {
        log.warn("No top-level pages found — skipping root page selection.");
      } else {
        const pageItems = [
          { label: "(none — skip)", value: "" as string },
          ...topPages.map((p) => ({
            label: `[${p.id}]  ${p.title}`,
            value: p.id,
          })),
        ];

        const selected = await select(pageItems, {
          title: "Root page for tree/sync (depth-1 pages):",
          pageSize: 14,
        });

        rootPageId = selected || undefined;
        if (rootPageId) {
          log.success(`Root page ID: ${rootPageId}\n`);
        } else {
          log.dim("No root page set.\n");
        }
      }
    } catch (err) {
      const { toMessage } = await import("@/utils/errors");
      log.warn(`Could not fetch pages: ${toMessage(err)} — skipping root page selection.`);
    }
  }

  // ── Step 5: save ─────────────────────────────────────────────────────────
  await patchConfig({
    confluence: {
      baseUrl,
      username,
      token,
      authMethod: "bearer",
      ...(defaultSpace ? { defaultSpace } : {}),
      ...(rootPageId   ? { rootPageId }   : {}),
    },
  });

  log.success("Confluence config saved.");
}


/** `cjvibe confluence status` — verify config & connectivity */
async function handleStatus(_args: ParsedArgs): Promise<void> {
  log.section("Confluence Status");

  const config = await loadConfig();
  if (!config.confluence) {
    log.warn("Confluence is not configured. Run `cjvibe confluence init` first.");
    return;
  }

  const { baseUrl, username, defaultSpace, rootPageId, authMethod } = config.confluence;
  log.info(`Base URL     : ${baseUrl}`);
  log.info(`Username     : ${username}`);
  log.info(`Auth method  : ${authMethod ?? "bearer"}`);
  log.info(`Default space: ${defaultSpace ?? "(none)"}`);
  log.info(`Root page ID : ${rootPageId ?? "(none)"}`);

  log.plain("\nTesting connection...");
  try {
    const { createConfluenceClient } = await import("@/confluence/client");
    const client = await createConfluenceClient();
    const spaces = await client.listSpaces(1);
    log.success(`Connected! (${spaces.size} space(s) visible in first page)`);
  } catch (err) {
    const { toMessage } = await import("@/utils/errors");
    log.error(`Connection failed: ${toMessage(err)}`);
    process.exit(1);
  }
}

/** `cjvibe confluence ls` — list accessible spaces */
async function handleSpaces(args: ParsedArgs): Promise<void> {
  const limit = Number(args.flags["limit"] ?? 25);
  const { createConfluenceClient } = await import("@/confluence/client");
  const client = await createConfluenceClient();

  log.plain("Fetching spaces...");
  const result = await client.listSpaces(limit);

  if (result.results.length === 0) {
    log.warn("No spaces found.");
    return;
  }

  log.section("Spaces");
  for (const space of result.results) {
    log.plain(`  ${space.key.padEnd(12)} ${space.name}  [${space.type}]`);
  }
}

/** `cjvibe confluence pages` — flat list of all pages in a space */
async function handlePages(args: ParsedArgs): Promise<void> {
  const config = await requireSection("confluence");
  const spaceKey = String(args.flags["space"] ?? config.defaultSpace ?? "");

  if (!spaceKey) {
    log.error("No space specified. Use --space=KEY or set a default with `cjvibe confluence init`.");
    process.exit(1);
  }

  const { createConfluenceClient } = await import("@/confluence/client");
  const client = await createConfluenceClient();

  log.plain(`Fetching all pages in space "${spaceKey}"...`);
  const pages = await client.getAllPages(spaceKey);

  if (pages.length === 0) {
    log.warn("No pages found.");
    return;
  }

  log.section(`Pages in ${spaceKey} (${pages.length} total)`);
  for (const page of pages) {
    log.plain(
      `  [${page.id}] v${page.version.number} — ${page.title}`,
    );
    log.dim(`          ${client.baseUrl}${page._links.webui}`);
  }
}

/** `cjvibe confluence tree` — hierarchical page tree */
async function handleTree(args: ParsedArgs): Promise<void> {
  const config = await requireSection("confluence");
  const spaceKey = String(args.flags["space"] ?? config.defaultSpace ?? "");

  if (!spaceKey) {
    log.error("No space specified. Use --space=KEY or set a default with `cjvibe confluence init`.");
    process.exit(1);
  }

  // Root page: explicit flag > config rootPageId
  const rootPageId = args.flags["root"]
    ? String(args.flags["root"])
    : config.rootPageId;

  const { createConfluenceClient } = await import("@/confluence/client");
  const client = await createConfluenceClient();

  const rootLabel = rootPageId ? `page ${rootPageId}` : "space root";
  log.plain(`Building page tree for "${spaceKey}" from ${rootLabel}...`);

  const showUrls = Boolean(args.flags["urls"]);

  const tree = await client.getPageTree(spaceKey, rootPageId);

  if (tree.length === 0) {
    log.warn("No pages found.");
    return;
  }

  log.section(`Page tree — ${spaceKey}${rootPageId ? ` (root: ${rootPageId})` : ""}`);
  log.dim(`  Sorted alphabetically. Use --urls to show URLs. Copy a [ID] to use with --root or future pull commands.\n`);

  for (const root of [...tree].sort((a, b) => naturalCompare(a.title, b.title))) {
    // Root node: depth-0 colour, no connector
    const c0 = depthColor(0);
    process.stdout.write(
      `${c0}${BOLD}[${root.id}]${RESET}${DIM} v${root.version}${RESET} — ${root.title}\n`,
    );
    if (showUrls) {
      process.stdout.write(`${DIM}${root.webUrl}${RESET}\n`);
    }
    printTree(root.children, "", showUrls);
  }
}

// ---------------------------------------------------------------------------
// Pull / Push
// ---------------------------------------------------------------------------

/** Resolve pagesDir: --dir flag > cwd/pages */
function resolvePagesDir(args: ParsedArgs): string {
  const { join } = require("node:path") as typeof import("node:path");
  const dir = args.flags["dir"];
  if (typeof dir === "string" && dir) return dir;
  return join(process.cwd(), "cjdata", "pages");
}

/**
 * `cjvibe confluence pull`
 *
 * Fetches pages from Confluence, converts to GCM, writes to local files.
 * On first run (or with --select), shows a multi-select checkbox picker
 * to choose which pages to sync.
 */
async function handlePull(args: ParsedArgs): Promise<void> {
  const { join } = await import("node:path");
  const { mkdir, readFile, writeFile } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");
  const { createConfluenceClient } = await import("@/confluence/client");
  const { htmlToGcm } = await import("@/confluence/gcm/from-html");
  const {
    loadManifest,
    saveManifest,
    hashContent,
    hashBinaryData,
    findEntry,
    upsertEntry,
    titleToFilename,
    ATTACHMENTS_DIR,
    CONTENT_FILE,
  } = await import("@/confluence/sync");
  const { multiSelect } = await import("@/utils/multi-select");

  const config = await requireSection("confluence");
  const spaceKey = String(args.flags["space"] ?? config.defaultSpace ?? "");
  if (!spaceKey) {
    log.error("No space specified. Use --space=KEY or set a default.");
    process.exit(1);
  }

  const rootPageId = args.flags["root"]
    ? String(args.flags["root"])
    : config.rootPageId;

  const pagesDir = resolvePagesDir(args);
  const spaceDir = join(pagesDir, spaceKey);
  const forceSelect = Boolean(args.flags["select"]);
  const forceAll = Boolean(args.flags["all"]);
  const forcePull = Boolean(args.flags["force"]);

  const client = await createConfluenceClient();

  // Load existing manifest
  let manifest = await loadManifest(spaceDir);
  const isFirstRun = !manifest || manifest.pages.length === 0;

  // Fetch all pages in the space (or subtree)
  log.plain(`Fetching pages from space "${spaceKey}"...`);
  const allPages = await client.getAllPages(spaceKey);

  // Filter to subtree if rootPageId is set
  let pagesToOffer = allPages;
  if (rootPageId) {
    const rootIds = new Set<string>([rootPageId]);
    // Build ancestor lookup to find descendants
    for (const p of allPages) {
      for (const anc of p.ancestors) {
        if (rootIds.has(anc.id)) {
          rootIds.add(p.id);
          break;
        }
      }
    }
    pagesToOffer = allPages.filter((p) => rootIds.has(p.id));
  }

  log.info(`${pagesToOffer.length} page(s) available.`);

  // --list: print available pages and exit (for LLMs / scripting)
  if (args.flags["list"]) {
    for (const p of pagesToOffer.sort((a, b) => naturalCompare(a.title, b.title))) {
      log.plain(`${p.id}  v${p.version.number}  ${p.title}`);
    }
    return;
  }

  // Determine which pages to pull
  let selectedIds: string[];

  const pagesFlag = args.flags["pages"];
  if (pagesFlag) {
    // Non-interactive: --pages=ID,ID,...
    const requested = String(pagesFlag).split(",").map((s) => s.trim()).filter(Boolean);
    const validSet = new Set(pagesToOffer.map((p) => p.id));
    const invalid = requested.filter((id) => !validSet.has(id));
    if (invalid.length > 0) {
      log.error(`Unknown page IDs: ${invalid.join(", ")}. Use --list to see available pages.`);
      process.exit(1);
    }
    selectedIds = requested;
  } else if (forceAll) {
    // --all: pull everything
    selectedIds = pagesToOffer.map((p) => p.id);
  } else if (forceSelect || isFirstRun) {
    // First run or --select: show checkbox picker
    const previouslySelected = new Set(
      manifest?.pages.map((e) => e.pageId) ?? [],
    );

    const items = pagesToOffer
      .sort((a, b) => naturalCompare(a.title, b.title))
      .map((p) => ({
        label: `[${p.id}] v${p.version.number} — ${p.title}`,
        value: p.id,
        checked: isFirstRun || previouslySelected.has(p.id),
      }));

    const selected = await multiSelect(items, {
      title: `Select pages to pull from ${spaceKey}:`,
      pageSize: 18,
    });

    if (!selected || selected.length === 0) {
      log.warn("No pages selected. Aborting.");
      return;
    }
    selectedIds = selected;
  } else {
    // Subsequent run: pull only previously-selected pages
    selectedIds = manifest!.pages.map((e) => e.pageId);
  }

  // Ensure output directory
  if (!existsSync(spaceDir)) {
    await mkdir(spaceDir, { recursive: true });
  }

  // Initialize manifest if needed
  if (!manifest) {
    manifest = { spaceKey, lastSync: 0, pages: [] };
  }

  // Pull each selected page
  let pulled = 0;
  let skipped = 0;
  let errors = 0;
  let totalAttachments = 0;

  for (const pageId of selectedIds) {
    const pageMeta = pagesToOffer.find((p) => p.id === pageId);
    if (!pageMeta) continue;

    const existing = findEntry(manifest, pageId);

    // Skip if version hasn't changed AND local file still matches manifest hash
    // (a restore changes the file but keeps manifest version → hash mismatch
    // signals we should re-pull the current remote content)
    if (!forcePull && existing && existing.version === pageMeta.version.number) {
      const filePath = join(spaceDir, existing.file);
      if (existsSync(filePath)) {
        const localContent = await readFile(filePath, "utf-8");
        const localHash = await hashContent(localContent);
        if (localHash === existing.hash) {
          skipped++;
          continue;
        }
        // Hash mismatch with same version — local file was modified (e.g. by restore)
        // Fall through to re-pull from remote
      } else {
        skipped++;
        continue;
      }
    }

    try {
      // Fetch full page with body
      const fullPage = await client.getPage(pageId);
      const storageHtml = fullPage.body.storage.value;
      const sourceUrl = config.baseUrl.replace(/\/$/, "") + (fullPage._links?.webui ?? "");

      // Convert to GCM
      const gcmContent = htmlToGcm(storageHtml, {
        title: fullPage.title,
        pageId: fullPage.id,
        version: fullPage.version.number,
        sourceUrl,
      });

      // Create page directory structure: <spaceDir>/<pageDir>/content.gcm + attachments/
      const pageDirName = titleToFilename(fullPage.title);
      const pageDir = join(spaceDir, pageDirName);
      const attachDir = join(pageDir, ATTACHMENTS_DIR);

      if (!existsSync(pageDir)) {
        await mkdir(pageDir, { recursive: true });
      }
      if (!existsSync(attachDir)) {
        await mkdir(attachDir, { recursive: true });
      }

      // Write GCM content file
      const contentFilePath = join(pageDir, CONTENT_FILE);
      await writeFile(contentFilePath, gcmContent, "utf-8");

      // --- Fetch and download attachments ---
      const existingAttachments = existing?.attachments ?? [];
      const existingAttachMap = new Map(
        existingAttachments.map((a) => [a.filename, a]),
      );

      let pageAttachCount = 0;
      type AttachmentManifestEntry = import("@/config/types").AttachmentManifestEntry;
      const newAttachEntries: AttachmentManifestEntry[] = [];

      try {
        const remoteAttachments = await client.listAttachments(fullPage.id);

        for (const att of remoteAttachments) {
          const existingAtt = existingAttachMap.get(att.title);

          // Skip download if attachment version unchanged and local file exists + hash matches
          if (!forcePull && existingAtt && existingAtt.version === att.version.number) {
            const localAttPath = join(attachDir, att.title);
            if (existsSync(localAttPath)) {
              newAttachEntries.push(existingAtt);
              continue;
            }
          }

          try {
            const data = await client.downloadAttachment(att._links.download);
            await Bun.write(join(attachDir, att.title), data);
            const attHash = hashBinaryData(data);

            newAttachEntries.push({
              attachmentId: att.id,
              filename: att.title,
              hash: attHash,
              version: att.version.number,
            });

            pageAttachCount++;
          } catch (attErr) {
            const { toMessage } = await import("@/utils/errors");
            log.warn(`    ⚠ attachment "${att.title}": ${toMessage(attErr)}`);
          }
        }
      } catch (attListErr) {
        const { toMessage } = await import("@/utils/errors");
        log.warn(`    ⚠ could not list attachments: ${toMessage(attListErr)}`);
      }

      totalAttachments += pageAttachCount;

      // Update manifest with new directory-based path
      const relativeFile = join(pageDirName, CONTENT_FILE);
      const hash = await hashContent(gcmContent);
      const manifestEntry: import("@/config/types").SyncManifestEntry = {
        pageId: fullPage.id,
        title: fullPage.title,
        version: fullPage.version.number,
        hash,
        file: relativeFile,
      };
      if (newAttachEntries.length > 0) {
        manifestEntry.attachments = newAttachEntries;
      }
      upsertEntry(manifest, manifestEntry);

      pulled++;
      const attSuffix = pageAttachCount > 0 ? `, ${pageAttachCount} attachment(s)` : "";
      log.dim(`  ✓ ${fullPage.title} (v${fullPage.version.number}${attSuffix})`);
    } catch (err) {
      errors++;
      const { toMessage } = await import("@/utils/errors");
      log.error(`  ✗ ${pageMeta.title}: ${toMessage(err)}`);
    }
  }

  // Remove manifest entries for pages no longer selected
  const selectedSet = new Set(selectedIds);
  manifest.pages = manifest.pages.filter((e) => selectedSet.has(e.pageId));

  // Save manifest
  manifest.lastSync = Date.now();
  await saveManifest(spaceDir, manifest);

  log.plain("");
  const attMsg = totalAttachments > 0 ? ` (${totalAttachments} attachment(s))` : "";
  log.success(
    `Pull complete: ${pulled} updated${attMsg}, ${skipped} unchanged, ${errors} failed.`,
  );
  log.dim(`Files at: ${spaceDir}`);
}

/**
 * `cjvibe confluence push`
 *
 * Pushes locally modified .gcm files back to Confluence.
 * Only pushes files that have changed since last pull (hash-based).
 * Detects version conflicts.
 * Also syncs attachments: uploads new files, updates changed ones.
 */
async function handlePush(args: ParsedArgs): Promise<void> {
  const { join, dirname } = await import("node:path");
  const { readFile } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");
  const { createConfluenceClient } = await import("@/confluence/client");
  const { gcmToHtml } = await import("@/confluence/gcm/to-html");
  const { parseFrontmatter } = await import("@/confluence/gcm/spec");
  const {
    loadManifest,
    saveManifest,
    hashContent,
    hasLocalChanges,
    hashBinaryFile,
    listLocalAttachments,
    ATTACHMENTS_DIR,
    CONTENT_FILE,
  } = await import("@/confluence/sync");

  const config = await requireSection("confluence");
  const spaceKey = String(args.flags["space"] ?? config.defaultSpace ?? "");
  if (!spaceKey) {
    log.error("No space specified. Use --space=KEY or set a default.");
    process.exit(1);
  }

  const pagesDir = resolvePagesDir(args);
  const spaceDir = join(pagesDir, spaceKey);

  if (!existsSync(spaceDir)) {
    log.error(`No pages directory found at: ${spaceDir}`);
    log.dim("Run `cjvibe confluence pull` first.");
    process.exit(1);
  }

  const manifest = await loadManifest(spaceDir);
  if (!manifest || manifest.pages.length === 0) {
    log.error("No sync manifest found. Run `cjvibe confluence pull` first.");
    process.exit(1);
  }

  const dryRun = Boolean(args.flags["dry-run"]);
  const forceAll = Boolean(args.flags["all"]);
  const singleFile = args.flags["file"] ? String(args.flags["file"]) : undefined;

  const client = await createConfluenceClient();

  // Find changed files (GCM content changes)
  const toProcess: typeof manifest.pages = [];

  if (singleFile) {
    // Match by full relative path (PageDir/content.gcm), page directory name,
    // or legacy flat filename (PageDir.gcm)
    const entry = manifest.pages.find(
      (e) => e.file === singleFile
        || e.file === singleFile + ".gcm"
        || e.file === join(singleFile, CONTENT_FILE)
        || e.file.startsWith(singleFile + "/"),
    );
    if (!entry) {
      log.error(`File "${singleFile}" not found in sync manifest.`);
      process.exit(1);
    }
    toProcess.push(entry);
  } else if (forceAll) {
    toProcess.push(...manifest.pages);
  } else {
    // Check for GCM content changes OR attachment changes
    for (const entry of manifest.pages) {
      const gcmChanged = await hasLocalChanges(spaceDir, entry);
      if (gcmChanged) {
        toProcess.push(entry);
        continue;
      }

      // Also check for attachment changes even if GCM is unchanged
      const pageDir = dirname(join(spaceDir, entry.file));
      const localFiles = await listLocalAttachments(pageDir);
      const manifestAttachMap = new Map(
        (entry.attachments ?? []).map((a) => [a.filename, a]),
      );

      // New files not in manifest?
      const hasNewFiles = localFiles.some((f) => !manifestAttachMap.has(f));
      if (hasNewFiles) {
        toProcess.push(entry);
        continue;
      }

      // Changed files (hash mismatch)?
      let hasChangedFiles = false;
      for (const f of localFiles) {
        const manifestAtt = manifestAttachMap.get(f);
        if (manifestAtt) {
          const localHash = await hashBinaryFile(join(pageDir, ATTACHMENTS_DIR, f));
          if (localHash !== manifestAtt.hash) {
            hasChangedFiles = true;
            break;
          }
        }
      }
      if (hasChangedFiles) {
        toProcess.push(entry);
        continue;
      }

      // Deleted local files that were in manifest?
      const localSet = new Set(localFiles);
      const hasDeletedFiles = (entry.attachments ?? []).some(
        (a) => !localSet.has(a.filename),
      );
      if (hasDeletedFiles) {
        toProcess.push(entry);
      }
    }
  }

  if (toProcess.length === 0) {
    log.success("No local changes detected. Nothing to push.");
    return;
  }

  log.info(`${toProcess.length} file(s) with local changes:`);
  for (const entry of toProcess) {
    log.dim(`  ${entry.file} — ${entry.title}`);
  }

  if (dryRun) {
    log.warn("Dry run — no changes pushed to Confluence.");
    // Show converted XHTML for each
    for (const entry of toProcess) {
      const filePath = join(spaceDir, entry.file);
      const content = await readFile(filePath, "utf-8");
      const [html, _meta] = gcmToHtml(content, {
        jiraServer: config.jiraServer,
        jiraServerId: config.jiraServerId,
      });
      log.section(`── ${entry.title} ──`);
      log.plain(html);
    }
    return;
  }

  log.plain("");
  let pushed = 0;
  let conflicts = 0;
  let errors = 0;
  let totalAttUploaded = 0;
  let totalAttUpdated = 0;

  for (const entry of toProcess) {
    const filePath = join(spaceDir, entry.file);
    if (!existsSync(filePath)) {
      log.warn(`  ⚠ ${entry.file}: file missing, skipping.`);
      continue;
    }

    try {
      const content = await readFile(filePath, "utf-8");
      const [meta] = parseFrontmatter(content);
      const [html, _gcmMeta] = gcmToHtml(content, {
        jiraServer: config.jiraServer,
        jiraServerId: config.jiraServerId,
      });

      // Check for version conflicts
      const remotePage = await client.getPage(entry.pageId);
      if (remotePage.version.number !== entry.version) {
        log.error(
          `  ✗ ${entry.title}: version conflict! ` +
            `Local base: v${entry.version}, remote: v${remotePage.version.number}. ` +
            `Pull first to merge.`,
        );
        conflicts++;
        continue;
      }

      // Check if GCM content actually changed (it might only be attachments)
      const gcmChanged = await hasLocalChanges(spaceDir, entry);

      if (gcmChanged) {
        // Push page body update
        const title = meta["title"] ?? remotePage.title;
        await client.updatePage({
          pageId: entry.pageId,
          title,
          body: html,
          currentVersion: remotePage.version.number,
        });

        // Update manifest entry with new version + hash
        const newVersion = remotePage.version.number + 1;
        entry.version = newVersion;
        entry.hash = await hashContent(content);

        log.dim(`  ✓ ${entry.title} → v${newVersion}`);
      }

      // --- Sync attachments ---
      const pageDir = dirname(filePath);
      const localFiles = await listLocalAttachments(pageDir);
      const manifestAttachMap = new Map(
        (entry.attachments ?? []).map((a) => [a.filename, a]),
      );

      type AttachmentManifestEntry = import("@/config/types").AttachmentManifestEntry;
      const updatedAttachEntries: AttachmentManifestEntry[] = [];
      let pageAttUploaded = 0;
      let pageAttUpdated = 0;

      for (const filename of localFiles) {
        const localAttPath = join(pageDir, ATTACHMENTS_DIR, filename);
        const localHash = await hashBinaryFile(localAttPath);
        const manifestAtt = manifestAttachMap.get(filename);

        if (manifestAtt && localHash === manifestAtt.hash) {
          // Unchanged — keep existing manifest entry
          updatedAttachEntries.push(manifestAtt);
          continue;
        }

        // Read the file binary
        const data = await readFile(localAttPath);

        if (manifestAtt) {
          // Existing attachment with changed content → update
          try {
            const updated = await client.updateAttachmentData({
              pageId: entry.pageId,
              attachmentId: manifestAtt.attachmentId,
              filename,
              data,
            });
            updatedAttachEntries.push({
              attachmentId: updated.id,
              filename,
              hash: localHash,
              version: updated.version.number,
            });
            pageAttUpdated++;
            log.dim(`    ↻ attachment "${filename}" updated`);
          } catch (attErr) {
            const { toMessage } = await import("@/utils/errors");
            log.warn(`    ⚠ attachment "${filename}": ${toMessage(attErr)}`);
            // Keep old manifest entry on failure
            updatedAttachEntries.push(manifestAtt);
          }
        } else {
          // New attachment → upload
          try {
            const uploaded = await client.uploadAttachment({
              pageId: entry.pageId,
              filename,
              data,
            });
            updatedAttachEntries.push({
              attachmentId: uploaded.id,
              filename,
              hash: localHash,
              version: uploaded.version.number,
            });
            pageAttUploaded++;
            log.dim(`    + attachment "${filename}" uploaded`);
          } catch (attErr) {
            const { toMessage } = await import("@/utils/errors");
            log.warn(`    ⚠ attachment "${filename}": ${toMessage(attErr)}`);
          }
        }
      }

      // Check for locally deleted attachments (warn only, never delete remotely)
      const localSet = new Set(localFiles);
      for (const [filename, manifestAtt] of manifestAttachMap) {
        if (!localSet.has(filename)) {
          log.warn(
            `    ⚠ "${filename}" exists remotely but was deleted locally — not removed from Confluence`,
          );
          // Keep manifest entry so we don't re-warn on next push
          updatedAttachEntries.push(manifestAtt);
        }
      }

      // Update entry attachments
      if (updatedAttachEntries.length > 0) {
        entry.attachments = updatedAttachEntries;
      }

      totalAttUploaded += pageAttUploaded;
      totalAttUpdated += pageAttUpdated;

      if (gcmChanged || pageAttUploaded > 0 || pageAttUpdated > 0) {
        pushed++;
      }

      if (!gcmChanged && (pageAttUploaded > 0 || pageAttUpdated > 0)) {
        log.dim(`  ✓ ${entry.title} — ${pageAttUploaded} uploaded, ${pageAttUpdated} updated attachment(s)`);
      }
    } catch (err) {
      errors++;
      const { toMessage } = await import("@/utils/errors");
      log.error(`  ✗ ${entry.title}: ${toMessage(err)}`);
    }
  }

  // Save updated manifest
  manifest.lastSync = Date.now();
  await saveManifest(spaceDir, manifest);

  log.plain("");
  const attParts: string[] = [];
  if (totalAttUploaded > 0) attParts.push(`${totalAttUploaded} attachment(s) uploaded`);
  if (totalAttUpdated > 0) attParts.push(`${totalAttUpdated} attachment(s) updated`);
  const attSuffix = attParts.length > 0 ? `, ${attParts.join(", ")}` : "";
  log.success(
    `Push complete: ${pushed} updated${attSuffix}, ${conflicts} conflict(s), ${errors} error(s).`,
  );
}

/**
 * `cjvibe confluence restore [HEAD~N] [--file=NAME.gcm] [--id=PAGE_ID] [--space=KEY] [--dir=PATH]`
 *
 * Restores a page's local .gcm file to a historical Confluence version.
 * Does NOT push automatically — use `confluence push` afterwards if wanted.
 *
 *   HEAD~1  → one version back from current
 *   HEAD~3  → three versions back
 *   (no arg) → interactive picker showing all versions with date + author
 */
async function handleRestore(args: ParsedArgs): Promise<void> {
  const { join } = await import("node:path");
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");
  const { createConfluenceClient } = await import("@/confluence/client");
  const { htmlToGcm } = await import("@/confluence/gcm/from-html");
  const { parseFrontmatter } = await import("@/confluence/gcm/spec");
  const {
    loadManifest,
    saveManifest,
    upsertEntry,
    titleToFilename,
    CONTENT_FILE,
    ATTACHMENTS_DIR,
  } = await import("@/confluence/sync");
  const { select } = await import("@/utils/select");

  const config = await requireSection("confluence");
  const spaceKey = String(args.flags["space"] ?? config.defaultSpace ?? "");

  // ── Resolve page ID ─────────────────────────────────────────────────────
  let pageId: string | undefined;
  let localFilePath: string | undefined;

  if (args.flags["id"]) {
    pageId = String(args.flags["id"]);
  } else {
    // Try to read from --file or derive from manifest
    const pagesDir = resolvePagesDir(args);
    const spaceDir = spaceKey ? join(pagesDir, spaceKey) : pagesDir;
    let fileName = args.flags["file"] ? String(args.flags["file"]) : undefined;

    if (!fileName && !spaceKey) {
      log.error("Provide --id=PAGE_ID, --file=NAME.gcm, or --space=KEY.");
      process.exit(1);
    }

    if (!fileName && spaceKey) {
      // If only one page in manifest, default to it; else require --file
      const manifest = await loadManifest(spaceDir);
      if (!manifest || manifest.pages.length === 0) {
        log.error("No sync manifest found. Run `cjvibe confluence pull` first.");
        process.exit(1);
      }
      if (manifest.pages.length === 1) {
        const e = manifest.pages[0]!;
        pageId = e.pageId;
        localFilePath = join(spaceDir, e.file);
      } else {
        log.error(
          "Multiple pages in manifest. Use --file=NAME.gcm or --id=PAGE_ID to specify which page.",
        );
        process.exit(1);
      }
    } else if (fileName) {
      // Resolve the file path and read front-matter
      // Support: direct path, PageDir/content.gcm, or just the page directory name
      if (!fileName.endsWith(".gcm")) {
        // Could be a page directory name — try <dir>/content.gcm first
        const dirPath = join(spaceDir, fileName, CONTENT_FILE);
        if (existsSync(dirPath)) {
          localFilePath = dirPath;
        } else {
          fileName += ".gcm";
          localFilePath = existsSync(fileName) ? fileName : join(spaceDir, fileName);
        }
      } else {
        localFilePath = existsSync(fileName) ? fileName : join(spaceDir, fileName);
      }
      if (!existsSync(localFilePath)) {
        log.error(`File not found: ${localFilePath}`);
        process.exit(1);
      }
      const { readFile } = await import("node:fs/promises");
      const raw = await readFile(localFilePath, "utf-8");
      const [meta] = parseFrontmatter(raw);
      pageId = meta["page_id"];
      if (!pageId) {
        log.error("No page_id found in front-matter. Cannot restore.");
        process.exit(1);
      }
    }
  }

  if (!pageId) {
    log.error("Could not determine page ID. Use --id=PAGE_ID or --file=NAME.gcm.");
    process.exit(1);
  }

  const client = await createConfluenceClient();

  // ── Parse HEAD~N ─────────────────────────────────────────────────────────
  const headArg = args.positionals[0]; // e.g. "HEAD~2"
  let targetVersionNumber: number | undefined;
  let currentRemoteVersion: number | undefined;

  // Always fetch current version so manifest stays in sync with remote HEAD
  log.plain("Fetching current page version...");
  const currentPage = await client.getPage(pageId);
  currentRemoteVersion = currentPage.version.number;

  if (headArg) {
    const m = headArg.match(/^HEAD(?:~(\d+)|\^)?$/i);
    if (!m) {
      log.error(`Unrecognised argument "${headArg}". Expected HEAD~N (e.g. HEAD~1).`);
      process.exit(1);
    }
    const stepsBack = m[1] !== undefined ? parseInt(m[1], 10) : 1; // HEAD^ = HEAD~1

    targetVersionNumber = currentRemoteVersion - stepsBack;
    if (targetVersionNumber < 1) {
      log.error(
        `Cannot go back ${stepsBack} version(s) — page only has ${currentRemoteVersion} version(s).`,
      );
      process.exit(1);
    }
    log.info(`Restoring version ${targetVersionNumber} (current is v${currentRemoteVersion}, HEAD~${stepsBack}).`);
  } else if (args.flags["version"]) {
    // Non-interactive: --version=N
    targetVersionNumber = Number(args.flags["version"]);
    if (isNaN(targetVersionNumber) || targetVersionNumber < 1 || targetVersionNumber > currentRemoteVersion) {
      log.error(`Invalid version ${args.flags["version"]}. Current version is v${currentRemoteVersion}.`);
      process.exit(1);
    }
    log.info(`Restoring version ${targetVersionNumber} (current is v${currentRemoteVersion}).`);
  } else {
    // ── Fetch version history (needed for --list and interactive picker) ──
    log.plain("Fetching version history...");
    const versions = await client.getVersionHistory(pageId, currentRemoteVersion);

    // Add the current version at the front so the user can see it
    const currentVer: PageVersion = {
      number:    currentRemoteVersion,
      when:      currentPage.version.when,
      minorEdit: false,
      ...(currentPage.version.by !== undefined ? { by: currentPage.version.by } : {}),
    };
    const allVersions = [currentVer, ...versions];

    if (allVersions.length <= 1) {
      log.error("No previous versions found for this page.");
      process.exit(1);
    }

    // --list: print versions and exit (for LLMs / scripting)
    if (args.flags["list"]) {
      for (const v of allVersions) {
        const when = new Date(v.when).toLocaleString("en-GB", {
          day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
        });
        const author = v.by?.displayName ?? v.by?.username ?? "unknown";
        const tag    = v.number === currentRemoteVersion ? "  (current)" : "";
        const msg    = v.message ? `  "${v.message}"` : "";
        log.plain(`v${String(v.number).padEnd(4)}  ${when.padEnd(22)}  ${author}${tag}${msg}`);
      }
      return;
    }

    const DIM_C = "\x1b[2m";
    const RST   = "\x1b[0m";
    const GRN   = "\x1b[32m";

    const items = allVersions.map((v) => {
      const when = new Date(v.when).toLocaleString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
      const author = v.by?.displayName ?? v.by?.username ?? "unknown";
      const msg    = v.message ? `  ${DIM_C}"${v.message}"${RST}` : "";
      const tag    = v.number === currentRemoteVersion ? `  ${GRN}(current)${RST}` : "";
      return {
        label: `v${String(v.number).padEnd(4)}  ${when.padEnd(22)}  ${author}${tag}${msg}`,
        value: v.number,
      };
    });

    const selected = await select(items, {
      title: "Select version to restore:",
      pageSize: 16,
    });

    if (selected === null) {
      log.warn("Restore cancelled.");
      return;
    }
    targetVersionNumber = selected;
  }

  // ── Fetch the historical body ────────────────────────────────────────────
  log.plain(`Fetching page body at v${targetVersionNumber}...`);
  const historical = await client.getPageAtVersion(pageId, targetVersionNumber);
  const storageHtml = historical.body.storage.value;
  const sourceUrl   = config.baseUrl.replace(/\/$/, "") + (historical._links?.webui ?? "");

  const gcmContent = htmlToGcm(storageHtml, {
    title:     historical.title,
    pageId:    historical.id,
    version:   targetVersionNumber,
    sourceUrl,
  });

  // ── Write to local file ──────────────────────────────────────────────────
  // Resolve output path: use whatever we found, or synthesise one
  if (!localFilePath) {
    const pagesDir = resolvePagesDir(args);
    const spaceDir = spaceKey ? join(pagesDir, spaceKey) : pagesDir;
    if (!existsSync(spaceDir)) await mkdir(spaceDir, { recursive: true });
    const pageDirName = titleToFilename(historical.title);
    const pageDir = join(spaceDir, pageDirName);
    if (!existsSync(pageDir)) await mkdir(pageDir, { recursive: true });
    const attachDir = join(pageDir, ATTACHMENTS_DIR);
    if (!existsSync(attachDir)) await mkdir(attachDir, { recursive: true });
    localFilePath = join(pageDir, CONTENT_FILE);
  }

  await writeFile(localFilePath, gcmContent, "utf-8");

  // Update manifest: keep version at current remote HEAD so push won't
  // see a version conflict, and preserve the OLD hash so push detects
  // that the local file content has changed.
  if (spaceKey) {
    const pagesDir = resolvePagesDir(args);
    const spaceDir = join(pagesDir, spaceKey);
    const manifest = await loadManifest(spaceDir);
    if (manifest) {
      const { findEntry } = await import("@/confluence/sync");
      const existing = findEntry(manifest, historical.id);
      // Keep old hash so push sees a diff; fall back to empty string for new entries
      const oldHash = existing?.hash ?? "";
      // Compute relative file path from spaceDir
      const pageDirName = titleToFilename(historical.title);
      const relativeFile = join(pageDirName, CONTENT_FILE);
      const entry: import("@/config/types").SyncManifestEntry = {
        pageId:  historical.id,
        title:   historical.title,
        version: currentRemoteVersion!,
        hash:    oldHash,
        file:    relativeFile,
      };
      // Preserve existing attachment entries
      if (existing?.attachments) {
        entry.attachments = existing.attachments;
      }
      upsertEntry(manifest, entry);
      manifest.lastSync = Date.now();
      await saveManifest(spaceDir, manifest);
    }
  }

  log.success(`Restored v${targetVersionNumber} → ${localFilePath}`);
  log.dim(`Run \`cjvibe confluence push\` to push this version back to Confluence.`);
}

// ---------------------------------------------------------------------------
// Command definition
// ---------------------------------------------------------------------------

export const confluenceCommand: Command = {
  name: "confluence",
  description: "Manage Confluence spaces and pages",
  usage: "cjvibe confluence <subcommand> [flags]",
  handler: async (_args) => {
    const BOLD = "\x1b[1m";
    const CYAN = "\x1b[36m";
    const DIM = "\x1b[2m";
    const RESET = "\x1b[0m";

    console.log(`\n${BOLD}cjvibe confluence${RESET} — Confluence integration\n`);
    console.log(`${BOLD}Subcommands:${RESET}`);
    for (const sub of confluenceCommand.subcommands ?? []) {
      console.log(
        `  ${CYAN}${sub.name.padEnd(14)}${RESET}${DIM}${sub.description}${RESET}`,
      );
    }
    console.log("");
  },
  subcommands: [
    {
      name: "init",
      description: "Configure Confluence credentials  [--space=KEY] [--root-page=ID]",
      handler: handleInit,
    },
    {
      name: "status",
      description: "Show current config and test connectivity",
      handler: handleStatus,
    },
    {
      name: "ls",
      description: "List accessible Confluence spaces  [--limit=N]",
      handler: handleSpaces,
    },
    {
      name: "pages",
      description: "Flat list of all pages in a space  [--space=KEY]",
      handler: handlePages,
    },
    {
      name: "tree",
      description: "Page tree  [--space=KEY] [--root=PAGE_ID] [--urls]",
      handler: handleTree,
    },
    {
      name: "pull",
      description: "Pull pages as .gcm files  [--space=KEY] [--select] [--all] [--pages=ID,...] [--list] [--force] [--dir=PATH]",
      handler: handlePull,
    },
    {
      name: "push",
      description: "Push changed .gcm files back  [--space=KEY] [--file=NAME] [--dry-run] [--dir=PATH]",
      handler: handlePush,
    },
    {
      name: "restore",
      description: "Restore page to a past version  [HEAD~N] [--version=N] [--list] [--file=NAME.gcm | --id=PAGE_ID] [--space=KEY]",
      handler: handleRestore,
    },
  ],
};
