import type { BrowserContext, Page } from "playwright";
import { TabLimitError, TabOutOfRangeError } from "./errors.js";

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
  status?: number;
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

/** Tuning knobs for a single session's resource bounds. */
export interface BrowserSessionOptions {
  /** Hard cap on tabs in this session; opening past it throws. */
  maxTabs?: number;
  /** Max console/network entries retained (ring buffer, drop-oldest). */
  maxCaptureEntries?: number;
}

const DEFAULT_MAX_TABS = 20;
const DEFAULT_MAX_CAPTURE_ENTRIES = 1000;

/** A pending decision for the next dialog, set by {@link BrowserSession.handleDialog}. */
interface DialogDecision {
  accept: boolean;
  promptText?: string;
}

/**
 * One isolated browser session: a single Playwright {@link BrowserContext}
 * plus the active page and the console/network captured against it.
 *
 * The session owns no cross-session state, which is what makes the isolation
 * guarantee in {@link import("./session-manager.js").SessionManager} hold: two
 * sessions never share a context, cookies, storage, or capture buffers.
 *
 * Methods return typed data, not transport-shaped payloads. Formatting results
 * for a specific transport (e.g. MCP text content) is the caller's job.
 */
export class BrowserSession {
  readonly #context: BrowserContext;
  readonly #maxTabs: number;
  readonly #maxCaptureEntries: number;
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

  async navigate(url: string): Promise<void> {
    await (await this.page()).goto(url);
  }

  /** Go back; returns false if there was no previous page in history. */
  async navigateBack(): Promise<boolean> {
    return (await (await this.page()).goBack()) !== null;
  }

  async click(selector: string): Promise<void> {
    await (await this.page()).click(selector);
  }

  async type(selector: string, text: string): Promise<void> {
    await (await this.page()).fill(selector, text);
  }

  async hover(selector: string): Promise<void> {
    await (await this.page()).hover(selector);
  }

  async pressKey(key: string): Promise<void> {
    await (await this.page()).keyboard.press(key);
  }

  async selectOption(selector: string, values: string[]): Promise<string[]> {
    return (await this.page()).selectOption(selector, values);
  }

  async fillForm(fields: readonly { selector: string; value: string }[]): Promise<void> {
    const page = await this.page();
    for (const field of fields) {
      await page.fill(field.selector, field.value);
    }
  }

  async fileUpload(selector: string, paths: string[]): Promise<void> {
    await (await this.page()).setInputFiles(selector, paths);
  }

  async drag(sourceSelector: string, targetSelector: string): Promise<void> {
    await (await this.page()).dragAndDrop(sourceSelector, targetSelector);
  }

  async resize(width: number, height: number): Promise<void> {
    await (await this.page()).setViewportSize({ width, height });
  }

  async screenshot(path: string, fullPage = false): Promise<void> {
    await (await this.page()).screenshot({ path, fullPage });
  }

  /** ARIA accessibility snapshot of the active page (YAML), for agent grounding. */
  async snapshot(): Promise<string> {
    return (await this.page()).locator("body").ariaSnapshot();
  }

  async evaluate(script: string): Promise<unknown> {
    return (await this.page()).evaluate(script);
  }

  async waitFor(
    selector: string,
    state: WaitForState = "visible",
    timeoutMs = 30_000,
  ): Promise<void> {
    await (await this.page()).waitForSelector(selector, { state, timeout: timeoutMs });
  }

  /** Console messages captured so far, optionally filtered to errors only. */
  consoleMessages(onlyErrors = false): ConsoleMessage[] {
    if (!onlyErrors) {
      return [...this.#consoleMessages];
    }
    return this.#consoleMessages.filter((m) => m.type === "error");
  }

  /** Network responses captured so far. */
  networkResponses(): NetworkResponse[] {
    return [...this.#networkResponses];
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
