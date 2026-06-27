import path from "node:path";
import { describe, expect, it } from "vitest";
import { PathNotAllowedError } from "../../src/errors";
import { resolveWithinDir } from "../../src/policy/path-policy";

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
