# Publish RouteLint from your Mac

This repository intentionally has no npm publish workflow. GitHub Actions tests and packs the project, but every npm publication is run interactively from your terminal and requires your npm account's two-factor authentication.

## 1. Use a current Node and npm

```bash
cd routelint
nvm install
nvm use
node --version
npm install --global npm@latest
npm --version
```

The development default is Node 24. The published package still supports Node 22.12.0 and newer. Install or select Node 24 before upgrading npm because current npm releases may require a newer Node patch release.

Verify the exact checkout:

```bash
npm ci
npm run check
npm audit --audit-level=low
npm pack --dry-run
```

## 2. Create and push the GitHub repository

If GitHub CLI is not installed or authenticated:

```bash
brew install gh
gh auth login
gh auth status
```

Create the local history:

```bash
git init -b main
git status --short
git add .
git diff --cached --check
git commit -m "Initial RouteLint release"
```

Create and push the public repository:

```bash
gh repo create lame13/routelint \
  --public \
  --source=. \
  --remote=origin \
  --push \
  --description "Lint the routes, links, canonicals, sitemaps, and indexability signals your SSR site actually ships." \
  --homepage "https://nikom.work"
```

Add repository topics:

```bash
gh repo edit lame13/routelint \
  --add-topic technical-seo \
  --add-topic ssr \
  --add-topic nextjs \
  --add-topic nuxt \
  --add-topic astro \
  --add-topic crawler \
  --add-topic sitemap \
  --add-topic hreflang \
  --add-topic link-checker \
  --add-topic typescript \
  --add-topic cli \
  --add-topic sarif
```

Enable the private vulnerability-reporting route referenced by `SECURITY.md`:

```bash
gh api --method PUT repos/lame13/routelint/private-vulnerability-reporting
```

Watch the initial CI run and do not publish until it is green:

```bash
gh run list --repo lame13/routelint --workflow CI
gh run watch --repo lame13/routelint --exit-status
```

The CI workflow has no Docker job and no npm publishing job. It runs Node 22.12 and 24 tests on Linux plus installed-package smoke tests on macOS and Windows.

## 3. Make the first npm publication interactively

Sign in through npm's interactive web flow, confirm the account, and inspect its 2FA mode:

```bash
npm login --auth-type=web
npm whoami
npm profile get
npm view routelint
```

`npm profile get` must show `two-factor auth: auth-and-writes`. If it does not, stop and enable account 2FA before publishing. New 2FA setups should use a WebAuthn security key or passkey through npmjs.com. Before the first publication, `npm view routelint` should return `E404`. A different result means the name is no longer available; stop and inspect it rather than publishing under an unexpected package.

Run the complete release gate again:

```bash
npm ci
npm run check
npm audit --audit-level=low
npm pack --dry-run
```

Remove any environment-provided automation credential from this shell, then publish with the explicit `latest` dist-tag. Complete npm's interactive WebAuthn or one-time-password prompt when it appears:

```bash
unset NPM_TOKEN NODE_AUTH_TOKEN
NPM_CONFIG_PROVENANCE=false npm publish --access public --tag latest
```

Do not pass `--otp` on the command line, create a bypass-2FA token, or add an npm token to this repository. Let the terminal prompt for the second factor. Do not add `--provenance` to a local publication; verifiable npm provenance requires a supported cloud CI identity. The `prepublishOnly` lifecycle runs the complete release gate again automatically before npm uploads anything.

Verify the registry result:

```bash
npm view routelint version dist-tags repository.url engines
npx --yes routelint@0.1.0 --version
```

npm's current default for new packages still permits a granular access token configured to bypass 2FA. After the package exists, open `https://www.npmjs.com/package/routelint/access`, choose **Require two-factor authentication and disallow tokens (Recommended)** under Publishing access, and save it with the interactive 2FA challenge.

- [Require 2FA for package publishing and settings changes](https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification/)
- [npm account 2FA](https://docs.npmjs.com/configuring-two-factor-authentication/)

## 4. Create the matching source release

```bash
git tag -a v0.1.0 -m "RouteLint v0.1.0"
git push origin v0.1.0
gh release create v0.1.0 \
  --verify-tag \
  --generate-notes \
  --latest \
  --title "RouteLint v0.1.0"
```

Keep future releases interactive: bump the version and changelog, rerun the release gate, publish from a real terminal with its 2FA prompt, then push the matching annotated Git tag and GitHub release. Do not add an npm publishing workflow or a bypass-2FA token without deliberately changing this release policy.
