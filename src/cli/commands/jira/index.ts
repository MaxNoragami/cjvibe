import type { Command, ParsedArgs } from "@/cli/router";
import { log } from "@/utils/logger";
import { configFilePath, patchConfig, requireSection } from "@/config";
import type { JiraIssue, JiraComment } from "@/jira/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BOLD  = "\x1b[1m";
const RESET = "\x1b[0m";
const CYAN  = "\x1b[36m";
const DIM   = "\x1b[2m";
const GRN   = "\x1b[32m";
const YLW   = "\x1b[33m";
const RED   = "\x1b[31m";

function statusColor(categoryKey: string): string {
  switch (categoryKey) {
    case "new":           return "\x1b[34m"; // blue
    case "indeterminate": return YLW;         // yellow
    case "done":          return GRN;         // green
    default:              return DIM;
  }
}

function resolveIssuesDir(args: ParsedArgs): string {
  const dir = args.flags["dir"];
  if (typeof dir === "string" && dir) return dir;
  const { join } = require("node:path") as typeof import("node:path");
  return join(process.cwd(), "cjdata", "issues");
}

/**
 * Render a Jira issue to a simple Markdown-ish text format.
 * Includes key metadata in a YAML-ish front-matter block.
 */
function issueToMarkdown(issue: JiraIssue, baseUrl: string): string {
  const f = issue.fields;
  const lines: string[] = [];

  // Front-matter
  lines.push("---");
  lines.push(`key: ${issue.key}`);
  lines.push(`id: ${issue.id}`);
  lines.push(`summary: ${f.summary}`);
  lines.push(`type: ${f.issuetype.name}`);
  lines.push(`status: ${f.status.name}`);
  lines.push(`priority: ${f.priority?.name ?? "None"}`);
  lines.push(`assignee: ${f.assignee?.displayName ?? "Unassigned"}`);
  lines.push(`reporter: ${f.reporter?.displayName ?? "Unknown"}`);
  lines.push(`project: ${f.project.key}`);
  lines.push(`created: ${f.created}`);
  lines.push(`updated: ${f.updated}`);
  if (f.labels.length > 0) lines.push(`labels: ${f.labels.join(", ")}`);
  if (f.components.length > 0) lines.push(`components: ${f.components.map((c) => c.name).join(", ")}`);
  if (f.fixVersions.length > 0) lines.push(`fixVersions: ${f.fixVersions.map((v) => v.name).join(", ")}`);
  if (f.parent) lines.push(`parent: ${f.parent.key} — ${f.parent.fields.summary}`);
  lines.push(`url: ${baseUrl.replace(/\/$/, "")}/browse/${issue.key}`);
  lines.push("---");
  lines.push("");

  // Title
  lines.push(`# ${issue.key}: ${f.summary}`);
  lines.push("");

  // Description
  if (f.description) {
    lines.push("## Description");
    lines.push("");
    lines.push(f.description);
    lines.push("");
  }

  // Subtasks
  if (f.subtasks && f.subtasks.length > 0) {
    lines.push("## Subtasks");
    lines.push("");
    for (const sub of f.subtasks) {
      const mark = sub.fields.status.statusCategory.key === "done" ? "x" : " ";
      lines.push(`- [${mark}] ${sub.key}: ${sub.fields.summary}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function issueKeyToFilename(key: string): string {
  return key + ".md";
}

// ---------------------------------------------------------------------------
// Subcommand handlers
// ---------------------------------------------------------------------------

/** `cjvibe jira init` — interactively configure Jira credentials */
async function handleInit(_args: ParsedArgs): Promise<void> {
  const { select } = await import("@/utils/select");
  const { JiraClient } = await import("@/jira/client");

  log.section("Jira Setup");
  log.info("Credentials will be saved to:");
  log.dim(configFilePath());
  log.plain("");

  // ── Step 1: credentials ──────────────────────────────────────────────────
  const baseUrl  = prompt("Jira base URL (e.g. http://jira.example.com):")?.trim();
  const username = prompt("Username / email:")?.trim();
  const token    = prompt("Personal access token (PAT):")?.trim();

  if (!baseUrl || !username || !token) {
    log.error("Base URL, username, and token are all required.");
    process.exit(1);
  }

  const client = new JiraClient({
    baseUrl,
    username,
    token,
    authMethod: "bearer",
  });

  // ── Step 2: verify connectivity ──────────────────────────────────────────
  log.plain("\nVerifying connection...");
  try {
    const user = await client.myself();
    log.success(`Connected as ${BOLD}${user.displayName}${RESET} (${user.name})\n`);
  } catch (err) {
    const { toMessage } = await import("@/utils/errors");
    log.error(`Connection failed: ${toMessage(err)}`);
    log.dim("Check your base URL, username, and PAT.");
    process.exit(1);
  }

  // ── Step 3: pick default board ───────────────────────────────────────────
  log.plain("Fetching boards...");
  let boards: Awaited<ReturnType<typeof client.listBoards>>;
  try {
    boards = await client.listBoards();
  } catch (err) {
    const { toMessage } = await import("@/utils/errors");
    log.warn(`Could not fetch boards: ${toMessage(err)}`);
    boards = [];
  }

  let defaultBoardId: number | undefined;
  let defaultBoardName: string | undefined;

  if (boards.length > 0) {
    log.info(`${boards.length} board(s) found.\n`);
    const boardItems = boards.map((b) => ({
      label: `${String(b.id).padEnd(6)} ${b.name}  [${b.type}]${b.location ? `  ${b.location.projectKey}` : ""}`,
      value: b.id,
    }));

    const selected = await select(boardItems, {
      title: "Default board (used when --board is omitted):",
      pageSize: 14,
    });

    if (selected !== null) {
      const board = boards.find((b) => b.id === selected);
      defaultBoardId = selected;
      defaultBoardName = board?.name;
      log.success(`Default board: ${defaultBoardName} (${defaultBoardId})\n`);
    } else {
      log.dim("No board selected.\n");
    }
  } else {
    log.warn("No boards found. You can set a board later.");
  }

  // ── Step 4: save ─────────────────────────────────────────────────────────
  await patchConfig({
    jira: {
      baseUrl,
      username,
      token,
      authMethod: "bearer",
      ...(defaultBoardId !== undefined ? { defaultBoardId } : {}),
      ...(defaultBoardName !== undefined ? { defaultBoardName } : {}),
    },
  });

  log.success("Jira config saved.");
}

/** `cjvibe jira status` — show config & test connectivity */
async function handleStatus(_args: ParsedArgs): Promise<void> {
  log.section("Jira Status");

  const config = await requireSection("jira");
  log.dim(`  URL:       ${config.baseUrl}`);
  log.dim(`  User:      ${config.username}`);
  log.dim(`  Auth:      ${config.authMethod ?? "bearer"}`);
  if (config.defaultBoardId) {
    log.dim(`  Board:     ${config.defaultBoardName ?? ""} (${config.defaultBoardId})`);
  }
  log.plain("");

  const { createJiraClient } = await import("@/jira/client");
  const client = await createJiraClient();
  try {
    const user = await client.myself();
    log.success(`Connected as ${user.displayName} (${user.name})`);
  } catch (err) {
    const { toMessage } = await import("@/utils/errors");
    log.error(`Connection failed: ${toMessage(err)}`);
  }
}

/** `cjvibe jira boards` — list available boards */
async function handleBoards(_args: ParsedArgs): Promise<void> {
  const { createJiraClient } = await import("@/jira/client");
  const client = await createJiraClient();

  log.plain("Fetching boards...");
  const boards = await client.listBoards();

  if (boards.length === 0) {
    log.warn("No boards found.");
    return;
  }

  log.info(`${boards.length} board(s):\n`);
  for (const b of boards) {
    const proj = b.location ? `  ${DIM}${b.location.projectKey} — ${b.location.projectName}${RESET}` : "";
    console.log(`  ${CYAN}${String(b.id).padEnd(6)}${RESET} ${b.name}  ${DIM}[${b.type}]${RESET}${proj}`);
  }
  log.plain("");
}

/** `cjvibe jira pull` — fetch issues from a board */
async function handlePull(args: ParsedArgs): Promise<void> {
  const { join } = await import("node:path");
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");
  const { createJiraClient } = await import("@/jira/client");

  const config = await requireSection("jira");

  const boardId = args.flags["board"]
    ? Number(args.flags["board"])
    : config.defaultBoardId;

  if (!boardId) {
    log.error("No board specified. Use --board=ID or set a default with `cjvibe jira init`.");
    process.exit(1);
  }

  const fetchAll = Boolean(args.flags["all"]);

  const client = await createJiraClient();

  // Get current user for filtering
  let myUsername: string | undefined;
  if (!fetchAll) {
    try {
      const user = await client.myself();
      myUsername = user.name;
      log.info(`Fetching issues assigned to ${BOLD}${user.displayName}${RESET}...`);
    } catch {
      log.warn("Could not identify current user. Fetching all issues.");
    }
  } else {
    log.info("Fetching all issues on board...");
  }

  const issues = await client.getBoardIssues(boardId, {
    assignee: fetchAll ? undefined : myUsername,
  });

  if (issues.length === 0) {
    log.success("No issues found.");
    return;
  }

  log.info(`${issues.length} issue(s) found.`);

  // Determine output directory
  const issuesDir = resolveIssuesDir(args);
  const boardDir = join(issuesDir, String(boardId));
  if (!existsSync(boardDir)) {
    await mkdir(boardDir, { recursive: true });
  }

  let written = 0;
  for (const issue of issues) {
    const content = issueToMarkdown(issue, config.baseUrl);
    const filename = issueKeyToFilename(issue.key);
    const filePath = join(boardDir, filename);
    await writeFile(filePath, content, "utf-8");
    written++;

    const cat = issue.fields.status.statusCategory.key;
    const sc = statusColor(cat);
    log.dim(`  ${sc}${issue.fields.status.name.padEnd(14)}${RESET} ${issue.key.padEnd(12)} ${issue.fields.summary}`);
  }

  log.plain("");
  log.success(`Pull complete: ${written} issue(s) written to ${boardDir}`);
}

/** `cjvibe jira clean` — remove issue files from local */
async function handleClean(args: ParsedArgs): Promise<void> {
  const { join } = await import("node:path");
  const { readdir, readFile, unlink } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");
  const { createJiraClient } = await import("@/jira/client");

  const config = await requireSection("jira");

  const boardId = args.flags["board"]
    ? Number(args.flags["board"])
    : config.defaultBoardId;

  if (!boardId) {
    log.error("No board specified. Use --board=ID or set a default.");
    process.exit(1);
  }

  const cleanAll = Boolean(args.flags["all"]);
  const dryRun = Boolean(args.flags["dry-run"]);
  const issuesDir = resolveIssuesDir(args);
  const boardDir = join(issuesDir, String(boardId));

  if (!existsSync(boardDir)) {
    log.warn(`No issues directory found at: ${boardDir}`);
    return;
  }

  // List .md files
  const files = (await readdir(boardDir)).filter((f) => f.endsWith(".md"));
  if (files.length === 0) {
    log.success("No issue files to clean.");
    return;
  }

  if (cleanAll) {
    // Remove everything
    if (dryRun) {
      log.warn(`Dry run — would delete ${files.length} file(s):`);
      for (const f of files) log.dim(`  ${f}`);
      return;
    }

    let removed = 0;
    for (const f of files) {
      await unlink(join(boardDir, f));
      removed++;
      log.dim(`  ✗ ${f}`);
    }
    log.success(`Cleaned ${removed} file(s).`);
    return;
  }

  // Remove only issues NOT assigned to me
  const client = await createJiraClient();
  let myUsername: string;
  let myDisplayName: string;
  try {
    const user = await client.myself();
    myUsername = user.name;
    myDisplayName = user.displayName;
  } catch {
    log.error("Could not identify current user. Use --all to remove all files.");
    process.exit(1);
  }

  let removed = 0;
  let kept = 0;

  for (const f of files) {
    const filePath = join(boardDir, f);
    try {
      const content = await readFile(filePath, "utf-8");
      // Parse front-matter to find assignee
      const assigneeMatch = content.match(/^assignee:\s*(.+)$/m);
      const assignee = assigneeMatch?.[1]?.trim() ?? "";

      const ismine =
        assignee === myDisplayName ||
        assignee === myUsername;

      if (ismine) {
        kept++;
        continue;
      }

      if (dryRun) {
        log.dim(`  would delete: ${f} (assigned to: ${assignee})`);
        removed++;
        continue;
      }

      await unlink(filePath);
      removed++;
      log.dim(`  ✗ ${f} (${assignee})`);
    } catch {
      // If we can't read it, skip
      kept++;
    }
  }

  if (dryRun) {
    log.warn(`Dry run — would delete ${removed}, keep ${kept} file(s).`);
  } else {
    log.success(`Cleaned ${removed} file(s), kept ${kept} (yours).`);
  }
}

// ---------------------------------------------------------------------------
// Comment sync helpers
// ---------------------------------------------------------------------------

interface CommentManifestEntry {
  commentId: string;
  author: string;        // username (key for ownership check)
  authorDisplay: string; // display name
  created: string;
  updated: string;
  hash: string;          // SHA-256 of local file content
  file: string;          // relative filename
}

interface CommentManifest {
  issueKey: string;
  lastSync: number;
  comments: CommentManifestEntry[];
}

async function hashContent(content: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(content);
  return hasher.digest("hex");
}

async function loadCommentManifest(dir: string): Promise<CommentManifest | null> {
  const { join } = await import("node:path");
  const { existsSync } = await import("node:fs");
  const { readFile } = await import("node:fs/promises");
  const p = join(dir, ".cjvibe-comments.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(await readFile(p, "utf-8")) as CommentManifest;
  } catch {
    return null;
  }
}

async function saveCommentManifest(dir: string, manifest: CommentManifest): Promise<void> {
  const { join } = await import("node:path");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(dir, ".cjvibe-comments.json"), JSON.stringify(manifest, null, 2) + "\n", "utf-8");
}

/**
 * Render a Jira comment to a markdown file with front-matter.
 */
function commentToMarkdown(comment: JiraComment, issueKey: string): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push(`comment_id: ${comment.id}`);
  lines.push(`issue: ${issueKey}`);
  lines.push(`author: ${comment.author.displayName}`);
  lines.push(`author_key: ${comment.author.name}`);
  lines.push(`created: ${comment.created}`);
  lines.push(`updated: ${comment.updated}`);
  lines.push("---");
  lines.push("");
  lines.push(comment.body);
  lines.push("");
  return lines.join("\n");
}

/**
 * Parse a comment markdown file. Returns front-matter fields + body.
 */
function parseCommentFile(content: string): {
  meta: Record<string, string>;
  body: string;
} {
  const meta: Record<string, string> = {};
  let body = content;

  if (content.startsWith("---\n") || content.startsWith("---\r\n")) {
    const endIdx = content.indexOf("\n---\n", 4);
    const endIdxR = content.indexOf("\r\n---\r\n", 4);
    const end = endIdx !== -1 ? endIdx : endIdxR;
    if (end !== -1) {
      const sep = endIdx !== -1 ? "\n" : "\r\n";
      const fmBlock = content.slice(4, end);
      for (const line of fmBlock.split(sep)) {
        const colonIdx = line.indexOf(":");
        if (colonIdx !== -1) {
          const key = line.slice(0, colonIdx).trim();
          const val = line.slice(colonIdx + 1).trim();
          meta[key] = val;
        }
      }
      body = content.slice(end + (sep === "\n" ? 5 : 7)).replace(/^\n+/, "");
    }
  }

  return { meta, body };
}

function commentFilename(commentId: string, authorKey: string, seq: number): string {
  const safe = authorKey.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${String(seq).padStart(3, "0")}_${safe}_${commentId}.md`;
}

function newCommentFilename(authorKey: string, seq: number): string {
  const safe = authorKey.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${String(seq).padStart(3, "0")}_${safe}_new.md`;
}

// ---------------------------------------------------------------------------
// Comment command handlers
// ---------------------------------------------------------------------------

/** `cjvibe jira pull comments --issue=KEY` */
async function handlePullComments(args: ParsedArgs): Promise<void> {
  const { join } = await import("node:path");
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");
  const { createJiraClient } = await import("@/jira/client");

  const config = await requireSection("jira");

  const issueKey = args.flags["issue"] ? String(args.flags["issue"]) : undefined;
  if (!issueKey) {
    log.error("Specify an issue with --issue=KEY (e.g. --issue=GMS-10).");
    process.exit(1);
  }

  const boardId = args.flags["board"]
    ? Number(args.flags["board"])
    : config.defaultBoardId;

  if (!boardId) {
    log.error("No board specified. Use --board=ID or set a default.");
    process.exit(1);
  }

  const client = await createJiraClient();
  const issuesDir = resolveIssuesDir(args);
  const commentsDir = join(issuesDir, String(boardId), "comments", issueKey);

  log.info(`Fetching comments for ${BOLD}${issueKey}${RESET}...`);
  const comments = await client.getComments(issueKey);

  if (comments.length === 0) {
    log.success("No comments found.");
    return;
  }

  if (!existsSync(commentsDir)) {
    await mkdir(commentsDir, { recursive: true });
  }

  // Load existing manifest
  let manifest = await loadCommentManifest(commentsDir);
  if (!manifest) {
    manifest = { issueKey, lastSync: 0, comments: [] };
  }

  let pulled = 0;
  let updated = 0;
  let skipped = 0;

  for (let i = 0; i < comments.length; i++) {
    const comment = comments[i]!;
    const existing = manifest.comments.find((e) => e.commentId === comment.id);
    const filename = existing?.file ?? commentFilename(comment.id, comment.author.name, i + 1);

    const content = commentToMarkdown(comment, issueKey);
    const hash = await hashContent(content);

    if (existing) {
      // Check if remote was updated
      if (existing.updated === comment.updated) {
        skipped++;
        continue;
      }
      // Remote was edited — update local
      await writeFile(join(commentsDir, filename), content, "utf-8");
      existing.updated = comment.updated;
      existing.hash = hash;
      updated++;
      log.dim(`  ↻ ${filename} (updated)`);
    } else {
      // New comment
      await writeFile(join(commentsDir, filename), content, "utf-8");
      manifest.comments.push({
        commentId: comment.id,
        author: comment.author.name,
        authorDisplay: comment.author.displayName,
        created: comment.created,
        updated: comment.updated,
        hash,
        file: filename,
      });
      pulled++;
      log.dim(`  ✓ ${filename}`);
    }
  }

  manifest.lastSync = Date.now();
  await saveCommentManifest(commentsDir, manifest);

  log.plain("");
  log.success(`Pull complete: ${pulled} new, ${updated} updated, ${skipped} unchanged.`);
  log.dim(`Files at: ${commentsDir}`);
}

/** `cjvibe jira push comments --issue=KEY` */
async function handlePushComments(args: ParsedArgs): Promise<void> {
  const { join } = await import("node:path");
  const { readdir, readFile } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");
  const { createJiraClient } = await import("@/jira/client");

  const config = await requireSection("jira");

  const issueKey = args.flags["issue"] ? String(args.flags["issue"]) : undefined;
  if (!issueKey) {
    log.error("Specify an issue with --issue=KEY (e.g. --issue=GMS-10).");
    process.exit(1);
  }

  const boardId = args.flags["board"]
    ? Number(args.flags["board"])
    : config.defaultBoardId;

  if (!boardId) {
    log.error("No board specified. Use --board=ID or set a default.");
    process.exit(1);
  }

  const dryRun = Boolean(args.flags["dry-run"]);
  const client = await createJiraClient();
  const issuesDir = resolveIssuesDir(args);
  const commentsDir = join(issuesDir, String(boardId), "comments", issueKey);

  if (!existsSync(commentsDir)) {
    log.error(`No comments directory found at: ${commentsDir}`);
    log.dim("Run `cjvibe jira pull comments --issue=KEY` first.");
    process.exit(1);
  }

  let manifest = await loadCommentManifest(commentsDir);
  if (!manifest) {
    manifest = { issueKey, lastSync: 0, comments: [] };
  }

  // Get current user
  let myUsername: string;
  try {
    const user = await client.myself();
    myUsername = user.name;
  } catch {
    log.error("Could not identify current user.");
    process.exit(1);
  }

  // Scan all .md files in the directory
  const files = (await readdir(commentsDir)).filter((f) => f.endsWith(".md")).sort();

  let created = 0;
  let edited = 0;
  let skippedCount = 0;
  let errors = 0;

  for (const file of files) {
    const filePath = join(commentsDir, file);
    const content = await readFile(filePath, "utf-8");
    const { meta, body } = parseCommentFile(content);
    const commentId = meta["comment_id"];
    const trimmedBody = body.trim();

    if (!trimmedBody) {
      skippedCount++;
      continue;
    }

    if (commentId) {
      // Existing comment — check if it was edited locally
      const entry = manifest.comments.find((e) => e.commentId === commentId);
      if (!entry) {
        skippedCount++;
        continue;
      }

      // Only allow editing own comments
      if (entry.author !== myUsername) {
        skippedCount++;
        continue;
      }

      const currentHash = await hashContent(content);
      if (currentHash === entry.hash) {
        skippedCount++;
        continue;
      }

      // Local file changed — push update
      if (dryRun) {
        log.dim(`  would update: ${file}`);
        edited++;
        continue;
      }

      try {
        const updatedComment = await client.updateComment(issueKey, commentId, trimmedBody);
        entry.updated = updatedComment.updated;
        entry.hash = await hashContent(content);
        edited++;
        log.dim(`  ↻ ${file} → updated`);
      } catch (err) {
        errors++;
        const { toMessage } = await import("@/utils/errors");
        log.error(`  ✗ ${file}: ${toMessage(err)}`);
      }
    } else {
      // New comment — no comment_id in front-matter
      if (dryRun) {
        log.dim(`  would create: ${file}`);
        created++;
        continue;
      }

      try {
        const newComment = await client.createComment(issueKey, trimmedBody);
        // Re-write the file with proper front-matter including the new ID
        const newContent = commentToMarkdown(newComment, issueKey);
        const { writeFile } = await import("node:fs/promises");

        // Rename to include the real comment ID
        const newFilename = commentFilename(
          newComment.id,
          newComment.author.name,
          manifest.comments.length + 1,
        );
        const { unlink } = await import("node:fs/promises");
        await unlink(filePath);
        await writeFile(join(commentsDir, newFilename), newContent, "utf-8");

        manifest.comments.push({
          commentId: newComment.id,
          author: newComment.author.name,
          authorDisplay: newComment.author.displayName,
          created: newComment.created,
          updated: newComment.updated,
          hash: await hashContent(newContent),
          file: newFilename,
        });
        created++;
        log.dim(`  ✓ ${file} → ${newFilename} (created)`);
      } catch (err) {
        errors++;
        const { toMessage } = await import("@/utils/errors");
        log.error(`  ✗ ${file}: ${toMessage(err)}`);
      }
    }
  }

  manifest.lastSync = Date.now();
  await saveCommentManifest(commentsDir, manifest);

  log.plain("");
  if (dryRun) {
    log.warn(`Dry run — would create ${created}, update ${edited}.`);
  } else {
    log.success(`Push complete: ${created} created, ${edited} updated, ${skippedCount} unchanged, ${errors} error(s).`);
  }
}

// ---------------------------------------------------------------------------
// Delete comment helpers
// ---------------------------------------------------------------------------

function formatShortDate(isoString: string): string {
  const d = new Date(isoString);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const mon = months[d.getMonth()]!;
  const day = d.getDate();
  if (diffDays === 0) return `today ${hh}:${mm}`;
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7)  return `${diffDays}d ago`;
  if (d.getFullYear() === now.getFullYear()) return `${mon} ${day}`;
  return `${mon} ${day} '${String(d.getFullYear()).slice(2)}`;
}

/** `cjvibe jira delete-comments --issue=KEY` — interactive picker to delete one of your comments. */
async function handleDeleteComment(args: ParsedArgs): Promise<void> {
  const { join } = await import("node:path");
  const { readFile, unlink } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");
  const { createJiraClient } = await import("@/jira/client");
  const { select } = await import("@/utils/select");

  const config = await requireSection("jira");

  const issueKey = args.flags["issue"] ? String(args.flags["issue"]) : undefined;
  if (!issueKey) {
    log.error("Specify an issue with --issue=KEY (e.g. --issue=GMS-10).");
    process.exit(1);
  }

  const boardId = args.flags["board"]
    ? Number(args.flags["board"])
    : config.defaultBoardId;

  if (!boardId) {
    log.error("No board specified. Use --board=ID or set a default.");
    process.exit(1);
  }

  const client = await createJiraClient();
  const issuesDir = resolveIssuesDir(args);
  const commentsDir = join(issuesDir, String(boardId), "comments", issueKey);

  if (!existsSync(commentsDir)) {
    log.error(`No comments directory found at: ${commentsDir}`);
    log.dim(`Run \`cjvibe jira pull-comments --issue=${issueKey}\` first.`);
    process.exit(1);
  }

  const manifest = await loadCommentManifest(commentsDir);
  if (!manifest || manifest.comments.length === 0) {
    log.warn("No comments in local manifest.");
    return;
  }

  let myUsername: string;
  try {
    const user = await client.myself();
    myUsername = user.name;
  } catch {
    log.error("Could not identify current user.");
    process.exit(1);
  }

  const ownComments = manifest.comments.filter((e) => e.author === myUsername);
  if (ownComments.length === 0) {
    log.warn("No comments authored by you found locally.");
    return;
  }

  const termCols = process.stdout.columns ?? 80;

  const items = await Promise.all(
    ownComments.map(async (entry) => {
      const idStr   = `#${entry.commentId}`;
      const dateStr = formatShortDate(entry.updated);

      let preview = "";
      const filePath = join(commentsDir, entry.file);
      if (existsSync(filePath)) {
        try {
          const raw = await readFile(filePath, "utf-8");
          preview = parseCommentFile(raw).body.replace(/\s+/g, " ").trim();
        } catch { /* skip */ }
      }

      // columns: "#ID          DATE           preview..."
      const ID_W   = 12;
      const DATE_W = 14;
      const prefix = ID_W + DATE_W + 4; // 4 = spaces
      const avail  = Math.max(termCols - prefix, 10);
      const snippet = preview.length > avail ? preview.slice(0, avail - 1) + "\u2026" : preview;

      return {
        label: `${idStr.padEnd(ID_W)}${dateStr.padEnd(DATE_W)}  ${snippet}`,
        value: entry,
      };
    }),
  );

  const chosen = await select(items, {
    title: `Delete comment on ${issueKey}  (only your comments shown)`,
  });

  if (!chosen) {
    log.dim("Cancelled.");
    return;
  }

  try {
    await client.deleteComment(issueKey, chosen.commentId);
  } catch (err) {
    const { toMessage } = await import("@/utils/errors");
    log.error(`Failed to delete: ${toMessage(err)}`);
    process.exit(1);
  }

  const filePath = join(commentsDir, chosen.file);
  if (existsSync(filePath)) await unlink(filePath);

  manifest.comments = manifest.comments.filter((e) => e.commentId !== chosen.commentId);
  await saveCommentManifest(commentsDir, manifest);

  log.success(`Deleted comment #${chosen.commentId}.`);
}

// ---------------------------------------------------------------------------
// Command definition
// ---------------------------------------------------------------------------

export const jiraCommand: Command = {
  name: "jira",
  description: "Manage Jira boards and issues",
  usage: "cjvibe jira <subcommand> [flags]",
  handler: async (_args) => {
    console.log(`\n${BOLD}cjvibe jira${RESET} — Jira integration\n`);
    console.log(`${BOLD}Subcommands:${RESET}`);
    for (const sub of jiraCommand.subcommands ?? []) {
      console.log(
        `  ${CYAN}${sub.name.padEnd(16)}${RESET}${DIM}${sub.description}${RESET}`,
      );
    }
    console.log("");
  },
  subcommands: [
    {
      name: "init",
      description: "Configure Jira credentials interactively",
      handler: handleInit,
    },
    {
      name: "status",
      description: "Show current config and test connectivity",
      handler: handleStatus,
    },
    {
      name: "boards",
      description: "List available boards",
      handler: handleBoards,
    },
    {
      name: "pull",
      description: "Fetch issues from a board  [--board=ID] [--all] [--dir=PATH]",
      handler: handlePull,
    },
    {
      name: "clean",
      description: "Remove issue files  [--board=ID] [--all] [--dry-run] [--dir=PATH]",
      handler: handleClean,
    },
    {
      name: "pull-comments",
      description: "Fetch issue comments  --issue=KEY [--board=ID] [--dir=PATH]",
      handler: handlePullComments,
    },
    {
      name: "push-comments",
      description: "Push new/edited comments  --issue=KEY [--board=ID] [--dry-run] [--dir=PATH]",
      handler: handlePushComments,
    },
    {
      name: "delete-comments",
      description: "Interactively delete one of your comments  --issue=KEY [--board=ID]",
      handler: handleDeleteComment,
    },
  ],
};
