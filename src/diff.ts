import { readFile } from "node:fs/promises";

import { z } from "zod";

import { getIndexability, getSnapshotIndexability } from "./audit.js";
import type {
  DiffChange,
  Finding,
  PageSnapshot,
  RouteLintDiff,
  RouteLintReport,
  RouteNode,
  Severity,
} from "./types.js";

const SEVERITY_ORDER: Readonly<Record<Severity, number>> = {
  error: 0,
  warning: 1,
  info: 2,
};

const severitySchema = z.enum(["error", "warning", "info"]);
const redirectStatusSchema = z.union([
  z.literal(301),
  z.literal(302),
  z.literal(303),
  z.literal(307),
  z.literal(308),
]);
const httpUrlSchema = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username.length === 0 &&
      url.password.length === 0
    );
  } catch {
    return false;
  }
}, "Expected an absolute HTTP(S) URL without credentials");
const nonNegativeIntegerSchema = z.number().int().nonnegative();
const nonNegativeNumberSchema = z.number().finite().nonnegative();
const routeDepthSchema = z.number().int().min(-1);

const agentSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  userAgent: z.string().min(1),
});
const metadataSignalSchema = z.object({
  value: z.string(),
  location: z.enum(["head", "body"]),
});
const robotsSignalSchema = metadataSignalSchema.extend({
  audience: z.enum(["robots", "googlebot", "bingbot"]),
  source: z.enum(["meta", "header"]),
});
const linkSignalSchema = z.object({
  href: z.string(),
  resolvedUrl: httpUrlSchema.optional(),
  text: z.string(),
  rel: z.array(z.string()),
  nofollow: z.boolean(),
});
const hreflangSignalSchema = z.object({
  language: z.string(),
  href: z.string(),
  resolvedUrl: httpUrlSchema.optional(),
});
const pageSignalsSchema = z.object({
  titles: z.array(metadataSignalSchema),
  descriptions: z.array(metadataSignalSchema),
  canonicals: z.array(metadataSignalSchema),
  robots: z.array(robotsSignalSchema),
  h1s: z.array(metadataSignalSchema),
  links: z.array(linkSignalSchema),
  hreflangs: z.array(hreflangSignalSchema),
  htmlLang: z.string().optional(),
  baseHref: z.string().optional(),
});
const pageContentEvidenceSchema = z.object({
  characters: nonNegativeIntegerSchema,
  words: nonNegativeIntegerSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  simhash: z.string().regex(/^[a-f0-9]{16}$/i),
});
const redirectHopSchema = z.object({
  url: httpUrlSchema,
  status: nonNegativeIntegerSchema,
  location: httpUrlSchema,
  durationMs: nonNegativeNumberSchema,
});
const snapshotSchema = z.object({
  requestedUrl: httpUrlSchema,
  finalUrl: httpUrlSchema,
  agent: agentSchema,
  status: nonNegativeIntegerSchema.optional(),
  contentType: z.string().optional(),
  headers: z.record(z.string(), z.string()),
  redirects: z.array(redirectHopSchema),
  signals: pageSignalsSchema,
  bytesRead: nonNegativeIntegerSchema,
  bodySha256: z.string().optional(),
  content: pageContentEvidenceSchema.optional(),
  durationMs: nonNegativeNumberSchema,
  completion: z.enum([
    "complete",
    "max-bytes-exceeded",
    "timeout",
    "network-error",
    "invalid-response",
    "robots-blocked",
  ]),
  error: z.string().optional(),
});
const routeSourceSchema = z.object({
  kind: z.enum([
    "seed",
    "sitemap",
    "internal-link",
    "next-build",
    "sample",
    "url-list",
    "redirect-contract",
  ]),
  from: z.string().optional(),
  detail: z.string().optional(),
});
const renderedSnapshotSchema = z.object({
  requestedUrl: httpUrlSchema,
  finalUrl: httpUrlSchema,
  status: nonNegativeIntegerSchema.optional(),
  completion: z.enum(["complete", "timeout", "navigation-error", "capture-error"]),
  signals: pageSignalsSchema,
  content: pageContentEvidenceSchema.optional(),
  htmlBytes: nonNegativeIntegerSchema,
  durationMs: nonNegativeNumberSchema,
  error: z.string().optional(),
});
const buildRouteSchema = z.object({
  pathname: z.string(),
  pattern: z.string().optional(),
  renderMode: z.enum(["static", "isr", "dynamic", "unknown"]),
  revalidateSeconds: z.union([nonNegativeNumberSchema, z.literal(false)]).optional(),
  sourceManifest: z.string(),
});
const buildRedirectSchema = z.object({
  source: z.string(),
  destination: z.string(),
  status: nonNegativeIntegerSchema,
  conditional: z.boolean().optional(),
});
const redirectExpectationSchema = z.object({
  from: httpUrlSchema,
  to: httpUrlSchema,
  status: redirectStatusSchema,
  maxHops: z.number().int().positive(),
});
const redirectContractSchema = redirectExpectationSchema.extend({
  source: z.enum(["config", "next-build"]),
});
const redirectContractReportSchema = z.object({
  declared: nonNegativeIntegerSchema,
  verified: nonNegativeIntegerSchema,
  failed: nonNegativeIntegerSchema,
  unchecked: nonNegativeIntegerSchema,
  skippedBuildRedirects: nonNegativeIntegerSchema,
  checks: z.array(
    z.object({
      contract: redirectContractSchema,
      observed: z.object({
        completion: z.enum([
          "complete",
          "max-bytes-exceeded",
          "timeout",
          "network-error",
          "invalid-response",
          "robots-blocked",
          "not-fetched",
        ]),
        hops: z.array(redirectHopSchema),
        finalUrl: httpUrlSchema.optional(),
        finalStatus: nonNegativeIntegerSchema.optional(),
        targetIndexability: z.enum(["indexable", "noindex", "unknown"]),
      }),
      outcome: z.enum(["verified", "failed", "unchecked"]),
      findingCodes: z.array(z.string().min(1)),
    }),
  ),
});
const sitemapEntrySchema = z.object({
  url: httpUrlSchema,
  sitemapUrl: httpUrlSchema,
  lastModified: z.string().optional(),
  alternates: z.array(hreflangSignalSchema),
});
const routeNodeSchema = z.object({
  url: httpUrlSchema,
  depth: routeDepthSchema,
  sources: z.array(routeSourceSchema),
  sitemap: sitemapEntrySchema.optional(),
  build: buildRouteSchema.optional(),
  snapshots: z.array(snapshotSchema),
  rendered: renderedSnapshotSchema.optional(),
  inbound: z.array(httpUrlSchema),
  outbound: z.array(httpUrlSchema),
});
const findingSchema = z.object({
  code: z.string().min(1),
  severity: severitySchema,
  message: z.string(),
  url: httpUrlSchema.optional(),
  relatedUrls: z.array(httpUrlSchema).optional(),
  evidence: z
    .record(z.string(), z.union([z.string(), z.number().finite(), z.boolean()]))
    .optional(),
});
const buildInventorySchema = z.object({
  framework: z.literal("next"),
  root: z.string(),
  buildDirectory: z.string(),
  nextVersion: z.string().optional(),
  buildId: z.string().optional(),
  routes: z.array(buildRouteSchema),
  unresolvedPatterns: z.array(z.string()),
  redirects: z.array(buildRedirectSchema),
  warnings: z.array(z.string()),
});
const sitemapInventorySchema = z.object({
  requested: z.array(httpUrlSchema),
  fetched: z.array(httpUrlSchema),
  entries: z.array(sitemapEntrySchema),
  warnings: z.array(z.string()),
});
const robotsAvailabilitySchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("available") }),
  z.object({ state: z.literal("missing") }),
  z.object({
    state: z.literal("unavailable"),
    reason: z.enum([
      "not-fetched",
      "http-error",
      "timeout",
      "response-too-large",
      "read-error",
      "parse-error",
      "network-error",
    ]),
  }),
]);
const robotsFileSchema = z.object({
  url: httpUrlSchema,
  status: nonNegativeIntegerSchema.optional(),
  availability: robotsAvailabilitySchema.optional(),
  groups: z.array(
    z.object({
      agents: z.array(z.string()),
      rules: z.array(z.object({ directive: z.enum(["allow", "disallow"]), pattern: z.string() })),
    }),
  ),
  sitemaps: z.array(httpUrlSchema),
  warnings: z.array(z.string()),
});
const summarySchema = z.object({
  routes: nonNegativeIntegerSchema,
  fetched: nonNegativeIntegerSchema,
  indexable: nonNegativeIntegerSchema,
  errors: nonNegativeIntegerSchema,
  warnings: nonNegativeIntegerSchema,
  info: nonNegativeIntegerSchema,
  brokenLinks: nonNegativeIntegerSchema,
  redirects: nonNegativeIntegerSchema,
  noindex: nonNegativeIntegerSchema,
  maxDepth: nonNegativeIntegerSchema,
});
const ruleSeveritySchema = z.enum(["error", "warning", "info", "off"]);
const reportAuditSchema = z.object({
  requireTitle: z.boolean(),
  requireDescription: z.boolean(),
  requireCanonical: z.boolean(),
  requireH1: z.boolean(),
  requireSitemapCoverage: z.boolean(),
  maxDepth: nonNegativeIntegerSchema,
  severities: z.record(z.string(), ruleSeveritySchema).optional(),
  paths: z
    .array(
      z.object({
        include: z.array(z.string()),
        exclude: z.array(z.string()),
        requireTitle: z.boolean().optional(),
        requireDescription: z.boolean().optional(),
        requireCanonical: z.boolean().optional(),
        requireH1: z.boolean().optional(),
        requireSitemapCoverage: z.boolean().optional(),
        maxDepth: nonNegativeIntegerSchema.optional(),
        severities: z.record(z.string(), ruleSeveritySchema).optional(),
      }),
    )
    .optional(),
});
const routeLintReportSchema = z.object({
  schemaVersion: z.enum(["1", "2", "3"]),
  toolVersion: z.string().min(1),
  generatedAt: z.iso.datetime(),
  durationMs: nonNegativeNumberSchema,
  baseUrl: httpUrlSchema,
  config: z.object({
    maxPages: nonNegativeIntegerSchema,
    maxDepth: nonNegativeIntegerSchema,
    agents: z.array(z.string().min(1)).min(1),
    respectRobots: z.boolean(),
    queryPolicy: z.enum(["drop", "keep"]),
    seeds: z.array(httpUrlSchema).optional(),
    sitemapMode: z.enum(["auto", "explicit"]).optional(),
    sitemapUrls: z.array(httpUrlSchema).optional(),
    include: z.array(z.string()).optional(),
    exclude: z.array(z.string()).optional(),
    timeoutMs: z.number().int().positive().optional(),
    maxBytes: z.number().int().positive().optional(),
    maxRedirects: nonNegativeIntegerSchema.optional(),
    rendered: z.boolean().optional(),
    renderedConcurrency: z.number().int().positive().optional(),
    renderedTimeoutMs: z.number().int().positive().optional(),
    renderedSettleMs: nonNegativeIntegerSchema.optional(),
    headerNames: z.array(z.string().min(1)).optional(),
    urlListFiles: nonNegativeIntegerSchema.optional(),
    redirects: z.array(redirectExpectationSchema).optional(),
    audit: reportAuditSchema.optional(),
  }),
  inputs: z
    .object({
      urlListFiles: nonNegativeIntegerSchema,
      urlListUrls: nonNegativeIntegerSchema,
      warnings: z.array(z.string()),
    })
    .optional(),
  build: buildInventorySchema.optional(),
  redirectContracts: redirectContractReportSchema.optional(),
  sitemap: sitemapInventorySchema,
  robots: robotsFileSchema.optional(),
  routes: z.array(routeNodeSchema),
  findings: z.array(findingSchema),
  summary: summarySchema,
  truncated: z.boolean(),
  comparison: z
    .object({
      mode: z.literal("changed-only"),
      baselineGeneratedAt: z.iso.datetime(),
      newFindings: nonNegativeIntegerSchema,
      worsenedFindings: nonNegativeIntegerSchema,
      resolvedFindings: nonNegativeIntegerSchema,
      unchangedFindings: nonNegativeIntegerSchema,
    })
    .optional(),
});

