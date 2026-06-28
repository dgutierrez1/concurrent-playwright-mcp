import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { BrowserProvider } from "../src/browser-provider";
import { chromiumLauncher } from "../src/playwright-launcher";
import { createServer as createMcpServer } from "../src/server";
import { SessionManager } from "../src/session-manager";
import { serve } from "../test/fixtures/app";

/**
 * Agent-driven parallel demo. Four independent "agents" drive the MCP server at
 * the same time, each owning its own isolated session (`sessionId`), against a
 * local styled multi-page app. Their steps interleave in the terminal so you can
 * see the parallelism; at the end we assert the sessions never shared state.
 *
 * Everything runs in-process and offline (no network, no API key), so it is
 * deterministic and safe to record or run in CI.
 *
 *   npm run agent-demo                    # headless
 *   PW_HEADLESS=false npm run agent-demo  # watch four browsers work in parallel
 *   DEMO_STEP_MS=500 PW_HEADLESS=false npm run agent-demo   # slow down to record
 */

const ESC = String.fromCharCode(27);
const RESET = `${ESC}[0m`;
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const GREEN = `${ESC}[32m`;
const RED = `${ESC}[31m`;
const COLORS = [`${ESC}[36m`, `${ESC}[35m`, `${ESC}[32m`, `${ESC}[33m`] as const;

const headless = process.env.PW_HEADLESS !== "false";
const stepMs = Number(process.env.DEMO_STEP_MS ?? "0");

async function pause(): Promise<void> {
  if (stepMs > 0) await new Promise((resolve) => setTimeout(resolve, stepMs));
}

function makeLog(label: string, color: string): (msg: string) => void {
  const tag = `${color}${label.padEnd(9)}${RESET} ${DIM}│${RESET} `;
  return (msg: string) => {
    console.log(tag + msg);
  };
}

