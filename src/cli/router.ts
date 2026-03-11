// ---------------------------------------------------------------------------
// Minimal CLI argument parser — no external dependencies
// ---------------------------------------------------------------------------

export interface ParsedArgs {
  /** Positional tokens (command, subcommand, operands) */
  positionals: string[];
  /** Parsed flags: --flag=value → { flag: "value" }, --bool → { bool: true } */
  flags: Record<string, string | boolean>;
  /** Raw argv slice (already without node/bun + script path) */
  raw: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const eqIdx = body.indexOf("=");
      if (eqIdx !== -1) {
        flags[body.slice(0, eqIdx)] = body.slice(eqIdx + 1);
      } else {
        // Peek ahead: --key value (only if next token is not a flag)
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
          flags[body] = next;
          i++;
        } else {
          flags[body] = true;
        }
      }
    } else if (arg.startsWith("-") && arg.length === 2) {
      // Short flags: -v
      flags[arg.slice(1)] = true;
    } else {
      positionals.push(arg);
    }
  }

  return { positionals, flags, raw: argv };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export type CommandHandler = (args: ParsedArgs) => Promise<void> | void;

export interface Command {
  name: string;
  description: string;
  usage?: string;
  handler: CommandHandler;
  subcommands?: Command[];
}

export class Router {
  private readonly commands: Map<string, Command> = new Map();

  register(command: Command): this {
    this.commands.set(command.name, command);
    return this;
  }

  async run(argv: string[]): Promise<void> {
    const parsed = parseArgs(argv);
    const [commandName, subcommandName, ...rest] = parsed.positionals;

    // --version / -v (check before help so `cjvibe --version` works without a positional)
    if (parsed.flags["version"] || parsed.flags["v"]) {
      const pkg = await import("../../package.json");
      console.log(pkg.version);
      return;
    }

    // --help / -h / no command
    if (!commandName || parsed.flags["help"] || parsed.flags["h"]) {
      this.printHelp();
      return;
    }

    const command = this.commands.get(commandName);
    if (!command) {
      throw new (await import("@/utils/errors")).CommandNotFoundError(
        commandName,
      );
    }

    // Route to subcommand if present
    if (subcommandName && command.subcommands?.length) {
      const sub = command.subcommands.find((s) => s.name === subcommandName);
      if (!sub) {
        throw new (await import("@/utils/errors")).CommandNotFoundError(
          `${commandName} ${subcommandName}`,
        );
      }
      // Rebuild parsed with remaining positionals
      const subParsed = parseArgs([...rest, ...Object.entries(parsed.flags)
        .map(([k, v]) => v === true ? `--${k}` : `--${k}=${v}`)]);
      await sub.handler(subParsed);
      return;
    }

    await command.handler(parsed);
  }

  printHelp(): void {
    const BOLD = "\x1b[1m";
    const CYAN = "\x1b[36m";
    const DIM = "\x1b[2m";
    const RESET = "\x1b[0m";

    console.log(`\n${BOLD}cjvibe${RESET} — Confluence & Jira CLI\n`);
    console.log(`${BOLD}Usage:${RESET} cjvibe <command> [subcommand] [flags]\n`);
    console.log(`${BOLD}Commands:${RESET}`);

    for (const cmd of this.commands.values()) {
      const name = `  ${CYAN}${cmd.name.padEnd(16)}${RESET}`;
      const desc = `${DIM}${cmd.description}${RESET}`;
      console.log(`${name}${desc}`);
      if (cmd.subcommands?.length) {
        for (const sub of cmd.subcommands) {
          const subName = `    ${sub.name.padEnd(14)}`;
          console.log(`${subName}${DIM}${sub.description}${RESET}`);
        }
      }
    }

    console.log(`\n${BOLD}Global flags:${RESET}`);
    console.log(`  ${CYAN}--help, -h      ${RESET}${DIM}Show this help message${RESET}`);
    console.log(`  ${CYAN}--version, -v   ${RESET}${DIM}Show version${RESET}`);
    console.log(`  ${CYAN}--debug         ${RESET}${DIM}Enable debug output (also: DEBUG=1)${RESET}\n`);
  }
}
