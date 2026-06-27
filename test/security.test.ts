import path from "node:path";
import { describe, expect, it } from "vitest";
import { NavigationBlockedError, PathNotAllowedError } from "../src/errors.js";
import { assertUrlAllowed, resolveWithinDir } from "../src/security.js";

describe("assertUrlAllowed", () => {
  it("allows http(s) by default", () => {
    expect(() => {
      assertUrlAllowed("https://example.com/path", { allowFileUrls: false });
    }).not.toThrow();
    expect(() => {
      assertUrlAllowed("http://localhost:3000/", { allowFileUrls: false });
    }).not.toThrow();
  });

  it("blocks file: and data: by default", () => {
    expect(() => {
      assertUrlAllowed("file:///etc/passwd", { allowFileUrls: false });
    }).toThrow(NavigationBlockedError);
    expect(() => {
      assertUrlAllowed("data:text/html,<h1>hi</h1>", { allowFileUrls: false });
    }).toThrow(NavigationBlockedError);
  });

  it("allows file: when explicitly opted in", () => {
    expect(() => {
      assertUrlAllowed("file:///tmp/page.html", { allowFileUrls: true });
    }).not.toThrow();
  });

  it("rejects invalid or relative URLs", () => {
    expect(() => {
      assertUrlAllowed("not a url", { allowFileUrls: false });
    }).toThrow(NavigationBlockedError);
    expect(() => {
      assertUrlAllowed("/relative/path", { allowFileUrls: false });
    }).toThrow(NavigationBlockedError);
  });

  it("enforces an origin allowlist when one is set", () => {
    const policy = { allowFileUrls: false, allowedOrigins: ["https://allowed.com"] };
    expect(() => {
      assertUrlAllowed("https://allowed.com/deep/page", policy);
    }).not.toThrow();
    expect(() => {
      assertUrlAllowed("https://evil.com", policy);
    }).toThrow(NavigationBlockedError);
  });

  it("ignores an empty allowlist (treated as no restriction)", () => {
    expect(() => {
      assertUrlAllowed("https://anywhere.com", { allowFileUrls: false, allowedOrigins: [] });
    }).not.toThrow();
  });
});

describe("resolveWithinDir", () => {
  const base = path.resolve("output");

  it("resolves a relative path within the directory", () => {
    expect(resolveWithinDir(base, "shot.png")).toBe(path.join(base, "shot.png"));
    expect(resolveWithinDir(base, "sub/shot.png")).toBe(path.join(base, "sub", "shot.png"));
  });

  it("rejects traversal, absolute escapes, and the dir itself", () => {
    expect(() => resolveWithinDir(base, "../escape.png")).toThrow(PathNotAllowedError);
    expect(() => resolveWithinDir(base, "/etc/passwd")).toThrow(PathNotAllowedError);
    expect(() => resolveWithinDir(base, "")).toThrow(PathNotAllowedError);
    expect(() => resolveWithinDir(base, "sub/../../escape.png")).toThrow(PathNotAllowedError);
  });
});
