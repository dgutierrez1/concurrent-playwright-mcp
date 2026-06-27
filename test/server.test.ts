import path from "node:path";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { SessionNotFoundError } from "../src/errors";
import { createServer, type SecurityConfig } from "../src/server";
import type { SessionManager } from "../src/session-manager";

/** A no-Playwright stand-in for the session layer — server tests exercise wiring, not the browser. */
class FakeSession {
  async navigate(): Promise<void> {
    /* no-op */
  }
  async evaluate(): Promise<unknown> {
    return undefined;
  }
  async screenshot(): Promise<Buffer> {
    return Buffer.from("png");
  }
}

class FakeManager {
  readonly live = new Set<string>();
  async createSession(id: string): Promise<FakeSession> {
    this.live.add(id);
    return new FakeSession();
  }
  ids(): string[] {
    return [...this.live];
  }
  async closeSession(id: string): Promise<void> {
    this.live.delete(id);
  }
  get(id: string): FakeSession {
    if (!this.live.has(id)) {
      throw new SessionNotFoundError(id);
    }
    return new FakeSession();
  }
}

const DEFAULT_SECURITY: SecurityConfig = {
  outputDir: path.resolve("output"),
  allowFileUrls: false,
};

async function connect(
  security: SecurityConfig = DEFAULT_SECURITY,
): Promise<{ client: Client; manager: FakeManager }> {
  const manager = new FakeManager();
  const server = createServer(manager as unknown as SessionManager, security);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, manager };
}

/** Call a tool, narrowing the result to CallToolResult (off the legacy compat union). */
async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

function firstText(result: CallToolResult): string {
  const block = result.content[0];
  return block?.type === "text" ? block.text : "";
}

describe("createServer wiring", () => {
  it("registers all browser tools", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(23);
    const names = tools.map((t) => t.name);
    expect(names).toContain("browser_create_session");
    expect(names).toContain("browser_tabs");
    expect(names.every((n) => n.startsWith("browser_"))).toBe(true);
  });

  it("returns success content for a valid call", async () => {
    const { client } = await connect();
    await callTool(client, "browser_create_session", { sessionId: "a" });
    const result = await callTool(client, "browser_list_sessions", {});
    expect(result.isError).toBeFalsy();
    expect(firstText(result)).toContain("a");
  });

  it("serializes a void evaluate result as 'undefined' (not an invalid block)", async () => {
    const { client } = await connect();
    await callTool(client, "browser_create_session", { sessionId: "a" });
    const result = await callTool(client, "browser_evaluate", {
      sessionId: "a",
      script: "localStorage.setItem('k','v')",
    });
    expect(result.isError).toBeFalsy();
    expect(firstText(result)).toBe("undefined");
  });

  it("returns a screenshot as an image content block", async () => {
    const { client } = await connect();
    await callTool(client, "browser_create_session", { sessionId: "a" });
    const result = await callTool(client, "browser_screenshot", { sessionId: "a" });
    expect(result.isError).toBeFalsy();
    const image = result.content.find((c) => c.type === "image");
    expect(image).toBeDefined();
    expect(image?.type === "image" ? image.mimeType : "").toBe("image/png");
    expect(image?.type === "image" ? image.data.length : 0).toBeGreaterThan(0);
  });
});

describe("createServer error mapping (in-band, never thrown)", () => {
  it("maps a domain error to an isError result carrying its code", async () => {
    const { client } = await connect();
    const result = await callTool(client, "browser_navigate", {
      sessionId: "ghost",
      url: "https://example.com",
    });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("SESSION_NOT_FOUND");
  });

  it("returns INVALID_ARGUMENT when browser_tabs close is missing an index", async () => {
    const { client } = await connect();
    await callTool(client, "browser_create_session", { sessionId: "a" });
    const result = await callTool(client, "browser_tabs", { sessionId: "a", action: "close" });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("INVALID_ARGUMENT");
  });

  it("turns a missing-Chromium error into an actionable install hint", async () => {
    const throwingManager = {
      ids: () => ["a"],
      get: () => ({
        navigate: () => {
          throw new Error(
            "browserType.launch: Executable doesn't exist at /ms-playwright/chromium/chrome\n" +
              "╔════╗\n║ Looks like Playwright was just installed... ║\n╚════╝",
          );
        },
      }),
    };
    const server = createServer(throwingManager as unknown as SessionManager, DEFAULT_SECURITY);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const result = (await client.callTool({
      name: "browser_navigate",
      arguments: { sessionId: "a", url: "https://example.com" },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("npx playwright install chromium");
    await client.close();
  });
});

describe("createServer security enforcement", () => {
  it("blocks file:// navigation by default", async () => {
    const { client } = await connect();
    await callTool(client, "browser_create_session", { sessionId: "a" });
    const result = await callTool(client, "browser_navigate", {
      sessionId: "a",
      url: "file:///etc/passwd",
    });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("NAVIGATION_BLOCKED");
  });

  it("enforces the origin allowlist when configured", async () => {
    const { client } = await connect({
      outputDir: path.resolve("output"),
      allowFileUrls: false,
      allowedOrigins: ["https://allowed.com"],
    });
    await callTool(client, "browser_create_session", { sessionId: "a" });
    const result = await callTool(client, "browser_navigate", {
      sessionId: "a",
      url: "https://evil.com",
    });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("NAVIGATION_BLOCKED");
  });

  it("confines screenshots to the output directory", async () => {
    const { client } = await connect();
    await callTool(client, "browser_create_session", { sessionId: "a" });
    const result = await callTool(client, "browser_screenshot", {
      sessionId: "a",
      path: "../escape.png",
    });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("PATH_NOT_ALLOWED");
  });

  it("confines a create-session storageStatePath to the output directory", async () => {
    const { client } = await connect();
    const result = await callTool(client, "browser_create_session", {
      sessionId: "a",
      storageStatePath: "../../secrets.json",
    });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("PATH_NOT_ALLOWED");
  });
});
