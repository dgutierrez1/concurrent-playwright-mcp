# concurrent-playwright-mcp

An [MCP](https://modelcontextprotocol.io) server that runs **concurrent, session-isolated Playwright browser contexts**, so many agents can each drive their own browser at the same time without colliding.

## The problem this solves

The official Playwright MCP server (`@playwright/mcp`) drives a single shared browser context by default, so concurrent clients share one cookie jar, storage, and set of tabs. That is fine for one agent doing one thing, but it breaks the moment you want **parallel** work:

- Two sub-agents navigating at once stomp on each other's page, cookies, and storage.
- A "log in as user A" flow and a "log in as user B" flow share one cookie jar, so the second login clobbers the first.
- There is no clean way to give each task its own sandbox and tear it down independently.

This server fixes that. Every session gets its **own** `BrowserContext` (an incognito-like profile: isolated cookies, `localStorage`, cache, and tabs) keyed by a `sessionId` you choose. Sessions share one browser process for efficiency but never share state. The headline guarantee is verified by a real-browser test and a benchmark that asserts **zero cross-session collisions**.

|                      | `@playwright/mcp` (default) | concurrent-playwright-mcp            |
| -------------------- | --------------------------- | ------------------------------------ |
| Parallel sessions    | Shared context              | Isolated context per `sessionId`     |
| Cookies / storage    | Shared                      | Isolated per session                 |
| Independent teardown | No                          | `browser_close_session` per session  |
| Resource bounds      | n/a                         | Session cap + optional idle eviction |

### Why not `@playwright/mcp --isolated`?

The official server can isolate too — its `--isolated` flag gives each *connection* its own context. The difference is the model:

- **Addressable sessions.** Here isolation is keyed by a `sessionId` you choose and pass to every call, so a single client can open and drive **many** isolated sessions and route each call deliberately. With `--isolated`, a "session" is just the transport connection — you can't address N parallel contexts from one client.
- **Persistable, not ephemeral.** `--isolated` discards all state when the browser closes. Here you can `browser_save_storage_state` and restore it (`storageStatePath` on create) to resume an authenticated profile across sessions. (An upstream request for named/persistent sessions was closed as out of scope.)
- **One lightweight context per session** — not a process or container per session — so many sessions share one Chromium.

Use `@playwright/mcp` for a single browser; use this when many agents or tasks each need their own isolated, addressable session at the same time — especially over HTTP.

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

> **HTTP mode has no built-in authentication.** It binds `127.0.0.1` by default and rejects
> mismatched `Host` headers (DNS-rebinding protection is on), so a local web page can't drive it.
> To serve real remote clients, set `PW_HOST` and add the externally-visible host to
> `PW_ALLOWED_HOSTS` (e.g. `PW_ALLOWED_HOSTS=mcp.example.com:3000`), and put it behind your own
> authenticating proxy / network controls — anyone who can reach the port can drive a browser.

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

> Those `browser_… { … }` lines are **illustrative**, not text you type. The model emits a
> structured tool call and the client routes it over MCP; you never hand-write tool calls.

## How it works (integrating with an agent)

Three actors are involved:

- **Operator (you):** install the package + Chromium and add the config block above. That is the
  entire human surface — you don't enumerate tools or write tool calls.
- **MCP client / harness** (Claude Code, Claude Desktop, Cursor, …): spawns the server (stdio) or
  connects to it (HTTP), performs the MCP handshake, calls `tools/list` to **discover the tools and
  their schemas automatically**, and surfaces them — plus the server's built-in `instructions` — to
  the model.
- **LLM / agent:** drives the tools in a loop: allocate a `sessionId` → `browser_create_session` →
  `browser_navigate` → `browser_snapshot` (read the page, get `ref`s) → act by `ref` → … →
  `browser_close_session`.

Configuration happens at **three layers**:

| Layer                  | Set by   | Where                                                         | Examples                                                                                |
| ---------------------- | -------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Server policy & limits | operator | `env` in the client config (stdio) or the server's env (HTTP) | `PW_HEADLESS`, `PW_MAX_SESSIONS`, `PW_ALLOWED_ORIGINS`, `PW_OUTPUT_DIR`, `PW_TRANSPORT` |
| Per-session            | agent    | `browser_create_session` args                                 | `sessionId` (required), `viewport`, `storageStatePath`                                  |
| Per-call               | agent    | each tool's args                                              | `url`, `ref` + `element`, `text`, `path`, …                                             |

Security limits live **only** in the server layer — an agent can't widen them (it can't escape
`PW_OUTPUT_DIR` or bypass `PW_ALLOWED_ORIGINS`). Per-call args are validated at the edge with
defaults, so the agent can omit the optional ones.

## Tools

The agent discovers these (with full JSON schemas) via `tools/list`; this reference is for human
integrators. Optional params are marked `?`. Every tool takes `sessionId` except
`browser_list_sessions`.

**Session lifecycle**

| Tool                         | Params (besides `sessionId`)     | Returns                            |
| ---------------------------- | -------------------------------- | ---------------------------------- |
| `browser_create_session`     | `viewport?`, `storageStatePath?` | confirmation                       |
| `browser_list_sessions`      | — (takes no `sessionId`)         | JSON array of live session ids     |
| `browser_close_session`      | —                                | confirmation                       |
| `browser_save_storage_state` | `path`                           | path to saved cookies+localStorage |

**Navigation & inspection**

