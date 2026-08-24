# URL-list input

URL lists provide an explicit crawl inventory for sites whose routes are not fully linked or listed in sitemaps.

```bash
routelint check https://example.com --urls routes.txt
routelint check https://example.com --urls generated.txt --urls manual.txt
cat routes.txt | routelint check https://example.com --urls -
```

Config paths are resolved relative to the config file. Command-line paths are resolved relative to the current directory.

```yaml
baseUrl: https://example.com
urls:
  - routes/public.txt
  - routes/products.txt
```

## Format

Each non-empty, non-comment line is one absolute HTTP(S) URL or a path resolved against `baseUrl`.

```text
# marketing routes
/
/pricing
/about?campaign=main
https://example.com/legal
```

Fragments are removed. Query parameters are sorted, then the configured `queryPolicy` decides whether they remain. Repeated URLs are retained once, using the first source and line as evidence.

Malformed URLs, unsupported protocols, embedded credentials, unreadable files, oversized files, and repeated stdin markers are errors. Off-origin URLs are excluded with warnings. Sources are bounded to 10 MiB each.
