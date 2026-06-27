import type { Browser } from "playwright";
import { BrowserSession } from "./session.js";
import { DuplicateSessionError, SessionLimitError, SessionNotFoundError } from "./errors.js";

export interface Viewport {
  width: number;
  height: number;
}

export interface CreateSessionOptions {
  viewport?: Viewport;
}

export interface SessionManagerOptions {
  /** Hard cap on live sessions; creating past it throws. Default 50. */
  maxSessions?: number;
  /**
   * Evict a session after this many ms with no access. 0 (default) disables
   * idle eviction. Eviction runs when {@link SessionManager.sweepIdle} is
   * called, either manually or by the interval from {@link startIdleSweeper}.
   */
  idleTimeoutMs?: number;
  /** Hard cap on tabs per session; opening past it throws. Default 20. */
  maxTabs?: number;
  /** Max console/network entries retained per session (ring buffer). Default 1000. */
  maxCaptureEntries?: number;
  /** Clock, injectable for deterministic tests. Defaults to Date.now. */
  now?: () => number;
}

/**
 * Launches and returns a browser. Injected into {@link SessionManager} so the
 * lifecycle/isolation logic can be exercised with a fake browser in unit tests,
 * while production wires in a real Playwright launcher.
 */
export type BrowserLauncher = () => Promise<Browser>;

export const DEFAULT_VIEWPORT: Viewport = { width: 1440, height: 900 };
export const DEFAULT_MAX_SESSIONS = 50;
export const DEFAULT_MAX_TABS = 20;
export const DEFAULT_MAX_CAPTURE_ENTRIES = 1000;

interface SessionRecord {
  session: BrowserSession;
  lastUsed: number;
}

/**
 * Owns one shared browser process and a set of isolated {@link BrowserSession}s
 * keyed by id. Each session gets its own {@link import("playwright").BrowserContext},
 * so cookies, storage, and capture buffers never cross between sessions. This is
 * the difference from the stock Playwright MCP server, which multiplexes
 * everything through a single shared context.
 *
 * The browser is launched lazily on first use and the launch is memoized, so
 * many sessions created concurrently share one browser without racing into
 * multiple launches. A session cap and optional idle eviction keep a
 * long-running server from leaking contexts.
 */
export class SessionManager {
  readonly #launch: BrowserLauncher;
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #maxSessions: number;
  readonly #idleTimeoutMs: number;
  readonly #maxTabs: number;
  readonly #maxCaptureEntries: number;
  readonly #now: () => number;
  #browser: Browser | null = null;
  #launchInFlight: Promise<Browser> | null = null;
  #sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(launch: BrowserLauncher, options: SessionManagerOptions = {}) {
    this.#launch = launch;
    this.#maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.#idleTimeoutMs = options.idleTimeoutMs ?? 0;
    this.#maxTabs = options.maxTabs ?? DEFAULT_MAX_TABS;
    this.#maxCaptureEntries = options.maxCaptureEntries ?? DEFAULT_MAX_CAPTURE_ENTRIES;
    this.#now = options.now ?? Date.now;
  }

  /** Number of live sessions. */
  get size(): number {
    return this.#sessions.size;
  }

  has(sessionId: string): boolean {
    return this.#sessions.has(sessionId);
  }

  /** Ids of all live sessions, in creation order. */
  ids(): string[] {
    return [...this.#sessions.keys()];
  }

  async #browserInstance(): Promise<Browser> {
    if (this.#browser !== null && this.#browser.isConnected()) {
      return this.#browser;
    }
    // Memoize an in-flight launch so concurrent callers share one browser.
    if (this.#launchInFlight === null) {
      this.#launchInFlight = this.#launch();
      try {
        this.#browser = await this.#launchInFlight;
      } finally {
        this.#launchInFlight = null;
      }
      return this.#browser;
    }
    return this.#launchInFlight;
  }

  /**
   * Create a new isolated session. Throws {@link DuplicateSessionError} if the
   * id is in use, or {@link SessionLimitError} if the cap is reached.
   */
  async createSession(
    sessionId: string,
    options: CreateSessionOptions = {},
  ): Promise<BrowserSession> {
    if (this.#sessions.has(sessionId)) {
      throw new DuplicateSessionError(sessionId);
    }
    if (this.#sessions.size >= this.#maxSessions) {
      throw new SessionLimitError(this.#maxSessions);
    }
    const browser = await this.#browserInstance();
    const context = await browser.newContext({
      viewport: options.viewport ?? DEFAULT_VIEWPORT,
    });
    const session = new BrowserSession(context, {
      maxTabs: this.#maxTabs,
      maxCaptureEntries: this.#maxCaptureEntries,
    });
    this.#sessions.set(sessionId, { session, lastUsed: this.#now() });
    return session;
  }

  /**
   * Get an existing session and mark it freshly used (so idle eviction does not
   * reclaim a session under active use). Throws {@link SessionNotFoundError}.
   */
  get(sessionId: string): BrowserSession {
    const record = this.#sessions.get(sessionId);
    if (record === undefined) {
      throw new SessionNotFoundError(sessionId);
    }
    record.lastUsed = this.#now();
    return record.session;
  }

  /** Close one session and forget it. Throws if the id is unknown. */
  async closeSession(sessionId: string): Promise<void> {
    const record = this.#sessions.get(sessionId);
    if (record === undefined) {
      throw new SessionNotFoundError(sessionId);
    }
    this.#sessions.delete(sessionId);
    await record.session.close();
  }

  /**
   * Evict sessions untouched for longer than the configured idle timeout.
   * Pure with respect to the injected clock, so it can be tested without timers.
   * Returns the ids that were evicted. A no-op when idle eviction is disabled.
   */
  async sweepIdle(): Promise<string[]> {
    if (this.#idleTimeoutMs <= 0) {
      return [];
    }
    const cutoff = this.#now() - this.#idleTimeoutMs;
    const stale = [...this.#sessions.entries()]
      .filter(([, record]) => record.lastUsed < cutoff)
      .map(([id]) => id);
    await Promise.all(stale.map((id) => this.closeSession(id)));
    return stale;
  }

  /** Start an interval that evicts idle sessions. No-op if eviction is disabled. */
  startIdleSweeper(intervalMs = 30_000): void {
    if (this.#idleTimeoutMs <= 0 || this.#sweepTimer !== null) {
      return;
    }
    this.#sweepTimer = setInterval(() => {
      void this.sweepIdle();
    }, intervalMs);
    // Don't let the sweeper keep the process alive on its own.
    this.#sweepTimer.unref();
  }

  stopIdleSweeper(): void {
    if (this.#sweepTimer !== null) {
      clearInterval(this.#sweepTimer);
      this.#sweepTimer = null;
    }
  }

  /** Close every session and the shared browser. Safe to call more than once. */
  async closeAll(): Promise<void> {
    this.stopIdleSweeper();
    const records = [...this.#sessions.values()];
    this.#sessions.clear();
    await Promise.all(records.map((record) => record.session.close()));
    if (this.#browser !== null) {
      const browser = this.#browser;
      this.#browser = null;
      await browser.close();
    }
  }
}
