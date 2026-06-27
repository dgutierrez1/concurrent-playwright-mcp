import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { chromiumLauncher } from "../src/playwright-launcher.js";
import { SessionManager } from "../src/session-manager.js";

/**
 * Real-browser tests. Skipped unless RUN_INTEGRATION=1 and Chromium is
 * installed (`npm run setup:browser`). They prove the headline guarantee with
 * an actual browser: two sessions on the *same origin* still have fully
 * isolated storage.
 */
const enabled = process.env.RUN_INTEGRATION === "1";

describe.skipIf(!enabled)("real-browser session isolation", () => {
  let httpServer: Server;
  let baseUrl: string;
  let manager: SessionManager;

  beforeAll(async () => {
    httpServer = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><html><head><title>iso</title></head><body>ok</body></html>");
    });
    await new Promise<void>((resolve) => {
      httpServer.listen(0, "127.0.0.1", resolve);
    });
    const address = httpServer.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    baseUrl = `http://127.0.0.1:${String(port)}/`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      httpServer.close(() => {
        resolve();
      });
    });
  });

  afterEach(async () => {
    await manager.closeAll();
  });

  it("keeps localStorage isolated between concurrent same-origin sessions", async () => {
    manager = new SessionManager(chromiumLauncher({ headless: true }));
    await Promise.all([manager.createSession("a"), manager.createSession("b")]);

    const a = manager.get("a");
    const b = manager.get("b");
    await Promise.all([a.navigate(baseUrl), b.navigate(baseUrl)]);

    await a.evaluate("localStorage.setItem('who', 'session-a')");

    const aValue = await a.evaluate("localStorage.getItem('who')");
    const bValue = await b.evaluate("localStorage.getItem('who')");

    expect(aValue).toBe("session-a");
    // The whole point: b shares the origin but not the storage partition.
    expect(bValue).toBeNull();
  });

  it("keeps storage isolated across N concurrent sessions with zero collisions", async () => {
    const sessionCount = 10;
    manager = new SessionManager(chromiumLauncher({ headless: true }), {
      maxSessions: sessionCount + 1,
    });
    const ids = Array.from({ length: sessionCount }, (_, i) => `session-${String(i)}`);

    await Promise.all(
      ids.map(async (id) => {
        const session = await manager.createSession(id);
        await session.navigate(baseUrl);
        await session.evaluate(`localStorage.setItem('owner', ${JSON.stringify(id)})`);
      }),
    );

    let collisions = 0;
    for (const id of ids) {
      const owner = await manager.get(id).evaluate("localStorage.getItem('owner')");
      if (owner !== id) {
        collisions += 1;
      }
    }
    // The headline guarantee: every session reads back its own value.
    expect(collisions).toBe(0);
  });

  it("captures console output per session", async () => {
    manager = new SessionManager(chromiumLauncher({ headless: true }));
    const session = await manager.createSession("c");
    await session.navigate(baseUrl);
    await session.evaluate("console.log('hello from page')");

    // Poll instead of a fixed sleep: the console event arrives asynchronously.
    await expect
      .poll(() => session.consoleMessages().some((m) => m.text.includes("hello from page")), {
        timeout: 5_000,
      })
      .toBe(true);
  });
});
