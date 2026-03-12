import type { Command, ParsedArgs } from "@/cli/router";
import { log } from "@/utils/logger";
import { configFilePath, patchConfig, requireSection } from "@/config";
import type { JiraIssue, JiraComment, JiraWorklog } from "@/jira/types";

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
  lines.push(`epic: ${f.epic?.key ?? "None"}`);
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
async function handleInit(args: ParsedArgs): Promise<void> {
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

    const boardFlag = args.flags["board"];
    if (boardFlag) {
      // Non-interactive: --board=ID
      const id = Number(boardFlag);
      const match = boards.find((b) => b.id === id);
      if (!match) {
        log.error(`Board ${id} not found. Available: ${boards.map((b) => `${b.id} (${b.name})`).join(", ")}`);
        process.exit(1);
      }
      defaultBoardId = match.id;
      defaultBoardName = match.name;
      log.success(`Default board: ${defaultBoardName} (${defaultBoardId})\n`);
    } else {
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

// ---------------------------------------------------------------------------
// Push issues
// ---------------------------------------------------------------------------

interface FrontMatter {
  key: string;
  summary: string;
  type: string;
  status: string;
  priority: string;
  assignee: string;
  epic: string;
  labels: string;
  description: string;
}

/** Parse a .md issue file into front-matter fields + body */
function parseIssueMd(content: string): FrontMatter | null {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) return null;

  const [, header, body] = fmMatch as [string, string, string];
  const get = (key: string): string => {
    const m = header.match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
    return m?.[1]?.trim() ?? "";
  };

  // Body: strip the "# KEY: Summary" title line and "## Description" heading
  let desc = body.trim();
  // Remove title line
  desc = desc.replace(/^#\s+\S+:.*\n*/, "");
  // Remove ## Description heading
  desc = desc.replace(/^##\s+Description\s*\n*/, "");
  // Remove ## Subtasks and everything after
  desc = desc.replace(/\n##\s+Subtasks[\s\S]*$/, "");
  desc = desc.trim();

  return {
    key: get("key"),
    summary: get("summary"),
    type: get("type"),
    status: get("status"),
    priority: get("priority"),
    assignee: get("assignee"),
    epic: get("epic"),
    labels: get("labels"),
    description: desc,
  };
}

/** `cjvibe jira push` — push local issue changes back to Jira */
async function handlePushIssues(args: ParsedArgs): Promise<void> {
  const { join } = await import("node:path");
  const { readdir, readFile } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");
  const { createJiraClient } = await import("@/jira/client");

  const config = await requireSection("jira");
  const dryRun = Boolean(args.flags["dry-run"]);

  const boardId = args.flags["board"]
    ? Number(args.flags["board"])
    : config.defaultBoardId;

  if (!boardId) {
    log.error("No board specified. Use --board=ID or set a default.");
    process.exit(1);
  }

  const issuesDir = resolveIssuesDir(args);
  const boardDir = join(issuesDir, String(boardId));

  if (!existsSync(boardDir)) {
    log.error(`No issues directory found at ${boardDir}. Pull issues first.`);
    process.exit(1);
  }

  const client = await createJiraClient();
  let epicLinkFieldId: string | null | undefined;
  let boardEpics: { key: string; name?: string; summary?: string }[] | null = null;

  // Read all .md files in the board dir (not subdirs)
  const files = (await readdir(boardDir)).filter((f) => f.endsWith(".md"));
  if (files.length === 0) {
    log.info("No issue files found.");
    return;
  }

  let pushed = 0;
  let skipped = 0;
  let errors = 0;

  for (const file of files) {
    const filePath = join(boardDir, file);
    const content = await readFile(filePath, "utf-8");
    const local = parseIssueMd(content);
    if (!local || !local.key) {
      log.dim(`  ✗ ${file} — could not parse front-matter, skipping`);
      skipped++;
      continue;
    }

    // Fetch remote issue to diff
    let remote: import("@/jira/types").JiraIssue;
    try {
      remote = await client.getIssue(local.key);
    } catch (err) {
      const { toMessage } = await import("@/utils/errors");
      log.error(`  ✗ ${local.key}: ${toMessage(err)}`);
      errors++;
      continue;
    }

    const rf = remote.fields;
    const changes: string[] = [];
    const fields: Record<string, unknown> = {};

    // --- summary ---
    if (local.summary && local.summary !== rf.summary) {
      fields["summary"] = local.summary;
      changes.push(`summary: "${rf.summary}" → "${local.summary}"`);
    }

    // --- priority ---
    const remotePriority = rf.priority?.name ?? "None";
    if (local.priority && local.priority !== remotePriority) {
      fields["priority"] = { name: local.priority };
      changes.push(`priority: ${remotePriority} → ${local.priority}`);
    }

    // --- assignee ---
    const remoteAssignee = rf.assignee?.displayName ?? "Unassigned";
    if (local.assignee && local.assignee !== remoteAssignee) {
      if (local.assignee === "Unassigned") {
        fields["assignee"] = null;
        changes.push(`assignee: ${remoteAssignee} → Unassigned`);
      } else {
        // Resolve display name to user key
        try {
          const users = await client.findUsers(local.assignee);
          const match = users.find(
            (u) =>
              u.displayName.toLowerCase() === local.assignee.toLowerCase() ||
              u.name.toLowerCase() === local.assignee.toLowerCase(),
          );
          if (match) {
            fields["assignee"] = { name: match.name };
            changes.push(`assignee: ${remoteAssignee} → ${match.displayName}`);
          } else {
            log.warn(`  ⚠ ${local.key}: user "${local.assignee}" not found, skipping assignee change`);
          }
        } catch {
          log.warn(`  ⚠ ${local.key}: could not search users for "${local.assignee}"`);
        }
      }
    }

    // --- epic ---
    if (epicLinkFieldId === undefined) {
      try {
        epicLinkFieldId = await client.getEpicLinkFieldId(local.key);
      } catch {
        epicLinkFieldId = null;
      }
    }

    let remoteEpic = rf.epic?.key ?? "None";
    if (remoteEpic === "None" && epicLinkFieldId) {
      try {
        const rawEpic = await client.getIssueFieldValue(local.key, epicLinkFieldId);
        if (typeof rawEpic === "string" && rawEpic.trim()) {
          remoteEpic = rawEpic.trim();
        }
      } catch {
        // keep fallback value
      }
    }

    if (local.epic) {
      const requested = local.epic.trim();
      let desiredEpic = "None";

      if (requested !== "" && requested.toLowerCase() !== "none") {
        desiredEpic = requested;
        const looksLikeKey = /^[A-Z][A-Z0-9_]+-\d+$/.test(requested);

        if (!looksLikeKey) {
          if (!boardEpics) {
            try {
              boardEpics = await client.listBoardEpics(boardId);
            } catch {
              boardEpics = [];
            }
          }
          const match = boardEpics.find(
            (e) =>
              (e.name ?? "").toLowerCase() === requested.toLowerCase() ||
              (e.summary ?? "").toLowerCase() === requested.toLowerCase(),
          );
          if (match?.key) desiredEpic = match.key;
        }
      }

      const sameEpic = desiredEpic.toLowerCase() === remoteEpic.toLowerCase();
      if (!sameEpic) {
        if (!epicLinkFieldId) {
          log.warn(`  ⚠ ${local.key}: Epic Link field not available for this project/issue type`);
        } else {
          fields[epicLinkFieldId] = desiredEpic === "None" ? null : desiredEpic;
          changes.push(`epic: ${remoteEpic} → ${desiredEpic}`);
        }
      }
    }

    // --- labels ---
    const remoteLabels = rf.labels.join(", ");
    if (local.labels && local.labels !== remoteLabels) {
      const newLabels = local.labels.split(",").map((l) => l.trim()).filter(Boolean);
      fields["labels"] = newLabels;
      changes.push(`labels: [${remoteLabels}] → [${newLabels.join(", ")}]`);
    }

    // --- description ---
    const remoteDesc = (rf.description ?? "").trim();
    if (local.description && local.description !== remoteDesc) {
      fields["description"] = local.description;
      const preview = local.description.slice(0, 60).replace(/\n/g, " ");
      changes.push(`description: updated (${preview}…)`);
    }

    // --- status (via transition, not field edit) ---
    let statusChange: string | null = null;
    if (local.status && local.status !== rf.status.name) {
      statusChange = local.status;
    }

    if (changes.length === 0 && !statusChange) {
      skipped++;
      continue;
    }

    // Print what we're doing
    log.info(`${BOLD}${local.key}${RESET}:`);
    for (const c of changes) {
      log.dim(`  ${c}`);
    }
    if (statusChange) {
      log.dim(`  status: ${rf.status.name} → ${statusChange}`);
    }

    if (dryRun) {
      pushed++;
      continue;
    }

    // Push field changes
    if (Object.keys(fields).length > 0) {
      try {
        await client.updateIssue(local.key, fields);
      } catch (err) {
        const { toMessage } = await import("@/utils/errors");
        log.error(`  ✗ field update failed: ${toMessage(err)}`);
        errors++;
        continue;
      }
    }

    // Push status transition
    if (statusChange) {
      try {
        const result = await client.transitionIssue(local.key, statusChange);
        if (!result.ok) {
          const options = result.availableStatuses.length > 0
            ? ` Available now: ${result.availableStatuses.join(", ")}`
            : "";
          log.warn(`  ⚠ transition to "${statusChange}" not available.${options}`);
        }
      } catch (err) {
        const { toMessage } = await import("@/utils/errors");
        log.warn(`  ⚠ transition failed: ${toMessage(err)}`);
      }
    }

    pushed++;
    log.dim(`  ✓ updated`);
  }

  log.plain("");
  if (dryRun) {
    log.success(`Dry run: ${pushed} issue(s) would be updated, ${skipped} unchanged.`);
  } else {
    log.success(
      `Push complete: ${pushed} issue(s) updated, ${skipped} unchanged` +
        (errors > 0 ? `, ${errors} error(s)` : "") +
        ".",
    );
  }
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

  // Helper to build display entries
  const buildEntries = async () => {
    return Promise.all(
      ownComments.map(async (entry) => {
        let preview = "";
        const fp = join(commentsDir, entry.file);
        if (existsSync(fp)) {
          try {
            const raw = await readFile(fp, "utf-8");
            preview = parseCommentFile(raw).body.replace(/\s+/g, " ").trim();
          } catch { /* skip */ }
        }
        return { entry, preview };
      }),
    );
  };

  // --list: print your comments and exit (for LLMs / scripting)
  if (args.flags["list"]) {
    const entries = await buildEntries();
    for (const { entry, preview } of entries) {
      const avail = Math.max(termCols - 36, 10);
      const snippet = preview.length > avail ? preview.slice(0, avail - 1) + "\u2026" : preview;
      log.plain(`${entry.commentId.padEnd(10)}  ${formatShortDate(entry.updated).padEnd(14)}  ${snippet}`);
    }
    return;
  }

  // --id=COMMENT_ID,COMMENT_ID,...: delete directly without picker
  const idFlag = args.flags["id"];
  let chosen: CommentManifestEntry[] = [];

  if (idFlag) {
    const ids = String(idFlag).split(",").map((s) => s.trim()).filter(Boolean);
    for (const targetId of ids) {
      const match = ownComments.find((e) => e.commentId === targetId);
      if (!match) {
        log.error(`Comment ${targetId} not found among your comments. Use --list to see available.`);
        process.exit(1);
      }
      chosen.push(match);
    }
  } else {
    const entries = await buildEntries();

    const items = entries.map(({ entry, preview }) => {
      const idStr   = `#${entry.commentId}`;
      const dateStr = formatShortDate(entry.updated);
      const ID_W   = 12;
      const DATE_W = 14;
      const prefix = ID_W + DATE_W + 4;
      const avail  = Math.max(termCols - prefix, 10);
      const snippet = preview.length > avail ? preview.slice(0, avail - 1) + "\u2026" : preview;
      return {
        label: `${idStr.padEnd(ID_W)}${dateStr.padEnd(DATE_W)}  ${snippet}`,
        value: entry,
        checked: false,
      };
    });

    const { multiSelect } = await import("@/utils/multi-select");
    const selected = await multiSelect(items, {
      title: `Delete comments on ${issueKey}  (only your comments shown)`,
    });

    if (!selected || selected.length === 0) {
      log.dim("Cancelled.");
      return;
    }
    chosen = selected;
  }

  let deleted = 0;
  let errors = 0;

  for (const entry of chosen) {
    try {
      await client.deleteComment(issueKey, entry.commentId);
      const filePath = join(commentsDir, entry.file);
      if (existsSync(filePath)) await unlink(filePath);
      manifest.comments = manifest.comments.filter((e) => e.commentId !== entry.commentId);
      deleted++;
      log.dim(`  ✓ #${entry.commentId} deleted`);
    } catch (err) {
      errors++;
      const { toMessage } = await import("@/utils/errors");
      log.error(`  ✗ #${entry.commentId}: ${toMessage(err)}`);
    }
  }

  await saveCommentManifest(commentsDir, manifest);
  log.success(`Deleted ${deleted} comment(s)${errors > 0 ? `, ${errors} error(s)` : ""}.`);
}

// ---------------------------------------------------------------------------
// Worklog sync helpers
// ---------------------------------------------------------------------------

interface WorklogManifestEntry {
  worklogId: string;
  author: string;
  authorDisplay: string;
  started: string;
  timeSpent: string;
  timeSpentSeconds: number;
  updated: string;
  hash: string;
  file: string;
}

interface WorklogManifest {
  issueKey: string;
  lastSync: number;
  worklogs: WorklogManifestEntry[];
}

async function loadWorklogManifest(dir: string): Promise<WorklogManifest | null> {
  const { join } = await import("node:path");
  const { existsSync } = await import("node:fs");
  const { readFile } = await import("node:fs/promises");
  const p = join(dir, ".cjvibe-worklogs.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(await readFile(p, "utf-8")) as WorklogManifest;
  } catch {
    return null;
  }
}

async function saveWorklogManifest(dir: string, manifest: WorklogManifest): Promise<void> {
  const { join } = await import("node:path");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(dir, ".cjvibe-worklogs.json"), JSON.stringify(manifest, null, 2) + "\n", "utf-8");
}

function worklogToMarkdown(wl: JiraWorklog, issueKey: string): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push(`worklog_id: ${wl.id}`);
  lines.push(`issue: ${issueKey}`);
  lines.push(`author: ${wl.author.displayName}`);
  lines.push(`author_key: ${wl.author.name}`);
  lines.push(`started: ${wl.started}`);
  lines.push(`time_spent: ${wl.timeSpent}`);
  lines.push(`time_spent_seconds: ${wl.timeSpentSeconds}`);
  lines.push(`created: ${wl.created}`);
  lines.push(`updated: ${wl.updated}`);
  lines.push("---");
  lines.push("");
  if (wl.comment) lines.push(wl.comment);
  lines.push("");
  return lines.join("\n");
}

function parseWorklogFile(content: string): {
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

function worklogFilename(worklogId: string, authorKey: string, seq: number): string {
  const safe = authorKey.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${String(seq).padStart(3, "0")}_${safe}_${worklogId}.md`;
}

function formatTimeSpent(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  if (m > 0) return `${m}m`;
  return "0m";
}

// ---------------------------------------------------------------------------
// Worklog command handlers
// ---------------------------------------------------------------------------

/** `cjvibe jira pull-logs --issue=KEY` */
async function handlePullLogs(args: ParsedArgs): Promise<void> {
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
  const logsDir = join(issuesDir, String(boardId), "worklogs", issueKey);

  log.info(`Fetching worklogs for ${BOLD}${issueKey}${RESET}...`);
  const worklogs = await client.getWorklogs(issueKey);

  if (worklogs.length === 0) {
    log.success("No worklogs found.");
    return;
  }

  if (!existsSync(logsDir)) {
    await mkdir(logsDir, { recursive: true });
  }

  let manifest = await loadWorklogManifest(logsDir);
  if (!manifest) {
    manifest = { issueKey, lastSync: 0, worklogs: [] };
  }

  let pulled = 0;
  let updated = 0;
  let skipped = 0;

  for (let i = 0; i < worklogs.length; i++) {
    const wl = worklogs[i]!;
    const existing = manifest.worklogs.find((e) => e.worklogId === wl.id);
    const filename = existing?.file ?? worklogFilename(wl.id, wl.author.name, i + 1);

    const content = worklogToMarkdown(wl, issueKey);
    const hash = await hashContent(content);

    if (existing) {
      if (existing.updated === wl.updated) {
        skipped++;
        continue;
      }
      await writeFile(join(logsDir, filename), content, "utf-8");
      existing.updated = wl.updated;
      existing.started = wl.started;
      existing.timeSpent = wl.timeSpent;
      existing.timeSpentSeconds = wl.timeSpentSeconds;
      existing.hash = hash;
      updated++;
      log.dim(`  ↻ ${filename} (updated)`);
    } else {
      await writeFile(join(logsDir, filename), content, "utf-8");
      manifest.worklogs.push({
        worklogId: wl.id,
        author: wl.author.name,
        authorDisplay: wl.author.displayName,
        started: wl.started,
        timeSpent: wl.timeSpent,
        timeSpentSeconds: wl.timeSpentSeconds,
        updated: wl.updated,
        hash,
        file: filename,
      });
      pulled++;
      log.dim(`  ✓ ${filename}`);
    }
  }

  manifest.lastSync = Date.now();
  await saveWorklogManifest(logsDir, manifest);

  log.plain("");
  log.success(`Pull complete: ${pulled} new, ${updated} updated, ${skipped} unchanged.`);
  log.dim(`Files at: ${logsDir}`);
}

/** `cjvibe jira push-logs --issue=KEY` */
async function handlePushLogs(args: ParsedArgs): Promise<void> {
  const { join } = await import("node:path");
  const { readdir, readFile, writeFile, unlink } = await import("node:fs/promises");
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
  const logsDir = join(issuesDir, String(boardId), "worklogs", issueKey);

  if (!existsSync(logsDir)) {
    log.error(`No worklogs directory found at: ${logsDir}`);
    log.dim("Run `cjvibe jira pull-logs --issue=KEY` first, or create .md files manually.");
    process.exit(1);
  }

  let manifest = await loadWorklogManifest(logsDir);
  if (!manifest) {
    manifest = { issueKey, lastSync: 0, worklogs: [] };
  }

  let myUsername: string;
  try {
    const user = await client.myself();
    myUsername = user.name;
  } catch {
    log.error("Could not identify current user.");
    process.exit(1);
  }

  const files = (await readdir(logsDir)).filter((f) => f.endsWith(".md")).sort();

  let created = 0;
  let edited = 0;
  let skippedCount = 0;
  let errors = 0;

  for (const file of files) {
    const filePath = join(logsDir, file);
    const content = await readFile(filePath, "utf-8");
    const { meta, body } = parseWorklogFile(content);
    const worklogId = meta["worklog_id"];
    const timeSpent = meta["time_spent"];
    const started = meta["started"];
    const comment = body.trim();

    if (worklogId) {
      // Existing worklog — check if edited locally
      const entry = manifest.worklogs.find((e) => e.worklogId === worklogId);
      if (!entry) { skippedCount++; continue; }
      if (entry.author !== myUsername) { skippedCount++; continue; }

      const currentHash = await hashContent(content);
      if (currentHash === entry.hash) { skippedCount++; continue; }

      if (dryRun) {
        log.dim(`  would update: ${file}`);
        edited++;
        continue;
      }

      try {
        const updatedWl = await client.updateWorklog(
          issueKey,
          worklogId,
          timeSpent || entry.timeSpent,
          { ...(comment ? { comment } : {}), ...(started ? { started } : {}) },
        );
        entry.updated = updatedWl.updated;
        entry.timeSpent = updatedWl.timeSpent;
        entry.timeSpentSeconds = updatedWl.timeSpentSeconds;
        entry.started = updatedWl.started;
        entry.hash = await hashContent(content);
        edited++;
        log.dim(`  ↻ ${file} → updated`);
      } catch (err) {
        errors++;
        const { toMessage } = await import("@/utils/errors");
        log.error(`  ✗ ${file}: ${toMessage(err)}`);
      }
    } else {
      // New worklog — no worklog_id in front-matter
      if (!timeSpent) {
        log.error(`  ✗ ${file}: missing time_spent in front-matter (e.g. "2h 30m")`);
        errors++;
        continue;
      }

      if (dryRun) {
        log.dim(`  would create: ${file} (${timeSpent})`);
        created++;
        continue;
      }

      try {
        const newWl = await client.createWorklog(issueKey, timeSpent, {
          ...(comment ? { comment } : {}),
          ...(started ? { started } : {}),
        });

        const newContent = worklogToMarkdown(newWl, issueKey);
        const newFilename = worklogFilename(
          newWl.id,
          newWl.author.name,
          manifest.worklogs.length + 1,
        );
        await unlink(filePath);
        await writeFile(join(logsDir, newFilename), newContent, "utf-8");

        manifest.worklogs.push({
          worklogId: newWl.id,
          author: newWl.author.name,
          authorDisplay: newWl.author.displayName,
          started: newWl.started,
          timeSpent: newWl.timeSpent,
          timeSpentSeconds: newWl.timeSpentSeconds,
          updated: newWl.updated,
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
  await saveWorklogManifest(logsDir, manifest);

  log.plain("");
  if (dryRun) {
    log.warn(`Dry run — would create ${created}, update ${edited}.`);
  } else {
    log.success(`Push complete: ${created} created, ${edited} updated, ${skippedCount} unchanged, ${errors} error(s).`);
  }
}

/** `cjvibe jira delete-logs --issue=KEY` */
async function handleDeleteLogs(args: ParsedArgs): Promise<void> {
  const { join } = await import("node:path");
  const { readFile, unlink } = await import("node:fs/promises");
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
  const logsDir = join(issuesDir, String(boardId), "worklogs", issueKey);

  if (!existsSync(logsDir)) {
    log.error(`No worklogs directory found at: ${logsDir}`);
    log.dim(`Run \`cjvibe jira pull-logs --issue=${issueKey}\` first.`);
    process.exit(1);
  }

  const manifest = await loadWorklogManifest(logsDir);
  if (!manifest || manifest.worklogs.length === 0) {
    log.warn("No worklogs in local manifest.");
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

  const ownWorklogs = manifest.worklogs.filter((e) => e.author === myUsername);
  if (ownWorklogs.length === 0) {
    log.warn("No worklogs authored by you found locally.");
    return;
  }

  const termCols = process.stdout.columns ?? 80;

  const buildEntries = async () => {
    return Promise.all(
      ownWorklogs.map(async (entry) => {
        let preview = "";
        const fp = join(logsDir, entry.file);
        if (existsSync(fp)) {
          try {
            const raw = await readFile(fp, "utf-8");
            preview = parseWorklogFile(raw).body.replace(/\s+/g, " ").trim();
          } catch { /* skip */ }
        }
        return { entry, preview };
      }),
    );
  };

  // --list: print your worklogs and exit
  if (args.flags["list"]) {
    const entries = await buildEntries();
    for (const { entry, preview } of entries) {
      const avail = Math.max(termCols - 50, 10);
      const snippet = preview.length > avail ? preview.slice(0, avail - 1) + "\u2026" : preview;
      log.plain(
        `${entry.worklogId.padEnd(10)}  ${entry.timeSpent.padEnd(10)}  ${formatShortDate(entry.started).padEnd(14)}  ${snippet}`,
      );
    }
    return;
  }

  // --id=ID,...: delete directly
  const idFlag = args.flags["id"];
  let chosen: WorklogManifestEntry[] = [];

  if (idFlag) {
    const ids = String(idFlag).split(",").map((s) => s.trim()).filter(Boolean);
    for (const targetId of ids) {
      const match = ownWorklogs.find((e) => e.worklogId === targetId);
      if (!match) {
        log.error(`Worklog ${targetId} not found among your entries. Use --list to see available.`);
        process.exit(1);
      }
      chosen.push(match);
    }
  } else {
    const entries = await buildEntries();

    const items = entries.map(({ entry, preview }) => {
      const idStr   = `#${entry.worklogId}`;
      const timeStr = entry.timeSpent;
      const dateStr = formatShortDate(entry.started);
      const ID_W   = 12;
      const TIME_W = 10;
      const DATE_W = 14;
      const prefix = ID_W + TIME_W + DATE_W + 6;
      const avail  = Math.max(termCols - prefix, 10);
      const snippet = preview.length > avail ? preview.slice(0, avail - 1) + "\u2026" : preview;
      return {
        label: `${idStr.padEnd(ID_W)}${timeStr.padEnd(TIME_W)}${dateStr.padEnd(DATE_W)}  ${snippet}`,
        value: entry,
        checked: false,
      };
    });

    const { multiSelect } = await import("@/utils/multi-select");
    const selected = await multiSelect(items, {
      title: `Delete worklogs on ${issueKey}  (only your entries shown)`,
    });

    if (!selected || selected.length === 0) {
      log.dim("Cancelled.");
      return;
    }
    chosen = selected;
  }

  let deleted = 0;
  let delErrors = 0;

  for (const entry of chosen) {
    try {
      await client.deleteWorklog(issueKey, entry.worklogId);
      const filePath = join(logsDir, entry.file);
      if (existsSync(filePath)) await unlink(filePath);
      manifest.worklogs = manifest.worklogs.filter((e) => e.worklogId !== entry.worklogId);
      deleted++;
      log.dim(`  ✓ #${entry.worklogId} deleted`);
    } catch (err) {
      delErrors++;
      const { toMessage } = await import("@/utils/errors");
      log.error(`  ✗ #${entry.worklogId}: ${toMessage(err)}`);
    }
  }

  await saveWorklogManifest(logsDir, manifest);
  log.success(`Deleted ${deleted} worklog(s)${delErrors > 0 ? `, ${delErrors} error(s)` : ""}.`);
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
      description: "Configure Jira credentials  [--board=ID]",
      handler: handleInit,
    },
    {
      name: "status",
      description: "Show current config and test connectivity",
      handler: handleStatus,
    },
    {
      name: "ls",
      description: "List available boards",
      handler: handleBoards,
    },
    {
      name: "pull",
      description: "Fetch issues from a board  [--board=ID] [--all] [--dir=PATH]",
      handler: handlePull,
    },
    {
      name: "push",
      description: "Push local issue changes (incl. epic)  [--board=ID] [--dry-run] [--dir=PATH]",
      handler: handlePushIssues,
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
      description: "Delete your comments  --issue=KEY [--id=ID,...] [--list] [--board=ID]",
      handler: handleDeleteComment,
    },
    {
      name: "pull-logs",
      description: "Fetch worklogs  --issue=KEY [--board=ID] [--dir=PATH]",
      handler: handlePullLogs,
    },
    {
      name: "push-logs",
      description: "Push new/edited worklogs  --issue=KEY [--board=ID] [--dry-run] [--dir=PATH]",
      handler: handlePushLogs,
    },
    {
      name: "delete-logs",
      description: "Delete your worklogs  --issue=KEY [--id=ID,...] [--list] [--board=ID]",
      handler: handleDeleteLogs,
    },
  ],
};
