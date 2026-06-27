import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { BrowserProvider } from "../browser-provider";
import type { AppConfig } from "../config";
import { createServer } from "../server";
import { SessionManager } from "../session-manager";

/** A running transport that can be shut down. */
export interface RunningTransport {
  close(): Promise<void>;
}

/**
 * Run the MCP server over stdio: one shared browser, one session manager. The
 * single client owns every session it creates.
 */
export async function runStdio(
  config: AppConfig,
  provider: BrowserProvider,
): Promise<RunningTransport> {
  const manager = new SessionManager(provider, config.manager);
  manager.startIdleSweeper();
  const server = createServer(manager, config.security);
  await server.connect(new StdioServerTransport());
  return {
    close: () => manager.closeAll(),
  };
}
