import path from "node:path";
import type { LaunchOptions } from "./playwright-launcher.js";
import type { SecurityConfig } from "./server.js";
import {
  DEFAULT_MAX_CAPTURE_ENTRIES,
  DEFAULT_MAX_SESSIONS,
  DEFAULT_MAX_TABS,
} from "./session-manager.js";

/** Resolved manager bounds (every field defaulted/validated). */
export interface ManagerConfig {
  maxSessions: number;
  idleTimeoutMs: number;
  maxTabs: number;
  maxCaptureEntries: number;
}

/** The full resolved configuration the CLI wires into the server. */
export interface AppConfig {
  launch: LaunchOptions;
  manager: ManagerConfig;
  security: SecurityConfig;
}

type Env = Record<string, string | undefined>;

/** Warnings go to stderr — stdout is reserved for the JSON-RPC channel. */
function warn(message: string): void {
  console.error(`[concurrent-playwright-mcp] ${message}`);
}

function envFlag(env: Env, name: string, fallback: boolean): boolean {
  const value = env[name];
  if (value === undefined) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true") {
    return true;
  }
  if (normalized === "0" || normalized === "false") {
    return false;
  }
  warn(`${name}='${value}' is not a recognized boolean (use true/false); using ${String(fallback)}.`);
  return fallback;
}

function envInt(env: Env, name: string, fallback: number, min: number): number {
  const value = env[name];
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value.trim());
  if (!Number.isInteger(parsed)) {
    warn(`${name}='${value}' is not an integer; using ${String(fallback)}.`);
    return fallback;
  }
  if (parsed < min) {
    warn(`${name}='${value}' is below the minimum ${String(min)}; using ${String(fallback)}.`);
    return fallback;
  }
  return parsed;
}

/** Parse a comma-separated origin list, normalizing each to scheme://host:port. */
function parseOrigins(env: Env, name: string): string[] | undefined {
  const value = env[name];
  if (value === undefined) {
    return undefined;
  }
  const origins: string[] = [];
  for (const raw of value.split(",")) {
    const trimmed = raw.trim();
    if (trimmed === "") {
      continue;
    }
    try {
      origins.push(new URL(trimmed).origin);
    } catch {
      warn(`${name}: '${trimmed}' is not a valid origin URL; ignoring it.`);
    }
  }
  return origins.length > 0 ? origins : undefined;
}

/**
 * Resolve the full configuration from environment variables, validating and
 * warning (to stderr) on bad values rather than silently misbehaving. Pure in
 * its `env` argument so it can be unit-tested without touching `process.env`.
 */
export function loadConfig(env: Env = process.env): AppConfig {
  const launch: LaunchOptions = { headless: envFlag(env, "PW_HEADLESS", true) };
  const executablePath = env.PW_EXECUTABLE_PATH;
  if (executablePath !== undefined) {
    launch.executablePath = executablePath;
  }

  const manager: ManagerConfig = {
    maxSessions: envInt(env, "PW_MAX_SESSIONS", DEFAULT_MAX_SESSIONS, 1),
    idleTimeoutMs: envInt(env, "PW_IDLE_TIMEOUT_MS", 0, 0),
    maxTabs: envInt(env, "PW_MAX_TABS", DEFAULT_MAX_TABS, 1),
    maxCaptureEntries: envInt(env, "PW_MAX_CAPTURE", DEFAULT_MAX_CAPTURE_ENTRIES, 1),
  };

  const allowedOrigins = parseOrigins(env, "PW_ALLOWED_ORIGINS");
  const uploadDir = env.PW_UPLOAD_DIR;
  const security: SecurityConfig = {
    outputDir: path.resolve(env.PW_OUTPUT_DIR ?? "output"),
    allowFileUrls: envFlag(env, "PW_ALLOW_FILE_URLS", false),
    ...(allowedOrigins !== undefined ? { allowedOrigins } : {}),
    ...(uploadDir !== undefined ? { uploadDir: path.resolve(uploadDir) } : {}),
  };

  return { launch, manager, security };
}

/** One-line, stderr-safe summary of the effective config, for startup logging. */
export function describeConfig(config: AppConfig): string {
  const { launch, manager, security } = config;
  return [
    `headless=${String(launch.headless ?? true)}`,
    `maxSessions=${String(manager.maxSessions)}`,
    `idleTimeoutMs=${String(manager.idleTimeoutMs)}`,
    `maxTabs=${String(manager.maxTabs)}`,
    `maxCapture=${String(manager.maxCaptureEntries)}`,
    `outputDir=${security.outputDir}`,
    `allowFileUrls=${String(security.allowFileUrls)}`,
    `allowedOrigins=${security.allowedOrigins ? security.allowedOrigins.join(",") : "(any)"}`,
    `uploadDir=${security.uploadDir ?? "(unrestricted)"}`,
  ].join(" ");
}
