import type { BrowserContext, Locator, Page } from "playwright";
import { ElementRefError, TabLimitError, TabOutOfRangeError } from "./errors";

/** A console message captured from a page within a session. */
export interface ConsoleMessage {
  type: string;
  text: string;
  timestamp: number;
}

/** A network response observed within a session. */
export interface NetworkResponse {
  url: string;
  method: string;
  status: number;
  timestamp: number;
}

/** A tab (page) belonging to a session's browser context. */
export interface TabInfo {
  index: number;
  url: string;
  title: string;
}

/** States a selector can be waited for, mirroring Playwright's own set. */
export type WaitForState = "attached" | "detached" | "visible" | "hidden";

/**
 * An element targeted by a `ref` from the latest {@link BrowserSession.snapshot}.
 * `element` is a human-readable description, used only for error messages.
 */
export interface ElementTarget {
  ref: string;
  element: string;
}

/** One field to fill, targeted by ref. */
export interface FormField extends ElementTarget {
  value: string;
}

/** Tuning knobs for a single session's resource bounds and timing. */
export interface BrowserSessionOptions {
  /** Hard cap on tabs in this session; opening past it throws. */
  maxTabs?: number;
  /** Max console/network entries retained (ring buffer, drop-oldest). */
  maxCaptureEntries?: number;
  /** Per-action timeout (ms) for element interactions. */
  actionTimeoutMs?: number;
}

/** Defaults for a session; the single source of truth, re-exported by the manager. */
export const DEFAULT_MAX_TABS = 20;
export const DEFAULT_MAX_CAPTURE_ENTRIES = 1000;
export const DEFAULT_ACTION_TIMEOUT_MS = 15_000;

/** A pending decision for the next dialog, set by {@link BrowserSession.handleDialog}. */
interface DialogDecision {
  accept: boolean;
  promptText?: string;
}

/**
 * One isolated browser session: a single Playwright {@link BrowserContext}
 * plus the active page and the console/network captured against it.
 *
 * Elements are targeted by `ref` ids from {@link snapshot} (the accessibility
 * tree), resolved through Playwright's `aria-ref=` engine — the same model the
 * official Playwright MCP uses, more reliable than raw CSS for agents.
 *
 * The session owns no cross-session state, which is what makes the isolation
 * guarantee in {@link import("./session-manager").SessionManager} hold: two
 * sessions never share a context, cookies, storage, or capture buffers.
 *
 * Methods return typed data, not transport-shaped payloads. Formatting results
 * for a specific transport (e.g. MCP text content) is the caller's job.
 */
export class BrowserSession {
  readonly #context: BrowserContext;
  readonly #maxTabs: number;
  readonly #maxCaptureEntries: number;
  readonly #actionTimeoutMs: number;
  #activePage: Page | null = null;
  readonly #consoleMessages: ConsoleMessage[] = [];
  readonly #networkResponses: NetworkResponse[] = [];
  /** Pages already wired for capture, so attaching is idempotent. */
  readonly #wired = new WeakSet<Page>();
  /** Decision for the next dialog (any page); consumed once, then auto-dismiss resumes. */
  #nextDialog: DialogDecision | null = null;

