# Engineering conventions — concurrent-playwright-mcp

Conventions for humans and AI agents working in this repo. Keep changes consistent with this file.

## Cross-cutting principles (shared across all portfolio repos)

- **Clean architecture, one direction.** Domain logic does not depend on transport. Here:
  `SessionManager`/`BrowserSession` (domain) know nothing about MCP; `server.ts` (transport) is a
  thin delegate. Never leak transport shapes (MCP `content`) into the domain.
- **Dependency inversion at the seams that need testing.** The browser is injected as a
  `BrowserLauncher` so the isolation logic is unit-testable with fakes. Inject only where it buys
  testability or swappability; do not add abstraction layers a small tool does not need.
- **Right-size it.** SOLID and separation, yes; speculative managers/factories/interfaces, no.
  Heavy ceremony hurts readability and AI codegen alike.
- **TDD the real logic.** Write tests first for the logic that matters (session isolation,
  lifecycle, eviction, error paths). Do not chase coverage on thin pass-throughs to a library.
- **Errors are explicit and typed.** Named error classes (`SessionNotFoundError`, ...), never
  silent failure. At the transport edge, report failures in-band (`isError`), never throw across
  the wire.
- **Secrets hygiene.** No secrets in the repo. `.env` is gitignored from commit #1. This server
  takes none, but the rule stands.

## Stack and tooling

- **Language/runtime:** TypeScript (strict) on Node 20+, **ESM only** (`"type": "module"`).
- **Imports:** relative imports carry the `.js` extension (NodeNext resolution).
- **MCP:** `@modelcontextprotocol/sdk` v1.x with the high-level `McpServer` + `registerTool`.
  `inputSchema` is a **raw Zod shape** (`{ a: z.string() }`), not `z.object({...})`. Subpath imports
  use `.js` (`.../server/mcp.js`). A stdio server **must not write to stdout** (it is the JSON-RPC
  channel) — log to stderr.
- **Browser:** Playwright. One shared `Browser`, one isolated `BrowserContext` per session. Always
  `await` closes; clean up on `SIGINT`/`SIGTERM`. Bound resources (session cap + idle eviction).
- **Build:** tsup (ESM, `dts`, sourcemaps). **Types:** `tsc --noEmit`. **Lint:** ESLint flat config
  (`strictTypeChecked` + `stylisticTypeChecked`) + Prettier (separate step). **Tests:** Vitest.

## TypeScript rules

- `strict` plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`,
  `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`. No `any`; use `unknown` + narrowing.
- No non-null assertions (`!`). Narrow with explicit `=== undefined` / `=== null` checks.
- `exactOptionalPropertyTypes` is on: build optional fields conditionally rather than passing
  `{ key: undefined }`.
- Template literals take strings: wrap numbers with `String(n)` (matches `restrict-template-expressions`).
- Prefer `??` over `||` for defaults.

## Layout

```
src/
  cli.ts                 entrypoint (shebang); env config + stdio + signal handling
  server.ts              MCP tool registration (transport edge)
  session-manager.ts     shared browser + isolated sessions (domain core)
  session.ts             one isolated context: page lifecycle, ops, capture
  playwright-launcher.ts production BrowserLauncher
  index.ts               public library barrel
test/
  session-manager.test.ts  unit tests (fake browser) — the isolation guarantee
  integration.test.ts      real-Chromium, gated by RUN_INTEGRATION=1
scripts/
  benchmark.ts  demo.ts
```

## Definition of done

- `npm run check` is green (typecheck + lint + unit tests).
- New domain logic has unit tests written first.
- Public API changes are reflected in `index.ts` and the README tool list.
- `npm run build` succeeds; secret-scan clean; README explains problem → architecture → demo.