export function parseRouteLintReport(value: unknown): RouteLintReport {
  const parsed = routeLintReportSchema.safeParse(value);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "report"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid RouteLint report: ${details}`);
  }
  return value as RouteLintReport;
}

export async function readRouteLintReport(path: string): Promise<RouteLintReport> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new Error(`Could not read report: ${path}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`Could not parse JSON report: ${path}`);
  }
  return parseRouteLintReport(value);
}

function firstSnapshot(route: RouteNode) {
  return route.snapshots[0];
}

function canonical(route: RouteNode): string | undefined {
  const snapshot = firstSnapshot(route);
  return snapshot === undefined ? undefined : snapshotCanonical(snapshot);
}

function snapshotCanonical(snapshot: PageSnapshot): string | undefined {
  if (snapshot.completion !== "complete") return undefined;
  const value = snapshot.signals.canonicals[0]?.value;
  if (value === undefined) return undefined;
  try {
    const url = new URL(value, snapshot.finalUrl);
    url.hash = "";
    return url.href;
  } catch {
    return value;
  }
}

function title(route: RouteNode): string | undefined {
  const snapshot = firstSnapshot(route);
  return snapshot === undefined ? undefined : snapshotTitle(snapshot);
}

function snapshotTitle(snapshot: PageSnapshot): string | undefined {
  if (snapshot.completion !== "complete") return undefined;
  return snapshot.signals.titles[0]?.value.trim().replace(/\s+/g, " ");
}

