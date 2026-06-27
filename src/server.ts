import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import pkg from "../package.json" with { type: "json" };
import { InvalidArgumentError, SessionError } from "./errors.js";
import { assertUrlAllowed, resolveWithinDir } from "./security.js";
import { DEFAULT_VIEWPORT, type SessionManager } from "./session-manager.js";
import type { WaitForState } from "./session.js";

/**
 * Security policy for the file/URL-touching tools, enforced here at the MCP edge
 * (the untrusted-input boundary) so the domain layer stays pure and reusable.
 */
export interface SecurityConfig {
  /** Directory screenshots are written into; paths are confined to it. */
  outputDir: string;
  /** If set, uploads are confined to this directory; otherwise unrestricted. */
  uploadDir?: string;
  /** If set and non-empty, navigation is restricted to these origins. */
  allowedOrigins?: readonly string[];
  /** Allow `file:`/`data:` navigation. Default false. */
  allowFileUrls: boolean;
}

const DEFAULT_SECURITY: SecurityConfig = {
  outputDir: path.resolve("output"),
  allowFileUrls: false,
};

function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

/**
 * Map any error into an MCP error result. This is the single error→transport
 * mapping point: deliberate {@link SessionError}s are surfaced with their `code`
 * so agents can branch on it; everything else (raw Playwright/runtime errors) is
 * reduced to its first line, keeping multi-line implementation noise off the wire.
 */
function fail(error: unknown): CallToolResult {
  if (error instanceof SessionError) {
    return { content: [{ type: "text", text: `${error.code}: ${error.message}` }], isError: true };
  }
  const message = error instanceof Error ? error.message : String(error);
  const firstLine = message.split("\n", 1)[0] ?? message;
  return { content: [{ type: "text", text: `Error: ${firstLine}` }], isError: true };
}

/**
 * Run a tool body, converting its result string into MCP text content and any
 * thrown error into an `isError` result. Tool errors are reported in-band; we
 * never throw across the JSON-RPC boundary. The body may be sync or async.
 */
async function run(body: () => string | Promise<string>): Promise<CallToolResult> {
  try {
    return ok(await body());
  } catch (error) {
    return fail(error);
  }
}

/** Require an optional index argument, throwing a typed error if it is missing. */
function requireIndex(index: number | undefined, action: string): number {
  if (index === undefined) {
    throw new InvalidArgumentError(`'index' is required for action '${action}'.`);
  }
  return index;
}

const SESSION = z.string().min(1).describe("Id of the isolated browser session");
const SELECTOR = z.string().describe("CSS selector or Playwright locator");

/**
 * Build the MCP server and register every browser tool against the given
 * {@link SessionManager}. Pure wiring: each handler is a thin delegate to the
 * session layer, so the testable logic lives in SessionManager/BrowserSession,
 * not here. File/URL-touching tools are guarded by {@link SecurityConfig}.
 */
