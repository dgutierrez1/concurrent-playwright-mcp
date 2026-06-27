import { chromium } from "playwright";
import type { LaunchOptions as PlaywrightLaunchOptions } from "playwright";
import type { BrowserLauncher } from "./browser-provider";

export interface LaunchOptions {
  /** Run without a visible window. Defaults to true (right for servers/CI). */
  headless?: boolean;
  /** Path to a specific Chromium build, if not using Playwright's bundled one. */
  executablePath?: string;
}

/**
 * Production {@link BrowserLauncher} backed by Playwright's bundled Chromium.
 * Returned as a factory so launch options are captured once at startup.
 */
export function chromiumLauncher(options: LaunchOptions = {}): BrowserLauncher {
  const { headless = true, executablePath } = options;
  return () => {
    const launchOptions: PlaywrightLaunchOptions = { headless };
    if (executablePath !== undefined) {
      launchOptions.executablePath = executablePath;
    }
    return chromium.launch(launchOptions);
  };
}
