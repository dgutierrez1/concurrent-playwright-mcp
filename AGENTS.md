# Engineering conventions — concurrent-playwright-mcp

Conventions for humans and AI agents working in this repo. Keep changes consistent with this file.

## Cross-cutting principles

- **Clean architecture, one direction.** Domain logic does not depend on transport. Here:
  `SessionManager`/`BrowserSession` (domain) know nothing about MCP; `server.ts` (transport) is a
  thin delegate. Never leak transport shapes (MCP `content`) into the domain.
- **Parse, don't validate.** Untrusted input is validated and shaped at the edge (`server.ts` via
  Zod, with `.default()` for defaults); inner layers receive complete, typed values and keep only
  genuine domain-state checks (a session/tab lookup miss). Use `as` only to bridge external
  (Playwright) types, never to skip a real check.
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
- **Imports:** extensionless relative imports (`moduleResolution: bundler`; the output is bundled by
  tsup). SDK subpath imports keep their published `.js` (`.../server/mcp.js`).
- **MCP:** `@modelcontextprotocol/sdk` v1.x with the high-level `McpServer` + `registerTool`.
  `inputSchema` is a **raw Zod shape** (`{ a: z.string() }`), not `z.object({...})`. Transports:
  stdio (default) and Streamable HTTP. A stdio server **must not write to stdout** (it is the
  JSON-RPC channel) — log to stderr.
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
  cli.ts                 entrypoint (shebang); load config → pick transport
  config.ts              env parsing/validation into a typed AppConfig
  transport/stdio.ts     run over stdio
  transport/http.ts      run Streamable HTTP (manager per client, shared browser)
  server.ts              MCP edge: Zod validation + defaults, ref targeting, error map
  policy/url-policy.ts   pure URL policy (allowlist, file:/data: blocking)
  policy/path-policy.ts  pure filesystem path confinement
  errors.ts              error taxonomy: SessionError base + codes
  browser-provider.ts    shared lazy/memoized Browser (a port)
  session-manager.ts     isolated sessions over a BrowserProvider (domain core)
  session.ts             one isolated context: ref actions, capture, storage state
  playwright-launcher.ts production BrowserLauncher
  index.ts               public library barrel
test/
  session-manager.test.ts  unit (fake browser) — lifecycle/eviction/bounds
  browser-provider.test.ts unit (fake browser) — lazy/memoize/relaunch
  session.test.ts          unit (fake context/page) — capture, tabs, dialogs
  server.test.ts           in-memory MCP round-trip — wiring + error mapping + policy
  transport-http.test.ts   HTTP round-trip + per-client isolation (no Chromium)
  policy/*.test.ts errors.test.ts config.test.ts  pure-unit coverage
  integration.test.ts      real-Chromium isolation, gated by RUN_INTEGRATION=1
  e2e.test.ts              multiple deterministic journeys THROUGH the MCP server, RUN_INTEGRATION=1
  fixtures/app.ts          styled multi-page app served in-process for the e2e (offline)
scripts/
  benchmark.ts  demo.ts
```

Test tiers: unit (the merge gate) → deterministic real-Chromium integration + e2e through the MCP
server (gated by `RUN_INTEGRATION=1`, also run in CI).

## Definition of done

- `npm run check` is green (typecheck + lint + unit tests).
- New domain logic has unit tests written first.
- Public API changes are reflected in `index.ts` and the README tool list.
- `npm run build` succeeds; secret-scan clean; README explains problem → architecture → demo.
