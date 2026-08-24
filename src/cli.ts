#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Command, CommanderError, InvalidArgumentError, Option } from "commander";

import { changedOnlyReport } from "./changed.js";
import {
  type ConfigOverrides,
  DEFAULT_CONFIG_YAML,
  loadConfig,
  parseHeaderOptions,
} from "./config.js";
import { diffReports, readRouteLintReport, renderDiffJson, renderDiffTerminal } from "./diff.js";
import { renderReport } from "./reporters/index.js";
import { runRouteLint } from "./run.js";
import type { ReportFormat, Severity } from "./types.js";
import { VERSION } from "./version.js";

type FailureThreshold = Severity | "none";

interface CheckCliOptions {
  readonly config?: string;
  readonly output?: string;
  readonly format: ReportFormat;
  readonly failOn: FailureThreshold;
  readonly color: boolean;
  readonly maxPages?: number;
  readonly maxDepth?: number;
  readonly concurrency?: number;
  readonly timeout?: number;
  readonly maxBytes?: number;
  readonly maxRedirects?: number;
  readonly agent?: readonly string[];
  readonly header?: readonly string[];
  readonly sitemap?: readonly string[];
  readonly urls?: readonly string[];
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly query?: "drop" | "keep";
  readonly ignoreRobots?: boolean;
  readonly rendered?: boolean;
  readonly renderConcurrency?: number;
  readonly renderTimeout?: number;
  readonly renderSettle?: number;
  readonly changedOnly?: string;
  readonly root?: string;
  readonly buildDirectory?: string;
}

function collect(value: string, previous: readonly string[] = []): string[] {
  return [...previous, value];
}

function integer(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new InvalidArgumentError("Expected a non-negative integer.");
  }
  return parsed;
}

function positiveInteger(value: string): number {
  const parsed = integer(value);
  if (parsed === 0) throw new InvalidArgumentError("Expected an integer greater than zero.");
  return parsed;
}

function duration(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/i.exec(value.trim());
  if (match === null) throw new InvalidArgumentError("Use milliseconds, 15s, or 1m.");
  const amount = Number(match[1]);
  const unit = match[2]?.toLowerCase() ?? "ms";
  const multiplier = unit === "m" ? 60_000 : unit === "s" ? 1_000 : 1;
  const result = Math.round(amount * multiplier);
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new InvalidArgumentError("Timeout must be greater than zero.");
  }
  return result;
}

function settleDuration(value: string): number {
  return /^0(?:ms|s|m)?$/i.test(value.trim()) ? 0 : duration(value);
}

function bytes(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(b|kb|mb)?$/i.exec(value.trim());
  if (match === null) throw new InvalidArgumentError("Use bytes, 512kb, or 2mb.");
  const amount = Number(match[1]);
  const unit = match[2]?.toLowerCase() ?? "b";
  const multiplier = unit === "mb" ? 1024 * 1024 : unit === "kb" ? 1024 : 1;
  const result = Math.round(amount * multiplier);
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new InvalidArgumentError("Byte limit must be greater than zero.");
  }
  return result;
}

function addCheckOptions(command: Command): Command {
  return command
    .option("-c, --config <file>", "read YAML or JSON config")
    .addOption(
      new Option("-f, --format <format>", "report format")
        .choices(["terminal", "json", "sarif", "html"])
        .default("terminal"),
    )
    .option("-o, --output <file>", "write the report to a file")
    .addOption(
      new Option("--fail-on <severity>", "set the failing severity")
        .choices(["error", "warning", "info", "none"])
        .default("error"),
    )
    .option("--no-color", "disable terminal colors")
    .option("--max-pages <count>", "maximum pages to fetch", positiveInteger)
    .option("--max-depth <count>", "maximum crawl depth", integer)
    .option("--concurrency <count>", "concurrent requests", positiveInteger)
    .option("--timeout <duration>", "timeout for each request", duration)
    .option("--max-bytes <size>", "maximum HTML bytes per response", bytes)
    .option("--max-redirects <count>", "maximum redirect hops", integer)
    .option("--agent <name-or-user-agent>", "repeat for bot-delivery comparison", collect)
    .option("--header <name:value>", "repeat for preview credentials", collect)
    .option("--sitemap <url>", "repeat to override sitemap discovery", collect)
    .option("--urls <file>", "repeat for URL-list files; use - for stdin", collect)
    .option("--include <pattern>", "repeat to include matching paths", collect)
    .option("--exclude <pattern>", "repeat to exclude matching paths", collect)
    .addOption(new Option("--query <policy>", "query-string handling").choices(["drop", "keep"]))
    .option("--ignore-robots", "fetch routes even when robots.txt disallows them")
    .option("--rendered", "compare server HTML with a Playwright-rendered DOM")
    .option("--render-concurrency <count>", "concurrent browser pages", positiveInteger)
    .option("--render-timeout <duration>", "browser navigation timeout", duration)
    .option("--render-settle <duration>", "wait after DOMContentLoaded", settleDuration)
    .option("--changed-only <baseline.json>", "report only new or worsened findings");
}

