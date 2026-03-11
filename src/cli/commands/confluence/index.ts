import type { Command, ParsedArgs } from "@/cli/router";
import { log } from "@/utils/logger";
import { configFilePath, loadConfig, patchConfig, requireSection } from "@/config";
import type { PageTreeNode } from "@/confluence/types";

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
      description: "Page tree  [--space=KEY] [--root=PAGE_ID] [--urls]",
      handler: handleTree,
    },
  ],
};