function robots(route: RouteNode): string {
  const snapshot = firstSnapshot(route);
  return snapshot === undefined ? "" : snapshotRobots(snapshot);
}

function snapshotRobots(snapshot: PageSnapshot): string {
  if (snapshot.completion !== "complete") return "";
  return snapshot.signals.robots
    .map((signal) => `${signal.audience}:${signal.value.toLowerCase().replace(/\s+/g, "").trim()}`)
    .sort()
    .join("|");
}

function status(route: RouteNode): number | undefined {
  return firstSnapshot(route)?.status;
}

function finalUrl(route: RouteNode): string | undefined {
  return firstSnapshot(route)?.finalUrl;
}

function compareSecondaryAgents(
  baseline: RouteNode,
  current: RouteNode,
  url: string,
  changes: DiffChange[],
): void {
  const baselineAgents = new Map(
    baseline.snapshots.map((snapshot) => [snapshot.agent.key, snapshot]),
  );
  const currentAgents = new Map(
    current.snapshots.map((snapshot) => [snapshot.agent.key, snapshot]),
  );
  const primaryBefore = firstSnapshot(baseline)?.agent.key;
  const primaryAfter = firstSnapshot(current)?.agent.key;
  const agentKeys = [...new Set([...baselineAgents.keys(), ...currentAgents.keys()])].sort();

  for (const agentKey of agentKeys) {
    if (agentKey === primaryBefore && agentKey === primaryAfter) continue;
    const before = baselineAgents.get(agentKey);
    const after = currentAgents.get(agentKey);
    if (before === undefined || after === undefined) {
      changes.push({
        kind: before === undefined ? "added" : "removed",
        code: before === undefined ? "agent-snapshot-added" : "agent-snapshot-removed",
        severity: before === undefined ? "info" : "warning",
        url,
        message:
          before === undefined
            ? `The ${agentKey} response was added to the report.`
            : `The ${agentKey} response was removed from the report.`,
      });
      continue;
    }

    addChangedValue(
      changes,
      url,
      `agent-completion-changed:${agentKey}`,
      `${agentKey} fetch outcome`,
      before.completion,
      after.completion,
      after.completion === "complete" ? "info" : "error",
    );
    addChangedValue(
      changes,
      url,
      `agent-status-changed:${agentKey}`,
      `${agentKey} HTTP status`,
      before.status,
      after.status,
      statusChangeSeverity(before.status, after.status),
    );
    addChangedValue(
      changes,
      url,
      `agent-final-url-changed:${agentKey}`,
      `${agentKey} final URL`,
      before.finalUrl,
      after.finalUrl,
      "warning",
    );
    addChangedValue(
      changes,
      url,
      `agent-indexability-changed:${agentKey}`,
      `${agentKey} indexability`,
      getSnapshotIndexability(before),
      getSnapshotIndexability(after),
      getSnapshotIndexability(after) === "indexable" ? "info" : "error",
    );
    addChangedValue(
      changes,
      url,
      `agent-canonical-changed:${agentKey}`,
      `${agentKey} canonical`,
      snapshotCanonical(before),
      snapshotCanonical(after),
      "warning",
    );
    addChangedValue(
      changes,
      url,
      `agent-title-changed:${agentKey}`,
      `${agentKey} title`,
      snapshotTitle(before),
      snapshotTitle(after),
      "info",
    );
    addChangedValue(
      changes,
      url,
      `agent-robots-changed:${agentKey}`,
      `${agentKey} robots directives`,
      snapshotRobots(before),
      snapshotRobots(after),
      "warning",
    );
  }
}

