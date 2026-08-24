import { createHash } from "node:crypto";
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { capturePage } from "../src/http.js";
import type { AgentProfile } from "../src/types.js";

const agent: AgentProfile = {
  key: "testbot",
  label: "Test bot",
  userAgent: "TestBot/1.0",
};
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
});

describe("capturePage", () => {
  it("rejects unsafe limits before making a request", async () => {
    await expect(
      capturePage("https://example.test/", {
        agent,
        timeoutMs: 2_000,
        maxBytes: 10_000,
        maxRedirects: Number.POSITIVE_INFINITY,
      }),
    ).rejects.toThrow("maxRedirects must be a safe integer");
  });

  it("follows explicit redirects and captures the raw HTML response", async () => {
    const body = `<!doctype html><html><head><title>Server title</title>
      <meta name="description" content="From SSR"></head><body><h1>Ready</h1></body></html>`;
    const origin = await listen((request, response) => {
      if (request.url === "/start") {
        expect(request.headers["x-preview-key"]).toBe("private-value");
        response.writeHead(302, { location: "/final" }).end();
        return;
      }
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "set-cookie": "session=should-not-leak",
        "x-robots-tag": "googlebot: noindex, nofollow",
      });
      response.end(body);
    });

    const snapshot = await capturePage(`${origin}/start`, {
      agent,
      headers: { "x-preview-key": "private-value" },
      timeoutMs: 2_000,
      maxBytes: 100_000,
      maxRedirects: 3,
    });

    expect(snapshot.completion).toBe("complete");
    expect(snapshot.status).toBe(200);
    expect(snapshot.finalUrl).toBe(`${origin}/final`);
    expect(snapshot.redirects).toHaveLength(1);
    expect(snapshot.redirects[0]).toMatchObject({
      url: `${origin}/start`,
      status: 302,
      location: `${origin}/final`,
    });
    expect(snapshot.signals.titles[0]?.value).toBe("Server title");
    expect(snapshot.signals.descriptions[0]?.value).toBe("From SSR");
    expect(snapshot.signals.robots).toEqual([
      {
        value: "noindex",
        location: "head",
        audience: "googlebot",
        source: "header",
      },
      {
        value: "nofollow",
        location: "head",
        audience: "googlebot",
        source: "header",
      },
    ]);
    expect(snapshot.headers["set-cookie"]).toBe("[redacted]");
    expect(snapshot.bodySha256).toBe(createHash("sha256").update(body).digest("hex"));
  });

  it("never forwards custom headers across an origin-changing redirect", async () => {
    let receivedSecret: string | undefined;
    const destination = await listen((request, response) => {
      const header = request.headers["x-preview-key"];
      receivedSecret = Array.isArray(header) ? header[0] : header;
      response.writeHead(200, { "content-type": "text/html" }).end("<title>Destination</title>");
    });
    const source = await listen((_request, response) => {
      response.writeHead(302, { location: `${destination}/landing` }).end();
    });

    const snapshot = await capturePage(`${source}/start`, {
      agent,
      headers: { "x-preview-key": "private-value", authorization: "Bearer private" },
      timeoutMs: 2_000,
      maxBytes: 10_000,
      maxRedirects: 2,
    });

    expect(snapshot.status).toBe(200);
    expect(receivedSecret).toBeUndefined();
  });

  it("stops streaming at the byte budget and hashes the retained prefix", async () => {
    const body = "0123456789abcdefghijklmnopqrstuvwxyz";
    const origin = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" }).end(body);
    });

    const snapshot = await capturePage(`${origin}/large`, {
      agent,
      timeoutMs: 2_000,
      maxBytes: 10,
      maxRedirects: 0,
    });

    expect(snapshot.completion).toBe("max-bytes-exceeded");
    expect(snapshot.bytesRead).toBe(10);
    expect(snapshot.bodySha256).toBe(createHash("sha256").update(body.slice(0, 10)).digest("hex"));
  });

  it("reports a bounded timeout without exposing request header values", async () => {
    const origin = await listen((_request, response) => {
      setTimeout(() => response.end("too late"), 100);
    });
    const snapshot = await capturePage(`${origin}/slow?token=url-secret`, {
      agent,
      headers: { authorization: "Bearer header-secret" },
      timeoutMs: 20,
      maxBytes: 1_000,
      maxRedirects: 0,
    });

    expect(snapshot.completion).toBe("timeout");
    expect(snapshot.error).toContain("20 ms");
    expect(snapshot.error).not.toContain("header-secret");
    expect(snapshot.error).not.toContain("url-secret");
  });

  it("hashes but does not parse non-HTML responses", async () => {
    const body = '{"html":"<title>Not a document</title>"}';
    const origin = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" }).end(body);
    });
    const snapshot = await capturePage(`${origin}/data`, {
      agent,
      timeoutMs: 2_000,
      maxBytes: 10_000,
      maxRedirects: 0,
    });

    expect(snapshot.completion).toBe("complete");
    expect(snapshot.signals.titles).toEqual([]);
    expect(snapshot.bodySha256).toBe(createHash("sha256").update(body).digest("hex"));
  });

  it("fails clearly when the explicit redirect budget is exceeded", async () => {
    const origin = await listen((_request, response) => {
      response.writeHead(302, { location: "/again?token=not-for-report" }).end();
    });
    const snapshot = await capturePage(`${origin}/start`, {
      agent,
      timeoutMs: 2_000,
      maxBytes: 10_000,
      maxRedirects: 0,
    });

    expect(snapshot.completion).toBe("invalid-response");
    expect(snapshot.redirects).toHaveLength(1);
    expect(snapshot.error).toContain("Redirect limit exceeded");
    expect(snapshot.redirects[0]?.location).not.toContain("not-for-report");
    expect(snapshot.headers.location).not.toContain("not-for-report");
  });
});

async function listen(listener: RequestListener): Promise<string> {
  const server = createServer(listener);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}
