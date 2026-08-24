import { describe, expect, it } from "vitest";

import {
  contentEvidenceFromText,
  extractContentEvidence,
  simhashDistance,
} from "../src/content.js";

describe("content evidence", () => {
  it("excludes head, script, style, template, noscript, and SVG payload text", () => {
    const evidence =
      extractContentEvidence(`<!doctype html><html><head><title>Hidden title</title></head>
      <body><h1>Visible heading</h1><p>Useful body copy.</p>
      <script>secret script words</script><style>.hidden { content: "style words" }</style>
      <template>template words</template><noscript>fallback words</noscript><svg><text>icon label</text></svg>
      </body></html>`);
    const expected = contentEvidenceFromText("Visible heading Useful body copy.");

    expect(evidence).toEqual(expected);
    expect(evidence).toMatchObject({ characters: 33, words: 5 });
  });

  it("produces stable exact and near-duplicate fingerprints without storing text", () => {
    const first = contentEvidenceFromText("A useful page about technical SEO checks");
    const repeated = contentEvidenceFromText("  A USEFUL page about technical SEO checks  ");
    const changed = contentEvidenceFromText("A useful page about technical SEO audits");

    expect(first).toEqual(repeated);
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.simhash).toMatch(/^[a-f0-9]{16}$/);
    expect(simhashDistance(first.simhash, changed.simhash)).toBeLessThan(20);
    expect(first).not.toHaveProperty("text");
  });
});
