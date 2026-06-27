import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.ts"],
      // The CLI entry and the Playwright adapter are exercised by the gated
      // integration test, not unit tests; the logic lives in the manager/session.
      exclude: ["src/index.ts", "src/cli.ts", "src/playwright-launcher.ts"],
    },
  },
});
