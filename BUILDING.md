# Reproducing the Firefox 1.6.0 package

These instructions are for Mozilla reviewers and developers. No university
account, credentials, environment files, private dependencies, or build secrets
are needed. All dependencies are resolved from the included `package-lock.json`.

## Environment

The submitted-package candidate is built with:

- macOS 26.5.2, ARM64
- Node.js 22.16.0
- npm 10.9.2

Install Node.js from the [official 22.16.0 downloads](https://nodejs.org/download/release/v22.16.0/).
If the installed npm differs, `npm install --global npm@10.9.2` selects the
recorded npm version. The repository also runs CI on Linux with Node 20.19.0
and 22.12.0. The package candidate's recorded local build environment is the one
listed above; do not assume the default AMO reviewer environment matches it.

## Build

Extract `koan-plus-1.6.0-source.zip` and open its `koan-plus-1.6.0` directory.
Run these commands from that directory with development dependencies enabled:

```sh
node --version
npm --version
npm ci
npm run build:firefox
```

The complete installable file tree is `dist-firefox/`. Its `manifest.json` is
the Firefox manifest, with add-on ID `@koan-plus.haze-355` and version `1.6.0`.
Compare that file tree against the extracted contents of
`koan-plus-1.6.0-firefox.zip`. ZIP container timestamps are not source changes.

To produce the Firefox ZIP:

```sh
node scripts/build-zip.mjs dist-firefox koan-plus-1.6.0-firefox.zip
```

TypeScript and Vite build the React dashboard; the readable extension background
and content scripts are copied from `public/`. The build uses no obfuscator or
remote code. `scripts/build-notices.mjs` includes the project license, notices,
and third-party license texts in the package.

## Offline application tests

After installing dependencies:

```sh
npm run typecheck
npm test
npx playwright install chromium firefox
npm run test:all
```

Tests use synthetic academic data and browser API substitutes. They do not
contact university services or contain usable credentials. Browser downloads
and npm dependency installation require internet access. These tests do not
replace real university authentication or Firefox distribution review.

The runtime data flows and permissions are described in [PRIVACY.md](./PRIVACY.md).
Recorded verification scope and limitations are in
[docs/firefox-verification.md](./docs/firefox-verification.md).
