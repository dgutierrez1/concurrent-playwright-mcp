import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import { chromiumLauncher } from "../src/playwright-launcher.js";
import { SessionManager } from "../src/session-manager.js";

/**
 * Benchmark: spin up N isolated sessions concurrently, have each write a unique
 * value into localStorage on a shared origin, then read it back. It reports
 * throughput and, more importantly, the collision count: if isolation held,
 * every session reads back its own value and collisions is 0. A shared-context
 * implementation (like the stock Playwright MCP) would show collisions == N-?.
 *
 * Usage: npm run benchmark [sessionCount]   (default 10)
 */
const sessionCount = Number.parseInt(process.argv[2] ?? "10", 10);

async function main(): Promise<void> {
  const httpServer = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><html><head><title>bench</title></head><body>ok</body></html>");
  });
  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", resolve);
  });
  const address = httpServer.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${String(port)}/`;

  const manager = new SessionManager(chromiumLauncher({ headless: true }), {
    maxSessions: sessionCount + 1,
  });
  const ids = Array.from({ length: sessionCount }, (_, i) => `session-${String(i)}`);

  const start = performance.now();
  await Promise.all(
    ids.map(async (id) => {
      const session = await manager.createSession(id);
      await session.navigate(baseUrl);
      await session.evaluate(`localStorage.setItem('owner', ${JSON.stringify(id)})`);
    }),
  );
  const elapsedMs = performance.now() - start;

  let collisions = 0;
  for (const id of ids) {
    const owner = await manager.get(id).evaluate("localStorage.getItem('owner')");
    if (owner !== id) {
      collisions += 1;
    }
  }

  await manager.closeAll();
  await new Promise<void>((resolve) => {
    httpServer.close(() => {
      resolve();
    });
  });

  const perSession = elapsedMs / sessionCount;
  console.log("Concurrent Playwright MCP - isolation benchmark");
  console.log("------------------------------------------------");
  console.log(`Sessions (parallel):     ${String(sessionCount)}`);
  console.log(`Total wall time:         ${elapsedMs.toFixed(0)} ms`);
  console.log(`Per session (amortized): ${perSession.toFixed(1)} ms`);
  console.log(`Cross-session collisions: ${String(collisions)}  (expected 0)`);
  if (collisions !== 0) {
    throw new Error(`Isolation broken: ${String(collisions)} collisions detected.`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
