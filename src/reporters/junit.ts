import type { Finding, RouteLintReport, Severity } from "../types.js";

const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  error: 0,
  warning: 1,
  info: 2,
};

function compareFindings(left: Finding, right: Finding): number {
  return (
    SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity] ||
    (left.url ?? "").localeCompare(right.url ?? "") ||
    left.code.localeCompare(right.code) ||
    left.message.localeCompare(right.message)
  );
}

function xml(value: string): string {
  let safe = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    // XML 1.0 also excludes lone surrogates and U+FFFE/U+FFFF.
    const allowed =
      code === 9 ||
      code === 10 ||
      code === 13 ||
      (code >= 0x20 && code <= 0xd7ff) ||
      (code >= 0xe000 && code <= 0xfffd) ||
      (code >= 0x10000 && code <= 0x10ffff);
    safe += allowed ? character : " ";
  }
  return safe
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

function failureBody(finding: Finding): string {
  const details = [finding.message];
  if (finding.url !== undefined) details.push(`url: ${finding.url}`);
  if ((finding.relatedUrls?.length ?? 0) > 0) {
    details.push(`related: ${(finding.relatedUrls ?? []).slice().sort().join(" ")}`);
  }
  const evidence = Object.entries(finding.evidence ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}: ${value}`);
  if (evidence.length > 0) details.push(`evidence: ${evidence.join(", ")}`);
  return details.join("\n");
}

/**
 * Render findings as JUnit XML: one test case per finding, grouped by finding code.
 * Failing severities become `failure` elements; informational findings pass with output.
 */
export function renderJunitReport(report: RouteLintReport): string {
  const findings = report.findings.slice().sort(compareFindings);
  const failures = findings.filter((finding) => finding.severity !== "info");
  const cases =
    findings.length === 0
      ? ['    <testcase classname="routelint" name="no findings"/>']
      : findings.map((finding) => {
          const name =
            finding.url === undefined ? finding.code : `${finding.code} · ${finding.url}`;
          const attributes = `classname="routelint.${xml(finding.code)}" name="${xml(name)}"`;
          if (finding.severity === "info") {
            return `    <testcase ${attributes}>\n      <system-out>${xml(failureBody(finding))}</system-out>\n    </testcase>`;
          }
          return `    <testcase ${attributes}>\n      <failure type="${xml(finding.severity)}" message="${xml(finding.message)}">${xml(failureBody(finding))}</failure>\n    </testcase>`;
        });

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="routelint" tests="${Math.max(1, findings.length)}" failures="${failures.length}">`,
    `  <testsuite name="routelint" tests="${Math.max(1, findings.length)}" failures="${failures.length}" errors="0" skipped="0" timestamp="${xml(report.generatedAt)}">`,
    "    <properties>",
    `      <property name="baseUrl" value="${xml(report.baseUrl)}"/>`,
    `      <property name="toolVersion" value="${xml(report.toolVersion)}"/>`,
    `      <property name="reportSchemaVersion" value="${xml(report.schemaVersion)}"/>`,
    `      <property name="routes" value="${report.summary.routes}"/>`,
    `      <property name="errors" value="${report.summary.errors}"/>`,
    `      <property name="warnings" value="${report.summary.warnings}"/>`,
    `      <property name="info" value="${report.summary.info}"/>`,
    "    </properties>",
    ...cases,
    "  </testsuite>",
    "</testsuites>",
    "",
  ].join("\n");
}
