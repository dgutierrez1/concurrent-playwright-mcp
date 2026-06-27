import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { BrowserProvider } from "../src/browser-provider";
import { chromiumLauncher } from "../src/playwright-launcher";
import { createServer as createMcpServer } from "../src/server";
import { SessionManager } from "../src/session-manager";
import { serve } from "./fixtures/app";

/**
 * End-to-end tests: several realistic journeys driven entirely through the MCP
 * server (client → tools/call → real Chromium → result) against a local, styled
 * multi-page app. Deterministic and offline; gated by RUN_INTEGRATION=1. Run
 * headed with PW_HEADLESS=false to watch the parallel, isolated sessions.
 *
 * Together these cover the tool surface against a real browser: snapshot→ref
 * actions (click/type/select/fill_form/drag), navigation/back, tabs, screenshot,
 * storage-state save + reuse, and per-session isolation on a stateful app.
 */
const enabled = process.env.RUN_INTEGRATION === "1";

describe.skipIf(!enabled)("e2e journeys through the MCP server", () => {
  let httpServer: Server;
  let baseUrl: string;
  let provider: BrowserProvider;
  let manager: SessionManager;
  let client: Client;
  let outputDir: string;

  beforeAll(async () => {
    httpServer = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(serve(req.url ?? "/"));
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    baseUrl = `http://127.0.0.1:${String(port)}/`;

    outputDir = await mkdtemp(join(tmpdir(), "cpm-e2e-"));
    provider = new BrowserProvider(
      chromiumLauncher({ headless: process.env.PW_HEADLESS !== "false" }),
    );
    manager = new SessionManager(provider);
    const server = createMcpServer(manager, { outputDir, allowFileUrls: false });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "e2e", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  });

  afterEach(async () => {
    await manager.closeAll();
  });

  afterAll(async () => {
    await client.close();
    await provider.close();
    await new Promise<void>((resolve) => {
      httpServer.close(() => {
        resolve();
      });
    });
    await rm(outputDir, { recursive: true, force: true });
  });

  async function call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
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
    expect(ref, `no ref for ${String(pattern)} in snapshot:\n${snap}`).toBeDefined();
    return ref ?? "";
  }

  async function evalText(sessionId: string, script: string): Promise<string> {
    return textOf(await call("browser_evaluate", { sessionId, script }));
  }

  async function open(sessionId: string, path: string, options: Record<string, unknown> = {}) {
    await call("browser_create_session", { sessionId, ...options });
    await call("browser_navigate", { sessionId, url: `${baseUrl}${path}` });
  }

  it("logs in via the form, reuses saved storage state, and isolates from anon", async () => {
    await open("main", "login");
    const snap = await snapshot("main");
    await call("browser_type", {
      sessionId: "main",
      ref: refFor(snap, /textbox "Username"[^\n]*\[ref=(e\d+)\]/),
      element: "Username",
      text: "alice",
    });
    await call("browser_select_option", {
      sessionId: "main",
      ref: refFor(snap, /(?:combobox|listbox) "Plan"[^\n]*\[ref=(e\d+)\]/),
      element: "Plan",
      values: ["pro"],
    });
    await call("browser_click", {
      sessionId: "main",
      ref: refFor(snap, /button "Sign in"[^\n]*\[ref=(e\d+)\]/),
      element: "Sign in",
    });

    await call("browser_wait_for", { sessionId: "main", selector: "#welcome", state: "visible" });
    await expect
      .poll(() => evalText("main", "document.getElementById('welcome')?.textContent ?? ''"), {
        timeout: 5_000,
      })
      .toContain("alice");

    await call("browser_save_storage_state", { sessionId: "main", path: "alice.json" });

    await open("reuse", "app", { storageStatePath: "alice.json" });
    await expect
      .poll(() => evalText("reuse", "document.getElementById('welcome')?.textContent ?? ''"), {
        timeout: 5_000,
      })
      .toContain("alice");

    await open("anon", "app");
    expect(
      await evalText("anon", "document.getElementById('welcome')?.textContent ?? ''"),
    ).toContain("Not signed in");
  });

  it("searches + filters stocks, then opens a result by ref", async () => {
    await open("search", "search");
    await call("browser_type", {
      sessionId: "search",
      ref: refFor(await snapshot("search"), /textbox "Search stocks"[^\n]*\[ref=(e\d+)\]/),
      element: "Search box",
      text: "MS",
    });
    // The list filters client-side; only the MSFT row remains in the a11y tree.
    const filtered = await snapshot("search");
    await call("browser_click", {
      sessionId: "search",
      ref: refFor(filtered, /link "MSFT[^"]*"[^\n]*\[ref=(e\d+)\]/),
      element: "MSFT result",
    });
    await expect
      .poll(() => evalText("search", "document.getElementById('sym')?.textContent ?? ''"), {
        timeout: 5_000,
      })
      .toContain("MSFT");
    expect(
      await evalText("search", "document.getElementById('price')?.textContent ?? ''"),
    ).toContain("$");
  });

  it("fills a multi-field contact form and submits", async () => {
    await open("form", "contact");
    const snap = await snapshot("form");
    await call("browser_fill_form", {
      sessionId: "form",
      fields: [
        {
          ref: refFor(snap, /textbox "Name"[^\n]*\[ref=(e\d+)\]/),
          element: "Name",
          value: "Alice",
        },
        {
          ref: refFor(snap, /textbox "Email"[^\n]*\[ref=(e\d+)\]/),
          element: "Email",
          value: "alice@example.com",
        },
        {
          ref: refFor(snap, /textbox "Message"[^\n]*\[ref=(e\d+)\]/),
          element: "Message",
          value: "Hello there",
        },
      ],
    });
    await call("browser_select_option", {
      sessionId: "form",
      ref: refFor(snap, /(?:combobox|listbox) "Country"[^\n]*\[ref=(e\d+)\]/),
      element: "Country",
      values: ["uk"],
    });
    await call("browser_click", {
      sessionId: "form",
      ref: refFor(snap, /checkbox "Subscribe"[^\n]*\[ref=(e\d+)\]/),
      element: "Subscribe",
    });
    await call("browser_click", {
      sessionId: "form",
      ref: refFor(snap, /button "Send"[^\n]*\[ref=(e\d+)\]/),
      element: "Send",
    });

    await expect
      .poll(() => evalText("form", "document.getElementById('thanks')?.textContent ?? ''"), {
        timeout: 5_000,
      })
      .toContain("Alice");
  });

  it("keeps two parallel shopping carts isolated", async () => {
    await Promise.all([open("cartA", "shop"), open("cartB", "shop")]);

    async function add(sessionId: string, product: string): Promise<void> {
      const snap = await snapshot(sessionId);
      await call("browser_click", {
        sessionId,
        ref: refFor(snap, new RegExp(`button "Add ${product}"[^\\n]*\\[ref=(e\\d+)\\]`)),
        element: `Add ${product}`,
      });
    }

    await Promise.all([
      (async () => {
        await add("cartA", "Widget");
        await add("cartA", "Gadget");
      })(),
      add("cartB", "Gizmo"),
    ]);

    await expect
      .poll(() => evalText("cartA", "document.getElementById('cart').textContent"))
      .toBe('"2"');
    await expect
      .poll(() => evalText("cartB", "document.getElementById('cart').textContent"))
      .toBe('"1"');

    const cartA = await evalText("cartA", "localStorage.getItem('cart')");
    expect(cartA).toContain("Widget");
    expect(cartA).not.toContain("Gizmo");
    const cartB = await evalText("cartB", "localStorage.getItem('cart')");
    expect(cartB).toContain("Gizmo");
    expect(cartB).not.toContain("Widget");
  });

  it("reorders a list by drag and drop", async () => {
    await open("board", "board");
    const snap = await snapshot("board");
    await call("browser_drag", {
      sessionId: "board",
      sourceRef: refFor(snap, /listitem \[ref=(e\d+)\]: One/),
      sourceElement: "One",
      targetRef: refFor(snap, /listitem \[ref=(e\d+)\]: Three/),
      targetElement: "Three",
    });
    await expect
      .poll(() =>
        evalText(
          "board",
          "Array.from(document.querySelectorAll('#board li')).map(li => li.textContent).join(',')",
        ),
      )
      .toContain("Three,One");
  });

  it("manages tabs and navigates back through history", async () => {
    await open("tabs", "search");
    expect(textOf(await call("browser_tabs", { sessionId: "tabs", action: "new" }))).toContain("1");
    const listed = textOf(await call("browser_tabs", { sessionId: "tabs", action: "list" }));
    expect((listed.match(/"index"/g) ?? []).length).toBe(2);
    await call("browser_tabs", { sessionId: "tabs", action: "close", index: 1 });

    await call("browser_navigate", { sessionId: "tabs", url: `${baseUrl}contact` });
    const moved = textOf(await call("browser_navigate_back", { sessionId: "tabs" }));
    expect(moved).toContain("Navigated back");
    expect(await evalText("tabs", "location.pathname")).toBe('"/search"');
  });

  it("returns a screenshot as an image content block", async () => {
    await open("shot", "login");
    const result = await call("browser_screenshot", { sessionId: "shot" });
    const image = result.content.find((c) => c.type === "image");
    expect(image?.type === "image" ? image.mimeType : "").toBe("image/png");
  });
});
