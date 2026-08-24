# Next.js build discovery

`routelint next` combines a live HTTP crawl with routes found in an existing Next.js production build.

```bash
npm run build
npm start
npx routelint next http://localhost:3000 --root .
```

The production server must already be running. RouteLint does not start, import, or execute the application.

## Files read

When present, RouteLint reads these known build artifacts under `.next` (or the configured build directory):

- `routes-manifest.json`
- `prerender-manifest.json`
- `server/app-paths-manifest.json`
- `server/pages-manifest.json`
- `build-manifest.json`
- `BUILD_ID`

It also reads the locally installed `next/package.json` version when available. Files are size-limited and parsed as untrusted JSON.

Concrete static, prerendered, and ISR routes become crawl candidates. Next redirects are retained as build evidence. Internal framework routes, Pages Router API routes, App Router route handlers, error documents, and unresolved patterns are not treated as public pages. Next's standard metadata routes, such as `robots.txt`, `sitemap.xml`, and `manifest.webmanifest`, remain discoverable.

## Dynamic routes

A pattern is not a URL. RouteLint will not turn `/blog/[slug]` into a fake page.

Concrete routes can come from:

- a sitemap;
- an internal link found during the live crawl;
- a prerender manifest entry;
- an explicit sample.

```yaml
next:
  root: .
  buildDirectory: .next
  samples:
    /blog/[slug]:
      - /blog/hello-world
      - /blog/release-notes
    /docs/[[...parts]]:
      - /docs
      - /docs/getting-started/install
```

Samples must match their pattern. Invalid samples produce warnings and are ignored.

## Render modes

RouteLint reports the strongest state supported by build evidence:

- `static`: prerendered without revalidation;
- `isr`: prerendered with a revalidation interval;
- `dynamic`: present in route manifests without prerender evidence;
- `unknown`: the artifacts do not support a safe conclusion.

Partially prerendered/PPR evidence stays `unknown` when the manifest cannot prove full static rendering. This avoids turning a framework implementation detail into a false SEO conclusion.

## Compatibility boundary

Next.js build manifests are known artifacts, not a stable public integration API. RouteLint handles missing fields and files without crashing and reports compatibility warnings. The live HTTP response remains the source of truth for status, redirects, HTML metadata, links, and indexability.

The configured Next.js `basePath` is applied to public build paths before they enter the crawl graph.
