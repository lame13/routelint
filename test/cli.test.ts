import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG_YAML } from "../src/config.js";
import { VERSION } from "../src/version.js";

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const tsxImportPath = createRequire(import.meta.url).resolve("tsx");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

interface CliResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "routelint-cli-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function runCli(arguments_: readonly string[], cwd: string): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", tsxImportPath, cliPath, ...arguments_], {
      cwd,
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function emptyReport(generatedAt: string): Record<string, unknown> {
  return {
    schemaVersion: "1",
    toolVersion: VERSION,
    generatedAt,
    durationMs: 1,
    baseUrl: "https://example.test/",
    config: {
      maxPages: 10,
      maxDepth: 2,
      agents: ["routelint"],
      respectRobots: true,
      queryPolicy: "drop",
    },
    sitemap: { requested: [], fetched: [], entries: [], warnings: [] },
    routes: [],
    findings: [],
    summary: {
      routes: 0,
      fetched: 0,
      indexable: 0,
      errors: 0,
      warnings: 0,
      info: 0,
      brokenLinks: 0,
      redirects: 0,
      noindex: 0,
      maxDepth: 0,
    },
    truncated: false,
  };
}

describe("packaged-style CLI execution", () => {
  it("prints top-level and command help without importing a network target", async () => {
    const directory = await temporaryDirectory();
    const topLevel = await runCli(["--help"], directory);
    const check = await runCli(["check", "--help"], directory);

    expect(topLevel).toMatchObject({ code: 0, stderr: "" });
    expect(topLevel.stdout).toContain("Usage: routelint [options] [command]");
    expect(topLevel.stdout).toContain("check");
    expect(topLevel.stdout).toContain("next");
    expect(topLevel.stdout).toContain("diff");
    expect(topLevel.stdout).toContain("init");
    expect(check).toMatchObject({ code: 0, stderr: "" });
    expect(check.stdout).toContain("Usage: routelint check [options] [base-url]");
    expect(check.stdout).toContain("--max-pages <count>");
    expect(check.stdout).toContain("--ignore-robots");
    expect(check.stdout).toContain("--urls <file>");
    expect(check.stdout).toContain("--rendered");
    expect(check.stdout).toContain("--changed-only <baseline.json>");
  });

  it("prints the package version", async () => {
    const result = await runCli(["--version"], await temporaryDirectory());

    expect(result).toEqual({ code: 0, stdout: `${VERSION}\n`, stderr: "" });
  });

  it("initializes a config once and refuses to overwrite it", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "routelint.config.yml");
    const created = await runCli(["init"], directory);

    expect(created.code).toBe(0);
    expect(created.stdout).toBe(`Created ${await realpath(path)}\n`);
    expect(created.stderr).toBe("");
    expect(await readFile(path, "utf8")).toBe(DEFAULT_CONFIG_YAML);

    await writeFile(path, "user-owned: true\n", "utf8");
    const repeated = await runCli(["init"], directory);

    expect(repeated.code).toBe(2);
    expect(repeated.stderr).toContain("Refusing to overwrite existing file");
    expect(await readFile(path, "utf8")).toBe("user-owned: true\n");
  });

  it("compares report files through the real command entrypoint without network access", async () => {
    const directory = await temporaryDirectory();
    const baselinePath = join(directory, "baseline.json");
    const currentPath = join(directory, "current.json");
    await Promise.all([
      writeFile(baselinePath, JSON.stringify(emptyReport("2026-08-20T00:00:00.000Z")), "utf8"),
      writeFile(currentPath, JSON.stringify(emptyReport("2026-08-22T00:00:00.000Z")), "utf8"),
    ]);

    const result = await runCli(
      ["diff", baselinePath, currentPath, "--format", "json", "--fail-on", "none"],
      directory,
    );

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: "1",
      changes: [],
      summary: { added: 0, removed: 0, changed: 0 },
    });
  });

  it("uses exit code 1 when findings meet the failure threshold", async () => {
    const directory = await temporaryDirectory();
    const baselinePath = join(directory, "baseline.json");
    const currentPath = join(directory, "current.json");
    const current = {
      ...emptyReport("2026-08-22T00:00:00.000Z"),
      findings: [
        {
          code: "new-error",
          severity: "error",
          message: "A new error finding.",
          url: "https://example.test/broken",
        },
      ],
      summary: {
        routes: 0,
        fetched: 0,
        indexable: 0,
        errors: 1,
        warnings: 0,
        info: 0,
        brokenLinks: 0,
        redirects: 0,
        noindex: 0,
        maxDepth: 0,
      },
    };
    await Promise.all([
      writeFile(baselinePath, JSON.stringify(emptyReport("2026-08-20T00:00:00.000Z")), "utf8"),
      writeFile(currentPath, JSON.stringify(current), "utf8"),
    ]);

    const result = await runCli(["diff", baselinePath, currentPath, "--format", "json"], directory);

    expect(result.code).toBe(1);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      summary: { errors: 1 },
      changes: [{ code: "finding-added:new-error", severity: "error" }],
    });
  });

  it.each([
    [["--definitely-not-an-option"], "unknown option"],
    [["check", "--definitely-not-an-option"], "unknown option"],
    [["diff", "baseline-only.json"], "missing required argument 'current'"],
    [
      ["check", "https://example.test", "--max-pages", "0"],
      "Expected an integer greater than zero",
    ],
    [["diff", "baseline.json", "current.json", "extra.json"], "too many arguments"],
  ])("uses exit code 2 for Commander usage errors: %j", async (arguments_, message) => {
    const result = await runCli(arguments_, await temporaryDirectory());

    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(message);
    expect(result.stderr).toContain("Usage:");
  });

  it("returns a usage error before attempting a request for an invalid base URL", async () => {
    const result = await runCli(
      ["check", "not-an-http-url", "--format", "json"],
      await temporaryDirectory(),
    );

    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("baseUrl must be an absolute HTTP(S) URL");
  });
});
