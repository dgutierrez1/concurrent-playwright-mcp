import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import pkg from "../package.json" with { type: "json" };
import { DEFAULT_SECURITY, type SecurityConfig } from "./config";
import { InvalidArgumentError, SessionError } from "./errors";
import { assertUrlAllowed } from "./policy/url-policy";
import { resolveWithinDir } from "./policy/path-policy";
import { DEFAULT_VIEWPORT, type SessionManager } from "./session-manager";

export type { SecurityConfig } from "./config";

/** What a tool body returns: a plain string (→ text content) or a full result. */
type ToolResult = string | CallToolResult;

function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * Map any error into an MCP error result. This is the single error→transport
 * mapping point: deliberate {@link SessionError}s are surfaced with their `code`
 * so agents can branch on it; everything else (raw Playwright/runtime errors) is
 * reduced to its first line, keeping multi-line implementation noise off the wire.
 */
function fail(error: unknown): CallToolResult {
  if (error instanceof SessionError) {
    return errorResult(`${error.code}: ${error.message}`);
  }
  const message = error instanceof Error ? error.message : String(error);
  // Playwright's "executable doesn't exist" hint spans several lines; surface a
  // single actionable line instead of just "Executable doesn't exist at ...".
  if (message.includes("Executable doesn't exist") || message.includes("playwright install")) {
    return errorResult("Chromium is not installed. Run: npx playwright install chromium");
  }
  const firstLine = message.split("\n", 1)[0] ?? message;
  return errorResult(`Error: ${firstLine}`);
}

/**
 * Run a tool body, normalizing its result into MCP content and any thrown error
 * into an `isError` result. Tool errors are reported in-band; we never throw
 * across the JSON-RPC boundary.
 */
