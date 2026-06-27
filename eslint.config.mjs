// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier/flat";

export default tseslint.config(
  { ignores: ["dist/**", "coverage/**", "node_modules/**"] },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // Plain JS/MJS config files: no type-aware linting.
  {
    files: ["**/*.js", "**/*.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
  },

  // Test fakes legitimately implement async-shaped interface methods that have
  // no await; require-await is noise here while staying strict in src.
  {
    files: ["test/**/*.ts"],
    rules: { "@typescript-eslint/require-await": "off" },
  },

  // MUST be last: turns off rules that conflict with Prettier.
  eslintConfigPrettier,
);
