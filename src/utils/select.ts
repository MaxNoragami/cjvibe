/**
 * Minimal interactive list picker — no external dependencies.
 *
 * Renders in the alternate screen buffer (like vim/fzf/less) so it never
 * pollutes terminal scrollback and arrow keys can't accidentally scroll the
 * terminal while the picker is active.
 *
 * Returns the selected item value, or null on Esc / q / Ctrl+C.
 */

// ── ANSI helpers ─────────────────────────────────────────────────────────────
const ESC   = "\x1b";
const RESET = "\x1b[0m";
const BOLD  = "\x1b[1m";
const DIM   = "\x1b[2m";
const INV   = "\x1b[7m"; // reverse video — highlight selected row
const CYAN  = "\x1b[36m";

/** Move cursor to row, col (1-based). */
const moveTo = (row: number, col = 1) => `\x1b[${row};${col}H`;
/** Clear from cursor to end of screen. */
const clrEos = "\x1b[0J";
/** Clear entire screen. */
const clrAll = "\x1b[2J";
/** Enter / exit alternate screen buffer. */
const altOn  = "\x1b[?1049h";
const altOff = "\x1b[?1049l";
/** Hide / show cursor. */
const curHide = "\x1b[?25l";
const curShow = "\x1b[?25h";

// ── Types ────────────────────────────────────────────────────────────────────
export interface SelectItem<T> {
  label: string;
  value: T;
}

export interface SelectOptions {
  /** How many list rows to show at once (default: terminal height − 4). */
  pageSize?: number;
  /** Prompt / title shown at the top. */
  title?: string;
}

// ── Core ─────────────────────────────────────────────────────────────────────
export async function select<T>(
  items: SelectItem<T>[],
  opts: SelectOptions = {},
): Promise<T | null> {
  if (items.length === 0) return null;

  const stdout    = process.stdout;
  const stdin     = process.stdin;
  const termRows  = stdout.rows  ?? 24;
  const termCols  = stdout.columns ?? 80;
  const PAGE      = Math.min(opts.pageSize ?? termRows - 4, items.length);
  const title     = opts.title ?? "Select an item";

  let cursor    = 0;
  let scrollTop = 0;

  function clamp() {
    if (cursor < 0) cursor = 0;
    if (cursor >= items.length) cursor = items.length - 1;
    if (cursor < scrollTop) scrollTop = cursor;
    if (cursor >= scrollTop + PAGE) scrollTop = cursor - PAGE + 1;
  }

  function render() {
    const buf: string[] = [];

    // ── header ──
    buf.push(moveTo(1));
    buf.push(clrAll);
    buf.push(`${BOLD}${CYAN}${title}${RESET}  ${DIM}↑↓ navigate · Enter select · Esc cancel${RESET}`);
    buf.push("\n");

    if (scrollTop > 0) {
      buf.push(`  ${DIM}↑ ${scrollTop} more above${RESET}\n`);
    } else {
      buf.push("\n"); // keep layout stable
    }

    // ── items ──
    const visible = items.slice(scrollTop, scrollTop + PAGE);
    for (let i = 0; i < visible.length; i++) {
      const idx  = scrollTop + i;
      const item = visible[i]!;
      if (idx === cursor) {
        buf.push(`${INV} › ${item.label.slice(0, termCols - 4)}${RESET}\n`);
      } else {
        buf.push(`   ${DIM}${item.label.slice(0, termCols - 4)}${RESET}\n`);
      }
    }

    const below = items.length - scrollTop - visible.length;
    if (below > 0) {
      buf.push(`  ${DIM}↓ ${below} more below${RESET}\n`);
    }

    stdout.write(buf.join(""));
  }

  // ── enter alternate screen ───────────────────────────────────────────────
  stdout.write(altOn + curHide + clrAll);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  render();

  return new Promise<T | null>((resolve) => {
    function exit(value: T | null) {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      // Leave alternate screen — terminal is exactly as it was before
      stdout.write(curShow + altOff);
      resolve(value);
    }

    function onData(key: string) {
      // Ctrl+C
      if (key === "\x03") {
        exit(null);
        process.exit(130);
      }
      // Esc / q
      if (key === ESC || key === "q" || key === "Q") {
        exit(null);
        return;
      }
      // Enter
      if (key === "\r" || key === "\n") {
        exit(items[cursor]!.value);
        return;
      }
      // Arrow up / k
      if (key === "\x1b[A" || key === "k") { cursor--; clamp(); render(); return; }
      // Arrow down / j
      if (key === "\x1b[B" || key === "j") { cursor++; clamp(); render(); return; }
      // Page up
      if (key === "\x1b[5~") { cursor -= PAGE; clamp(); render(); return; }
      // Page down
      if (key === "\x1b[6~") { cursor += PAGE; clamp(); render(); return; }
      // Home
      if (key === "\x1b[H") { cursor = 0; clamp(); render(); return; }
      // End
      if (key === "\x1b[F") { cursor = items.length - 1; clamp(); render(); return; }
    }

    stdin.on("data", onData);
  });
}

