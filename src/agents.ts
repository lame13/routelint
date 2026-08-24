import type { AgentProfile } from "./types.js";
import { VERSION } from "./version.js";

export const BUILTIN_AGENTS = Object.freeze({
  routelint: {
    key: "routelint",
    label: "RouteLint",
    userAgent: `RouteLint/${VERSION} (+https://github.com/lame13/routelint)`,
  },
  googlebot: {
    key: "googlebot",
    label: "Googlebot",
    userAgent: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  },
  bingbot: {
    key: "bingbot",
    label: "Bingbot",
    userAgent: "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
  },
  browser: {
    key: "browser",
    label: "Browser-like client",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  },
} satisfies Readonly<Record<string, AgentProfile>>);

export function resolveAgent(value: string): AgentProfile {
  const key = value.trim().toLowerCase();
  const builtin = BUILTIN_AGENTS[key as keyof typeof BUILTIN_AGENTS];
  if (builtin !== undefined) return builtin;
  if (value.trim().length === 0) throw new Error("Agent cannot be empty.");
  return { key: `custom-${key.replace(/[^a-z0-9]+/g, "-")}`, label: value, userAgent: value };
}
