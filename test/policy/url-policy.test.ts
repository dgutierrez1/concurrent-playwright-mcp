import { describe, expect, it } from "vitest";
import { NavigationBlockedError } from "../../src/errors";
import { assertUrlAllowed } from "../../src/policy/url-policy";

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