  constructor(context: BrowserContext, options: BrowserSessionOptions = {}) {
    this.#context = context;
    this.#maxTabs = options.maxTabs ?? DEFAULT_MAX_TABS;
    this.#maxCaptureEntries = options.maxCaptureEntries ?? DEFAULT_MAX_CAPTURE_ENTRIES;
    this.#actionTimeoutMs = options.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
    // Wire capture for every page the context ever owns — new tabs, popups
    // (window.open / target=_blank), and the lazily-created first page alike.
    this.#context.on("page", (page) => {
      this.#attachCapture(page);
    });
  }

  /**
   * Return the active page, creating one (with capture listeners attached) on
   * first use. Subsequent calls reuse it unless it was closed, in which case a
   * fresh page is created so the session stays usable.
   */
  async page(): Promise<Page> {
    if (this.#activePage !== null && !this.#activePage.isClosed()) {
      return this.#activePage;
    }
    const page = await this.#context.newPage();
    // The "page" event usually wires this already; the explicit call makes it
    // deterministic regardless of event ordering (idempotent via #wired).
    this.#attachCapture(page);
    this.#activePage = page;
    return page;
  }

  #attachCapture(page: Page): void {
    if (this.#wired.has(page)) {
      return;
    }
    this.#wired.add(page);
    page.on("console", (msg) => {
      this.#pushCapped(this.#consoleMessages, {
        type: msg.type(),
        text: msg.text(),
        timestamp: Date.now(),
      });
    });
    page.on("response", (response) => {
      this.#pushCapped(this.#networkResponses, {
        url: response.url(),
        method: response.request().method(),
        status: response.status(),
        timestamp: Date.now(),
      });
    });
    // Apply a one-shot decision from handleDialog() if one is pending; otherwise
    // auto-dismiss so a stray alert/confirm can never wedge the session.
    page.on("dialog", (dialog) => {
      const decision = this.#nextDialog;
      this.#nextDialog = null;
      const outcome =
        decision !== null
          ? decision.accept
            ? dialog.accept(decision.promptText)
            : dialog.dismiss()
          : dialog.dismiss();
      outcome.catch(() => {
        // Dialog may already be gone; nothing actionable to do.
      });
    });
  }

  /** Append to a capture buffer, dropping the oldest entry past the cap. */
  #pushCapped<T>(buffer: T[], entry: T): void {
    buffer.push(entry);
    if (buffer.length > this.#maxCaptureEntries) {
      buffer.shift();
    }
  }

  /**
   * Resolve a snapshot `ref` to a locator and run `act`. A missing/stale ref is
   * detected up front (the `aria-ref=` engine matches zero elements) and turned
   * into a clear {@link ElementRefError} instead of waiting out the action
   * timeout — so a real action failure (e.g. a disabled element) surfaces as its
   * own Playwright error rather than being mislabeled as a bad ref.
   */
  async #onRef<T>(target: ElementTarget, act: (locator: Locator) => Promise<T>): Promise<T> {
    const locator = (await this.page()).locator(`aria-ref=${target.ref}`);
    if ((await locator.count()) === 0) {
      throw new ElementRefError(target.ref, target.element);
    }
    return act(locator);
  }

  async navigate(url: string): Promise<void> {
    await (await this.page()).goto(url);
  }

  /** Go back; returns false if there was no previous page in history. */
  async navigateBack(): Promise<boolean> {
    return (await (await this.page()).goBack()) !== null;
  }

  async click(target: ElementTarget): Promise<void> {
    await this.#onRef(target, (locator) => locator.click({ timeout: this.#actionTimeoutMs }));
  }

  async type(target: ElementTarget, text: string): Promise<void> {
    await this.#onRef(target, (locator) => locator.fill(text, { timeout: this.#actionTimeoutMs }));
  }

  async hover(target: ElementTarget): Promise<void> {
    await this.#onRef(target, (locator) => locator.hover({ timeout: this.#actionTimeoutMs }));
  }

  async pressKey(key: string): Promise<void> {
    await (await this.page()).keyboard.press(key);
  }

  async selectOption(target: ElementTarget, values: string[]): Promise<string[]> {
    return this.#onRef(target, (locator) =>
      locator.selectOption(values, { timeout: this.#actionTimeoutMs }),
    );
  }

  async fillForm(fields: readonly FormField[]): Promise<void> {
    for (const field of fields) {
      await this.#onRef(field, (locator) =>
        locator.fill(field.value, { timeout: this.#actionTimeoutMs }),
      );
    }
  }

  async fileUpload(target: ElementTarget, paths: string[]): Promise<void> {
    await this.#onRef(target, (locator) =>
      locator.setInputFiles(paths, { timeout: this.#actionTimeoutMs }),
    );
  }

  async drag(source: ElementTarget, dest: ElementTarget): Promise<void> {
    const page = await this.page();
    const from = page.locator(`aria-ref=${source.ref}`);
    const to = page.locator(`aria-ref=${dest.ref}`);
    // Fail fast on whichever ref is stale, so the error names the right element.
    if ((await from.count()) === 0) {
      throw new ElementRefError(source.ref, source.element);
    }
    if ((await to.count()) === 0) {
      throw new ElementRefError(dest.ref, dest.element);
    }
    await from.dragTo(to, { timeout: this.#actionTimeoutMs });
  }

  async resize(width: number, height: number): Promise<void> {
    await (await this.page()).setViewportSize({ width, height });
  }

  /** Capture a PNG of the active page and return the bytes. */
  async screenshot(fullPage: boolean): Promise<Buffer> {
    return (await this.page()).screenshot({ fullPage });
  }

  /** Accessibility snapshot of the active page (YAML with element refs). */
  async snapshot(): Promise<string> {
    return (await this.page()).locator("body").ariaSnapshot({ mode: "ai" });
  }

  async evaluate(script: string): Promise<unknown> {
    return (await this.page()).evaluate(script);
  }

  async waitFor(selector: string, state: WaitForState, timeoutMs: number): Promise<void> {
    await (await this.page()).waitForSelector(selector, { state, timeout: timeoutMs });
  }

  /** Console messages captured so far, optionally filtered to errors only. */
  consoleMessages(onlyErrors: boolean): ConsoleMessage[] {
    if (!onlyErrors) {
      return [...this.#consoleMessages];
    }
    return this.#consoleMessages.filter((m) => m.type === "error");
  }

  /** Network responses captured so far. */
  networkResponses(): NetworkResponse[] {
    return [...this.#networkResponses];
  }

  /** Write this session's cookies + localStorage to a Playwright storageState file. */
  async saveStorageState(path: string): Promise<void> {
    await this.#context.storageState({ path });
  }

  /**
   * Decide the next dialog (alert/confirm/prompt) instead of auto-dismissing it.
   * Applies once, to whichever page raises the next dialog; afterwards the
   * auto-dismiss default resumes.
   */
  async handleDialog(accept: boolean, promptText?: string): Promise<void> {
    // Ensure at least one page exists so a dialog handler is wired.
    await this.page();
    this.#nextDialog = promptText === undefined ? { accept } : { accept, promptText };
  }

  /** List the tabs (pages) currently open in this session's context. */
  async listTabs(): Promise<TabInfo[]> {
    const pages = this.#context.pages();
    return Promise.all(
      pages.map(async (p, index) => ({
        index,
        url: p.url(),
        title: await p.title(),
      })),
    );
  }

  /** Open a new tab and return its index. Throws past the per-session tab cap. */
  async newTab(): Promise<number> {
    if (this.#context.pages().length >= this.#maxTabs) {
      throw new TabLimitError(this.#maxTabs);
    }
    await this.#context.newPage();
    return this.#context.pages().length - 1;
  }

  async closeTab(index: number): Promise<void> {
    const page = this.#tabAt(index);
    await page.close();
  }

  /** Make an existing tab the active page for subsequent operations. */
  async selectTab(index: number): Promise<void> {
    const page = this.#tabAt(index);
    this.#activePage = page;
    await page.bringToFront();
  }

  #tabAt(index: number): Page {
    const pages = this.#context.pages();
    const page = pages[index];
    if (page === undefined) {
      throw new TabOutOfRangeError(index, pages.length);
    }
    return page;
  }

  /** Close the underlying context and release its resources. */
  async close(): Promise<void> {
    await this.#context.close();
  }
}
