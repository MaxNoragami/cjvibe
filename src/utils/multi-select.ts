/**
 * Multi-select checkbox picker — alternate screen buffer, no deps.
 *
 * Returns array of selected values, or null on Esc / Ctrl+C.
 */

const ESC   = "\x1b";
const RESET = "\x1b[0m";
const BOLD  = "\x1b[1m";
const DIM   = "\x1b[2m";
const INV   = "\x1b[7m";
const CYAN  = "\x1b[36m";
const GREEN = "\x1b[32m";

const moveTo = (row: number, col = 1) => `\x1b[${row};${col}H`;
const clrEos = "\x1b[0J";
const clrAll = "\x1b[2J";
const altOn  = "\x1b[?1049h";
const altOff = "\x1b[?1049l";
const curHide = "\x1b[?25l";
const curShow = "\x1b[?25h";

export interface MultiSelectItem<T> {
  label: string;
  value: T;
  checked?: boolean;
}

export interface MultiSelectOptions {
  pageSize?: number;
  title?: string;
}

export async function multiSelect<T>(
  items: MultiSelectItem<T>[],
  opts: MultiSelectOptions = {},
): Promise<T[] | null> {
  if (items.length === 0) return [];

  const stdout   = process.stdout;
  const stdin    = process.stdin;
  const termRows = stdout.rows ?? 24;
  const termCols = stdout.columns ?? 80;
  const PAGE     = Math.min(opts.pageSize ?? termRows - 6, items.length);
  const title    = opts.title ?? "Select items";

  const checked = new Set<number>();
  // Pre-check items
  for (let idx = 0; idx < items.length; idx++) {
    if (items[idx]!.checked) checked.add(idx);
  }

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
    buf.push(moveTo(1));
    buf.push(clrEos);
    buf.push(
      `${BOLD}${CYAN}${title}${RESET}  ` +
      `${DIM}↑↓ navigate · Space toggle · a all · n none · Enter confirm · Esc cancel${RESET}`,
    );
    buf.push("\n");

    if (scrollTop > 0) {
      buf.push(`  ${DIM}↑ ${scrollTop} more above${RESET}\n`);
    } else {
      buf.push("\n");
    }

    const visible = items.slice(scrollTop, scrollTop + PAGE);
    for (let i = 0; i < visible.length; i++) {
      const idx  = scrollTop + i;
      const item = visible[i]!;
      const check = checked.has(idx)
        ? `${GREEN}[✓]${RESET}`
        : `${DIM}[ ]${RESET}`;

      if (idx === cursor) {
        buf.push(`${INV} ${check} ${item.label.slice(0, termCols - 8)}${RESET}\n`);
      } else {
        buf.push(`  ${check} ${DIM}${item.label.slice(0, termCols - 8)}${RESET}\n`);
      }
    }

    const below = items.length - scrollTop - visible.length;
    if (below > 0) {
      buf.push(`  ${DIM}↓ ${below} more below${RESET}\n`);
    }

    buf.push(`\n${DIM}${checked.size}/${items.length} selected${RESET}`);
    stdout.write(buf.join(""));
  }

  stdout.write(altOn + curHide + clrAll);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  render();

  return new Promise<T[] | null>((resolve) => {
    function exit(value: T[] | null) {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      stdout.write(curShow + altOff);
      resolve(value);
    }

    function onData(key: string) {
      if (key === "\x03") { exit(null); process.exit(130); }
      if (key === ESC || key === "q" || key === "Q") { exit(null); return; }

      // Enter → confirm
      if (key === "\r" || key === "\n") {
        const result: T[] = [];
        for (let idx = 0; idx < items.length; idx++) {
          if (checked.has(idx)) result.push(items[idx]!.value);
        }
        exit(result);
        return;
      }

      // Space → toggle current
      if (key === " ") {
        if (checked.has(cursor)) checked.delete(cursor);
        else checked.add(cursor);
        render();
        return;
      }

      // 'a' → select all
      if (key === "a" || key === "A") {
        for (let idx = 0; idx < items.length; idx++) checked.add(idx);
        render();
        return;
      }

      // 'n' → deselect all
      if (key === "n" || key === "N") {
        checked.clear();
        render();
        return;
      }

      // Navigation
      if (key === "\x1b[A" || key === "k") { cursor--; clamp(); render(); return; }
      if (key === "\x1b[B" || key === "j") { cursor++; clamp(); render(); return; }
      if (key === "\x1b[5~") { cursor -= PAGE; clamp(); render(); return; }
      if (key === "\x1b[6~") { cursor += PAGE; clamp(); render(); return; }
      if (key === "\x1b[H")  { cursor = 0; clamp(); render(); return; }
      if (key === "\x1b[F")  { cursor = items.length - 1; clamp(); render(); return; }
    }

    stdin.on("data", onData);
  });
}