export function createServer(
  manager: SessionManager,
  security: SecurityConfig = DEFAULT_SECURITY,
): McpServer {
  const server = new McpServer(
    {
      name: "concurrent-playwright-mcp",
      version: pkg.version,
    },
    {
      instructions:
        "Browser automation with one isolated session per agent/task. Allocate a unique " +
        "`sessionId` for your work, call browser_create_session first, then pass that " +
        "`sessionId` to every other tool. Close it with browser_close_session when done.",
    },
  );

  server.registerTool(
    "browser_create_session",
    {
      title: "Create session",
      description:
        "Create an isolated browser session. Each session has its own cookies, storage, and tabs; sessions never share state, so many agents can drive separate sessions at once.",
      inputSchema: {
        sessionId: SESSION,
        viewport: z
          .object({ width: z.number().int().positive(), height: z.number().int().positive() })
          .optional()
          .describe(
            `Viewport size; defaults to ${String(DEFAULT_VIEWPORT.width)}x${String(DEFAULT_VIEWPORT.height)}`,
          ),
      },
    },
    ({ sessionId, viewport }) =>
      run(async () => {
        await manager.createSession(sessionId, viewport ? { viewport } : {});
        const size = viewport ?? DEFAULT_VIEWPORT;
        return `Created session '${sessionId}' (${String(size.width)}x${String(size.height)}).`;
      }),
  );

  server.registerTool(
    "browser_list_sessions",
    {
      title: "List sessions",
      description: "List the ids of all live browser sessions.",
      inputSchema: {},
    },
    () => run(() => JSON.stringify(manager.ids())),
  );

  server.registerTool(
    "browser_close_session",
    {
      title: "Close session",
      description: "Close a session and release its browser context.",
      inputSchema: { sessionId: SESSION },
    },
    ({ sessionId }) =>
      run(async () => {
        await manager.closeSession(sessionId);
        return `Closed session '${sessionId}'.`;
      }),
  );

  server.registerTool(
    "browser_navigate",
    {
      title: "Navigate",
      description: "Navigate the session's active page to a URL.",
      inputSchema: { sessionId: SESSION, url: z.string().describe("Destination URL") },
    },
    ({ sessionId, url }) =>
      run(async () => {
        assertUrlAllowed(url, security);
        await manager.get(sessionId).navigate(url);
        return `Navigated to ${url} in session '${sessionId}'.`;
      }),
  );

  server.registerTool(
    "browser_navigate_back",
    {
      title: "Navigate back",
      description: "Go back to the previous page in the session.",
      inputSchema: { sessionId: SESSION },
    },
    ({ sessionId }) =>
      run(async () => {
        const moved = await manager.get(sessionId).navigateBack();
        return moved
          ? `Navigated back in session '${sessionId}'.`
          : `No previous page in history for session '${sessionId}'.`;
      }),
  );

  server.registerTool(
    "browser_click",
    {
      title: "Click",
      description: "Click an element in the session.",
      inputSchema: { sessionId: SESSION, selector: SELECTOR },
    },
    ({ sessionId, selector }) =>
      run(async () => {
        await manager.get(sessionId).click(selector);
        return `Clicked '${selector}' in session '${sessionId}'.`;
      }),
  );

  server.registerTool(
    "browser_type",
    {
      title: "Type",
      description: "Fill an input with text in the session.",
      inputSchema: { sessionId: SESSION, selector: SELECTOR, text: z.string() },
    },
    ({ sessionId, selector, text }) =>
      run(async () => {
        await manager.get(sessionId).type(selector, text);
        return `Typed into '${selector}' in session '${sessionId}'.`;
      }),
  );

  server.registerTool(
    "browser_hover",
    {
      title: "Hover",
      description: "Hover over an element in the session.",
      inputSchema: { sessionId: SESSION, selector: SELECTOR },
    },
    ({ sessionId, selector }) =>
      run(async () => {
        await manager.get(sessionId).hover(selector);
        return `Hovered '${selector}' in session '${sessionId}'.`;
      }),
  );

  server.registerTool(
    "browser_press_key",
    {
      title: "Press key",
      description: 'Press a keyboard key (e.g. "Enter", "ArrowDown").',
      inputSchema: { sessionId: SESSION, key: z.string() },
    },
    ({ sessionId, key }) =>
      run(async () => {
        await manager.get(sessionId).pressKey(key);
        return `Pressed '${key}' in session '${sessionId}'.`;
      }),
  );

  server.registerTool(
    "browser_select_option",
    {
      title: "Select option",
      description: "Select one or more options in a <select> element.",
      inputSchema: { sessionId: SESSION, selector: SELECTOR, values: z.array(z.string()) },
    },
    ({ sessionId, selector, values }) =>
      run(async () => {
        const selected = await manager.get(sessionId).selectOption(selector, values);
        return `Selected ${JSON.stringify(selected)} in '${selector}'.`;
      }),
  );

  server.registerTool(
    "browser_fill_form",
    {
      title: "Fill form",
      description: "Fill several fields in one call.",
      inputSchema: {
        sessionId: SESSION,
        fields: z.array(z.object({ selector: z.string(), value: z.string() })),
      },
    },
    ({ sessionId, fields }) =>
      run(async () => {
        await manager.get(sessionId).fillForm(fields);
        return `Filled ${String(fields.length)} field(s) in session '${sessionId}'.`;
      }),
  );

  server.registerTool(
    "browser_file_upload",
    {
      title: "Upload files",
      description: "Set files on a file input.",
      inputSchema: {
        sessionId: SESSION,
        selector: SELECTOR,
        paths: z
          .array(z.string())
          .describe("File paths (confined to the upload dir if configured)"),
      },
    },
    ({ sessionId, selector, paths }) =>
      run(async () => {
        const uploadDir = security.uploadDir;
        const resolved =
          uploadDir === undefined ? paths : paths.map((p) => resolveWithinDir(uploadDir, p));
        await manager.get(sessionId).fileUpload(selector, resolved);
        return `Uploaded ${String(resolved.length)} file(s) to '${selector}'.`;
      }),
  );

  server.registerTool(
    "browser_drag",
    {
      title: "Drag and drop",
      description: "Drag one element onto another.",
      inputSchema: {
        sessionId: SESSION,
        sourceSelector: z.string(),
        targetSelector: z.string(),
      },
    },
    ({ sessionId, sourceSelector, targetSelector }) =>
      run(async () => {
        await manager.get(sessionId).drag(sourceSelector, targetSelector);
        return `Dragged '${sourceSelector}' onto '${targetSelector}'.`;
      }),
  );

  server.registerTool(
    "browser_resize",
    {
      title: "Resize viewport",
      description: "Resize the session's viewport.",
      inputSchema: {
        sessionId: SESSION,
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      },
    },
    ({ sessionId, width, height }) =>
      run(async () => {
        await manager.get(sessionId).resize(width, height);
        return `Resized session '${sessionId}' to ${String(width)}x${String(height)}.`;
      }),
  );

  server.registerTool(
    "browser_screenshot",
    {
      title: "Screenshot",
      description:
        "Save a screenshot of the active page to a file within the configured output directory.",
      inputSchema: {
        sessionId: SESSION,
        path: z.string().describe("File path, relative to the configured output directory"),
        fullPage: z.boolean().optional(),
      },
    },
    ({ sessionId, path: requestedPath, fullPage }) =>
      run(async () => {
        const dest = resolveWithinDir(security.outputDir, requestedPath);
        await manager.get(sessionId).screenshot(dest, fullPage ?? false);
        return `Saved screenshot to ${dest}.`;
      }),
  );

  server.registerTool(
    "browser_snapshot",
    {
      title: "Accessibility snapshot",
      description: "Get the ARIA accessibility snapshot (YAML) of the active page.",
      inputSchema: { sessionId: SESSION },
    },
    ({ sessionId }) => run(() => manager.get(sessionId).snapshot()),
  );

  server.registerTool(
    "browser_evaluate",
    {
      title: "Evaluate JavaScript",
      description: "Run a JavaScript expression in the page and return the JSON-serialized result.",
      inputSchema: { sessionId: SESSION, script: z.string() },
    },
    ({ sessionId, script }) =>
      run(async () => {
        const result = await manager.get(sessionId).evaluate(script);
        // page.evaluate returns undefined for void scripts; JSON.stringify(undefined)
        // is the JS value undefined, which would make an invalid content block.
        return result === undefined ? "undefined" : JSON.stringify(result, null, 2);
      }),
  );

  server.registerTool(
    "browser_wait_for",
    {
      title: "Wait for selector",
      description: "Wait until a selector reaches a state.",
      inputSchema: {
        sessionId: SESSION,
        selector: SELECTOR,
        state: z.enum(["attached", "detached", "visible", "hidden"]).optional(),
        timeout: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Timeout in milliseconds; defaults to 30000"),
      },
    },
    ({ sessionId, selector, state, timeout }) =>
      run(async () => {
        const target: WaitForState = state ?? "visible";
        await manager.get(sessionId).waitFor(selector, target, timeout ?? 30_000);
        return `'${selector}' reached '${target}' in session '${sessionId}'.`;
      }),
  );

  server.registerTool(
    "browser_console_messages",
    {
      title: "Console messages",
      description: "Return console messages captured in the session.",
      inputSchema: { sessionId: SESSION, onlyErrors: z.boolean().optional() },
    },
    ({ sessionId, onlyErrors }) =>
      run(() =>
        JSON.stringify(manager.get(sessionId).consoleMessages(onlyErrors ?? false), null, 2),
      ),
  );

  server.registerTool(
    "browser_network_requests",
    {
      title: "Network requests",
      description: "Return network responses captured in the session.",
      inputSchema: { sessionId: SESSION },
    },
    ({ sessionId }) =>
      run(() => JSON.stringify(manager.get(sessionId).networkResponses(), null, 2)),
  );

  server.registerTool(
    "browser_handle_dialog",
    {
      title: "Handle dialog",
      description: "Decide the next dialog (alert/confirm/prompt) instead of auto-dismissing it.",
      inputSchema: {
        sessionId: SESSION,
        accept: z.boolean(),
        promptText: z.string().optional(),
      },
    },
    ({ sessionId, accept, promptText }) =>
      run(async () => {
        await manager.get(sessionId).handleDialog(accept, promptText);
        return `Next dialog will be ${accept ? "accepted" : "dismissed"} in session '${sessionId}'.`;
      }),
  );

  server.registerTool(
    "browser_tabs",
    {
      title: "Tabs",
      description: "List, open, close, or select a tab within the session.",
      inputSchema: {
        sessionId: SESSION,
        action: z.enum(["list", "new", "close", "select"]),
        index: z.number().int().nonnegative().optional().describe("Tab index for close/select"),
      },
    },
    ({ sessionId, action, index }) =>
      run(async () => {
        const session = manager.get(sessionId);
        switch (action) {
          case "list":
            return JSON.stringify(await session.listTabs(), null, 2);
          case "new": {
            const newIndex = await session.newTab();
            return `Opened tab ${String(newIndex)} in session '${sessionId}'.`;
          }
          case "close": {
            const target = requireIndex(index, action);
            await session.closeTab(target);
            return `Closed tab ${String(target)} in session '${sessionId}'.`;
          }
          case "select": {
            const target = requireIndex(index, action);
            await session.selectTab(target);
            return `Selected tab ${String(target)} in session '${sessionId}'.`;
          }
        }
      }),
  );

  return server;
}
