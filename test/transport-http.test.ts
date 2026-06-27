import { createServer as createNetServer } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Browser, BrowserContext } from "playwright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { BrowserProvider } from "../src/browser-provider";
import type { AppConfig } from "../src/config";
import { runHttp } from "../src/transport/http";
import type { RunningTransport } from "../src/transport/stdio";

/** A fake browser so the HTTP transport can be tested without Chromium. */
class FakeContext {
  on(): void {
    /* no page events in this test */
  }
  async close(): Promise<void> {
    /* no-op */
  }
  pages(): unknown[] {
    return [];
  }
}

class FakeBrowser {
  isConnected(): boolean {
    return true;
  }
  async newContext(): Promise<BrowserContext> {
    return new FakeContext() as unknown as BrowserContext;
  }
  async close(): Promise<void> {
    /* no-op */
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      srv.close(() => {
        resolve(port);
      });
    });
  });
}

function configFor(port: number): AppConfig {
  return {
    launch: {},
    manager: {
      maxSessions: 50,
      idleTimeoutMs: 0,
      maxTabs: 20,
      maxCaptureEntries: 1000,
      actionTimeoutMs: 15000,
    },
    security: { outputDir: "output", allowFileUrls: false },
    transport: { mode: "http", host: "127.0.0.1", port },
  };
}

function firstText(result: CallToolResult): string {
  const block = result.content[0];
  return block?.type === "text" ? block.text : "";
}

describe("Streamable HTTP transport", () => {
  let transport: RunningTransport;
  let provider: BrowserProvider;
  let url: URL;
  const clients: Client[] = [];

  beforeEach(async () => {
    const port = await freePort();
    url = new URL(`http://127.0.0.1:${String(port)}/`);
    provider = new BrowserProvider(async () => new FakeBrowser() as unknown as Browser);
    transport = await runHttp(configFor(port), provider);
  });

  afterEach(async () => {
    await Promise.all(clients.map((c) => c.close()));
    clients.length = 0;
    await transport.close();
    await provider.close();
  });

  async function connect(): Promise<Client> {
    const client = new Client({ name: "http-test", version: "0.0.0" });
    // Bridge the SDK transport's optional-sessionId typing under exactOptionalPropertyTypes.
    const clientTransport = new StreamableHTTPClientTransport(url) as unknown as Parameters<
      typeof client.connect
    >[0];
    await client.connect(clientTransport);
    clients.push(client);
    return client;
  }

  async function call(
    client: Client,
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
    return firstText(result);
  }

  it("serves tools/list over HTTP", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(23);
    expect(tools.map((t) => t.name)).toContain("browser_create_session");
  });

  it("round-trips a session lifecycle", async () => {
    const client = await connect();
    await call(client, "browser_create_session", { sessionId: "x" });
    expect(await call(client, "browser_list_sessions", {})).toContain("x");
  });

  it("isolates session namespaces between separate clients", async () => {
    const a = await connect();
    const b = await connect();
    await call(a, "browser_create_session", { sessionId: "owned-by-a" });

    expect(await call(a, "browser_list_sessions", {})).toContain("owned-by-a");
    // b is a separate connection with its own SessionManager → cannot see a's session.
    expect(await call(b, "browser_list_sessions", {})).not.toContain("owned-by-a");
  });

  it("rejects a non-initialize POST without a session (400)", async () => {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        connection: "close",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    await res.text();
    expect(res.status).toBe(400);
  });

  it("rejects a GET without a session (400)", async () => {
    const res = await fetch(url, {
      method: "GET",
      headers: { accept: "text/event-stream", connection: "close" },
    });
    await res.text();
    expect(res.status).toBe(400);
  });
});
