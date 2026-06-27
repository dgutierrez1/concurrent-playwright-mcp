import { writeFile } from "node:fs/promises";
import { BrowserProvider } from "../src/browser-provider";
import { chromiumLauncher } from "../src/playwright-launcher";
import { SessionManager } from "../src/session-manager";

/**
 * Demo: two agents, two isolated browsers, at the same time. One drives a
 * desktop viewport and one a mobile viewport against the same site, each takes
 * its own screenshot, and the two never share state. Set PW_HEADLESS=false to
 * watch the windows. Requires network access (loads example.com).
 *
 * Usage: npm run demo
 */
const headless = process.env.PW_HEADLESS !== "false";
const target = process.env.DEMO_URL ?? "https://example.com";

async function main(): Promise<void> {
  const provider = new BrowserProvider(chromiumLauncher({ headless }));
  const manager = new SessionManager(provider);

  console.log(`Opening two isolated sessions against ${target} ...`);
  await Promise.all([
    manager.createSession("desktop", { viewport: { width: 1440, height: 900 } }),
    manager.createSession("mobile", { viewport: { width: 375, height: 812 } }),
  ]);
  console.log(`Live sessions: ${JSON.stringify(manager.ids())}`);

  await Promise.all([
    manager.get("desktop").navigate(target),
    manager.get("mobile").navigate(target),
  ]);

  const [desktopTitle, mobileWidth] = await Promise.all([
    manager.get("desktop").evaluate("document.title"),
    manager.get("mobile").evaluate("window.innerWidth"),
  ]);
  console.log(`desktop page title: ${JSON.stringify(desktopTitle)}`);
  console.log(`mobile innerWidth:  ${JSON.stringify(mobileWidth)}`);

  const [desktopPng, mobilePng] = await Promise.all([
    manager.get("desktop").screenshot(false),
    manager.get("mobile").screenshot(false),
  ]);
  await Promise.all([
    writeFile("demo-desktop.png", desktopPng),
    writeFile("demo-mobile.png", mobilePng),
  ]);
  console.log("Saved demo-desktop.png and demo-mobile.png.");

  await manager.closeAll();
  await provider.close();
  console.log("Closed all sessions.");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
