#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { describeConfig, loadConfig } from "./config.js";
import { chromiumLauncher } from "./playwright-launcher.js";
import { createServer } from "./server.js";
import { SessionManager } from "./session-manager.js";

async function main(): Promise<void> {
  const config = loadConfig();
  // Ensure the screenshot output directory exists up front.
  await mkdir(config.security.outputDir, { recursive: true });

  const manager = new SessionManager(chromiumLauncher(config.launch), config.manager);
  manager.startIdleSweeper();

  const server = createServer(manager, config.security);

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    try {
      await manager.closeAll();
    } finally {
      process.exit(0);
    }
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the JSON-RPC channel; all logging goes to stderr.
  console.error(`concurrent-playwright-mcp running on stdio | ${describeConfig(config)}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
