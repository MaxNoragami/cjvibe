import type { Command, ParsedArgs } from "@/cli/router";
import { log } from "@/utils/logger";
import { configFilePath, loadConfig, patchConfig, requireSection } from "@/config";
import type { PageTreeNode } from "@/confluence/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function printTree(nodes: PageTreeNode[], indent = 0): void {
  const CYAN = "\x1b[36m";
  const DIM = "\x1b[2m";
  const RESET = "\x1b[0m";
  const prefix = "  ".repeat(indent);
  for (const node of nodes) {
    const connector = indent === 0 ? "" : "└─ ";
    log.plain(`${prefix}${connector}${CYAN}[${node.id}]${RESET} v${node.version} — ${node.title}`);
    log.dim(`${prefix}  ${DIM}${node.webUrl}${RESET}`);
    if (node.children.length > 0) {
      printTree(node.children, indent + 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Subcommand handlers
// ---------------------------------------------------------------------------

/** `cjvibe confluence init` — interactively configure Confluence credentials */
async function handleInit(_args: ParsedArgs): Promise<void> {
  log.section("Confluence Setup");
  log.info("This wizard will save your Confluence credentials to:");
  log.dim(configFilePath());
  log.plain("");

  const baseUrl = prompt("Confluence base URL (e.g. https://wiki.example.com):")?.trim();
  const username = prompt("Username / email:")?.trim();
  const token = prompt("Personal access token (PAT):")?.trim();
  const authMethodRaw = prompt(
    "Auth method — (1) bearer [default, self-hosted PAT]  (2) basic [Cloud API token]:",
  )?.trim();
  const defaultSpace = prompt("Default space key (optional, press Enter to skip):")?.trim();
  const rootPageId = prompt(
    "Root page ID for tree/sync (optional — find it in the page URL as ?pageId=XXXXX):",
  )?.trim();

  if (!baseUrl || !username || !token) {
    log.error("Base URL, username, and token are all required.");
    process.exit(1);
  }

  const authMethod =
    authMethodRaw === "2" || authMethodRaw === "basic" ? "basic" : "bearer";

  await patchConfig({
    confluence: {
      baseUrl,
      username,
      token,
      authMethod,
      ...(defaultSpace ? { defaultSpace } : {}),
      ...(rootPageId ? { rootPageId } : {}),
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

  const rootLabel = rootPageId ? `page ${rootPageId}` : `space root`;
  log.plain(`Building page tree for "${spaceKey}" from ${rootLabel}...`);

  const tree = await client.getPageTree(spaceKey, rootPageId);

  if (tree.length === 0) {
    log.warn("No pages found.");
    return;
  }

  log.section(`Page tree — ${spaceKey}${rootPageId ? ` (root: ${rootPageId})` : ""}`);
  printTree(tree);
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
      description: "Configure Confluence credentials interactively",
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
      description: "Page tree  [--space=KEY] [--root=PAGE_ID]",
      handler: handleTree,
    },
  ],
};
