import type { Finding, PageCompletion, RouteLintReport, Severity } from "../types.js";

export interface TerminalReportOptions {
  /** Emit ANSI color sequences. Defaults to false for deterministic redirected output. */
  readonly color?: boolean;
  /** Limit displayed findings without changing the summary. */
  readonly maxFindings?: number;
}

const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  error: 0,
  warning: 1,
  info: 2,
};

const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  red: "\u001b[31m",
  yellow: "\u001b[33m",
  cyan: "\u001b[36m",
} as const;

function paint(value: string, code: string, enabled: boolean): string {
  return enabled ? `${code}${value}${ANSI.reset}` : value;
}

function terminalText(value: string): string {
  let safe = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 9 || code === 10 || code === 13) {
      safe += " ";
      continue;
    }
    if (code < 32 || (code >= 127 && code <= 159)) continue;
    safe += character;
  }
  return safe.replace(/\s+/gu, " ").trim();
}

function plural(value: number, singular: string, pluralForm = `${singular}s`): string {
  return `${value.toLocaleString("en-US")} ${value === 1 ? singular : pluralForm}`;
}

function duration(value: number): string {
  if (value < 1_000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(2)} s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

function compareFindings(left: Finding, right: Finding): number {
  return (
    SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity] ||
    left.code.localeCompare(right.code) ||
    (left.url ?? "").localeCompare(right.url ?? "") ||
    left.message.localeCompare(right.message)
  );
}

function severityLabel(severity: Severity, color: boolean): string {
  const label = severity.toUpperCase().padEnd(7);
  if (severity === "error") return paint(label, ANSI.red, color);
  if (severity === "warning") return paint(label, ANSI.yellow, color);
  return paint(label, ANSI.cyan, color);
}

function formatEvidence(finding: Finding): string | undefined {
  if (finding.evidence === undefined) return undefined;
  const entries = Object.entries(finding.evidence).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  if (entries.length === 0) return undefined;
  return entries
    .map(([key, value]) => `${terminalText(key)}=${terminalText(String(value))}`)
    .join(", ");
}

function incompleteEvidence(report: RouteLintReport): {
  readonly routes: number;
  readonly reasons: ReadonlyMap<PageCompletion | "not-fetched", number>;
} {
  const reasons = new Map<PageCompletion | "not-fetched", number>();
  let routes = 0;

  for (const route of report.routes) {
    const completions =
      route.snapshots.length === 0
        ? (["not-fetched"] as const)
        : route.snapshots
            .filter((snapshot) => snapshot.completion !== "complete")
            .map((snapshot) => snapshot.completion);
    if (completions.length === 0) continue;
    routes += 1;
    for (const completion of new Set(completions)) {
      reasons.set(completion, (reasons.get(completion) ?? 0) + 1);
    }
  }

  return { routes, reasons };
}

export function renderTerminalReport(
  report: RouteLintReport,
  options: TerminalReportOptions = {},
): string {
  const color = options.color ?? false;
  const findings = report.findings.slice().sort(compareFindings);
  const requestedLimit = options.maxFindings ?? findings.length;
  const limit = Number.isFinite(requestedLimit) ? Math.max(0, Math.floor(requestedLimit)) : 0;
  const visibleFindings = findings.slice(0, limit);
  const hiddenFindings = findings.length - visibleFindings.length;
  const incomplete = incompleteEvidence(report);
  const lines: string[] = [];

  lines.push(paint("Site report", ANSI.bold, color));
  lines.push(terminalText(report.baseUrl));
  lines.push(
    paint(
      `Generated ${terminalText(report.generatedAt)} in ${duration(report.durationMs)}`,
      ANSI.dim,
      color,
    ),
  );
  if (report.comparison !== undefined) {
    const comparison = report.comparison;
    lines.push(
      `Changed only: ${comparison.newFindings} new, ${comparison.worsenedFindings} worsened, ${comparison.resolvedFindings} resolved, ${comparison.unchangedFindings} unchanged.`,
    );
    lines.push(`Baseline: ${terminalText(comparison.baselineGeneratedAt)}`);
  }
  lines.push("");
  lines.push(
    [
      plural(report.summary.routes, "route"),
      `${report.summary.fetched.toLocaleString("en-US")} fetched`,
      `${report.summary.indexable.toLocaleString("en-US")} indexable`,
      `${report.summary.noindex.toLocaleString("en-US")} noindex`,
      `max depth ${report.summary.maxDepth.toLocaleString("en-US")}`,
    ].join("  |  "),
  );
  const agentDifferences = report.findings.filter((finding) => finding.code.startsWith("agent-"));
  if (report.config.agents.length > 1) {
    lines.push(
      `${agentDifferences.length.toLocaleString("en-US")} agent response differences across ${new Set(agentDifferences.map((finding) => finding.url).filter(Boolean)).size.toLocaleString("en-US")} routes`,
    );
  }
  if (report.config.rendered === true) {
    const completed = report.routes.filter(
      (route) => route.rendered?.completion === "complete",
    ).length;
    lines.push(`Rendered comparison: ${completed}/${report.routes.length} routes complete`);
  }
  if ((report.inputs?.urlListFiles ?? 0) > 0) {
    lines.push(
      `URL lists: ${report.inputs?.urlListFiles ?? 0} files, ${report.inputs?.urlListUrls ?? 0} accepted routes`,
    );
    for (const warning of report.inputs?.warnings ?? []) {
      lines.push(`  URL-list warning: ${terminalText(warning)}`);
    }
  }
  lines.push(
    [
      paint(`${report.summary.errors} errors`, ANSI.red, color),
      paint(`${report.summary.warnings} warnings`, ANSI.yellow, color),
      paint(`${report.summary.info} info`, ANSI.cyan, color),
      `${report.summary.brokenLinks} broken links`,
      `${report.summary.redirects} redirects`,
    ].join("  |  "),
  );

  if (report.truncated || incomplete.routes > 0) {
    lines.push("");
    lines.push(paint("INCOMPLETE EVIDENCE", ANSI.yellow, color));
    if (report.truncated) {
      lines.push("  Collection stopped at a configured limit; unchecked routes may have issues.");
    }
    if (incomplete.routes > 0) {
      const reasonText = [...incomplete.reasons.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([reason, count]) => `${reason}: ${count}`)
        .join(", ");
      lines.push(
        `  ${plural(incomplete.routes, "route")} with incomplete evidence (${reasonText}).`,
      );
    }
  }

  lines.push("");
  lines.push(paint(`Findings (${findings.length.toLocaleString("en-US")})`, ANSI.bold, color));

  if (visibleFindings.length === 0) {
    lines.push(findings.length === 0 ? "No findings." : "No findings displayed.");
  }

  for (const finding of visibleFindings) {
    const location = finding.url === undefined ? "" : `  ${terminalText(finding.url)}`;
    lines.push(
      `${severityLabel(finding.severity, color)} ${terminalText(finding.code)}${location}`,
    );
    lines.push(`  ${terminalText(finding.message)}`);
    const evidence = formatEvidence(finding);
    if (evidence !== undefined) lines.push(`  Evidence: ${evidence}`);
    if ((finding.relatedUrls?.length ?? 0) > 0) {
      const related = (finding.relatedUrls ?? [])
        .slice()
        .sort((left, right) => left.localeCompare(right))
        .map((url) => terminalText(url))
        .join(", ");
      lines.push(`  Related: ${related}`);
    }
  }

  if (hiddenFindings > 0) {
    lines.push("");
    lines.push(`${plural(hiddenFindings, "finding")} not displayed.`);
  }

  return `${lines.join("\n")}\n`;
}
