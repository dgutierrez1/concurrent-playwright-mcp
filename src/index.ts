export {
  SessionManager,
  DEFAULT_VIEWPORT,
  DEFAULT_MAX_SESSIONS,
  DEFAULT_MAX_TABS,
  DEFAULT_MAX_CAPTURE_ENTRIES,
} from "./session-manager.js";
export type {
  BrowserLauncher,
  CreateSessionOptions,
  SessionManagerOptions,
  Viewport,
} from "./session-manager.js";

export {
  SessionError,
  SessionNotFoundError,
  DuplicateSessionError,
  SessionLimitError,
  TabLimitError,
  TabOutOfRangeError,
  InvalidArgumentError,
  NavigationBlockedError,
  PathNotAllowedError,
} from "./errors.js";
export type { SessionErrorCode } from "./errors.js";

export { BrowserSession } from "./session.js";
export type {
  BrowserSessionOptions,
  ConsoleMessage,
  NetworkResponse,
  TabInfo,
  WaitForState,
} from "./session.js";

export { assertUrlAllowed, resolveWithinDir } from "./security.js";
export type { UrlPolicy } from "./security.js";

export { chromiumLauncher } from "./playwright-launcher.js";
export type { LaunchOptions } from "./playwright-launcher.js";

export { createServer } from "./server.js";
export type { SecurityConfig } from "./server.js";

export { loadConfig, describeConfig } from "./config.js";
export type { AppConfig, ManagerConfig } from "./config.js";
