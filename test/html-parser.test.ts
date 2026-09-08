import { describe, expect, it } from "vitest";
import { parseHtml, parseXRobotsTag } from "../src/html-parser.js";

describe("parseHtml", () => {
  it("extracts server-rendered metadata, headings, alternates, and crawlable anchors", () => {
    const signals = parseHtml(
      `<!doctype html>
      <html lang="en-GB">
        <head>
          <base href="/docs/">
          <title>  A useful &amp; direct title </title>
          <meta name="description" content="  A concise description.  ">
          <meta name="ROBOTS" content="index, follow">
          <meta name="googlebot" content="max-snippet:120">
          <link rel="canonical alternate" href="../guide">
          <link rel="alternate" hreflang="fr" href="fr/">
        </head>
        <body>
          <h1> Read <span>the guide</span> </h1>
          <a href="intro" rel="nofollow sponsored"> Intro <strong>now</strong> </a>
          <a href="/visual"><img alt="Visual guide"></a>
          <a href="mailto:hello@example.test">Email us</a>
          <meta name="description" content="body description">
        </body>
      </html>`,
      "https://example.test/products/page",
    );

    expect(signals.htmlLang).toBe("en-GB");
    expect(signals.baseHref).toBe("/docs/");
    expect(signals.titles).toEqual([{ value: "A useful & direct title", location: "head" }]);
    expect(signals.descriptions).toEqual([
      { value: "A concise description.", location: "head" },
      { value: "body description", location: "body" },
    ]);
    expect(signals.canonicals).toEqual([{ value: "../guide", location: "head" }]);
    expect(signals.robots).toEqual([
      {
        value: "index, follow",
        location: "head",
        audience: "robots",
        source: "meta",
      },
      {
        value: "max-snippet:120",
        location: "head",
        audience: "googlebot",
        source: "meta",
      },
    ]);
    expect(signals.h1s).toEqual([{ value: "Read the guide", location: "body" }]);
    expect(signals.hreflangs).toEqual([
      {
        language: "fr",
        href: "fr/",
        resolvedUrl: "https://example.test/docs/fr/",
      },
    ]);
    expect(signals.links).toEqual([
      {
        href: "intro",
        resolvedUrl: "https://example.test/docs/intro",
        text: "Intro now",
        rel: ["nofollow", "sponsored"],
        nofollow: true,
      },
      {
        href: "/visual",
        resolvedUrl: "https://example.test/visual",
        text: "Visual guide",
        rel: [],
        nofollow: false,
      },
      {
        href: "mailto:hello@example.test",
        text: "Email us",
        rel: [],
        nofollow: false,
      },
    ]);
  });

  it("retains empty signals and does not treat script text as anchor text", () => {
    const signals = parseHtml(
      `<html lang=""><head><title></title><meta name="description" content="">
       <link rel="canonical" href=""></head><body><h1></h1>
       <a href="/target" aria-label="Fallback"><script>wrong()</script></a></body></html>`,
      "https://example.test/current",
    );

    expect(signals.htmlLang).toBe("");
    expect(signals.titles[0]?.value).toBe("");
    expect(signals.descriptions[0]?.value).toBe("");
    expect(signals.canonicals[0]?.value).toBe("");
    expect(signals.h1s[0]?.value).toBe("");
    expect(signals.links[0]?.text).toBe("Fallback");
  });

  it("ignores template metadata and links, including nested templates", () => {
    const signals = parseHtml(
      `<html lang="en"><head>
        <template>
          <base href="https://outside.test/">
          <title>Template title</title>
          <meta name="description" content="Template description">
          <meta name="robots" content="noindex">
          <link rel="canonical" href="/template-canonical">
          <link rel="alternate" hreflang="fr" href="/template-fr">
          <h1>Template heading</h1>
          <template><a href="/nested">Nested template link</a></template>
          <a href="/template-only"><img alt="Template image"></a>
          <script>unused()</script><style>.unused { color: red; }</style>
        </template>
        <base href="/docs/">
        <title>Guide</title>
      </head><body>
        <h1>Read the guide</h1>
        <a href="next">Next <template><img alt="Hidden label"></template>page</a>
      </body></html>`,
      "https://example.test/current",
    );

    expect(signals).toEqual({
      htmlLang: "en",
      baseHref: "/docs/",
      titles: [{ value: "Guide", location: "head" }],
      descriptions: [],
      canonicals: [],
      robots: [],
      h1s: [{ value: "Read the guide", location: "body" }],
      links: [
        {
          href: "next",
          resolvedUrl: "https://example.test/docs/next",
          text: "Next page",
          rel: [],
          nofollow: false,
        },
      ],
      hreflangs: [],
    });
  });

  it("ignores unclosed template contents while keeping earlier page signals", () => {
    const signals = parseHtml(
      `<head><title>Page</title></head><body><h1>Visible</h1>
       <template><meta name="robots" content="noindex"><a href="/unused">Unused`,
      "https://example.test/",
    );

    expect(signals.titles).toEqual([{ value: "Page", location: "head" }]);
    expect(signals.h1s).toEqual([{ value: "Visible", location: "body" }]);
    expect(signals.robots).toEqual([]);
    expect(signals.links).toEqual([]);
  });
});

describe("parseXRobotsTag", () => {
  it("keeps audience prefixes across comma-separated directives", () => {
    expect(
      parseXRobotsTag(
        "noarchive, googlebot: noindex, nofollow, bingbot: max-snippet: 0, noimageindex",
      ),
    ).toEqual([
      { value: "noarchive", location: "head", audience: "robots", source: "header" },
      { value: "noindex", location: "head", audience: "googlebot", source: "header" },
      { value: "nofollow", location: "head", audience: "googlebot", source: "header" },
      { value: "max-snippet: 0", location: "head", audience: "bingbot", source: "header" },
      { value: "noimageindex", location: "head", audience: "bingbot", source: "header" },
    ]);
  });

  it("ignores directives scoped to an unsupported crawler", () => {
    expect(parseXRobotsTag("otherbot: noindex, nofollow")).toEqual([]);
  });
});
