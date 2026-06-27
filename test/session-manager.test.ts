import { describe, expect, it, vi } from "vitest";
import type { Browser, BrowserContext } from "playwright";
import { BrowserProvider } from "../src/browser-provider";
import {
  SessionManager,
  type SessionManagerOptions,
  type CreateSessionOptions,
  type Viewport,
} from "../src/session-manager";
import { DuplicateSessionError, SessionLimitError, SessionNotFoundError } from "../src/errors";

/**
 * Minimal fakes implementing only the slice of the Playwright API that
 * {@link SessionManager} touches, cast to the real types at the boundary. Each
 * fake context records whether it was closed so tests can assert that sessions
 * never share a context and that teardown targets the right one.
 */
class FakeContext {
  closed = false;
  constructor(readonly viewport: Viewport | null | undefined) {}
  on(): void {
    // BrowserSession wires capture via context.on("page", ...); no-op here since
    // SessionManager unit tests never create pages.
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  pages(): unknown[] {
    return [];
  }
  async newPage(): Promise<never> {
    throw new Error("newPage is not exercised by SessionManager unit tests");
  }
}

class FakeBrowser {
  connected = true;
  closed = false;
  readonly contexts: FakeContext[] = [];
  isConnected(): boolean {
    return this.connected;
  }
  async newContext(options: { viewport?: Viewport | null }): Promise<BrowserContext> {
    const context = new FakeContext(options.viewport);
    this.contexts.push(context);
    return context as unknown as BrowserContext;
  }
  async close(): Promise<void> {
    this.closed = true;
    this.connected = false;
  }
}

function setup(options?: SessionManagerOptions): {
  manager: SessionManager;
  browser: FakeBrowser;
  provider: BrowserProvider;
  launch: ReturnType<typeof vi.fn>;
} {
  const browser = new FakeBrowser();
  const launch = vi.fn(async () => browser as unknown as Browser);
  const provider = new BrowserProvider(launch);
  const manager = new SessionManager(provider, options);
  return { manager, browser, provider, launch };
}

describe("SessionManager isolation", () => {
  it("gives each session its own context", async () => {
    const { manager, browser } = setup();
    await manager.createSession("a");
    await manager.createSession("b");

    expect(browser.contexts).toHaveLength(2);
    expect(browser.contexts[0]).not.toBe(browser.contexts[1]);
    expect(manager.size).toBe(2);
  });

  it("applies the default viewport, and a custom one when given", async () => {
    const { manager, browser } = setup();
    await manager.createSession("default");
    const custom: CreateSessionOptions = { viewport: { width: 375, height: 812 } };
    await manager.createSession("mobile", custom);

    expect(browser.contexts[0]?.viewport).toEqual({ width: 1440, height: 900 });
    expect(browser.contexts[1]?.viewport).toEqual({ width: 375, height: 812 });
  });
});

describe("SessionManager browser lifecycle", () => {
  it("acquires the browser lazily, only on first session", async () => {
    const { manager, launch } = setup();
    expect(launch).not.toHaveBeenCalled();
    await manager.createSession("a");
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("shares one browser across many concurrent sessions", async () => {
    const { manager, browser, launch } = setup();
    const ids = Array.from({ length: 12 }, (_, i) => `s${String(i)}`);

    await Promise.all(ids.map((id) => manager.createSession(id)));

    expect(launch).toHaveBeenCalledTimes(1);
    expect(browser.contexts).toHaveLength(12);
    expect(manager.size).toBe(12);
  });
});

describe("SessionManager teardown", () => {
  it("closeSession closes only that context and forgets it", async () => {
    const { manager, browser } = setup();
    await manager.createSession("keep");
    await manager.createSession("drop");

    await manager.closeSession("drop");

    expect(browser.contexts[0]?.closed).toBe(false);
    expect(browser.contexts[1]?.closed).toBe(true);
    expect(manager.has("drop")).toBe(false);
    expect(manager.has("keep")).toBe(true);
    expect(manager.size).toBe(1);
  });

  it("closeAll closes every context but leaves the shared browser to the provider", async () => {
    const { manager, browser, provider } = setup();
    await manager.createSession("a");
    await manager.createSession("b");

    await manager.closeAll();
    expect(browser.contexts.every((c) => c.closed)).toBe(true);
    expect(manager.size).toBe(0);
    // The browser belongs to the provider, not the manager.
    expect(browser.closed).toBe(false);

    await provider.close();
    expect(browser.closed).toBe(true);
  });
});

describe("SessionManager error handling", () => {
  it("rejects a duplicate session id", async () => {
    const { manager } = setup();
    await manager.createSession("dup");
    await expect(manager.createSession("dup")).rejects.toBeInstanceOf(DuplicateSessionError);
  });

  it("throws SessionNotFoundError for an unknown id on get", async () => {
    const { manager } = setup();
    expect(() => manager.get("ghost")).toThrow(SessionNotFoundError);
  });

  it("throws SessionNotFoundError when closing an unknown id", async () => {
    const { manager } = setup();
    await expect(manager.closeSession("ghost")).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it("tracks ids in creation order", async () => {
    const { manager } = setup();
    await manager.createSession("first");
    await manager.createSession("second");
    expect(manager.ids()).toEqual(["first", "second"]);
  });
});

describe("SessionManager bounds", () => {
  it("rejects creating past the session cap", async () => {
    const { manager } = setup({ maxSessions: 2 });
    await manager.createSession("a");
    await manager.createSession("b");
    await expect(manager.createSession("c")).rejects.toBeInstanceOf(SessionLimitError);
    expect(manager.size).toBe(2);
  });

  it("frees a slot when a session is closed", async () => {
    const { manager } = setup({ maxSessions: 1 });
    await manager.createSession("a");
    await manager.closeSession("a");
    await expect(manager.createSession("b")).resolves.toBeDefined();
  });
});

describe("SessionManager idle eviction", () => {
  it("does nothing when eviction is disabled (default)", async () => {
    const { manager } = setup();
    await manager.createSession("a");
    expect(await manager.sweepIdle()).toEqual([]);
    expect(manager.has("a")).toBe(true);
  });

  it("evicts only sessions idle past the timeout, sparing recently used ones", async () => {
    let clock = 0;
    const { manager } = setup({ idleTimeoutMs: 1_000, now: () => clock });

    await manager.createSession("idle"); // lastUsed = 0
    await manager.createSession("busy"); // lastUsed = 0

    clock = 500;
    manager.get("busy"); // touched → lastUsed = 500

    clock = 1_200; // cutoff = 200: idle(0) < 200 evicted, busy(500) >= 200 kept
    const evicted = await manager.sweepIdle();

    expect(evicted).toEqual(["idle"]);
    expect(manager.has("idle")).toBe(false);
    expect(manager.has("busy")).toBe(true);
  });
});

describe("SessionManager idle sweeper", () => {
  it("does not start a timer when eviction is disabled", () => {
    vi.useFakeTimers();
    try {
      const { manager } = setup(); // idleTimeoutMs defaults to 0
      manager.startIdleSweeper(100);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("evicts on the interval and ignores a second start", async () => {
    vi.useFakeTimers();
    try {
      let clock = 0;
      const { manager } = setup({ idleTimeoutMs: 1_000, now: () => clock });
      await manager.createSession("a"); // lastUsed = 0

      manager.startIdleSweeper(100);
      manager.startIdleSweeper(100); // no-op: must not create a second timer
      expect(vi.getTimerCount()).toBe(1);

      clock = 2_000; // well past the idle timeout
      await vi.advanceTimersByTimeAsync(100);
      expect(manager.has("a")).toBe(false);

      manager.stopIdleSweeper();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
