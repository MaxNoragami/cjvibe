# cjvibe

A fast CLI tool for syncing content between your local file system and self-hosted **Confluence** and **Jira** instances. Built with [Bun](https://bun.sh) and TypeScript.

- Pull Confluence pages as human-editable `.gcm` markup files, push changes back
- Pull Jira board issues, comments, and worklogs as `.md` files with YAML front-matter
- Interactive pickers **and** non-interactive flags (`--list`, `--id`) for scripting and LLM agents
- Lossless round-trip via the **GCM** format — edit freely, never lose structure

---

## Table of Contents

- [Installation](#installation)
- [Updating](#updating)
- [Uninstalling](#uninstalling)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Confluence](#confluence)
  - [confluence init](#confluence-init)
  - [confluence status](#confluence-status)
  - [confluence ls](#confluence-ls)
  - [confluence pages](#confluence-pages)
  - [confluence tree](#confluence-tree)
  - [confluence pull](#confluence-pull)
  - [confluence push](#confluence-push)
  - [confluence restore](#confluence-restore)
- [Jira](#jira)
  - [jira init](#jira-init)
  - [jira status](#jira-status)
  - [jira ls](#jira-ls)
  - [jira pull](#jira-pull)
  - [jira push](#jira-push)
  - [jira clean](#jira-clean)
  - [jira pull-comments](#jira-pull-comments)
  - [jira push-comments](#jira-push-comments)
  - [jira delete-comments](#jira-delete-comments)
  - [jira pull-logs](#jira-pull-logs)
  - [jira push-logs](#jira-push-logs)
  - [jira delete-logs](#jira-delete-logs)
- [GCM Format Specification](#gcm-format-specification)
- [File Structure](#file-structure)
- [LLM / Scripting Usage](#llm--scripting-usage)

---

## Installation

### One-liner (Linux / macOS)

```bash
curl -fsSL https://raw.githubusercontent.com/MaxNoragami/cjvibe/main/install.sh | bash
```

This downloads the latest release binary for your OS and architecture to `~/.local/bin/cjvibe` and adds it to your `PATH`.

You can override the install directory:

```bash
CJVIBE_INSTALL_DIR=/usr/local/bin curl -fsSL ... | bash
```

### Updating

Once installed, update to the latest release with a single command:

```bash
cjvibe update
```

This checks GitHub for the latest release, downloads the new binary, and atomically replaces the current one in place. No need to re-run the install script.

### Uninstalling

```bash
rm ~/.local/bin/cjvibe
```

Then remove the PATH line that the installer added to your shell rc (`~/.bashrc`, `~/.zshrc`, or `~/.config/fish/config.fish`):

```bash
# The line looks like:
export PATH="$HOME/.local/bin:$PATH"  # bash/zsh
fish_add_path $HOME/.local/bin        # fish
```

### Manual download

Grab a binary from the [Releases](https://github.com/MaxNoragami/cjvibe/releases) page:

| Binary | OS | Arch |
|---|---|---|
| `cjvibe-linux-x64` | Linux | x86_64 |
| `cjvibe-linux-arm64` | Linux | ARM64 |
| `cjvibe-darwin-x64` | macOS | Intel |
| `cjvibe-darwin-arm64` | macOS | Apple Silicon |

```bash
chmod +x cjvibe-linux-x64
mv cjvibe-linux-x64 ~/.local/bin/cjvibe
```

### From source

Requires [Bun](https://bun.sh) ≥ 1.0.

```bash
git clone https://github.com/MaxNoragami/cjvibe.git
cd cjvibe
bun install
bun run build        # compiles to ./dist/cjvibe
# or run directly:
bun run dev          # runs bin/cjvibe.ts with bun
```

---

## Quick Start

```bash
# 1. Set up Confluence
cjvibe confluence init

# 2. Browse the page tree
cjvibe confluence tree

# 3. Pull pages to local .gcm files
cjvibe confluence pull --select

# 4. Edit a .gcm file in your editor, then push
cjvibe confluence push

# 5. Set up Jira
cjvibe jira init

# 6. Pull board issues
cjvibe jira pull
```

---

## Configuration

Config is stored at `~/.config/cjvibe/config.json`. You can edit it manually or run the interactive `init` commands.

```jsonc
{
  "confluence": {
    "baseUrl": "https://wiki.example.com",
    "username": "john.doe",
    "token": "YOUR_PERSONAL_ACCESS_TOKEN",
    "authMethod": "bearer",           // "bearer" (default for Server/DC) or "basic"
    "defaultSpace": "PROJ",           // optional — default space key
    "rootPageId": "12345678",         // optional — root page for tree/pull
    "jiraServer": "Jira",             // optional — Jira macro server name
    "jiraServerId": "abc-def-123"     // optional — Jira macro server ID
  },
  "jira": {
    "baseUrl": "https://jira.example.com",
    "username": "john.doe",
    "token": "YOUR_PERSONAL_ACCESS_TOKEN",
    "authMethod": "bearer",
    "defaultBoardId": 78,             // optional — default board
    "defaultBoardName": "My Board"    // optional — display name
  }
}
```

**Authentication**: Both Confluence and Jira use Personal Access Tokens (PATs) by default (`bearer`). For Confluence Cloud / Jira Cloud, switch to `basic` where `token` is your API token.

---

## Confluence

```
cjvibe confluence <subcommand> [options]
```

### confluence init

Configure Confluence credentials interactively, or pass flags for non-interactive setup.

```bash
# Interactive — prompts for URL, username, token, then picks space and root page
cjvibe confluence init

# Non-interactive — supply everything via flags
cjvibe confluence init --space=PROJ --root-page=12345678
```

| Flag | Description |
|---|---|
| `--space=KEY` | Set the default space key directly (skips interactive picker) |
| `--root-page=ID` | Set the root page ID directly (skips interactive picker) |

During interactive init, you'll pick a space from a scrollable list, then optionally pick a root page from the page tree.

---

### confluence status

Show current Confluence configuration and test connectivity.

```bash
cjvibe confluence status
```

Output example:

```
Confluence configuration:
  Base URL : https://wiki.example.com
  Username : john.doe
  Auth     : bearer
  Space    : PROJ
  Root page: 12345678

Testing connection... ✔ Authenticated as John Doe
```

---

### confluence ls

List all accessible Confluence spaces.

```bash
cjvibe confluence ls
cjvibe confluence ls --limit=50
```

| Flag | Description |
|---|---|
| `--limit=N` | Maximum spaces to return (default: server default) |

---

### confluence pages

Flat list of all pages in a space (no hierarchy).

```bash
cjvibe confluence pages
cjvibe confluence pages --space=PROJ
```

| Flag | Description |
|---|---|
| `--space=KEY` | Space key (defaults to configured `defaultSpace`) |

---

### confluence tree

Display the page hierarchy as a colored tree with indentation.

```bash
cjvibe confluence tree
cjvibe confluence tree --space=PROJ --root=42634112 --urls
```

| Flag | Description |
|---|---|
| `--space=KEY` | Space key |
| `--root=ID` | Start tree from this page ID (defaults to configured `rootPageId`) |
| `--urls` | Show the full page URL next to each title |

Output example:

```
04 - GMS -Greenhouse Management System
├── WP1 Project Initiation
│   ├── WP1.1 Problem Definition
│   ├── WP1.2 Feasibility Study
│   └── WP1.3 Requirements
├── WP2 Design
│   ├── WP2.1 Architecture
│   └── WP2.2 Database Design
└── WP3 Implementation
```

---

### confluence pull

Pull Confluence pages as `.gcm` files into `./cjdata/pages/<SPACE>/`.

```bash
# Interactive multi-select picker
cjvibe confluence pull --select

# Pull specific pages by ID
cjvibe confluence pull --pages=42634112,42634200

# Pull all pages under the root
cjvibe confluence pull --all

# Force re-download (ignore local changes)
cjvibe confluence pull --force

# List available pages (useful for LLMs/scripts)
cjvibe confluence pull --list
```

| Flag | Description |
|---|---|
| `--select` | Open interactive multi-select picker |
| `--pages=ID,...` | Pull specific page IDs (comma-separated) |
| `--all` | Pull every page under the root page |
| `--list` | Print available pages as a list and exit (no pull) |
| `--force` | Overwrite local files even if they have changes |
| `--space=KEY` | Space key override |
| `--dir=PATH` | Custom output directory |

Each pulled page becomes a `.gcm` file with front-matter:

```
--- gcm ---
title: WP1.1 Problem Definition
page_id: 42634112
version: 65
---

= Problem Definition

This section describes...
```

A `.cjvibe-manifest.json` tracks sync state (page IDs, versions, content hashes).

---

### confluence push

Push modified `.gcm` files back to Confluence. Only files with local changes (detected by content hash) are pushed.

```bash
# Push all changed files
cjvibe confluence push

# Push a specific file
cjvibe confluence push --file="WP1.1_Problem_Definition.gcm"

# Dry run — show what would be pushed without actually pushing
cjvibe confluence push --dry-run
```

| Flag | Description |
|---|---|
| `--file=NAME` | Push only this `.gcm` file |
| `--dry-run` | Show changes without pushing |
| `--space=KEY` | Space key override |
| `--dir=PATH` | Custom pages directory |

Push increments the page version and updates the manifest. Watchers are **not** notified (`?notifyWatchers=false`).

---

### confluence restore

Restore a Confluence page to a previous version.

```bash
# Interactive — pick a page, then pick a version from the history
cjvibe confluence restore

# Restore to the previous version (git-style)
cjvibe confluence restore HEAD~1

# Restore to 3 versions back
cjvibe confluence restore HEAD~3

# Restore to a specific version number
cjvibe confluence restore --version=62

# Specify the page by file or ID
cjvibe confluence restore --file="WP1.1_Problem_Definition.gcm" --version=60
cjvibe confluence restore --id=42634112 --version=60

# List available versions for a page (useful for LLMs/scripts)
cjvibe confluence restore --list --file="WP1.1_Problem_Definition.gcm"
```

| Flag | Description |
|---|---|
| `HEAD~N` | Positional — restore N versions back from current |
| `--version=N` | Restore to exact version number |
| `--file=NAME` | Target page by `.gcm` filename |
| `--id=PAGE_ID` | Target page by Confluence page ID |
| `--list` | Show version history and exit |
| `--space=KEY` | Space key override |

---

## Jira

```
cjvibe jira <subcommand> [options]
```

### jira init

Configure Jira credentials and default board.

```bash
# Interactive — prompts for URL, username, token, then picks a board
cjvibe jira init

# Non-interactive — supply board ID directly
cjvibe jira init --board=78
```

| Flag | Description |
|---|---|
| `--board=ID` | Set the default board ID directly (skips interactive picker) |

---

### jira status

Show current Jira configuration and test connectivity.

```bash
cjvibe jira status
```

---

### jira ls

List all available Jira boards.

```bash
cjvibe jira ls
```

Output: board ID, name, and type for each board.

---

### jira pull

Fetch all issues from a board as `.md` files into `./cjdata/issues/<boardId>/`.

```bash
cjvibe jira pull
cjvibe jira pull --board=78
cjvibe jira pull --all
```

| Flag | Description |
|---|---|
| `--board=ID` | Board ID override |
| `--all` | Pull all issues (not just current sprint) |
| `--dir=PATH` | Custom output directory |

Each issue file has YAML front-matter:

```markdown
---
key: GMS-20
id: 29176
summary: Auto-refresh dashboard during rapid condition changes
type: Job Story
status: Proposed
priority: Highest
assignee: John Doe
reporter: Jane Smith
project: GMS
epic: GMS-1
related_issues: GMS-23, GMS-33
created: 2026-03-05T12:33:52.000+0100
updated: 2026-03-12T00:47:25.000+0100
url: http://jira.example.com/browse/GMS-20
---

(issue description body in markdown)
```

---

### jira push

Push local issue changes back to Jira. Detected by diffing the local `.md` front-matter against the live remote issue — only changed fields are sent.

```bash
cjvibe jira push
cjvibe jira push --board=78
cjvibe jira push --dry-run
```

| Flag | Description |
|---|---|
| `--board=ID` | Board ID override |
| `--dry-run` | Show what would change without pushing |
| `--dir=PATH` | Custom directory |

**Editable fields:**

| Front-matter field | Behaviour |
|---|---|
| `summary` | Updated directly |
| `priority` | Matched by name (`Highest`, `High`, `Medium`, `Low`, `Lowest`) |
| `assignee` | Resolved from display name via user search; set to `Unassigned` to clear |
| `epic` | Assign by Epic key (`PROJ-123`) or by exact epic name/summary on the board; set to `None` to clear |
| `related_issues` | Comma-separated issue keys (e.g. `GMS-23, GMS-33`). `None` clears all related links |
| `labels` | Comma-separated list, replaces all existing labels |
| `description` | Body text under the `## Description` section |
| `status` | Applied via Jira workflow transition by target status name. Works only if that status is directly reachable from the current state |

Epic comparisons are key-based (`GMS-123`) after resolution, so unchanged epics are not re-pushed on subsequent `jira push` runs.

**Read-only fields** (changes are ignored): `key`, `id`, `type`, `reporter`, `project`, `created`, `updated`, `url`, `parent`, subtasks.

Example — change summary and reassign:

```markdown
---
key: GMS-20
summary: Dashboard auto-refresh with staleness warning   # edited
assignee: Jane Smith                                      # edited
epic: GMS-1                                               # edited (or None)
status: In Progress                                       # triggers transition
...
---
```

```bash
cjvibe jira push
# GMS-20:
#   summary: "Dashboard auto-refresh..." → "Dashboard auto-refresh with staleness warning"
#   assignee: Adrian Vremere → Jane Smith
#   status: Proposed → In Progress
#   ✓ updated
```

---

### jira clean

Remove local issue files.

```bash
cjvibe jira clean
cjvibe jira clean --all --dry-run
```

| Flag | Description |
|---|---|
| `--all` | Clean all boards |
| `--dry-run` | Show what would be deleted without deleting |
| `--board=ID` | Board ID override |
| `--dir=PATH` | Custom directory |

---

### jira pull-comments

Fetch comments for a specific issue.

```bash
cjvibe jira pull-comments --issue=GMS-20
cjvibe jira pull-comments --issue=GMS-20 --board=78
```

| Flag | Description |
|---|---|
| `--issue=KEY` | **Required.** The issue key (e.g. `GMS-20`) |
| `--board=ID` | Board ID override |
| `--dir=PATH` | Custom directory |

Comments are saved to `./cjdata/issues/<boardId>/comments/<KEY>/` as numbered `.md` files:

```
001_john.doe_12345.md
002_jane.smith_12346.md
```

Each comment file:

```markdown
---
comment_id: 12345
issue: GMS-20
author: John Doe
author_key: john.doe
created: 2026-03-11T22:59:16.000+0100
updated: 2026-03-11T22:59:16.000+0100
---

The actual comment body text goes here.
```

A `.cjvibe-comments.json` manifest tracks synced comment IDs and hashes.

---

### jira push-comments

Push new or edited comments back to Jira.

```bash
cjvibe jira push-comments --issue=GMS-20
cjvibe jira push-comments --issue=GMS-20 --dry-run
```

| Flag | Description |
|---|---|
| `--issue=KEY` | **Required.** The issue key |
| `--board=ID` | Board ID override |
| `--dry-run` | Show what would be pushed without pushing |
| `--dir=PATH` | Custom directory |

**Creating a new comment**: Create a `.md` file in the comments directory with `comment_id: 0` (or omit it) and cjvibe will create it on push:

```markdown
---
comment_id: 0
issue: GMS-20
---

This is my new comment.
```

**Editing a comment**: Modify the body of an existing comment file and push. Only your own comments can be updated.

---

### jira delete-comments

Delete your comments from an issue.

```bash
# Interactive multi-select picker
cjvibe jira delete-comments --issue=GMS-20

# Delete by specific comment IDs
cjvibe jira delete-comments --issue=GMS-20 --id=12345,12346

# List deletable comments (for LLMs/scripts)
cjvibe jira delete-comments --issue=GMS-20 --list
```

| Flag | Description |
|---|---|
| `--issue=KEY` | **Required.** The issue key |
| `--id=ID,...` | Delete specific comment IDs (comma-separated) |
| `--list` | List your deletable comments and exit |
| `--board=ID` | Board ID override |

Only comments authored by you can be deleted.

---

### jira pull-logs

Fetch worklogs for a specific issue.

```bash
cjvibe jira pull-logs --issue=GMS-20
cjvibe jira pull-logs --issue=GMS-20 --board=78
```

| Flag | Description |
|---|---|
| `--issue=KEY` | **Required.** The issue key |
| `--board=ID` | Board ID override |
| `--dir=PATH` | Custom directory |

Worklogs are saved to `./cjdata/issues/<boardId>/worklogs/<KEY>/` as`.md` files:

```markdown
---
worklog_id: 5678
issue: GMS-20
time_spent: 2h
started: 2026-03-10T09:00:00.000+0100
author: John Doe
author_key: john.doe
---

Worked on dashboard refresh implementation.
```

A `.cjvibe-worklogs.json` manifest tracks synced worklog IDs and hashes.

---

### jira push-logs

Push new or edited worklogs back to Jira.

```bash
cjvibe jira push-logs --issue=GMS-20
cjvibe jira push-logs --issue=GMS-20 --dry-run
```

| Flag | Description |
|---|---|
| `--issue=KEY` | **Required.** The issue key |
| `--board=ID` | Board ID override |
| `--dry-run` | Show what would be pushed without pushing |
| `--dir=PATH` | Custom directory |

**Creating a new worklog**: Create a `.md` file with `worklog_id: 0` (or omit it):

```markdown
---
worklog_id: 0
issue: GMS-20
time_spent: 1h 30m
started: 2026-03-15T10:00:00.000+0100
---

Implemented sensor data caching.
```

**Time format**: Jira shorthand — `1h`, `2h 30m`, `1d`, `3d 4h`, etc.

---

### jira delete-logs

Delete your worklogs from an issue.

```bash
# Interactive multi-select picker
cjvibe jira delete-logs --issue=GMS-20

# Delete by specific worklog IDs
cjvibe jira delete-logs --issue=GMS-20 --id=5678,5679

# List deletable worklogs (for LLMs/scripts)
cjvibe jira delete-logs --issue=GMS-20 --list
```

| Flag | Description |
|---|---|
| `--issue=KEY` | **Required.** The issue key |
| `--id=ID,...` | Delete specific worklog IDs (comma-separated) |
| `--list` | List your deletable worklogs and exit |
| `--board=ID` | Board ID override |

---

## GCM Format Specification

**GCM** (GMS Confluence Markup) is a human-readable, line-oriented markup designed for lossless round-tripping with Confluence storage format. Every Confluence element maps to exactly one GCM construct — edit text freely, never lose structure.

### Document Envelope

Every `.gcm` file starts with front-matter:

```
--- gcm ---
title: My Page Title
page_id: 42634112
version: 65
---
```

### Headings

```
= Heading 1
== Heading 2
=== Heading 3
==== Heading 4
===== Heading 5
====== Heading 6
```

### Paragraphs

Plain text lines. Blank lines separate paragraphs.

### Horizontal Rule

```
----
```

### Blockquote

```
> Quoted paragraph text.
> Second line of same quote.
```

### Lists

**Unordered** (use `-` only, not `*` to avoid italic ambiguity):

```
- Item one
- Item two
  - Nested item
```

**Ordered**:

```
1. First
2. Second
  1. Sub-item
```

**Escaped list markers** (when a paragraph starts with a list-like pattern):

```
\- This is NOT a list item
\1. Neither is this
```

### Tables

Full merged-cell support with tag-style syntax:

```
{table width=54.0761%}
{thead}
{tr}
{th}Header 1{/th}
{th}Header 2{/th}
{th}Header 3{/th}
{/tr}
{/thead}
{tr}
{td rowspan=3}Spans 3 rows{/td}
{td}Normal cell{/td}
{td}Normal cell{/td}
{/tr}
{tr}
{td colspan=2}Spans 2 columns{/td}
{/tr}
{tr}
{td}Cell{/td}
{td}Cell{/td}
{/tr}
{/table}
```

Features:
- Supports `rowspan`, `colspan`, `style`, `class`, `scope`
- `{colgroup}` / `{col style=...}` preserved verbatim
- Cell content supports inline GCM (bold, links, etc.)
- Each `{td}...{/td}` can span multiple lines
- Headings inside cells use standard heading markers (`= H1`, `== H2`)
- Lists inside cells use `{ul}...{/ul}` or `{ol}...{/ol}` wrappers

### Code Blocks

```
{code lang=python}
def hello():
    print("world")
{/code}
```

### Inline Formatting

```
**bold text**
*italic text*
~~strikethrough~~
`inline code`
```

### Links

```
[display text](http://example.com)                          External link
{link page="Page Title"}display text{/link}                 Confluence page link
{link anchor=ref4}display text{/link}                       Anchor link
```

### Images

```
{image file="diagram.png" height=400 align=center}          Attached image
{image url="http://example.com/img.png" height=150}          External image
```

### Confluence Macros

**Jira issue** (most common macro):

```
{jira:GMS-10}
{jira:GMS-10|nosummary}
```

**Anchor**:

```
{anchor:ref4}
```

**Status badge**:

```
{status:Draft|color=Yellow}
```

**Layout**:

```
{layout}
{layout-section type=single}
{layout-cell}
Content here
{/layout-cell}
{/layout-section}
{/layout}
```

### Other Inline Elements

```
{user:ff8081819b134c58019c0a81410c0005}     User mention
{br}                                         Line break
H{sub}2{/sub}O                              Subscript
x{sup}2{/sup}                               Superscript
```

### Div / Span

```
{div class=content-wrapper}
  paragraph content
{/div}
```

### Raw Passthrough

Anything not natively supported is preserved verbatim:

```
{raw}
<ac:structured-macro ac:name="other-macro">
  <ac:parameter ac:name="foo">bar</ac:parameter>
</ac:structured-macro>
{/raw}
```

Block-level or inline — `{raw}...{/raw}` is the safety net. Content inside is never parsed or modified; it's pushed back byte-for-byte.

### Escaping

| Escape | Result | Purpose |
|---|---|---|
| `\{` | `{` | Prevents tag interpretation |
| `\*` | `*` | Prevents bold/italic |
| `\-` | `-` at line start | Prevents list interpretation |
| `\1.` | `1.` at line start | Prevents ordered list |
| `\[`, `\]` | `[`, `]` | Prevents link interpretation |
| `\~` | `~` | Prevents strikethrough |
| `` \` `` | `` ` `` | Prevents inline code |

### Design Principles

1. **One-to-one mapping** — every Confluence construct maps to exactly one GCM construct
2. **Lossless round-trip** — HTML → GCM → HTML produces semantically identical output
3. **Human-editable** — common elements look natural; exotic ones use readable `{tag}` syntax
4. **Diff-friendly** — line-oriented, deterministic formatting
5. **`{raw}` safety net** — anything unrecognized is captured verbatim

---

## File Structure

After pulling content, your workspace will look like this:

```
your-project/
├── cjdata/
│   ├── pages/
│   │   └── PROJ/                          # One folder per Confluence space
│   │       ├── .cjvibe-manifest.json      # Sync manifest (page IDs, versions, hashes)
│   │       ├── Page_Title.gcm             # Pulled Confluence pages
│   │       └── Another_Page.gcm
│   └── issues/
│       └── 78/                            # One folder per Jira board ID
│           ├── GMS-1.md                   # Issue files
│           ├── GMS-2.md
│           ├── comments/
│           │   └── GMS-20/                # Comments grouped by issue key
│           │       ├── .cjvibe-comments.json
│           │       ├── 001_john.doe_12345.md
│           │       └── 002_jane.smith_12346.md
│           └── worklogs/
│               └── GMS-20/               # Worklogs grouped by issue key
│                   ├── .cjvibe-worklogs.json
│                   ├── 001_john.doe_5678.md
│                   └── 002_john.doe_5679.md
```

### Manifests

- **`.cjvibe-manifest.json`** — tracks pulled Confluence pages (page ID, title, version, content hash, filename)
- **`.cjvibe-comments.json`** — tracks pulled Jira comments per issue (comment ID, content hash)
- **`.cjvibe-worklogs.json`** — tracks pulled Jira worklogs per issue (worklog ID, content hash)

These manifests enable change detection: on push, only files whose content hash differs from the manifest are uploaded.

---

## LLM / Scripting Usage

Every interactive command has non-interactive alternatives so cjvibe can be driven by scripts or LLM agents without a TTY.

### Pattern: List then Act

Use `--list` to discover available items, then use `--id`, `--pages`, `--version`, `--board`, etc. to act directly:

```bash
# Step 1: List available pages
cjvibe confluence pull --list
# Output:
#   42634112  WP1.1 Problem Definition
#   42634200  WP1.2 Feasibility Study
#   ...

# Step 2: Pull specific pages by ID
cjvibe confluence pull --pages=42634112,42634200
```

```bash
# Step 1: List version history
cjvibe confluence restore --list --file="WP1.1_Problem_Definition.gcm"
# Output:
#   v65  2026-03-12  John Doe  "Updated requirements"
#   v64  2026-03-11  Jane Smith  "Added diagram"
#   ...

# Step 2: Restore to a specific version
cjvibe confluence restore --version=64 --file="WP1.1_Problem_Definition.gcm"
```

```bash
# Step 1: List deletable comments
cjvibe jira delete-comments --issue=GMS-20 --list

# Step 2: Delete by ID
cjvibe jira delete-comments --issue=GMS-20 --id=12345,12346
```

### Non-interactive Init

```bash
cjvibe confluence init --space=PROJ --root-page=42634112
cjvibe jira init --board=78
```

### Summary of Non-interactive Flags

| Command | Flag | Purpose |
|---|---|---|
| `confluence init` | `--space=KEY`, `--root-page=ID` | Skip space/page pickers |
| `confluence pull` | `--list` | List pages |
| `confluence pull` | `--pages=ID,...` | Pull specific pages |
| `confluence pull` | `--all` | Pull everything |
| `confluence restore` | `--list` | List version history |
| `confluence restore` | `--version=N` | Restore specific version |
| `confluence restore` | `HEAD~N` | Restore N versions back |
| `jira init` | `--board=ID` | Skip board picker |
| `jira push` | `--dry-run` | Preview changes without pushing |
| `jira delete-comments` | `--list` | List deletable comments |
| `jira delete-comments` | `--id=ID,...` | Delete by comment ID |
| `jira delete-logs` | `--list` | List deletable worklogs |
| `jira delete-logs` | `--id=ID,...` | Delete by worklog ID |

---

## Acknowledgments

Inspired by and built upon the work of [mcittkmims](https://github.com/mcittkmims) in the [greenhouse](https://github.com/mcittkmims/greenhouse) project. The **GCM (GMS Confluence Markup)** format and the Confluence round-trip architecture originate from that project — kudos for the elegant design.

---

## License

[MIT](LICENSE) — Copyright © 2026 MaxNoragami
