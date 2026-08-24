import type { Finding, RouteLintReport, Severity } from "./types.js";

const RANK: Readonly<Record<Severity, number>> = { error: 0, warning: 1, info: 2 };

function identity(finding: Finding): string {
  return `${finding.code}\u0000${finding.url ?? ""}\u0000${(finding.relatedUrls ?? []).join("|")}`;
}

/** Keep only findings that are new or more severe than the baseline report. */
export function changedOnlyReport(
  current: RouteLintReport,
  baseline: RouteLintReport,
): RouteLintReport {
  assertComparable(current, baseline);
  const previous = new Map(baseline.findings.map((finding) => [identity(finding), finding]));
  const currentKeys = new Set(current.findings.map(identity));
  const changed: Finding[] = [];
  let newFindings = 0;
  let worsenedFindings = 0;
  let unchangedFindings = 0;

  for (const finding of current.findings) {
    const before = previous.get(identity(finding));
    if (before === undefined) {
      newFindings += 1;
      changed.push(finding);
    } else if (RANK[finding.severity] < RANK[before.severity]) {
      worsenedFindings += 1;
      changed.push(finding);
    } else {
      unchangedFindings += 1;
    }
  }
  const resolvedFindings = baseline.findings.filter(
    (finding) => !currentKeys.has(identity(finding)),
  ).length;

  return {
    ...current,
    findings: changed,
    summary: {
      ...current.summary,
      errors: changed.filter((finding) => finding.severity === "error").length,
      warnings: changed.filter((finding) => finding.severity === "warning").length,
      info: changed.filter((finding) => finding.severity === "info").length,
      brokenLinks: changed.filter((finding) => finding.code === "broken-internal-link").length,
    },
    comparison: {
      mode: "changed-only",
      baselineGeneratedAt: baseline.generatedAt,
      newFindings,
      worsenedFindings,
      resolvedFindings,
      unchangedFindings,
    },
  };
}

function assertComparable(current: RouteLintReport, baseline: RouteLintReport): void {
  if (baseline.comparison !== undefined) {
    throw new Error(
      "Changed-only baseline is not comparable: baseline report is already changed-only.",
    );
  }

  const truncatedReports = [
    ...(baseline.truncated ? ["baseline report"] : []),
    ...(current.truncated ? ["current report"] : []),
  ];
  if (truncatedReports.length > 0) {
    throw new Error(
      `Changed-only reports are not comparable: ${truncatedReports.join(" and ")} ${truncatedReports.length === 1 ? "is" : "are"} truncated.`,
    );
  }

  const mismatches: string[] = [];
  const checks: readonly (readonly [label: string, current: unknown, baseline: unknown])[] = [
    ["base URL", current.baseUrl, baseline.baseUrl],
    ["maximum page count", current.config.maxPages, baseline.config.maxPages],
    ["maximum crawl depth", current.config.maxDepth, baseline.config.maxDepth],
    ["query policy", current.config.queryPolicy, baseline.config.queryPolicy],
    ["robots policy", current.config.respectRobots, baseline.config.respectRobots],
    ["agent order", current.config.agents, baseline.config.agents],
    ["seed URLs", current.config.seeds, baseline.config.seeds],
    ["sitemap mode", current.config.sitemapMode, baseline.config.sitemapMode],
    ["sitemap URLs", current.config.sitemapUrls, baseline.config.sitemapUrls],
    ["include filters", current.config.include, baseline.config.include],
    ["exclude filters", current.config.exclude, baseline.config.exclude],
    ["request timeout", current.config.timeoutMs, baseline.config.timeoutMs],
    ["response byte limit", current.config.maxBytes, baseline.config.maxBytes],
    ["redirect limit", current.config.maxRedirects, baseline.config.maxRedirects],
    ["rendered evidence setting", current.config.rendered, baseline.config.rendered],
    [
      "rendered concurrency",
      current.config.renderedConcurrency,
      baseline.config.renderedConcurrency,
    ],
    ["rendered timeout", current.config.renderedTimeoutMs, baseline.config.renderedTimeoutMs],
    ["rendered settle time", current.config.renderedSettleMs, baseline.config.renderedSettleMs],
    ["request header names", current.config.headerNames, baseline.config.headerNames],
    ["URL-list input count", current.config.urlListFiles, baseline.config.urlListFiles],
    ["audit policy", current.config.audit, baseline.config.audit],
  ];
  for (const [label, currentValue, baselineValue] of checks) {
    if (stableSerialize(currentValue) !== stableSerialize(baselineValue)) mismatches.push(label);
  }
  if (mismatches.length > 0) {
    throw new Error(
      `Changed-only baseline is not comparable: ${mismatches.join(", ")} ${mismatches.length === 1 ? "differs" : "differ"}.`,
    );
  }
}

/** Serialize JSON-compatible values with deterministic object-key ordering. */
function stableSerialize(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;

  const record = value as Readonly<Record<string, unknown>>;
  const fields = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`);
  return `{${fields.join(",")}}`;
}
