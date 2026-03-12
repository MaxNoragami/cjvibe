import type { Command, ParsedArgs } from "@/cli/router";
import { log } from "@/utils/logger";
import { configFilePath, patchConfig, requireSection } from "@/config";
import type { JiraIssue } from "@/jira/types";

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
        `  ${CYAN}${sub.name.padEnd(14)}${RESET}${DIM}${sub.description}${RESET}`,
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
  ],
};
