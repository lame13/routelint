import { describe, expect, it } from "vitest";
import {
  isSameOrigin,
  isUrlIncluded,
  normalizeUrl,
  redactErrorText,
  redactUrl,
  redactUrlReference,
} from "../src/url.js";

describe("normalizeUrl", () => {
  it("resolves relative URLs, removes fragments, and normalizes default ports", () => {
    expect(normalizeUrl("../guide?b=2&a=1#part", "https://example.test:443/docs/page")).toBe(
      "https://example.test/guide?b=2&a=1",
    );
  });

  it("can remove queries without rewriting the path", () => {
    expect(normalizeUrl("/search?q=one#results", "https://example.test", "drop")).toBe(
      "https://example.test/search",
    );
  });

  it("rejects non-web protocols and URL credentials", () => {
    expect(normalizeUrl("mailto:test@example.test", "https://example.test")).toBeUndefined();
    expect(normalizeUrl("https://user:pass@example.test/", "https://example.test")).toBeUndefined();
  });
});

describe("URL scope helpers", () => {
  it("uses exact origins rather than hostname suffixes", () => {
    expect(isSameOrigin("https://example.test/a", "https://example.test/b")).toBe(true);
    expect(isSameOrigin("https://cdn.example.test/a", "https://example.test/b")).toBe(false);
    expect(isSameOrigin("http://example.test/a", "https://example.test/b")).toBe(false);
  });

  it("applies include globs before exclude globs", () => {
    expect(isUrlIncluded("https://example.test/docs/start", ["/docs/**"], ["**/private/**"])).toBe(
      true,
    );
    expect(
      isUrlIncluded("https://example.test/docs/private/key", ["/docs/**"], ["**/private/**"]),
    ).toBe(false);
    expect(isUrlIncluded("https://example.test/blog/post", ["/docs/**"], [])).toBe(false);
  });

  it("supports absolute URL globs", () => {
    expect(isUrlIncluded("https://example.test/docs?a=1", ["https://example.test/**"], [])).toBe(
      true,
    );
  });
});

describe("redaction", () => {
  it("redacts credentials and common secret query keys", () => {
    const redacted = redactUrl(
      "https://admin:password@example.test/callback?access_token=abc&view=full&api_key=def",
    );
    expect(redacted).not.toContain("password");
    expect(redacted).not.toContain("abc");
    expect(redacted).not.toContain("def");
    expect(redacted).toContain("view=full");
  });

  it("removes header values and URL secrets from error text", () => {
    const message = redactErrorText(
      "Bearer top-secret failed at https://example.test/path?token=secret-value.",
      ["top-secret"],
    );
    expect(message).not.toContain("top-secret");
    expect(message).not.toContain("secret-value");
    expect(message).toContain("[redacted]");
  });

  it("redacts secret values in relative response-header URLs", () => {
    const redacted = redactUrlReference("../preview?apiKey=secret&view=full#result");
    expect(redacted).not.toContain("secret");
    expect(redacted).toContain("view=full");
    expect(redacted).toContain("#result");
  });
});