function addChangedValue(
  changes: DiffChange[],
  url: string,
  code: string,
  label: string,
  before: string | number | boolean | undefined,
  after: string | number | boolean | undefined,
  severity: Severity,
): void {
  if (before === after) return;
  changes.push({
    kind: "changed",
    code,
    severity,
    url,
    message: `${label} changed from ${before ?? "<missing>"} to ${after ?? "<missing>"}.`,
    ...(before === undefined ? {} : { before }),
    ...(after === undefined ? {} : { after }),
  });
}

function statusChangeSeverity(before: number | undefined, after: number | undefined): Severity {
  if (after === undefined || after >= 400) return "error";
  if (before === undefined || before >= 400) return "info";
  return "warning";
}

function findingIdentity(finding: Finding): string {
  return `${finding.code}\u0000${finding.url ?? ""}\u0000${(finding.relatedUrls ?? []).join("|")}`;
}

function compareFindings(
  baseline: readonly Finding[],
  current: readonly Finding[],
  changes: DiffChange[],
): void {
  const before = new Map(baseline.map((finding) => [findingIdentity(finding), finding]));
  const after = new Map(current.map((finding) => [findingIdentity(finding), finding]));
  for (const [key, finding] of after) {
    const previous = before.get(key);
    if (previous === undefined) {
      changes.push({
        kind: "added",
        code: `finding-added:${finding.code}`,
        severity: finding.severity,
        ...(finding.url === undefined ? {} : { url: finding.url }),
        message: `New ${finding.code} finding: ${finding.message}`,
      });
      continue;
    }
    if (previous.severity !== finding.severity) {
      addChangedValue(
        changes,
        finding.url ?? "",
        `finding-severity:${finding.code}`,
        `${finding.code} severity`,
        previous.severity,
        finding.severity,
        finding.severity,
      );
    }
  }
  for (const [key, finding] of before) {
    if (after.has(key)) continue;
    changes.push({
      kind: "removed",
      code: `finding-resolved:${finding.code}`,
      severity: "info",
      ...(finding.url === undefined ? {} : { url: finding.url }),
      message: `Resolved ${finding.code} finding: ${finding.message}`,
    });
  }
}

