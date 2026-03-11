import { Router } from "./router";
import { confluenceCommand } from "./commands/confluence";
import { log } from "@/utils/logger";
import { CjvibeError, toMessage } from "@/utils/errors";

async function main(): Promise<void> {
  // Enable debug if flag is present anywhere in argv
  if (process.argv.includes("--debug")) {
    process.env["DEBUG"] = "1";
  }

  const router = new Router();
  router.register(confluenceCommand);

  try {
    await router.run(process.argv.slice(2));
  } catch (err) {
    if (err instanceof CjvibeError) {
      log.error(err.message);
      log.debug(`[${err.code}] exit ${err.exitCode}`);
      process.exit(err.exitCode);
    }
    // Unexpected error
    log.error(`Unexpected error: ${toMessage(err)}`);
    log.debug(err instanceof Error ? (err.stack ?? "") : String(err));
    process.exit(1);
  }
}

await main();
