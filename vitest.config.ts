import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.ts"],
      // Entry/wiring adapters are exercised by the gated integration path, not
      // unit tests; the logic lives in the manager/session/policy/config modules.
      exclude: [
        "src/index.ts",
        "src/cli.ts",
        "src/playwright-launcher.ts",
        "src/transport/stdio.ts",
      ],
    },
  },
});
