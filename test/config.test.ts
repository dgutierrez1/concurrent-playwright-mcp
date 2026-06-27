import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config";

/** Silence (and capture) the stderr warnings loadConfig emits for bad input. */
function muteWarnings() {
  return vi.spyOn(console, "error").mockImplementation(() => undefined);
}

describe("loadConfig", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses safe defaults for an empty environment", () => {
    const config = loadConfig({});
    expect(config.manager).toEqual({
      maxSessions: 50,
      idleTimeoutMs: 0,
      maxTabs: 20,
      maxCaptureEntries: 1000,
      actionTimeoutMs: 15000,
    });
    expect(config.launch.headless).toBe(true);
    expect(config.security.allowFileUrls).toBe(false);
    expect(config.security.allowedOrigins).toBeUndefined();
    expect(config.security.uploadDir).toBeUndefined();
    expect(config.security.outputDir).toBe(path.resolve("output"));
    expect(config.transport).toEqual({ mode: "stdio", host: "127.0.0.1", port: 3000 });
  });

  it("parses the http transport vars", () => {
    const config = loadConfig({
      PW_TRANSPORT: "http",
      PW_HOST: "0.0.0.0",
      PW_PORT: "8080",
      PW_ALLOWED_HOSTS: "example.com:8080, app.internal:8080",
      PW_ACTION_TIMEOUT_MS: "5000",
    });
    expect(config.transport).toEqual({
      mode: "http",
      host: "0.0.0.0",
      port: 8080,
      allowedHosts: ["example.com:8080", "app.internal:8080"],
    });
    expect(config.manager.actionTimeoutMs).toBe(5000);
  });

  it("warns on an unrecognized transport and falls back to stdio", () => {
    const warn = muteWarnings();
    expect(loadConfig({ PW_TRANSPORT: "carrier-pigeon" }).transport.mode).toBe("stdio");
    expect(warn).toHaveBeenCalled();
  });

  it("parses valid values", () => {
    const config = loadConfig({
      PW_HEADLESS: "false",
      PW_MAX_SESSIONS: "5",
      PW_IDLE_TIMEOUT_MS: "1000",
      PW_MAX_TABS: "3",
      PW_MAX_CAPTURE: "10",
      PW_ALLOW_FILE_URLS: "true",
      PW_ALLOWED_ORIGINS: "https://a.com, https://b.com/path",
      PW_OUTPUT_DIR: "shots",
      PW_UPLOAD_DIR: "uploads",
    });
    expect(config.launch.headless).toBe(false);
    expect(config.manager.maxSessions).toBe(5);
    expect(config.manager.maxTabs).toBe(3);
    expect(config.manager.maxCaptureEntries).toBe(10);
    expect(config.security.allowFileUrls).toBe(true);
    expect(config.security.allowedOrigins).toEqual(["https://a.com", "https://b.com"]);
    expect(config.security.outputDir).toBe(path.resolve("shots"));
    expect(config.security.uploadDir).toBe(path.resolve("uploads"));
  });

  it("falls back and warns on non-positive or non-numeric maxSessions", () => {
    const warn = muteWarnings();
    expect(loadConfig({ PW_MAX_SESSIONS: "0" }).manager.maxSessions).toBe(50);
    expect(loadConfig({ PW_MAX_SESSIONS: "-5" }).manager.maxSessions).toBe(50);
    expect(loadConfig({ PW_MAX_SESSIONS: "abc" }).manager.maxSessions).toBe(50);
    expect(loadConfig({ PW_MAX_SESSIONS: "12.5" }).manager.maxSessions).toBe(50);
    expect(warn).toHaveBeenCalled();
  });

  it("reads scientific notation as its real value, unlike parseInt", () => {
    expect(loadConfig({ PW_MAX_SESSIONS: "1e3" }).manager.maxSessions).toBe(1000);
  });

  it("warns on an unrecognized boolean and keeps the default", () => {
    const warn = muteWarnings();
    expect(loadConfig({ PW_HEADLESS: "maybe" }).launch.headless).toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  it("drops invalid origins from the allowlist", () => {
    const warn = muteWarnings();
    const config = loadConfig({ PW_ALLOWED_ORIGINS: "https://ok.com, not-a-url" });
    expect(config.security.allowedOrigins).toEqual(["https://ok.com"]);
    expect(warn).toHaveBeenCalled();
  });
});