async function main(): Promise<void> {
  // A local, styled multi-page app served in-process — no network needed.
  const httpServer: Server = createHttpServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(serve(req.url ?? "/"));
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${String(port)}/`;

  // One shared Chromium, one MCP server, one client — four isolated sessions.
  const outputDir = await mkdtemp(join(tmpdir(), "cpm-agent-demo-"));
  const provider = new BrowserProvider(chromiumLauncher({ headless }));
  const manager = new SessionManager(provider);
  const server = createMcpServer(manager, { outputDir, allowFileUrls: false });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "agent-demo", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  // --- tiny MCP helpers (mirrors how a real client calls tools) ---
  async function call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    await pause();
    return (await client.callTool({ name, arguments: args })) as CallToolResult;
  }
  function textOf(result: CallToolResult): string {
    return result.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
  }
  async function snapshot(sessionId: string): Promise<string> {
    return textOf(await call("browser_snapshot", { sessionId }));
  }
  function refFor(snap: string, pattern: RegExp): string {
    const ref = pattern.exec(snap)?.[1];
    if (ref === undefined) throw new Error(`no element matched ${String(pattern)}`);
    return ref;
  }
  async function evalText(sessionId: string, script: string): Promise<string> {
    return textOf(await call("browser_evaluate", { sessionId, script }));
  }

  console.log(`\n${BOLD}Four agents, four isolated sessions, one browser — in parallel${RESET}`);
  console.log(`${DIM}target: ${baseUrl}  ·  headless: ${String(headless)}${RESET}\n`);

  // --- Agent 1: research two tickers ---
  async function research(): Promise<string> {
    const id = "research";
    const log = makeLog(id, COLORS[0]);
    await call("browser_create_session", { sessionId: id });
    const prices: string[] = [];
    for (const ticker of ["NVDA", "MSFT"]) {
      await call("browser_navigate", { sessionId: id, url: `${baseUrl}search` });
      log(`searching for ${ticker}…`);
      await call("browser_type", {
        sessionId: id,
        ref: refFor(await snapshot(id), /textbox "Search stocks"[^\n]*\[ref=(e\d+)\]/),
        element: "Search box",
        text: ticker,
      });
      await call("browser_click", {
        sessionId: id,
        ref: refFor(
          await snapshot(id),
          new RegExp(`link "${ticker}[^"]*"[^\\n]*\\[ref=(e\\d+)\\]`),
        ),
        element: `${ticker} result`,
      });
      const raw = await evalText(id, "document.getElementById('price')?.textContent ?? ''");
      const price = raw.replace(/"/g, "");
      log(`${ticker} is trading at ${BOLD}${price}${RESET}`);
      prices.push(`${ticker} ${price}`);
    }
    return `researched ${prices.join(", ")}`;
  }

  // --- Agent 2: shop, building an isolated cart ---
  async function shopper(): Promise<string> {
    const id = "shopper";
    const log = makeLog(id, COLORS[1]);
    await call("browser_create_session", { sessionId: id });
    await call("browser_navigate", { sessionId: id, url: `${baseUrl}shop` });
    for (const product of ["Widget", "Gadget"]) {
      const pattern = new RegExp(`button "Add ${product}"[^\\n]*\\[ref=(e\\d+)\\]`);
      await call("browser_click", {
        sessionId: id,
        ref: refFor(await snapshot(id), pattern),
        element: `Add ${product}`,
      });
      log(`added ${product} to cart`);
    }
    const raw = await evalText(id, "document.getElementById('cart').textContent");
    const count = raw.replace(/"/g, "");
    log(`cart now holds ${BOLD}${count}${RESET} items`);
    return `shopper cart=${count}`;
  }

  // --- Agents 3 & 4: log in as two different users at the same time ---
  async function login(user: string, plan: string, color: string): Promise<string> {
    const id = `user:${user}`;
    const log = makeLog(user, color);
    await call("browser_create_session", { sessionId: id });
    await call("browser_navigate", { sessionId: id, url: `${baseUrl}login` });
    const snap = await snapshot(id);
    log(`signing in (plan: ${plan})…`);
    await call("browser_type", {
      sessionId: id,
      ref: refFor(snap, /textbox "Username"[^\n]*\[ref=(e\d+)\]/),
      element: "Username",
      text: user,
    });
    await call("browser_select_option", {
      sessionId: id,
      ref: refFor(snap, /(?:combobox|listbox) "Plan"[^\n]*\[ref=(e\d+)\]/),
      element: "Plan",
      values: [plan],
    });
    await call("browser_click", {
      sessionId: id,
      ref: refFor(snap, /button "Sign in"[^\n]*\[ref=(e\d+)\]/),
      element: "Sign in",
    });
    await call("browser_wait_for", { sessionId: id, selector: "#welcome", state: "visible" });
    const raw = await evalText(id, "document.getElementById('welcome')?.textContent ?? ''");
    const welcome = raw.replace(/"/g, "");
    log(`dashboard says: ${BOLD}${welcome}${RESET}`);
    return `${user}: ${welcome}`;
  }

  // Run all four agents concurrently — their logs interleave as they race.
  const [r1, r2, r3, r4] = await Promise.all([
    research(),
    shopper(),
    login("alice", "pro", COLORS[2]),
    login("bob", "team", COLORS[3]),
  ]);

  // --- prove isolation: each session kept its own state ---
  console.log(`\n${BOLD}Isolation check${RESET}`);
  const ids = textOf(await call("browser_list_sessions", {}));
  const aliceCart = await evalText("user:alice", "localStorage.getItem('cart')");
  const researchCart = await evalText("research", "localStorage.getItem('cart')");
  const liveAll = ["research", "shopper", "user:alice", "user:bob"].every((s) => ids.includes(s));
  const checks: [string, boolean][] = [
    ["4 live, independent sessions", liveAll],
    ["alice signed in as alice", r3.includes("alice")],
    ["bob signed in as bob (no clobber)", r4.includes("bob")],
    ["shopper built a 2-item cart", r2.includes("cart=2")],
    ["only the shopper has a cart", aliceCart.includes("null") && researchCart.includes("null")],
  ];
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`} ${label}`);
  }
  const allOk = checks.every(([, ok]) => ok);
  const verdict = allOk ? "Zero cross-session collisions." : "Isolation FAILED.";
  console.log(`\n${allOk ? GREEN : RED}${BOLD}${verdict}${RESET} ${DIM}(${r1})${RESET}\n`);

  await client.close();
  await manager.closeAll();
  await provider.close();
  await new Promise<void>((resolve) => {
    httpServer.close(() => {
      resolve();
    });
  });
  await rm(outputDir, { recursive: true, force: true });
  if (!allOk) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