function summarizeChanges(changes: readonly DiffChange[]): RouteLintDiff["summary"] {
  return {
    added: changes.filter((change) => change.kind === "added").length,
    removed: changes.filter((change) => change.kind === "removed").length,
    changed: changes.filter((change) => change.kind === "changed").length,
    errors: changes.filter((change) => change.severity === "error").length,
    warnings: changes.filter((change) => change.severity === "warning").length,
    info: changes.filter((change) => change.severity === "info").length,
  };
}

export function diffReports(baseline: RouteLintReport, current: RouteLintReport): RouteLintDiff {
  const changes: DiffChange[] = [];
  const before = new Map(baseline.routes.map((route) => [route.url, route]));
  const after = new Map(current.routes.map((route) => [route.url, route]));

  for (const [url, route] of after) {
    const previous = before.get(url);
    if (previous === undefined) {
      const currentStatus = status(route);
      changes.push({
        kind: "added",
        code: "route-added",
        severity: currentStatus !== undefined && currentStatus >= 400 ? "error" : "info",
        url,
        message: "A route was added to the crawl graph.",
        ...(currentStatus === undefined ? {} : { after: currentStatus }),
      });
      continue;
    }
    addChangedValue(
      changes,
      url,
      "status-changed",
      "HTTP status",
      status(previous),
      status(route),
      statusChangeSeverity(status(previous), status(route)),
    );
    addChangedValue(
      changes,
      url,
      "final-url-changed",
      "Final URL",
      finalUrl(previous),
      finalUrl(route),
      "warning",
    );
    addChangedValue(
      changes,
      url,
      "indexability-changed",
      "Indexability",
      getIndexability(previous),
      getIndexability(route),
      getIndexability(route) === "indexable" ? "info" : "error",
    );
    addChangedValue(
      changes,
      url,
      "canonical-changed",
      "Canonical",
      canonical(previous),
      canonical(route),
      "warning",
    );
    addChangedValue(changes, url, "title-changed", "Title", title(previous), title(route), "info");
    addChangedValue(
      changes,
      url,
      "robots-changed",
      "Robots directives",
      robots(previous),
      robots(route),
      "warning",
    );
    addChangedValue(
      changes,
      url,
      "render-mode-changed",
      "Next render mode",
      previous.build?.renderMode,
      route.build?.renderMode,
      "warning",
    );
    compareSecondaryAgents(previous, route, url, changes);
  }

  for (const [url, route] of before) {
    if (after.has(url)) continue;
    const previousStatus = status(route);
    changes.push({
      kind: "removed",
      code: "route-removed",
      severity: getIndexability(route) === "indexable" ? "warning" : "info",
      url,
      message: "A route was removed from the crawl graph.",
      ...(previousStatus === undefined ? {} : { before: previousStatus }),
    });
  }

  compareFindings(baseline.findings, current.findings, changes);
  changes.sort(
    (left, right) =>
      SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity] ||
      (left.url ?? "").localeCompare(right.url ?? "") ||
      left.code.localeCompare(right.code),
  );

  return {
    schemaVersion: "1",
    generatedAt: new Date().toISOString(),
    baselineGeneratedAt: baseline.generatedAt,
    currentGeneratedAt: current.generatedAt,
    changes,
    summary: summarizeChanges(changes),
  };
}

export function renderDiffJson(diff: RouteLintDiff): string {
  return `${JSON.stringify(diff, null, 2)}\n`;
}

export function renderDiffTerminal(diff: RouteLintDiff): string {
  const lines = [
    "RouteLint report diff",
    `${diff.summary.added} added · ${diff.summary.removed} removed · ${diff.summary.changed} changed`,
    `${diff.summary.errors} errors · ${diff.summary.warnings} warnings · ${diff.summary.info} info`,
  ];
  if (diff.changes.length === 0) lines.push("", "No route or finding changes.");
  for (const change of diff.changes) {
    lines.push(
      "",
      `[${change.severity.toUpperCase()}] ${change.code}${change.url === undefined ? "" : ` · ${change.url}`}`,
      change.message,
    );
  }
  return `${lines.join("\n")}\n`;
}
