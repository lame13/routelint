import type { Finding, RouteLintReport, Severity } from "../types.js";

const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  error: 0,
  warning: 1,
  info: 2,
};

const HEADER = ["severity", "code", "url", "message", "related_urls", "evidence"] as const;

function compareFindings(left: Finding, right: Finding): number {
  return (
    SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity] ||
    (left.url ?? "").localeCompare(right.url ?? "") ||
    left.code.localeCompare(right.code) ||
    left.message.localeCompare(right.message)
  );
}

/** Quote a field when it contains a delimiter, a quote, or a line break (RFC 4180). */
function field(value: string): string {
  let safe = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    safe += code < 32 && code !== 10 && code !== 13 ? " " : character;
  }
  // Quoting alone does not prevent a spreadsheet from evaluating a cell as a formula.
  if (/^\s*[=+@-]/u.test(safe)) safe = `'${safe}`;
  return /[",\r\n]/u.test(safe) ? `"${safe.replace(/"/gu, '""')}"` : safe;
}

function evidenceText(finding: Finding): string {
  return Object.entries(finding.evidence ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("; ");
}

/** Render findings as a spreadsheet-friendly table with one row per finding. */
export function renderCsvReport(report: RouteLintReport): string {
  const rows: string[] = [HEADER.join(",")];
  for (const finding of report.findings.slice().sort(compareFindings)) {
    rows.push(
      [
        finding.severity,
        finding.code,
        finding.url ?? "",
        finding.message,
        (finding.relatedUrls ?? []).slice().sort().join(" "),
        evidenceText(finding),
      ]
        .map(field)
        .join(","),
    );
  }
  return `${rows.join("\n")}\n`;
}