function overrides(baseUrl: string | undefined, options: CheckCliOptions): ConfigOverrides {
  return {
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(options.maxPages === undefined ? {} : { maxPages: options.maxPages }),
    ...(options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth }),
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    ...(options.timeout === undefined ? {} : { timeoutMs: options.timeout }),
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    ...(options.maxRedirects === undefined ? {} : { maxRedirects: options.maxRedirects }),
    ...(options.agent === undefined ? {} : { agents: options.agent }),
    ...(options.header === undefined ? {} : { headers: parseHeaderOptions(options.header) }),
    ...(options.sitemap === undefined ? {} : { sitemaps: options.sitemap }),
    ...(options.urls === undefined ? {} : { urlFiles: options.urls }),
    ...(options.include === undefined ? {} : { include: options.include }),
    ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
    ...(options.query === undefined ? {} : { queryPolicy: options.query }),
    ...(options.ignoreRobots === true ? { respectRobots: false } : {}),
    ...(options.rendered === true ? { rendered: true } : {}),
    ...(options.renderConcurrency === undefined
      ? {}
      : { renderedConcurrency: options.renderConcurrency }),
    ...(options.renderTimeout === undefined ? {} : { renderedTimeoutMs: options.renderTimeout }),
    ...(options.renderSettle === undefined ? {} : { renderedSettleMs: options.renderSettle }),
    ...(options.root === undefined ? {} : { nextRoot: options.root }),
    ...(options.buildDirectory === undefined ? {} : { buildDirectory: options.buildDirectory }),
  };
}

function shouldFail(severities: readonly Severity[], threshold: FailureThreshold): boolean {
  if (threshold === "none") return false;
  const rank: Readonly<Record<Severity, number>> = { error: 0, warning: 1, info: 2 };
  return severities.some((severity) => rank[severity] <= rank[threshold]);
}

async function output(text: string, path: string | undefined): Promise<void> {
  if (path === undefined || path === "-") {
    process.stdout.write(text);
    return;
  }
  const target = resolve(path);
  await writeFile(target, text, "utf8");
  process.stderr.write(`Wrote ${target}\n`);
}

async function executeCheck(
  baseUrl: string | undefined,
  options: CheckCliOptions,
  nextMode: boolean,
): Promise<void> {
  const config = await loadConfig({
    ...(options.config === undefined ? {} : { configPath: options.config }),
    overrides: {
      ...overrides(baseUrl, options),
      ...(nextMode ? { enableNext: true } : {}),
    },
  });
  const completeReport = await runRouteLint(config);
  const report =
    options.changedOnly === undefined
      ? completeReport
      : changedOnlyReport(completeReport, await readRouteLintReport(options.changedOnly));
  const text = renderReport(report, options.format, {
    color: options.color && options.output === undefined && process.stdout.isTTY === true,
  });
  await output(text, options.output);
  if (
    shouldFail(
      report.findings.map((finding) => finding.severity),
      options.failOn,
    )
  ) {
    process.exitCode = 1;
  }
}

export function createProgram(): Command {
  const program = new Command()
    .name("routelint")
    .description(
      "Lint SSR routes, links, canonicals, sitemaps, hreflang, redirects, and indexability.",
    )
    .version(VERSION)
    .showHelpAfterError();

  addCheckOptions(
    program
      .command("check")
      .description("crawl and lint any HTTP(S) site")
      .argument("[base-url]", "site URL; optional when config supplies baseUrl"),
  ).action(async (baseUrl: string | undefined, options: CheckCliOptions) => {
    await executeCheck(baseUrl, options, false);
  });

  addCheckOptions(
    program
      .command("next")
      .description("add Next.js build-manifest routes to the live crawl")
      .argument("[base-url]", "running Next.js site URL; optional when config supplies baseUrl")
      .option("--root <directory>", "Next.js project root")
      .option("--build-directory <directory>", "build directory under the project root", ".next"),
  ).action(async (baseUrl: string | undefined, options: CheckCliOptions) => {
    await executeCheck(baseUrl, options, true);
  });

  program
    .command("diff")
    .description("compare two RouteLint JSON reports")
    .argument("<baseline>", "older JSON report")
    .argument("<current>", "newer JSON report")
    .addOption(
      new Option("-f, --format <format>", "diff output format")
        .choices(["terminal", "json"])
        .default("terminal"),
    )
    .option("-o, --output <file>", "write the diff to a file")
    .addOption(
      new Option("--fail-on <severity>", "set the failing severity")
        .choices(["error", "warning", "info", "none"])
        .default("error"),
    )
    .action(
      async (
        baselinePath: string,
        currentPath: string,
        options: {
          readonly format: "terminal" | "json";
          readonly output?: string;
          readonly failOn: FailureThreshold;
        },
      ) => {
        const [baseline, current] = await Promise.all([
          readRouteLintReport(baselinePath),
          readRouteLintReport(currentPath),
        ]);
        const diff = diffReports(baseline, current);
        await output(
          options.format === "json" ? renderDiffJson(diff) : renderDiffTerminal(diff),
          options.output,
        );
        if (
          shouldFail(
            diff.changes.map((change) => change.severity),
            options.failOn,
          )
        ) {
          process.exitCode = 1;
        }
      },
    );

  program
    .command("init")
    .description("write a documented starter config")
    .argument("[file]", "config path", "routelint.config.yml")
    .action(async (path: string) => {
      const target = resolve(path);
      try {
        await writeFile(target, DEFAULT_CONFIG_YAML, { encoding: "utf8", flag: "wx" });
      } catch (error) {
        const code =
          typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
        if (code === "EEXIST") throw new Error(`Refusing to overwrite existing file: ${target}`);
        throw error;
      }
      process.stdout.write(`Created ${target}\n`);
    });

  return program;
}

function overrideCommanderExits(command: Command): Command {
  command.exitOverride();
  for (const child of command.commands) overrideCommanderExits(child);
  return command;
}

export async function main(argv: readonly string[] = process.argv): Promise<void> {
  const program = overrideCommanderExits(createProgram());
  try {
    await program.parseAsync([...argv]);
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.exitCode !== 0) process.exitCode = 2;
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`RouteLint: ${message}\n`);
    process.exitCode = 2;
  }
}

function isMainModule(): boolean {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  await main();
}
