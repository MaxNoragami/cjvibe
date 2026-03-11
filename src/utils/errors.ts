export class CjvibeError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly exitCode: number = 1,
  ) {
    super(message);
    this.name = "CjvibeError";
  }
}

export class ConfigError extends CjvibeError {
  constructor(message: string) {
    super(message, "CONFIG_ERROR", 1);
    this.name = "ConfigError";
  }
}

export class ConfluenceError extends CjvibeError {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message, "CONFLUENCE_ERROR", 1);
    this.name = "ConfluenceError";
  }
}

export class CommandNotFoundError extends CjvibeError {
  constructor(command: string) {
    super(`Unknown command: "${command}"`, "COMMAND_NOT_FOUND", 127);
    this.name = "CommandNotFoundError";
  }
}

/** Safely extract a human-readable message from an unknown thrown value. */
export function toMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
