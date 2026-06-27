import { describe, expect, it, vi } from "vitest";
import type { BrowserContext } from "playwright";
import { BrowserSession } from "../src/session";
import { ElementRefError, TabLimitError, TabOutOfRangeError } from "../src/errors";

/**
 * Minimal fakes for the slice of Playwright {@link BrowserContext}/Page that
 * {@link BrowserSession} touches, with a tiny event emitter so tests can drive
 * console/response/dialog/page events. Cast to the real types at the boundary.
 */
type Handler = (arg: unknown) => void;

class FakePage {
  closed = false;
  goBackResult: unknown = null;
  /** How many elements an `aria-ref=` locator resolves to (0 = stale ref). */
  locatorCount = 1;
  readonly #listeners = new Map<string, Handler[]>();

  on(event: string, handler: Handler): void {
    const existing = this.#listeners.get(event) ?? [];
    existing.push(handler);
    this.#listeners.set(event, existing);
  }

  emit(event: string, arg: unknown): void {
    for (const handler of this.#listeners.get(event) ?? []) {
      handler(arg);
    }
  }

  isClosed(): boolean {
    return this.closed;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  async goBack(): Promise<unknown> {
    return this.goBackResult;
  }
  url(): string {
    return "about:blank";
  }
  async title(): Promise<string> {
    return "title";
  }
  async bringToFront(): Promise<void> {
    /* no-op */
  }
  locator(): unknown {
    const noop = (): Promise<void> => Promise.resolve();
    return {
      count: (): Promise<number> => Promise.resolve(this.locatorCount),
      click: noop,
      fill: noop,
      hover: noop,
      selectOption: (): Promise<string[]> => Promise.resolve([]),
      setInputFiles: noop,
      dragTo: noop,
    };
  }
}

class FakeContext {
  readonly pagesList: FakePage[] = [];
  readonly #pageListeners: ((page: FakePage) => void)[] = [];

  on(event: string, handler: (page: FakePage) => void): void {
    if (event === "page") {
      this.#pageListeners.push(handler);
    }
  }

  async newPage(): Promise<FakePage> {
    const page = new FakePage();
    this.pagesList.push(page);
    for (const listener of this.#pageListeners) {
      listener(page);
    }
    return page;
  }

  pages(): FakePage[] {
    return this.pagesList;
  }

  async close(): Promise<void> {
    /* no-op */
  }
}

function makeSession(options?: { maxTabs?: number; maxCaptureEntries?: number }): {
  session: BrowserSession;
  context: FakeContext;
} {
  const context = new FakeContext();
  const session = new BrowserSession(context as unknown as BrowserContext, options);
  return { session, context };
}

const consoleMsg = (type: string, text: string): unknown => ({
  type: () => type,
  text: () => text,
});

const response = (url: string): unknown => ({
  url: () => url,
  request: () => ({ method: () => "GET" }),
  status: () => 200,
});

describe("BrowserSession page lifecycle", () => {
  it("reuses the active page, and recreates it after it closes", async () => {
    const { session, context } = makeSession();
    const first = await session.page();
    expect(await session.page()).toBe(first);

    await first.close();
    const second = await session.page();
    expect(second).not.toBe(first);
    expect(context.pagesList).toHaveLength(2);
  });
});

describe("BrowserSession capture", () => {
  it("captures console messages and filters to errors", async () => {
    const { session, context } = makeSession();
    await session.page();
    const page = context.pagesList[0];
    page?.emit("console", consoleMsg("log", "hello"));
    page?.emit("console", consoleMsg("error", "boom"));

    expect(session.consoleMessages(false)).toHaveLength(2);
    const errorsOnly = session.consoleMessages(true);
    expect(errorsOnly).toHaveLength(1);
    expect(errorsOnly[0]?.text).toBe("boom");
  });

  it("caps capture buffers at maxCaptureEntries (drop-oldest)", async () => {
    const { session, context } = makeSession({ maxCaptureEntries: 3 });
    await session.page();
    const page = context.pagesList[0];
    for (let i = 0; i < 5; i++) {
      page?.emit("console", consoleMsg("log", `m${String(i)}`));
    }
    const texts = session.consoleMessages(false).map((m) => m.text);
    expect(texts).toEqual(["m2", "m3", "m4"]);
  });

  it("attaches capture to tabs opened later (not just the first page)", async () => {
    const { session, context } = makeSession();
    await session.newTab();
    const tab = context.pagesList[0];
    tab?.emit("response", response("https://example.com/api"));
    expect(session.networkResponses().map((r) => r.url)).toContain("https://example.com/api");
  });
});

describe("BrowserSession tabs", () => {
  it("opens tabs up to the cap, then throws TabLimitError", async () => {
    const { session } = makeSession({ maxTabs: 2 });
    expect(await session.newTab()).toBe(0);
    expect(await session.newTab()).toBe(1);
    await expect(session.newTab()).rejects.toBeInstanceOf(TabLimitError);
  });

  it("throws TabOutOfRangeError for an unknown tab index", async () => {
    const { session } = makeSession();
    await session.page();
    await expect(session.closeTab(5)).rejects.toBeInstanceOf(TabOutOfRangeError);
  });
});

describe("BrowserSession dialogs", () => {
  it("auto-dismisses by default, applies a one-shot decision, then resumes auto-dismiss", async () => {
    const { session, context } = makeSession();
    await session.page();
    const page = context.pagesList[0];

    const d1 = { accept: vi.fn(async () => undefined), dismiss: vi.fn(async () => undefined) };
    page?.emit("dialog", d1);
    expect(d1.dismiss).toHaveBeenCalledTimes(1);
    expect(d1.accept).not.toHaveBeenCalled();

    await session.handleDialog(true, "yes");
    const d2 = { accept: vi.fn(async () => undefined), dismiss: vi.fn(async () => undefined) };
    page?.emit("dialog", d2);
    expect(d2.accept).toHaveBeenCalledWith("yes");

    const d3 = { accept: vi.fn(async () => undefined), dismiss: vi.fn(async () => undefined) };
    page?.emit("dialog", d3);
    expect(d3.dismiss).toHaveBeenCalledTimes(1);
  });
});

describe("BrowserSession navigation", () => {
  it("navigateBack reports whether it actually moved", async () => {
    const { session, context } = makeSession();
    await session.page();
    expect(await session.navigateBack()).toBe(false);

    const page = context.pagesList[0];
    if (page) {
      page.goBackResult = { ok: true };
    }
    expect(await session.navigateBack()).toBe(true);
  });
});

describe("BrowserSession ref targeting", () => {
  it("acts on a ref that resolves", async () => {
    const { session, context } = makeSession();
    await session.page();
    const page = context.pagesList[0];
    if (page) {
      page.locatorCount = 1;
    }
    await expect(session.click({ ref: "e1", element: "OK" })).resolves.toBeUndefined();
  });

  it("throws ElementRefError (fast) when a ref resolves to nothing", async () => {
    const { session, context } = makeSession();
    await session.page();
    const page = context.pagesList[0];
    if (page) {
      page.locatorCount = 0;
    }
    await expect(session.click({ ref: "e404", element: "ghost" })).rejects.toBeInstanceOf(
      ElementRefError,
    );
  });

  it("drag blames the stale ref", async () => {
    const { session, context } = makeSession();
    await session.page();
    const page = context.pagesList[0];
    if (page) {
      page.locatorCount = 0;
    }
    await expect(
      session.drag({ ref: "eSrc", element: "source" }, { ref: "eDst", element: "dest" }),
    ).rejects.toBeInstanceOf(ElementRefError);
  });
});
