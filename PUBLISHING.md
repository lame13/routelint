# Publish RouteLint 0.4.0 from your Mac

Releases go through a pull request to protected `main`. After the PR is merged and CI passes, publish from your terminal using npm's interactive 2FA flow. GitHub Actions verifies the package; it does not publish it or need an npm token.

## 1. Prepare and verify the release

Run these commands from the existing repository checkout. The release changes should already be present locally. Version 0.4.0 is already set in the package, lockfile, and CLI; its release notes are in `CHANGELOG.md`. Do not run `npm version` again:

```bash
git switch -c release/0.4.0
nvm install
nvm use
node --version
npm --version
```

The development default is Node 24. The published package supports Node 22.12.0 and newer. Use a current npm CLI for interactive publishing; if yours needs updating, run `npm install --global npm@latest` after selecting Node 24.

Check the release, including installing the packed package in a temporary directory:

```bash
npm ci
npm run check
npm audit --audit-level=low
npm pack --dry-run
```

All checks must pass before proceeding. The package smoke check removes its own temporary installation and tarball. Clear the remaining build output and test caches before committing:

```bash
node scripts/clean.mjs
rm -rf node_modules/.vite node_modules/.vite-temp
git status --short
```

## 2. Push a branch and open a PR

If needed, install GitHub CLI with `brew install gh` and sign in with `gh auth login`.

```bash
git add README.md CHANGELOG.md PUBLISHING.md package.json package-lock.json \
  docs/REDIRECTS.md docs/RULES.md examples/routelint.config.yml src test
git diff --cached --check
git diff --cached --stat
git commit -m "Release RouteLint 0.4.0" \
  -m "Add redirect patterns, response-time budgets, crawl pacing, and Markdown/CSV/JUnit reports. Fix query preservation, pacing, report redaction, and output escaping. Verified with npm run check."
git push -u origin release/0.4.0
gh pr create --base main --head release/0.4.0 --fill
gh pr checks release/0.4.0 --watch
```

Review the PR and satisfy the branch's required checks and approvals, then merge it:

```bash
gh pr merge release/0.4.0 --merge --delete-branch
```

If the repository uses a merge queue, wait for the PR to reach the merged state before continuing. Refresh your checkout and verify CI for that commit on `main`:

```bash
git switch main
git pull --ff-only origin main
gh run list --workflow CI --branch main --commit "$(git rev-parse HEAD)"
# Use the run ID shown above:
gh run watch RUN_ID --exit-status
```

Keep this merged commit checked out through publication and tagging. CI runs the full checks on Linux with Node 22.12 and 24, plus installed-package smoke tests on macOS and Windows. Publish only once the merged commit is green.

## 3. Publish 0.4.0 interactively

Start from the clean, merged checkout. Confirm the package version and inspect the registry so you do not attempt to publish an existing version:

```bash
git status --short
test -z "$(git status --porcelain)"
test "$(node -p "require('./package.json').version")" = "0.4.0"
npm pkg get name version repository homepage
npm view routelint version versions dist-tags
```

Run the release checks on this checkout:

```bash
npm ci
npm run check
npm audit --audit-level=low
npm pack --dry-run
node scripts/clean.mjs
rm -rf node_modules/.vite node_modules/.vite-temp
```

Sign in and confirm the npm account you intend to publish from:

```bash
unset NPM_TOKEN NODE_AUTH_TOKEN
npm login --auth-type=web
npm whoami
npm profile get
```

The account's 2FA mode must be `auth-and-writes`. On the [package access page](https://www.npmjs.com/package/routelint/access), keep **Require two-factor authentication and disallow tokens** enabled. This release process uses the interactive second-factor prompt; it does not use a bypass token.

Publish with the explicit `latest` tag, then complete npm's browser or terminal authentication prompt:

```bash
NPM_CONFIG_PROVENANCE=false npm publish --access public --tag latest
```

`prepublishOnly` reruns `npm run check`, and `prepack` rebuilds `dist` before upload. Local publishing does not use `--provenance`, which requires a supported CI identity. Keep the second factor in npm's prompt rather than passing it as a command-line argument.

After publication succeeds, verify the registry and installed CLI, then clear the regenerated build output and test caches:

```bash
npm view routelint@0.4.0 version dist.integrity repository.url engines
npm view routelint dist-tags
npx --yes routelint@0.4.0 --version
node scripts/clean.mjs
rm -rf node_modules/.vite node_modules/.vite-temp
git status --short
```

See npm's [interactive 2FA instructions](https://docs.npmjs.com/accessing-npm-using-2fa/) and [package publishing access settings](https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification/).

## 4. Tag the published source

From the same merged commit you just published:

```bash
test -z "$(git status --porcelain)"
git tag -a v0.4.0 -m "RouteLint v0.4.0"
git push origin v0.4.0
release_notes=$(mktemp)
awk '/^## 0\.4\.0 / { printing=1; next } printing && /^## / { exit } printing { print }' \
  CHANGELOG.md > "$release_notes"
gh release create v0.4.0 \
  --verify-tag \
  --notes-file "$release_notes" \
  --latest \
  --title "RouteLint v0.4.0"
```

For the next release, update the package version, `src/version.ts`, lockfile, changelog, and this guide. Keep the same PR, CI, and interactive publishing sequence.
