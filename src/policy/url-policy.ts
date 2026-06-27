import { NavigationBlockedError } from "../errors";

/**
 * URL policy for {@link assertUrlAllowed}. Both knobs are opt-in confinement on
 * top of a single safe default: `file:`/`data:` navigation is blocked unless
 * explicitly allowed, because it is the sharpest local-file-read / SSRF vector
 * and is almost never what an agent legitimately wants.
 */
export interface UrlPolicy {
  /** If set and non-empty, only these origins (scheme://host:port) may be navigated to. */
  allowedOrigins?: readonly string[];
  /** Allow `file:` and `data:` URLs. Defaults to false at the call sites. */
  allowFileUrls: boolean;
}

const BLOCKED_SCHEMES_WHEN_CONFINED = new Set(["file", "data"]);

/**
 * Throw {@link NavigationBlockedError} unless `rawUrl` satisfies `policy`.
 * Pure (no Playwright) so it can be unit-tested and reused at any edge.
 */
export function assertUrlAllowed(rawUrl: string, policy: UrlPolicy): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new NavigationBlockedError(rawUrl, "not a valid absolute URL");
  }

  const scheme = url.protocol.replace(/:$/, "");
  if (!policy.allowFileUrls && BLOCKED_SCHEMES_WHEN_CONFINED.has(scheme)) {
    throw new NavigationBlockedError(
      rawUrl,
      `'${scheme}:' URLs are blocked (set PW_ALLOW_FILE_URLS=true to allow)`,
    );
  }

  const allowlist = policy.allowedOrigins;
  if (allowlist !== undefined && allowlist.length > 0 && !allowlist.includes(url.origin)) {
    throw new NavigationBlockedError(
      rawUrl,
      `origin '${url.origin}' is not in the configured allowlist (PW_ALLOWED_ORIGINS)`,
    );
  }
}
