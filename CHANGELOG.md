# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — Unreleased

Initial public release.

### Added

- MCP server providing **concurrent, session-isolated** Playwright browsing: one isolated
  `BrowserContext` per `sessionId`, so many agents drive browsers in parallel without sharing
  cookies, storage, or tabs.
- **Two transports:** stdio (default) and Streamable **HTTP** (`PW_TRANSPORT=http`), where each
  client connection gets its own isolated session namespace over one shared Chromium.
- **Ref-based element targeting:** `browser_snapshot` returns an accessibility tree with `ref` ids;
  element actions take a `ref` + `element` description (the official Playwright MCP model).
- 23 tools: session lifecycle, navigation, ref-based actions, `browser_screenshot` (returns an
  image), `browser_snapshot`, `browser_evaluate`, tabs, dialogs, console/network capture, and
  per-session storage state (`browser_save_storage_state` + `storageStatePath` on create).
- **Security policy** enforced at the MCP edge: `file:`/`data:` navigation blocked by default,
  optional origin allowlist, screenshot/storage-state path confinement, optional upload-dir
  confinement, and HTTP DNS-rebinding protection.
- Bounded resources: session cap, per-session tab cap, capture ring buffers, optional idle
  eviction, request-body and connection caps in HTTP mode.
- Typed error taxonomy (`SessionError` + machine-readable codes) surfaced in-band.
- Configurable via `PW_*` environment variables; provenance-signed npm release workflow.
