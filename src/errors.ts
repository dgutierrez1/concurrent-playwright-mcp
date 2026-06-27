/**
 * The repo's error taxonomy. Every error this server raises on purpose is a
 * {@link SessionError} carrying a machine-readable {@link SessionErrorCode}, so
 * callers can `catch (e) { if (e instanceof SessionError) switch (e.code) ... }`
 * and the transport edge can map the code into the MCP response uniformly. Raw
 * Playwright/runtime errors are the only ones that fall outside this set; the
 * transport edge normalizes those (see `fail()` in server.ts).
 */
export type SessionErrorCode =
  | "SESSION_NOT_FOUND"
  | "DUPLICATE_SESSION"
  | "SESSION_LIMIT"
  | "TAB_LIMIT"
  | "TAB_OUT_OF_RANGE"
  | "INVALID_ARGUMENT"
  | "NAVIGATION_BLOCKED"
  | "PATH_NOT_ALLOWED";

/**
 * Base class for every deliberate error in this server. Subclasses set a
 * `code` discriminator and pass a human-readable, *actionable* message to
 * `super`. `name` is derived from the concrete subclass, so subclasses never
 * repeat `this.name = "..."`.
 */
export abstract class SessionError extends Error {
  abstract readonly code: SessionErrorCode;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Raised when an operation references a session id that does not exist. */
export class SessionNotFoundError extends SessionError {
  readonly code = "SESSION_NOT_FOUND";
  constructor(readonly sessionId: string) {
    super(`Session '${sessionId}' not found. Create it first with createSession().`);
  }
}

/** Raised when creating a session with an id that is already in use. */
export class DuplicateSessionError extends SessionError {
  readonly code = "DUPLICATE_SESSION";
  constructor(readonly sessionId: string) {
    super(`Session '${sessionId}' already exists.`);
  }
}

/** Raised when creating a session would exceed the configured session cap. */
export class SessionLimitError extends SessionError {
  readonly code = "SESSION_LIMIT";
  constructor(readonly limit: number) {
    super(`Session limit reached (${String(limit)}). Close a session before creating another.`);
  }
}

/** Raised when opening a tab would exceed the configured per-session tab cap. */
export class TabLimitError extends SessionError {
  readonly code = "TAB_LIMIT";
  constructor(readonly limit: number) {
    super(`Tab limit reached (${String(limit)}) for this session. Close a tab before opening another.`);
  }
}

/** Raised when a tab index does not refer to an open tab. */
export class TabOutOfRangeError extends SessionError {
  readonly code = "TAB_OUT_OF_RANGE";
  constructor(
    readonly index: number,
    readonly openTabs: number,
  ) {
    super(`Tab index ${String(index)} is out of range (open tabs: ${String(openTabs)}).`);
  }
}

/** Raised when a tool argument is missing or malformed beyond what the schema catches. */
export class InvalidArgumentError extends SessionError {
  readonly code = "INVALID_ARGUMENT";
}

/** Raised when navigation is rejected by the configured URL policy. */
export class NavigationBlockedError extends SessionError {
  readonly code = "NAVIGATION_BLOCKED";
  constructor(
    readonly url: string,
    reason: string,
  ) {
    super(`Navigation to '${url}' was blocked: ${reason}.`);
  }
}

/** Raised when a filesystem path falls outside the directory it is confined to. */
export class PathNotAllowedError extends SessionError {
  readonly code = "PATH_NOT_ALLOWED";
  constructor(
    readonly requestedPath: string,
    readonly baseDir: string,
  ) {
    super(
      `Path '${requestedPath}' is outside the allowed directory '${baseDir}'. ` +
        `Use a path within it, or change the configured directory.`,
    );
  }
}
