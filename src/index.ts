export {
  SessionManager,
  DEFAULT_VIEWPORT,
  DEFAULT_MAX_SESSIONS,
  DEFAULT_MAX_TABS,
  DEFAULT_MAX_CAPTURE_ENTRIES,
  DEFAULT_ACTION_TIMEOUT_MS,
} from "./session-manager";
export type { CreateSessionOptions, SessionManagerOptions, Viewport } from "./session-manager";

export { BrowserProvider } from "./browser-provider";
export type { BrowserLauncher } from "./browser-provider";

export {
  SessionError,
  SessionNotFoundError,
  DuplicateSessionError,
  SessionLimitError,
  TabLimitError,
  TabOutOfRangeError,
  InvalidArgumentError,
  ElementRefError,
  NavigationBlockedError,
  PathNotAllowedError,
} from "./errors";
export type { SessionErrorCode } from "./errors";

export { BrowserSession } from "./session";
export type {
  BrowserSessionOptions,
  ConsoleMessage,
  ElementTarget,
  FormField,
  NetworkResponse,
  TabInfo,
  WaitForState,
} from "./session";

export { assertUrlAllowed } from "./policy/url-policy";
export type { UrlPolicy } from "./policy/url-policy";
export { resolveWithinDir } from "./policy/path-policy";

export { chromiumLauncher } from "./playwright-launcher";
export type { LaunchOptions } from "./playwright-launcher";

export { createServer } from "./server";

export { loadConfig, describeConfig, DEFAULT_SECURITY } from "./config";
export type { AppConfig, ManagerConfig, TransportConfig, SecurityConfig } from "./config";
