import { describe, expect, it, vi } from "vitest";
import type { Browser } from "playwright";
import { BrowserProvider } from "../src/browser-provider";

class FakeBrowser {
  connected = true;
  closed = false;
  isConnected(): boolean {
    return this.connected;
  }
  async close(): Promise<void> {
    this.closed = true;
    this.connected = false;
  }
}

function setup(): {
  provider: BrowserProvider;
  browser: FakeBrowser;
  launch: ReturnType<typeof vi.fn>;
} {
  const browser = new FakeBrowser();
  const launch = vi.fn(async () => browser as unknown as Browser);
  return { provider: new BrowserProvider(launch), browser, launch };
}

describe("BrowserProvider", () => {
  it("launches lazily on first acquire", async () => {
    const { provider, launch } = setup();
    expect(launch).not.toHaveBeenCalled();
    await provider.acquire();
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("memoizes one browser across concurrent acquires", async () => {
    const { provider, launch } = setup();
    const browsers = await Promise.all(Array.from({ length: 8 }, () => provider.acquire()));
    expect(launch).toHaveBeenCalledTimes(1);
    expect(new Set(browsers).size).toBe(1);
  });

  it("relaunches after the browser disconnects (crash recovery)", async () => {
    const { provider, browser, launch } = setup();
    await provider.acquire();
    browser.connected = false;
    await provider.acquire();
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it("relaunches after an explicit close", async () => {
    const { provider, launch } = setup();
    await provider.acquire();
    await provider.close();
    await provider.acquire();
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it("close is a no-op when nothing is open", async () => {
    const { provider, browser } = setup();
    await provider.close();
    await provider.acquire();
    await provider.close();
    expect(browser.closed).toBe(true);
  });
});
