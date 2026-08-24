# Reports and baselines

## Formats

- `terminal` is concise and deterministic when color is disabled.
- `json` contains the complete route graph, evidence, findings, and run limits.
- `sarif` maps findings to URL artifact locations for code-scanning tools.
- `html` is one portable file with no external assets or network requests.

```bash
routelint check https://example.com --format json -o report.json
routelint check https://example.com --format sarif -o report.sarif
routelint check https://example.com --format html -o report.html
```

## JSON stability

Reports include `schemaVersion`, `toolVersion`, and `generatedAt`. Object keys and route/finding order are deterministic for the same evidence. Timing values and generation dates naturally differ.

Request headers are excluded. Response headers are allowlisted/redacted by the capture layer. URLs can still reveal private route names, so treat preview reports as potentially sensitive.

## Baseline comparison

```bash
routelint diff baseline.json current.json
routelint diff baseline.json current.json --format json -o diff.json
```

The reader validates nested report data before comparison. A malformed or unsupported schema exits with code 2 instead of being cast to an internal type.

The diff covers:

- route additions and removals;
- status and final URL;
- canonical and title;
- robots directives and effective indexability;
- secondary-agent fetch, status, URL, canonical, title, robots, and indexability changes;
- Next.js render mode;
- added, resolved, and severity-changed findings.

Baseline comparison describes observed change. It does not prove that an omitted route was deleted when either crawl was truncated; keep page/depth/robots/query settings stable between runs.
