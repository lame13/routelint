import type { Finding, RouteLintReport, Severity } from "../types.js";
import { stableJson } from "./json.js";

interface SarifMessage {
  readonly text: string;
}

interface SarifArtifactLocation {
  readonly uri: string;
}

interface SarifLocation {
  readonly id?: number;
  readonly message?: SarifMessage;
  readonly physicalLocation: {
    readonly artifactLocation: SarifArtifactLocation;
  };
}

interface SarifRule {
  readonly id: string;
  readonly name: string;
  readonly shortDescription: SarifMessage;
  readonly defaultConfiguration: {
    readonly level: SarifLevel;
  };
}

type SarifLevel = "error" | "warning" | "note";

function levelFor(severity: Severity): SarifLevel {
  return severity === "info" ? "note" : severity;
}

function ruleName(code: string): string {
  const words = code
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/u)
    .filter((word) => word.length > 0);

  if (words.length === 0) return "Site check";
  return words
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1).toLowerCase()}`)
    .join(" ");
}

function compareFindings(left: Finding, right: Finding): number {
  return (
    left.code.localeCompare(right.code) ||
    (left.url ?? "").localeCompare(right.url ?? "") ||
    left.message.localeCompare(right.message)
  );
}

function ruleFor(code: string, findings: readonly Finding[]): SarifRule {
  const matching = findings.filter((finding) => finding.code === code);
  const defaultSeverity = matching.reduce<Severity>((highest, finding) => {
    const rank = { error: 3, warning: 2, info: 1 } as const;
    return rank[finding.severity] > rank[highest] ? finding.severity : highest;
  }, "info");

  return {
    id: code,
    name: ruleName(code).replaceAll(" ", ""),
    shortDescription: { text: ruleName(code) },
    defaultConfiguration: { level: levelFor(defaultSeverity) },
  };
}

function locationFor(url: string, id?: number): SarifLocation {
  return {
    ...(id === undefined ? {} : { id }),
    physicalLocation: { artifactLocation: { uri: url } },
  };
}

function resultFor(finding: Finding): Record<string, unknown> {
  const relatedLocations = (finding.relatedUrls ?? [])
    .slice()
    .sort((left, right) => left.localeCompare(right))
    .map((url, index) => ({
      ...locationFor(url, index + 1),
      message: { text: "Related route" },
    }));

  return {
    ruleId: finding.code,
    level: levelFor(finding.severity),
    message: { text: finding.message },
    ...(finding.url === undefined ? {} : { locations: [locationFor(finding.url)] }),
    ...(relatedLocations.length === 0 ? {} : { relatedLocations }),
    properties: {
      severity: finding.severity,
      evidence: finding.evidence ?? {},
    },
  };
}

/** Render a SARIF 2.1.0 log suitable for GitHub code-scanning upload. */
export function renderSarifReport(report: RouteLintReport): string {
  const findings = report.findings.slice().sort(compareFindings);
  const codes = [...new Set(findings.map((finding) => finding.code))].sort((left, right) =>
    left.localeCompare(right),
  );

  return stableJson({
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "Site check",
            semanticVersion: report.toolVersion,
            informationUri: "https://nikom.work",
            rules: codes.map((code) => ruleFor(code, findings)),
          },
        },
        invocations: [
          {
            executionSuccessful: true,
            properties: {
              baseUrl: report.baseUrl,
              generatedAt: report.generatedAt,
              reportTruncated: report.truncated,
            },
          },
        ],
        results: findings.map((finding) => resultFor(finding)),
      },
    ],
  });
}
