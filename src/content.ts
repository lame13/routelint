import { createHash } from "node:crypto";

import { Parser } from "htmlparser2";

import type { PageContentEvidence } from "./types.js";

const IGNORED_TEXT_TAGS = new Set(["script", "style", "template", "noscript", "svg"]);

/** Extract measurements and fingerprints without retaining server-delivered body text. */
export function extractContentEvidence(html: string): PageContentEvidence {
  const chunks: string[] = [];
  let headDepth = 0;
  let ignoredDepth = 0;

  const parser = new Parser(
    {
      onopentag(name) {
        const tag = name.toLowerCase();
        if (tag === "head") headDepth += 1;
        if (IGNORED_TEXT_TAGS.has(tag)) ignoredDepth += 1;
      },
      ontext(value) {
        if (headDepth === 0 && ignoredDepth === 0) chunks.push(value);
      },
      onclosetag(name) {
        const tag = name.toLowerCase();
        if (IGNORED_TEXT_TAGS.has(tag)) ignoredDepth = Math.max(0, ignoredDepth - 1);
        if (tag === "head") headDepth = Math.max(0, headDepth - 1);
      },
    },
    { decodeEntities: true },
  );
  parser.end(html);

  return contentEvidenceFromText(chunks.join(" "));
}

/** Convert text into deterministic measurements without retaining the text. */
export function contentEvidenceFromText(value: string): PageContentEvidence {
  const normalized = value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
  const tokens = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  return {
    characters: normalized.length,
    words: tokens.length,
    sha256: createHash("sha256").update(normalized).digest("hex"),
    simhash: simhash(tokens),
  };
}

/** Return the Hamming distance between two encoded 64-bit SimHashes. */
export function simhashDistance(left: string, right: string): number | undefined {
  if (!/^[a-f0-9]{16}$/i.test(left) || !/^[a-f0-9]{16}$/i.test(right)) return undefined;
  let value = BigInt(`0x${left}`) ^ BigInt(`0x${right}`);
  let distance = 0;
  while (value > 0n) {
    distance += Number(value & 1n);
    value >>= 1n;
  }
  return distance;
}

function simhash(tokens: readonly string[]): string {
  if (tokens.length === 0) return "0000000000000000";
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  const weights = Array.from({ length: 64 }, () => 0);

  for (const [token, frequency] of counts) {
    const digest = createHash("sha256").update(token).digest();
    for (let bit = 0; bit < 64; bit += 1) {
      const byte = digest[Math.floor(bit / 8)] ?? 0;
      const enabled = (byte & (1 << (7 - (bit % 8)))) !== 0;
      weights[bit] = (weights[bit] ?? 0) + (enabled ? frequency : -frequency);
    }
  }

  let result = 0n;
  for (const weight of weights) result = (result << 1n) | (weight >= 0 ? 1n : 0n);
  return result.toString(16).padStart(16, "0");
}
