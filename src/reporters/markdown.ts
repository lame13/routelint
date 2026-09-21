import type { Finding, PageCompletion, RouteLintReport, Severity } from "../types.js";

const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  error: 0,
  warning: 1,
  info: 2,
};

/** Findings above this count are summarized instead of listed so a job summary stays readable. */
const MAX_ROWS = 200;

function compareFindings(left: Finding, right: Finding): number {
  return (
    SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity] ||
    (left.url ?? "").localeCompare(right.url ?? "") ||
    left.code.localeCompare(right.code) ||
    left.message.localeCompare(right.message)
  );
}

/**
 * Collapse a value to one inert table cell: no line breaks or control characters, and no
 * Markdown or HTML syntax that a summary renderer would interpret.
 */
function cell(value: string): string {
  let safe = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    safe += code < 32 || (code >= 127 && code <= 159) ? " " : character;
  }
  return safe
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/[\\`*_[\]{}()#+!|~=-]/gu, (match) => `\\${match}`)
    .replace(/\s+/gu, " ")
    .trim();
}

function duration(value: number): string {
  if (value < 1_000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(2)} s`;
  return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1_000)}s`;
}

function evidenceText(finding: Finding): string {
  const entries = Object.entries(finding.evidence ?? {}).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return cell(entries.map(([key, value]) => `${key}=${value}`).join("; "));
}

function relatedText(finding: Finding): string {
  return cell((finding.relatedUrls ?? []).slice().sort().join(" "));
}

function incompleteRoutes(
  report: RouteLintReport,
): ReadonlyMap<PageCompletion | "not-fetched", number> {
  const reasons = new Map<PageCompletion | "not-fetched", number>();
  for (const route of report.routes) {
    const completions =
      route.snapshots.length === 0
        ? (["not-fetched"] as const)
        : route.snapshots
            .filter((snapshot) => snapshot.completion !== "complete")
            .map((snapshot) => snapshot.completion);
    for (const completion of new Set(completions)) {
      reasons.set(completion, (reasons.get(completion) ?? 0) + 1);
    }
  }
  return reasons;
}

function redirectSection(report: RouteLintReport): readonly string[] {
  const contracts = report.redirectContracts;
  if (contracts === undefined) return [];
  const lines = [
    "### Redirect contracts",
    "",
    `- Declared checks: ${contracts.declared}`,
    `- Verified: ${contracts.verified}`,
    `- Failed: ${contracts.failed}`,
    `- Unchecked: ${contracts.unchecked}`,
  ];
  if ((contracts.patterns ?? 0) > 0) {
    lines.push(
      `- Pattern contracts: ${contracts.patterns} declared, ${contracts.patternMatches ?? 0} matched sources`,
    );
  }
  for (const pattern of contracts.unmatchedPatterns ?? []) {
    lines.push(`- No observed URL matched ${cell(pattern)}`);
  }
  if (contracts.skippedBuildRedirects > 0) {
    lines.push(
      `- ${contracts.skippedBuildRedirects} Next.js redirect definitions were outside contract scope`,
    );
  }
  lines.push("");
  return lines;
}

/** Render a GitHub-flavored summary suitable for a step summary or a pull-request comment. */
export function renderMarkdownReport(report: RouteLintReport): string {
  const findings = report.findings.slice().sort(compareFindings);
  const visible = findings.slice(0, MAX_ROWS);
  const hidden = findings.length - visible.length;
  const incomplete = incompleteRoutes(report);
  const lines: string[] = [
    "# RouteLint report",
    "",
    `- Site: ${cell(report.baseUrl)}`,
    `- Generated: ${cell(report.generatedAt)} in ${duration(report.durationMs)}`,
    `- RouteLint ${cell(report.toolVersion)} · report schema ${cell(report.schemaVersion)}`,
    "",
    "## Summary",
    "",
    "| Metric | Value |",
    "| --- | --- |",
    `| Routes | ${report.summary.routes} |`,
    `| Fetched | ${report.summary.fetched} |`,
    `| Indexable | ${report.summary.indexable} |`,
    `| Noindex | ${report.summary.noindex} |`,
    `| Findings | ${findings.length} (${report.summary.errors} errors, ${report.summary.warnings} warnings, ${report.summary.info} info) |`,
    `| Broken links | ${report.summary.brokenLinks} |`,
    `| Redirects | ${report.summary.redirects} |`,
    `| Maximum depth | ${report.summary.maxDepth} |`,
    "",
    ...redirectSection(report),
    "## Findings",
    "",
  ];

  if (visible.length === 0) {
    lines.push("No findings.", "");
  } else {
    lines.push(
      "| Severity | Code | URL | Message | Evidence | Related |",
      "| --- | --- | --- | --- | --- | --- |",
    );
    for (const finding of visible) {
      lines.push(
        `| ${finding.severity} | ${cell(finding.code)} | ${cell(finding.url ?? "")} | ${cell(finding.message)} | ${evidenceText(finding)} | ${relatedText(finding)} |`,
      );
    }
    lines.push("");
    if (hidden > 0) {
      lines.push(`${hidden} further findings are available in the JSON report.`, "");
    }
  }

  const notes: string[] = [];
  if (report.comparison !== undefined) {
    const comparison = report.comparison;
    notes.push(
      `- Changed-only report against ${cell(comparison.baselineGeneratedAt)}: ${comparison.newFindings} new, ${comparison.worsenedFindings} worsened, ${comparison.resolvedFindings} resolved, and ${comparison.unchangedFindings} unchanged findings.`,
    );
  }
  if (report.truncated) {
    notes.push(
      "- The crawl stopped at a configured limit; missing-target checks are conservative.",
    );
  }
  for (const [reason, count] of [...incomplete.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    notes.push(`- ${count} routes have incomplete evidence (${cell(reason)}).`);
  }
  for (const warning of [
    ...report.sitemap.warnings,
    ...(report.robots?.warnings ?? []),
    ...(report.build?.warnings ?? []),
    ...(report.inputs?.warnings ?? []),
  ]) {
    notes.push(`- ${cell(warning)}`);
  }
  if (notes.length > 0) lines.push("## Evidence notes", "", ...notes, "");

  return `${lines.join("\n").trimEnd()}\n`;
}