| Tool                       | Params (besides `sessionId`)                       | Returns                            |
| -------------------------- | -------------------------------------------------- | ---------------------------------- |
| `browser_navigate`         | `url`                                              | confirmation                       |
| `browser_navigate_back`    | —                                                  | confirmation                       |
| `browser_snapshot`         | —                                                  | accessibility YAML with `ref`s     |
| `browser_screenshot`       | `fullPage?`, `path?`                               | PNG image (+ saved file if `path`) |
| `browser_evaluate`         | `script`                                           | JSON-serialized result             |
| `browser_wait_for`         | `selector`, `state?`, `timeout?`                   | confirmation                       |
| `browser_press_key`        | `key`                                              | confirmation                       |
| `browser_resize`           | `width`, `height`                                  | confirmation                       |
| `browser_console_messages` | `onlyErrors?`                                      | JSON                               |
| `browser_network_requests` | —                                                  | JSON                               |
| `browser_handle_dialog`    | `accept`, `promptText?`                            | confirmation                       |
| `browser_tabs`             | `action` (`list`/`new`/`close`/`select`), `index?` | confirmation / tab list            |

**Element actions** — target by `ref` + `element` (a human description) from the latest `browser_snapshot`:

| Tool                    | Params (besides `sessionId`)                               |
| ----------------------- | ---------------------------------------------------------- |
| `browser_click`         | `ref`, `element`                                           |
| `browser_hover`         | `ref`, `element`                                           |
| `browser_type`          | `ref`, `element`, `text`                                   |
| `browser_select_option` | `ref`, `element`, `values`                                 |
| `browser_file_upload`   | `ref`, `element`, `paths`                                  |
| `browser_drag`          | `sourceRef`, `sourceElement`, `targetRef`, `targetElement` |
| `browser_fill_form`     | `fields` — array of `{ ref, element, value }`              |

## Configuration (env vars)

Invalid values (e.g. a negative `PW_MAX_SESSIONS`) are rejected with a warning on stderr and the
default is used; the effective config is logged to stderr at startup.

| Var                    | Default     | Meaning                                                     |
| ---------------------- | ----------- | ----------------------------------------------------------- |
| `PW_HEADLESS`          | `true`      | `false` to show browser windows                             |
| `PW_MAX_SESSIONS`      | `50`        | Hard cap on live sessions                                   |
| `PW_MAX_TABS`          | `20`        | Hard cap on tabs per session                                |
| `PW_MAX_CAPTURE`       | `1000`      | Max console/network entries retained per session            |
| `PW_IDLE_TIMEOUT_MS`   | `0` (off)   | Evict a session after this long with no use                 |
| `PW_OUTPUT_DIR`        | `./output`  | Directory screenshots are written to (paths confined to it) |
| `PW_UPLOAD_DIR`        | unset (any) | Confine `browser_file_upload` paths to this directory       |
| `PW_ALLOWED_ORIGINS`   | unset (any) | Comma-separated origin allowlist for navigation             |
| `PW_ALLOW_FILE_URLS`   | `false`     | Allow `file:`/`data:` navigation                            |
| `PW_ACTION_TIMEOUT_MS` | `15000`     | Per-action timeout for element interactions                 |
| `PW_EXECUTABLE_PATH`   | unset       | Use a specific Chromium build                               |
| `PW_TRANSPORT`         | `stdio`     | `http` to serve over Streamable HTTP                        |
| `PW_HOST`              | `127.0.0.1` | Host to bind in `http` mode                                 |
| `PW_PORT`              | `3000`      | Port to bind in `http` mode                                 |
| `PW_ALLOWED_HOSTS`     | unset       | Extra `Host` values accepted in `http` mode (see below)     |

## Security model

This server is **dual-use**: it hands an MCP client real control of a browser. Treat the client as
**semi-trusted** and any **page it visits as untrusted** (a hostile page can try to steer a credulous
agent into calling these tools with attacker-chosen arguments). With that in mind:

- **Navigation** (`browser_navigate`) blocks `file:` and `data:` URLs by default — the sharpest
  local-file-read / SSRF vector. Set `PW_ALLOW_FILE_URLS=true` to allow them. Note the default still
  permits any `http(s)` URL, including internal services and cloud metadata (`169.254.169.254`); set
  `PW_ALLOWED_ORIGINS` to restrict navigation to an allowlist of origins for any networked deployment.
- **Screenshots and storage state** (`browser_screenshot` with a `path`, `browser_save_storage_state`,
  and `storageStatePath` on create) are confined to `PW_OUTPUT_DIR`; paths that try to escape it (via
  `..` or an absolute path) are rejected. Storage-state files contain cookies and may hold auth
  tokens — treat the output dir accordingly.
- **File uploads** (`browser_file_upload`) read local files. By default any path is allowed; set
  `PW_UPLOAD_DIR` to confine uploads to one directory.
- **`browser_evaluate`** runs arbitrary JavaScript in the page (sandboxed to the page, not Node). It
  is a privileged capability; the navigation allowlist is the most effective containment.
- **HTTP mode** binds `127.0.0.1` by default, enables DNS-rebinding protection (rejects unexpected
  `Host` headers), caps request body size and concurrent sessions, and gives each client an isolated
  session namespace. It has **no authentication** — see the warning under "Over HTTP" before exposing
  it beyond localhost.

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
npm run check              # typecheck + lint + format + unit tests
npm run test:coverage      # unit tests with coverage (no browser needed)
npm run test:integration   # gated real-Chromium tests: isolation + deterministic, offline e2e
                           #   journeys through the MCP server (needs Chromium). Add
                           #   PW_HEADLESS=false to watch the parallel, isolated windows.
npm run build              # tsup -> dist/ (ESM + d.ts)
```

Test tiers: fast unit tests (the merge gate, no browser) → deterministic real-Chromium integration
and several end-to-end journeys through the MCP server against a local styled app (gated by
`RUN_INTEGRATION=1`, also run in CI).

See [`AGENTS.md`](./AGENTS.md) for the engineering conventions this repo is built to.

## License

MIT
