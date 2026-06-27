import { describe, expect, it } from "vitest";
import {
  DuplicateSessionError,
  InvalidArgumentError,
  NavigationBlockedError,
  PathNotAllowedError,
  SessionError,
  SessionLimitError,
  SessionNotFoundError,
  TabLimitError,
  TabOutOfRangeError,
} from "../src/errors.js";

describe("error taxonomy", () => {
  it("every deliberate error is a SessionError with a code and its class name", () => {
    const cases = [
      [new SessionNotFoundError("a"), "SESSION_NOT_FOUND", "SessionNotFoundError"],
      [new DuplicateSessionError("a"), "DUPLICATE_SESSION", "DuplicateSessionError"],
      [new SessionLimitError(5), "SESSION_LIMIT", "SessionLimitError"],
      [new TabLimitError(5), "TAB_LIMIT", "TabLimitError"],
      [new TabOutOfRangeError(3, 1), "TAB_OUT_OF_RANGE", "TabOutOfRangeError"],
      [new InvalidArgumentError("x"), "INVALID_ARGUMENT", "InvalidArgumentError"],
      [new NavigationBlockedError("u", "why"), "NAVIGATION_BLOCKED", "NavigationBlockedError"],
      [new PathNotAllowedError("p", "/base"), "PATH_NOT_ALLOWED", "PathNotAllowedError"],
    ] as const;

    for (const [error, code, name] of cases) {
      expect(error).toBeInstanceOf(SessionError);
      expect(error).toBeInstanceOf(Error);
      expect(error.code).toBe(code);
      expect(error.name).toBe(name);
      expect(error.message.length).toBeGreaterThan(0);
    }
  });

  it("preserves structured fields for programmatic handling", () => {
    expect(new SessionNotFoundError("sid").sessionId).toBe("sid");
    expect(new SessionLimitError(7).limit).toBe(7);
    const tab = new TabOutOfRangeError(3, 1);
    expect(tab.index).toBe(3);
    expect(tab.openTabs).toBe(1);
    const path = new PathNotAllowedError("../x", "/base");
    expect(path.requestedPath).toBe("../x");
    expect(path.baseDir).toBe("/base");
  });

  it("lets a caller catch any domain error via the base class", () => {
    const errors: unknown[] = [new SessionNotFoundError("a"), new TabLimitError(1)];
    const codes = errors
      .filter((e): e is SessionError => e instanceof SessionError)
      .map((e) => e.code);
    expect(codes).toEqual(["SESSION_NOT_FOUND", "TAB_LIMIT"]);
  });
});
