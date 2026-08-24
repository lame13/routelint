# Contributing to RouteLint

Bug reports and focused pull requests are welcome. RouteLint should remain bounded, deterministic, and honest about incomplete HTTP evidence.

## Development setup

Requirements:

- Node.js 22.12.0 or newer
- npm 10 or newer

```bash
git clone https://github.com/lame13/routelint.git
cd routelint
npm ci
npm run check
```

Use `npm run dev -- --help` while developing. Run `npm run format`, review the changes, then run `npm run check` before opening a pull request.

## Pull requests

Include focused tests for changes involving:

- redirect handling, cross-origin headers, timeouts, and response limits;
- malformed HTML, XML, robots rules, and Next.js manifest data;
- URL normalization, graph depth, page budgets, and deterministic ordering;
- canonicals, sitemaps, hreflang, indexability, and false-positive boundaries;
- terminal, JSON, SARIF, HTML, baseline diff, and exit-code behavior;
- escaping or redaction of untrusted response data.

Do not make network tests depend on public services. Use local fixtures. Do not weaken a limit or infer a route/indexing state when evidence is incomplete.

## Scope

RouteLint is a raw-HTTP route and technical-SEO linter. Browser rendering, hydration, Core Web Vitals, authenticated user journeys, and search-engine index data are separate concerns.

By contributing, you agree that your contribution is licensed under the MIT License.
