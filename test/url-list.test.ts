import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { loadUrlLists } from "../src/discovery/url-list.js";

describe("URL-list input", () => {
  it("reads a small real file without waiting for a full stream buffer", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "routelint-url-list-"));
    const file = path.join(directory, "targets.txt");
    try {
      await writeFile(file, "/one\n/two\n", "utf8");
      const inventory = await loadUrlLists([file], { baseUrl: "https://example.test" });

      expect(inventory.urls).toEqual(["https://example.test/one", "https://example.test/two"]);
      expect(inventory.diagnostics).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("loads repeated files, resolves paths, ignores comments, and de-duplicates in order", async () => {
    const readFile = vi.fn(async (filePath: string) => {
      if (filePath.endsWith("one.txt")) {
        return "\uFEFF# crawl targets\r\n/about\r\nrelative\r\n/products?z=2&a=1#details\r\n";
      }
      return "/about\nhttps://example.test/contact\n";
    });

    const inventory = await loadUrlLists(["one.txt", "two.txt", "one.txt"], {
      baseUrl: "https://example.test/docs/",
      cwd: "/project",
      readFile,
    });

    expect(readFile.mock.calls.map(([filePath]) => filePath)).toEqual([
      path.resolve("/project", "one.txt"),
      path.resolve("/project", "two.txt"),
      path.resolve("/project", "one.txt"),
    ]);
    expect(inventory.urls).toEqual([
      "https://example.test/about",
      "https://example.test/docs/relative",
      "https://example.test/products?a=1&z=2",
      "https://example.test/contact",
    ]);
    expect(inventory.entries).toEqual([
      { url: "https://example.test/about", source: "one.txt", line: 2 },
      { url: "https://example.test/docs/relative", source: "one.txt", line: 3 },
      {
        url: "https://example.test/products?a=1&z=2",
        source: "one.txt",
        line: 4,
      },
      { url: "https://example.test/contact", source: "two.txt", line: 2 },
    ]);
    expect(inventory.sources).toMatchObject([
      { source: "one.txt", kind: "file", accepted: 3, rejected: 0 },
      { source: "two.txt", kind: "file", accepted: 1, rejected: 0 },
      { source: "one.txt", kind: "file", accepted: 0, rejected: 0 },
    ]);
    expect(inventory.diagnostics).toEqual([]);
  });

  it("reads stdin once and reports a repeated '-' without consuming it again", async () => {
    const readStdin = vi.fn(async () => "/one\n/two\n");

    const inventory = await loadUrlLists(["-", "-"], {
      baseUrl: "https://example.test",
      readStdin,
    });

    expect(readStdin).toHaveBeenCalledTimes(1);
    expect(inventory.urls).toEqual(["https://example.test/one", "https://example.test/two"]);
    expect(inventory.diagnostics).toEqual([
      {
        severity: "error",
        code: "stdin-reused",
        source: "<stdin>",
        message: "<stdin> was already consumed; use '-' only once.",
      },
    ]);
  });

  it("rejects malformed, unsafe, and unsupported entries with source-line diagnostics", async () => {
    const inventory = await loadUrlLists(["targets.txt"], {
      baseUrl: "https://example.test",
      readFile: async () =>
        [
          "https://[invalid",
          "mailto:owner@example.test",
          "https://user:secret@example.test/private",
          "https://other.test/page",
          "/safe",
        ].join("\n"),
    });

    expect(inventory.urls).toEqual(["https://example.test/safe"]);
    expect(
      inventory.diagnostics.map(({ severity, code, source, line, message }) => ({
        severity,
        code,
        source,
        line,
        message,
      })),
    ).toEqual([
      {
        severity: "error",
        code: "invalid-entry",
        source: "targets.txt",
        line: 1,
        message: "targets.txt:1 is not a valid URL or path.",
      },
      {
        severity: "error",
        code: "unsupported-protocol",
        source: "targets.txt",
        line: 2,
        message: "targets.txt:2 uses the unsupported mailto: protocol.",
      },
      {
        severity: "error",
        code: "credentials-not-allowed",
        source: "targets.txt",
        line: 3,
        message: "targets.txt:3 contains URL credentials.",
      },
      {
        severity: "warning",
        code: "off-origin",
        source: "targets.txt",
        line: 4,
        message:
          "targets.txt:4 targets https://other.test, outside the configured https://example.test origin.",
      },
    ]);
    expect(inventory.sources[0]).toMatchObject({ accepted: 1, rejected: 4 });
  });

  it("reports file failures and enforces the source byte limit without partial acceptance", async () => {
    const inventory = await loadUrlLists(["missing.txt", "large.txt"], {
      baseUrl: "https://example.test",
      maxBytesPerSource: 4,
      readFile: async (filePath) => {
        if (filePath.endsWith("missing.txt")) throw new Error("ENOENT");
        return "/one\n";
      },
    });

    expect(inventory.urls).toEqual([]);
    expect(inventory.diagnostics.map(({ code, source }) => ({ code, source }))).toEqual([
      { code: "source-read-failed", source: "missing.txt" },
      { code: "source-too-large", source: "large.txt" },
    ]);
    expect(inventory.sources).toMatchObject([
      { source: "missing.txt", accepted: 0, rejected: 1 },
      { source: "large.txt", accepted: 0, rejected: 1 },
    ]);
  });

  it("rejects an oversized file from metadata before opening its reader", async () => {
    const statFile = vi.fn(async () => ({ size: 9 }));
    const readFileChunks = vi.fn(() =>
      (async function* () {
        yield "/one\n";
      })(),
    );

    const inventory = await loadUrlLists(["large.txt"], {
      baseUrl: "https://example.test",
      cwd: "/project",
      maxBytesPerSource: 8,
      statFile,
      readFileChunks,
    });

    expect(statFile).toHaveBeenCalledWith(path.resolve("/project", "large.txt"));
    expect(readFileChunks).not.toHaveBeenCalled();
    expect(inventory.urls).toEqual([]);
    expect(inventory.diagnostics).toEqual([
      {
        severity: "error",
        code: "source-too-large",
        source: "large.txt",
        message: "large.txt is 9 bytes and exceeds the 8-byte limit.",
      },
    ]);
  });

  it("stops incremental stdin reading at the limit and closes the iterator", async () => {
    let yielded = 0;
    let closed = false;

    async function* stdinChunks(): AsyncGenerator<string> {
      try {
        yielded += 1;
        yield "/one\n";
        yielded += 1;
        yield "/two\n";
        yielded += 1;
        yield "/three\n";
      } finally {
        closed = true;
      }
    }

    const inventory = await loadUrlLists(["-"], {
      baseUrl: "https://example.test",
      maxBytesPerSource: 8,
      readStdinChunks: stdinChunks,
    });

    expect(yielded).toBe(2);
    expect(closed).toBe(true);
    expect(inventory.urls).toEqual([]);
    expect(inventory.diagnostics).toEqual([
      {
        severity: "error",
        code: "source-too-large",
        source: "<stdin>",
        message: "<stdin> is at least 10 bytes and exceeds the 8-byte limit.",
      },
    ]);
  });

  it("removes stream listeners when bounded stdin reading stops early", async () => {
    const stream = Readable.from([Buffer.from("/one\n"), Buffer.from("/two\n")]);
    const stdin = vi.spyOn(process, "stdin", "get").mockReturnValue(stream as typeof process.stdin);

    try {
      const inventory = await loadUrlLists(["-"], {
        baseUrl: "https://example.test",
        maxBytesPerSource: 4,
      });

      expect(inventory.diagnostics[0]?.code).toBe("source-too-large");
      expect(stream.destroyed).toBe(false);
      for (const event of ["readable", "end", "finish", "close", "error"]) {
        expect(stream.listenerCount(event)).toBe(0);
      }
    } finally {
      stdin.mockRestore();
    }
  });

  it("validates the base URL and byte limit before reading input", async () => {
    await expect(
      loadUrlLists(["targets.txt"], {
        baseUrl: "file:///tmp/site",
        readFile: async () => "/one",
      }),
    ).rejects.toThrow("must use HTTP or HTTPS");

    await expect(
      loadUrlLists(["targets.txt"], {
        baseUrl: "https://example.test",
        maxBytesPerSource: 0,
        readFile: async () => "/one",
      }),
    ).rejects.toThrow("positive safe integer");
  });
});
