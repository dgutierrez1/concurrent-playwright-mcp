import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  format: ["esm"],
  // The CLI is an executable, not an importable surface, so it needs no .d.ts.
  dts: { entry: "src/index.ts" },
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: "node20",
  outDir: "dist",
});
