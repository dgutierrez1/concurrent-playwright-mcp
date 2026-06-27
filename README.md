# concurrent-playwright-mcp

An [MCP](https://modelcontextprotocol.io) server that runs **concurrent, session-isolated Playwright browser contexts**, so many agents can each drive their own browser at the same time without colliding.

## The problem this solves

The stock Playwright MCP server multiplexes everything through a single shared browser context. That is fine for one agent doing one thing, but it breaks the moment you want **parallel** work:

- Two sub-agents navigating at once stomp on each other's page, cookies, and storage.
- A "log in as user A" flow and a "log in as user B" flow share one cookie jar, so the second login clobbers the first.
- There is no clean way to give each task its own sandbox and tear it down independently.

This server fixes that. Every session gets its **own** `BrowserContext` (an incognito-like profile: isolated cookies, `localStorage`, cache, and tabs) keyed by a `sessionId` you choose. Sessions share one browser process for efficiency but never share state. The headline guarantee is verified by a real-browser test and a benchmark that asserts **zero cross-session collisions**.

|                      | Stock Playwright MCP | concurrent-playwright-mcp            |
| -------------------- | -------------------- | ------------------------------------ |
| Parallel sessions    | Shared context       | Isolated context per `sessionId`     |
| Cookies / storage    | Shared               | Isolated per session                 |
| Independent teardown | No                   | `browser_close_session` per session  |
| Resource bounds      | n/a                  | Session cap + optional idle eviction |

## Architecture

```
cli.ts                  entrypoint: load config → pick transport
  ├─ config.ts          parse + validate env into a typed config
  ├─ transport/stdio.ts run over stdio (default)
  ├─ transport/http.ts  run Streamable HTTP: a session manager per client, one shared browser
  ├─ browser-provider.ts  the shared, lazily-launched, memoized Browser (a port)
  └─ server.ts          MCP edge: validates input (Zod), enforces policy, maps errors
       ├─ policy/url-policy.ts   navigation allowlist + file:/data: blocking (pure)
       ├─ policy/path-policy.ts  filesystem path confinement (pure)
       ├─ errors.ts             error taxonomy: SessionError base + machine-readable codes
       └─ session-manager.ts    isolated sessions over a BrowserProvider (the core)
            └─ session.ts        one isolated context: ref actions, capture, storage state
```

This is **hexagonal**: untrusted input is validated at the edge (`server.ts`) and passed inward as
typed data, so the domain (`SessionManager`/`BrowserSession`) carries no transport or re-validation
concerns and knows nothing about MCP. The browser is a port (`BrowserProvider`) injected into the
manager, so the isolation guarantee is unit-tested with a fake browser (fast, no Chromium in CI)
while a gated integration test proves it against real Chromium. The provider launches lazily and
memoizes, so a burst of concurrent `createSession` calls shares one browser; over HTTP, every client
gets its own session namespace while still sharing that one Chromium.

## Install

```bash
npm install -g concurrent-playwright-mcp
# one-time: download the browser Playwright drives
npx playwright install chromium
```

> Installing the package does not download Chromium — run `npx playwright install chromium`
> once, or the first `browser_create_session` call will fail with a Playwright hint to do so.

Or run from source:

```bash
npm install
npm run setup:browser   # playwright install chromium
npm run build
```

## Use it from an MCP client

### Over stdio (one client, e.g. Claude Desktop / Claude Code / Cursor)

Point your client at the binary; it launches one server process for that client:

```jsonc
{
  "mcpServers": {
    "concurrent-playwright": {
      "command": "npx",
      "args": ["-y", "concurrent-playwright-mcp"],
      "env": {
        "PW_HEADLESS": "true",
        "PW_MAX_SESSIONS": "20",
        "PW_IDLE_TIMEOUT_MS": "300000",
      },
    },
  },
}
```

### Over HTTP (many remote / independent agents → one server)

Run one long-lived server and let multiple agent clients connect to it. Each client gets its **own
isolated session namespace** (it cannot see or touch another client's sessions), while all clients
share a single Chromium process:

```bash
PW_TRANSPORT=http PW_PORT=3000 npx -y concurrent-playwright-mcp
# clients connect to the Streamable HTTP endpoint at http://<host>:3000/
```

Most clients accept an HTTP MCP URL directly; e.g.:

```jsonc
{
  "mcpServers": {
    "concurrent-playwright": { "url": "http://localhost:3000/" },
  },
}
```

### The session-per-agent pattern

The core idea: **each agent or task uses its own `sessionId`**. Create it once, then pass it to every
call; sessions never share cookies, storage, or tabs, so parallel work can't collide. Target elements
by the `ref` ids returned from `browser_snapshot` (the accessibility tree), not raw CSS:

```
browser_create_session  { "sessionId": "userA", "viewport": { "width": 1440, "height": 900 } }
browser_create_session  { "sessionId": "userB", "viewport": { "width": 375,  "height": 812 } }   # in parallel, fully isolated
browser_navigate        { "sessionId": "userA", "url": "https://example.com" }
browser_snapshot        { "sessionId": "userA" }                       # → YAML with refs like [ref=e7]
browser_click           { "sessionId": "userA", "ref": "e7", "element": "Sign in button" }
browser_save_storage_state { "sessionId": "userA", "path": "userA.json" }   # reuse the login later
browser_close_session   { "sessionId": "userA" }
```

## Tools

Session lifecycle: `browser_create_session` (optionally seeded from a saved `storageStatePath`), `browser_list_sessions`, `browser_close_session`, `browser_save_storage_state`.

Element actions take a `ref` (from `browser_snapshot`) plus an `element` description: `browser_click`, `browser_type`, `browser_hover`, `browser_select_option`, `browser_fill_form`, `browser_file_upload`, `browser_drag`.

Other per-session tools (all take a `sessionId`): `browser_navigate`, `browser_navigate_back`, `browser_press_key`, `browser_resize`, `browser_screenshot` (returns an image), `browser_snapshot`, `browser_evaluate`, `browser_wait_for`, `browser_console_messages`, `browser_network_requests`, `browser_handle_dialog`, `browser_tabs`.

## Configuration (env vars)

Invalid values (e.g. a negative `PW_MAX_SESSIONS`) are rejected with a warning on stderr and the
default is used; the effective config is logged to stderr at startup.

| Var                  | Default     | Meaning                                                     |
| -------------------- | ----------- | ----------------------------------------------------------- |
| `PW_HEADLESS`        | `true`      | `false` to show browser windows                             |
| `PW_MAX_SESSIONS`    | `50`        | Hard cap on live sessions                                   |
| `PW_MAX_TABS`        | `20`        | Hard cap on tabs per session                                |
| `PW_MAX_CAPTURE`     | `1000`      | Max console/network entries retained per session            |
| `PW_IDLE_TIMEOUT_MS` | `0` (off)   | Evict a session after this long with no use                 |
| `PW_OUTPUT_DIR`      | `./output`  | Directory screenshots are written to (paths confined to it) |
| `PW_UPLOAD_DIR`      | unset (any) | Confine `browser_file_upload` paths to this directory       |
| `PW_ALLOWED_ORIGINS` | unset (any) | Comma-separated origin allowlist for navigation             |
| `PW_ALLOW_FILE_URLS` | `false`     | Allow `file:`/`data:` navigation                            |
| `PW_EXECUTABLE_PATH` | unset       | Use a specific Chromium build                               |
| `PW_TRANSPORT`       | `stdio`     | `http` to serve over Streamable HTTP                        |
| `PW_HOST`            | `127.0.0.1` | Host to bind in `http` mode                                 |
| `PW_PORT`            | `3000`      | Port to bind in `http` mode                                 |

## Security model

This server is **dual-use**: it hands an MCP client real control of a browser. Treat the client as
**semi-trusted** and any **page it visits as untrusted** (a hostile page can try to steer a credulous
agent into calling these tools with attacker-chosen arguments). With that in mind:

- **Navigation** (`browser_navigate`) blocks `file:` and `data:` URLs by default — the sharpest
  local-file-read / SSRF vector. Set `PW_ALLOW_FILE_URLS=true` to allow them. Set
  `PW_ALLOWED_ORIGINS` to restrict navigation to an allowlist of origins.
- **Screenshots and storage state** (`browser_screenshot` with a `path`, `browser_save_storage_state`,
  and `storageStatePath` on create) are confined to `PW_OUTPUT_DIR`; paths that try to escape it (via
  `..` or an absolute path) are rejected. Storage-state files contain cookies and may hold auth
  tokens — treat the output dir accordingly.
- **File uploads** (`browser_file_upload`) read local files. By default any path is allowed; set
  `PW_UPLOAD_DIR` to confine uploads to one directory.
- **`browser_evaluate`** runs arbitrary JavaScript in the page (sandboxed to the page, not Node). It
  is a privileged capability; the navigation allowlist is the most effective containment.
- **HTTP mode** binds `127.0.0.1` by default and gives each client an isolated session namespace;
  put it behind your own auth/proxy before exposing it beyond localhost.

Errors are reported in-band (`isError`) with a stable `code` prefix (e.g. `NAVIGATION_BLOCKED`,
`PATH_NOT_ALLOWED`, `SESSION_NOT_FOUND`), never thrown across the JSON-RPC channel.

## Demo and benchmark

```bash
npm run demo        # two isolated sessions (desktop + mobile) drive a site in parallel
npm run benchmark   # N parallel sessions, reports throughput + asserts 0 collisions
npm run benchmark 25
```

## Development

```bash
npm run check              # typecheck + lint + unit tests
npm run test:coverage      # unit tests with coverage (no browser needed)
npm run test:integration   # real-browser isolation test (needs Chromium)
npm run build              # tsup -> dist/ (ESM + d.ts)
```

See [`AGENTS.md`](./AGENTS.md) for the engineering conventions this repo is built to.

## License

MIT
