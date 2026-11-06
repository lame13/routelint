import { readFile } from "node:fs/promises";

import { findingDocsUrl } from "./rules.js";

export interface RuleExplanation {
  readonly code: string;
  readonly section: string;
  readonly severity?: string;
  readonly meaning: string;
  readonly docsUrl: string;
}

/** Read the rule reference bundled with the installed package. */
export async function readRuleDocs(): Promise<string> {
  return readFile(new URL("../docs/RULES.md", import.meta.url), "utf8");
}

export function findRuleExplanation(code: string, markdown: string): RuleExplanation | undefined {
  let section = "";
  let familyMatch: RuleExplanation | undefined;
  for (const line of markdown.split(/\r?\n/u)) {
    const heading = /^(?:##|###) (.+)$/u.exec(line);
    if (heading !== null) {
      section = heading[1]?.trim() ?? "";
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;

    const cells = trimmed
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    const declaredCodes = [...(cells[0] ?? "").matchAll(/`([^`]+)`/gu)].map(
      (match) => match[1] ?? "",
    );
    const exact = declaredCodes.some((declared) => !declared.includes("*") && declared === code);
    const family = declaredCodes.some(
      (declared) => declared.includes("*") && ruleMatches(declared, code),
    );
    if (!exact && !family) continue;

    const details = cells.slice(1).map((cell) => cell.replaceAll("`", ""));
    const severity = details.length > 1 ? details[0] : undefined;
    const meaning = details.at(-1) ?? "";
    const explanation: RuleExplanation = {
      code,
      section,
      ...(severity === undefined || severity.length === 0 ? {} : { severity }),
      meaning,
      docsUrl: findingDocsUrl(code),
    };
    if (exact) return explanation;
    familyMatch ??= explanation;
  }
  return familyMatch;
}

export function formatRuleExplanation(rule: RuleExplanation): string {
  return [
    `${rule.code} (${rule.section})`,
    ...(rule.severity === undefined ? [] : [`Default severity: ${rule.severity}`]),
    rule.meaning,
    rule.docsUrl,
    "",
  ].join("\n");
}

function ruleMatches(declared: string, code: string): boolean {
  if (!declared.includes("*")) return declared === code;
  const pattern = declared
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join(".*");
  return new RegExp(`^${pattern}$`, "u").test(code);
}
