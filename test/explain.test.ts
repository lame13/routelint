import { describe, expect, it } from "vitest";

import { findRuleExplanation, formatRuleExplanation, readRuleDocs } from "../src/explain.js";

describe("rule explanations", () => {
  it("matches exact codes and documented wildcard families", () => {
    const markdown = `# Rules

## Page signals

| Code family | Meaning |
| --- | --- |
| \`missing-title\` | The title is absent. |
| \`duplicate-*\`, \`conflicting-*\` | Values repeat or disagree. |
`;

    expect(findRuleExplanation("missing-title", markdown)).toMatchObject({
      section: "Page signals",
      meaning: "The title is absent.",
    });
    expect(findRuleExplanation("duplicate-title", markdown)).toMatchObject({
      section: "Page signals",
      meaning: "Values repeat or disagree.",
    });
    expect(findRuleExplanation("not-a-code", markdown)).toBeUndefined();
  });

  it("stays in sync with the bundled rule reference", async () => {
    const markdown = await readRuleDocs();
    const invalid = findRuleExplanation("invalid-json-ld", markdown);
    const openGraph = findRuleExplanation("missing-og-title", markdown);
    const duplicate = findRuleExplanation("duplicate-json-ld", markdown);

    expect(invalid).toMatchObject({
      section: "Structured data and social metadata",
      severity: "warning",
    });
    expect(openGraph).toMatchObject({
      section: "Structured data and social metadata",
      severity: "error",
    });
    expect(duplicate).toMatchObject({
      section: "Structured data and social metadata",
      severity: "warning",
    });
    if (invalid === undefined) throw new Error("invalid-json-ld is missing from docs/RULES.md");
    expect(formatRuleExplanation(invalid)).toContain(
      "https://github.com/lame13/routelint/blob/main/docs/RULES.md#structured-data-and-social-metadata",
    );
  });
});
