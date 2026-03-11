const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

const FG = {
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
} as const;

function fmt(color: string, prefix: string, msg: string): string {
  return `${color}${BOLD}${prefix}${RESET} ${msg}`;
}

export const log = {
  info: (msg: string) => console.log(fmt(FG.blue, "info", msg)),
  success: (msg: string) => console.log(fmt(FG.green, "ok", msg)),
  warn: (msg: string) => console.warn(fmt(FG.yellow, "warn", msg)),
  error: (msg: string) => console.error(fmt(FG.red, "error", msg)),
  debug: (msg: string) => {
    if (Bun.env["DEBUG"]) {
      console.log(fmt(FG.gray, "debug", msg));
    }
  },
  dim: (msg: string) => console.log(`${DIM}${msg}${RESET}`),
  plain: (msg: string) => console.log(msg),
  /** Print a section header */
  section: (title: string) =>
    console.log(`\n${BOLD}${FG.cyan}${title}${RESET}\n`),
};
