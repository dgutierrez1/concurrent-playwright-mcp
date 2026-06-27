import { randomUUID } from "node:crypto";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { BrowserProvider } from "../browser-provider";
import type { AppConfig } from "../config";
import { createServer } from "../server";
import { SessionManager } from "../session-manager";
import type { RunningTransport } from "./stdio";

/** Cap a single request body (MCP messages are small; this only bounds abuse). */
const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** Backstop against unbounded session/manager accumulation from an init flood. */
const MAX_CONNECTIONS = 100;

interface Connection {
  transport: StreamableHTTPServerTransport;
  manager: SessionManager;
}

class BodyTooLargeError extends Error {}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/** Read and JSON-parse a request body; returns undefined for an empty body. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      throw new BodyTooLargeError();
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) {
    return undefined;
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendError(res: ServerResponse, status: number, message: string, rpcCode = -32000): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: rpcCode, message }, id: null }));
}

/**
 * Build the allowlist of `Host` header values accepted in http mode, used to
 * enable the SDK's DNS-rebinding protection. Always includes the bound
 * host:port; for loopback binds it also accepts the localhost aliases. Operators
 * exposing the server (e.g. behind a proxy) add the external host via
 * `PW_ALLOWED_HOSTS`.
 */
function allowedHostsFor(config: AppConfig): string[] {
  const { host, port, allowedHosts } = config.transport;
  const hosts = new Set<string>([`${host}:${String(port)}`]);
  if (isLoopbackHost(host)) {
    hosts.add(`localhost:${String(port)}`);
    hosts.add(`127.0.0.1:${String(port)}`);
  }
  for (const extra of allowedHosts ?? []) {
    hosts.add(extra);
  }
  return [...hosts];
}

/**
 * Run the MCP server over Streamable HTTP. Each MCP client connection gets its
 * OWN {@link SessionManager} (so browser-session namespaces are isolated per
 * client), all sharing one {@link BrowserProvider} (one Chromium process).
 */
export async function runHttp(
  config: AppConfig,
  provider: BrowserProvider,
): Promise<RunningTransport> {
  const connections = new Map<string, Connection>();
  const allowedHosts = allowedHostsFor(config);

  function open(): Connection {
    const manager = new SessionManager(provider, config.manager);
    manager.startIdleSweeper();
    const server = createServer(manager, config.security);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      // Reject mismatched Host headers so a malicious web page cannot drive this
      // server via DNS rebinding to the bound (loopback) address.
      enableDnsRebindingProtection: true,
      allowedHosts,
    });
    const connection: Connection = { transport, manager };
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id !== undefined) {
        connections.delete(id);
      }
      void manager.closeAll();
    };
    // Bridge the SDK transport's optional-onclose typing under exactOptionalPropertyTypes.
    void server.connect(transport as unknown as Parameters<typeof server.connect>[0]);
    return connection;
  }

  async function handlePost(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        sendError(res, 413, "Request body too large.");
      } else {
        sendError(res, 400, "Invalid JSON body.", -32700);
      }
      return;
    }

    const sessionId = req.headers["mcp-session-id"];
    const existing = typeof sessionId === "string" ? connections.get(sessionId) : undefined;
    if (existing !== undefined) {
      await existing.transport.handleRequest(req, res, body);
      return;
    }
    if (isInitializeRequest(body)) {
      if (connections.size >= MAX_CONNECTIONS) {
        sendError(res, 503, "Too many active sessions; try again later.");
        return;
      }
      const connection = open();
      try {
        await connection.transport.handleRequest(req, res, body);
      } catch (error) {
        await connection.transport.close();
        throw error;
      }
      const id = connection.transport.sessionId;
      if (id !== undefined) {
        connections.set(id, connection);
      } else {
        await connection.transport.close();
      }
      return;
    }
    sendError(res, 400, "No valid session: send an initialize request first.");
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === "POST") {
      await handlePost(req, res);
      return;
    }
    // GET (SSE stream) and DELETE (session teardown) require an existing session.
    const sessionId = req.headers["mcp-session-id"];
    const existing = typeof sessionId === "string" ? connections.get(sessionId) : undefined;
    if (existing !== undefined) {
      await existing.transport.handleRequest(req, res);
      return;
    }
    sendError(res, 400, "Unknown or missing Mcp-Session-Id.");
  }

  const http = createHttpServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) {
        sendError(res, 500, error instanceof Error ? error.message : "Internal error");
      }
    });
  });

  await new Promise<void>((resolve) => {
    http.listen(config.transport.port, config.transport.host, resolve);
  });

  if (!isLoopbackHost(config.transport.host)) {
    console.error(
      `[concurrent-playwright-mcp] WARNING: bound to ${config.transport.host} with no built-in ` +
        `authentication. Put it behind your own auth/proxy and set PW_ALLOWED_HOSTS.`,
    );
  }

  return {
    async close() {
      for (const connection of connections.values()) {
        await connection.transport.close();
        await connection.manager.closeAll();
      }
      connections.clear();
      await new Promise<void>((resolve, reject) => {
        http.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    },
  };
}
