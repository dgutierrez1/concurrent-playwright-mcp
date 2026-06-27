import path from "node:path";
import { PathNotAllowedError } from "../errors";

/**
 * Resolve `requested` inside `baseDir` and return the absolute path, throwing
 * {@link PathNotAllowedError} if it escapes the directory (via `..`, an absolute
 * path, or otherwise). Confines tool file I/O to a configured directory.
 */
export function resolveWithinDir(baseDir: string, requested: string): string {
  const base = path.resolve(baseDir);
  const resolved = path.resolve(base, requested);
  const relative = path.relative(base, resolved);
  // Empty (== baseDir itself), climbing out (`..`), or still absolute → outside.
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new PathNotAllowedError(requested, base);
  }
  return resolved;
}