async function run(body: () => ToolResult | Promise<ToolResult>): Promise<CallToolResult> {
  try {
    const result = await body();
    return typeof result === "string" ? ok(result) : result;
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
const REF = z.string().min(1).describe("Element ref from the latest browser_snapshot (e.g. 'e12')");
const ELEMENT = z.string().min(1).describe("Human description of the element (for logs/errors)");

/**
 * Build the MCP server and register every browser tool against the given
 * {@link SessionManager}. Pure wiring: each handler validates input here (Zod,
 * with defaults), then delegates to the session layer. File/URL-touching tools
 * are guarded by {@link SecurityConfig}.
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
        "`sessionId`, call browser_create_session first, then pass it to every other tool. " +
        "Target elements by `ref` from browser_snapshot (not CSS). Close with " +
        "browser_close_session when done.",
    },
  );

  /**
   * Register a tool whose body returns a string or a full result; errors are
   * reported in-band by {@link run}. The callback is cast to the SDK's loosely
   * typed handler shape — the generic `Shape` gives us precise `args` typing that
   * the SDK's own generic does not preserve through this wrapper.
   */
  type RegisterArgs = Parameters<typeof server.registerTool>;
  const tool = <Shape extends z.ZodRawShape>(
    name: string,
    config: { title: string; description: string; inputSchema: Shape },
    body: (args: z.infer<z.ZodObject<Shape>>) => ToolResult | Promise<ToolResult>,
  ): void => {
    const handler = (args: z.infer<z.ZodObject<Shape>>): Promise<CallToolResult> =>
      run(() => body(args));
    server.registerTool(name, config as RegisterArgs[1], handler as unknown as RegisterArgs[2]);
  };

  // --- Session lifecycle -----------------------------------------------------

  tool(
    "browser_create_session",
    {
      title: "Create session",
      description:
        "Create an isolated browser session. Each session has its own cookies, storage, and tabs; sessions never share state, so many agents can drive separate sessions at once.",
      inputSchema: {
        sessionId: SESSION,
        viewport: z
          .object({ width: z.number().int().positive(), height: z.number().int().positive() })
          .default(DEFAULT_VIEWPORT)
          .describe("Viewport size"),
        storageStatePath: z
          .string()
          .optional()
          .describe("Storage-state JSON (within the output dir) to seed cookies/localStorage from"),
      },
    },
    async ({ sessionId, viewport, storageStatePath }) => {
      const options =
        storageStatePath === undefined
          ? { viewport }
          : { viewport, storageStatePath: resolveWithinDir(security.outputDir, storageStatePath) };
      await manager.createSession(sessionId, options);
      return `Created session '${sessionId}' (${String(viewport.width)}x${String(viewport.height)}).`;
    },
  );

  tool(
    "browser_list_sessions",
    {
      title: "List sessions",
      description: "List the ids of all live browser sessions.",
      inputSchema: {},
    },
    () => JSON.stringify(manager.ids()),
  );

  tool(
    "browser_close_session",
    {
      title: "Close session",
      description: "Close a session and release its browser context.",
      inputSchema: { sessionId: SESSION },
    },
    async ({ sessionId }) => {
      await manager.closeSession(sessionId);
      return `Closed session '${sessionId}'.`;
    },
  );

  tool(
    "browser_save_storage_state",
    {
      title: "Save storage state",
      description:
        "Save the session's cookies + localStorage to a JSON file (within the output dir) for later reuse via browser_create_session.",
      inputSchema: {
        sessionId: SESSION,
        path: z.string().describe("File path within the output dir"),
      },
    },
    async ({ sessionId, path }) => {
      const dest = resolveWithinDir(security.outputDir, path);
      await mkdir(dirname(dest), { recursive: true });
      await manager.get(sessionId).saveStorageState(dest);
      return `Saved storage state to ${dest}.`;
    },
  );

  // --- Navigation ------------------------------------------------------------

  tool(
    "browser_navigate",
    {
      title: "Navigate",
      description: "Navigate the session's active page to a URL.",
      inputSchema: { sessionId: SESSION, url: z.string().describe("Destination URL") },
    },
    async ({ sessionId, url }) => {
      assertUrlAllowed(url, security);
      await manager.get(sessionId).navigate(url);
      return `Navigated to ${url} in session '${sessionId}'.`;
    },
  );

  tool(
    "browser_navigate_back",
    {
      title: "Navigate back",
      description: "Go back to the previous page in the session.",
      inputSchema: { sessionId: SESSION },
    },
    async ({ sessionId }) => {
      const moved = await manager.get(sessionId).navigateBack();
      return moved
        ? `Navigated back in session '${sessionId}'.`
        : `No previous page in history for session '${sessionId}'.`;
    },
  );

  // --- Element actions (ref-based) -------------------------------------------

  tool(
    "browser_click",
    {
      title: "Click",
      description: "Click an element (by ref from browser_snapshot).",
      inputSchema: { sessionId: SESSION, ref: REF, element: ELEMENT },
    },
    async ({ sessionId, ref, element }) => {
      await manager.get(sessionId).click({ ref, element });
      return `Clicked ${element} in session '${sessionId}'.`;
    },
  );

  tool(
    "browser_type",
    {
      title: "Type",
      description: "Fill an input with text (by ref from browser_snapshot).",
      inputSchema: { sessionId: SESSION, ref: REF, element: ELEMENT, text: z.string() },
    },
    async ({ sessionId, ref, element, text }) => {
      await manager.get(sessionId).type({ ref, element }, text);
      return `Typed into ${element} in session '${sessionId}'.`;
    },
  );

  tool(
    "browser_hover",
    {
      title: "Hover",
      description: "Hover over an element (by ref from browser_snapshot).",
      inputSchema: { sessionId: SESSION, ref: REF, element: ELEMENT },
    },
    async ({ sessionId, ref, element }) => {
      await manager.get(sessionId).hover({ ref, element });
      return `Hovered ${element} in session '${sessionId}'.`;
    },
  );

  tool(
    "browser_press_key",
    {
      title: "Press key",
      description: 'Press a keyboard key (e.g. "Enter", "ArrowDown").',
      inputSchema: { sessionId: SESSION, key: z.string() },
    },
    async ({ sessionId, key }) => {
      await manager.get(sessionId).pressKey(key);
      return `Pressed '${key}' in session '${sessionId}'.`;
    },
  );

  tool(
    "browser_select_option",
    {
      title: "Select option",
      description: "Select one or more options in a <select> (by ref from browser_snapshot).",
      inputSchema: { sessionId: SESSION, ref: REF, element: ELEMENT, values: z.array(z.string()) },
    },
    async ({ sessionId, ref, element, values }) => {
      const selected = await manager.get(sessionId).selectOption({ ref, element }, values);
      return `Selected ${JSON.stringify(selected)} in ${element}.`;
    },
  );

  tool(
    "browser_fill_form",
    {
      title: "Fill form",
      description: "Fill several fields in one call (each by ref from browser_snapshot).",
      inputSchema: {
        sessionId: SESSION,
        fields: z.array(z.object({ ref: REF, element: ELEMENT, value: z.string() })),
      },
    },
    async ({ sessionId, fields }) => {
      await manager.get(sessionId).fillForm(fields);
      return `Filled ${String(fields.length)} field(s) in session '${sessionId}'.`;
    },
  );

  tool(
    "browser_file_upload",
    {
      title: "Upload files",
      description: "Set files on a file input (by ref from browser_snapshot).",
      inputSchema: {
        sessionId: SESSION,
        ref: REF,
        element: ELEMENT,
        paths: z
          .array(z.string())
          .describe("File paths (confined to the upload dir if configured)"),
      },
    },
    async ({ sessionId, ref, element, paths }) => {
      const uploadDir = security.uploadDir;
      const resolved =
        uploadDir === undefined ? paths : paths.map((p) => resolveWithinDir(uploadDir, p));
      await manager.get(sessionId).fileUpload({ ref, element }, resolved);
      return `Uploaded ${String(resolved.length)} file(s) to ${element}.`;
    },
  );

  tool(
    "browser_drag",
    {
      title: "Drag and drop",
      description: "Drag one element onto another (both by ref from browser_snapshot).",
      inputSchema: {
        sessionId: SESSION,
        sourceRef: REF,
        sourceElement: ELEMENT,
        targetRef: REF,
        targetElement: ELEMENT,
      },
    },
    async ({ sessionId, sourceRef, sourceElement, targetRef, targetElement }) => {
      await manager
        .get(sessionId)
        .drag(
          { ref: sourceRef, element: sourceElement },
          { ref: targetRef, element: targetElement },
        );
      return `Dragged ${sourceElement} onto ${targetElement}.`;
    },
  );

  tool(
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
    async ({ sessionId, width, height }) => {
      await manager.get(sessionId).resize(width, height);
      return `Resized session '${sessionId}' to ${String(width)}x${String(height)}.`;
    },
  );

  // --- Inspection ------------------------------------------------------------

  tool(
    "browser_screenshot",
    {
      title: "Screenshot",
      description:
        "Capture a PNG of the active page and return it as an image. Optionally also save it to a file within the output dir.",
      inputSchema: {
        sessionId: SESSION,
        fullPage: z.boolean().default(false),
        path: z
          .string()
          .optional()
          .describe("Optional file path within the output dir to also save to"),
      },
    },
    async ({ sessionId, fullPage, path }): Promise<CallToolResult> => {
      const png = await manager.get(sessionId).screenshot(fullPage);
      const content: CallToolResult["content"] = [];
      if (path !== undefined) {
        const dest = resolveWithinDir(security.outputDir, path);
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, png);
        content.push({ type: "text", text: `Saved screenshot to ${dest}.` });
      }
      content.push({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
      return { content };
    },
  );

  tool(
    "browser_snapshot",
    {
      title: "Accessibility snapshot",
      description:
        "Get the accessibility snapshot (YAML) of the active page, including element refs to target with other tools.",
      inputSchema: { sessionId: SESSION },
    },
    ({ sessionId }) => manager.get(sessionId).snapshot(),
  );

  tool(
    "browser_evaluate",
    {
      title: "Evaluate JavaScript",
      description: "Run a JavaScript expression in the page and return the JSON-serialized result.",
      inputSchema: { sessionId: SESSION, script: z.string() },
    },
    async ({ sessionId, script }) => {
      const result = await manager.get(sessionId).evaluate(script);
      // page.evaluate returns undefined for void scripts; JSON.stringify(undefined)
      // is the JS value undefined, which would make an invalid content block.
      return result === undefined ? "undefined" : JSON.stringify(result, null, 2);
    },
  );

  tool(
    "browser_wait_for",
    {
      title: "Wait for selector",
      description: "Wait until a CSS selector reaches a state.",
      inputSchema: {
        sessionId: SESSION,
        selector: z.string().describe("CSS selector to wait for"),
        state: z.enum(["attached", "detached", "visible", "hidden"]).default("visible"),
        timeout: z.number().int().positive().default(30_000).describe("Timeout in milliseconds"),
      },
    },
    async ({ sessionId, selector, state, timeout }) => {
      await manager.get(sessionId).waitFor(selector, state, timeout);
      return `'${selector}' reached '${state}' in session '${sessionId}'.`;
    },
  );

  tool(
    "browser_console_messages",
    {
      title: "Console messages",
      description: "Return console messages captured in the session.",
      inputSchema: { sessionId: SESSION, onlyErrors: z.boolean().default(false) },
    },
    ({ sessionId, onlyErrors }) =>
      JSON.stringify(manager.get(sessionId).consoleMessages(onlyErrors), null, 2),
  );

  tool(
    "browser_network_requests",
    {
      title: "Network requests",
      description: "Return network responses captured in the session.",
      inputSchema: { sessionId: SESSION },
    },
    ({ sessionId }) => JSON.stringify(manager.get(sessionId).networkResponses(), null, 2),
  );

  tool(
    "browser_handle_dialog",
    {
      title: "Handle dialog",
      description: "Decide the next dialog (alert/confirm/prompt) instead of auto-dismissing it.",
      inputSchema: { sessionId: SESSION, accept: z.boolean(), promptText: z.string().optional() },
    },
    async ({ sessionId, accept, promptText }) => {
      await manager.get(sessionId).handleDialog(accept, promptText);
      return `Next dialog will be ${accept ? "accepted" : "dismissed"} in session '${sessionId}'.`;
    },
  );

  tool(
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
    async ({ sessionId, action, index }) => {
      const session = manager.get(sessionId);
      switch (action) {
        case "list":
          return JSON.stringify(await session.listTabs(), null, 2);
        case "new":
          return `Opened tab ${String(await session.newTab())} in session '${sessionId}'.`;
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
    },
  );

  return server;
}
