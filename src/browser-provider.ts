import type { Browser } from "playwright";

/**
 * Launches and returns a browser. Injected into {@link BrowserProvider} so the
 * lifecycle/isolation logic can be exercised with a fake browser in unit tests,
 * while production wires in a real Playwright launcher.
 */
export type BrowserLauncher = () => Promise<Browser>;

/**
 * Owns a single shared browser process: launched lazily on first use, memoized,
 * and relaunched transparently if it disconnects. One provider can back many
 * {@link import("./session-manager").SessionManager}s (e.g. one per HTTP client)
 * so they share a single Chromium while keeping isolated session namespaces.
 */
export class BrowserProvider {
  readonly #launch: BrowserLauncher;
  #browser: Browser | null = null;
  #launchInFlight: Promise<Browser> | null = null;

  constructor(launch: BrowserLauncher) {
    this.#launch = launch;
  }

  /** The shared browser, launched (or relaunched after a disconnect) as needed. */
  async acquire(): Promise<Browser> {
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

  /** Close the shared browser if one is open. Safe to call more than once. */
  async close(): Promise<void> {
    // Await any launch still in flight so a browser started concurrently with
    // shutdown is not orphaned.
    const inFlight = this.#launchInFlight;
    if (inFlight !== null) {
      try {
        await inFlight;
      } catch {
        // A failed launch has nothing to close.
      }
    }
    const browser = this.#browser;
    this.#browser = null;
    if (browser !== null) {
      await browser.close();
    }
  }
}
