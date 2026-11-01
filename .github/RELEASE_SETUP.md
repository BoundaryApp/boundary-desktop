# GitHub Actions Release Setup

This document explains how to set up and use the automated build and release system for Boundary Desktop (Electron Forge).

## Overview

The GitHub Actions workflow builds Boundary for macOS, Windows, and Linux when `main` gets a `package.json` version that has no tag yet, when you push a `v*` tag, or when you trigger a release manually. It creates Forge distributables under `out/make/` and publishes them to GitHub Releases.

## Features

- Cross-platform builds (macOS, Windows, Linux)
- Package formats: DMG + ZIP (macOS), Squirrel EXE (Windows), DEB + RPM (Linux)
- Optional macOS code signing and notarization
- Automatic release creation and manual `workflow_dispatch` triggers

## Packaging stack

Boundary uses **Electron Forge** (not electron-builder):

| Script | What it does |
|--------|----------------|
| `bun run build` / `npm run package` | `electron-forge package` |
| `bun run make` | `electron-forge make` (all makers for host OS) |
| `bun run dist:mac` | Fetch container runtime + `make --platform=darwin` (DMG + ZIP) |
| `bun run dist:win` | `make --platform=win32` |
| `bun run dist:linux` | `make --platform=linux` |

Before macOS packaging, run `bun run fetch:container-runtime` (also invoked by `dist:mac`) so `resources/container-runtime` is populated for `extraResource`.

## Updates

Boundary updates itself from feeds on the `update-feed` release (docs/updates-plan.md decision 4). In the public repository, set the Actions variable (Settings → Secrets and variables → Actions → **Variables**):

```
BOUNDARY_UPDATE_FEED_URL=https://github.com/BoundaryApp/boundary-desktop/releases/download/update-feed
```

Each channel has two files there: `<channel>-darwin-arm64-mac.yml` for electron-updater, and `<channel>-darwin-arm64.json` for 0.0.1-rc.13 and earlier. Builds without the setting have updates off, and the release skips the feed step. Every release is published as a prerelease on the beta feed. **Promote to Stable** (Actions → **Run workflow**, with a tag such as `v0.0.1`) writes the stable feed from that release's assets and marks it Latest. `.github/update-summary.txt` holds the line shown in the update notice; change it with each release.

## Required GitHub Secrets

Add these secrets (Settings → Secrets and variables → Actions):

### macOS code signing and notarization

```
MAC_CERTS=base64_encoded_p12_certificate
MAC_CERTS_PASSWORD=your_p12_password
APPLE_ID=your_apple_id
APPLE_APP_SPECIFIC_PASSWORD=your_app_specific_password
APPLE_TEAM_ID=your_apple_team_id
CSC_NAME=Developer ID Application: Your Name (TEAMID)   # optional but recommended
```

Encode the P12:

```bash
base64 -i certificate.p12 -o certificate.txt
```

Without these secrets, local `dist:mac` still produces an **unsigned** DMG/ZIP. CI release builds expect signing secrets on `macos-latest`.

### Optional Windows signing (future)

```
CSC_LINK=base64_encoded_certificate_or_url
CSC_KEY_PASSWORD=your_certificate_password
```

Windows artifacts are produced via Forge Squirrel today; full Windows signing parity is not required for the macOS DMG path.

## Creating releases

The `version` in `package.json` is the release version. Forge stamps it into the app as
`CFBundleShortVersionString` and `CFBundleVersion`, so the app reports the version it was
released as only when the two match.

Every release runs **Test Build** on the commit it builds first, and a failure stops the release.

### On merge to main

Bump `version` in `package.json` in the PR. When it merges, **Build and Release** sees that
`v<version>` has no tag yet, builds, creates the `v<version>` tag on the merged commit and
publishes the release. Pushes to `main` whose version is already tagged stop after the version
check and build nothing.

### Tag

```bash
git tag v1.0.0
git push origin v1.0.0
```

The workflow warns if the tag differs from `package.json`'s version.

### Manual

1. Actions → **Build and Release** → **Run workflow**
2. Enter version (e.g. `v1.0.0`)
3. Run workflow

## Build outputs

Artifacts are uploaded from `out/make/`:

### macOS

- `*.dmg` — installer disk image
- `*.zip` — app archive that update feeds point at

### Windows

- Squirrel `.exe` / `.nupkg` under `out/make/squirrel.windows/`

### Linux

- `.deb` and `.rpm` under `out/make/deb/` and `out/make/rpm/`

## Local validation

### Unsigned macOS DMG (real packaging)

On a Mac:

```bash
node scripts/setup-dependencies.js
bun run dist:mac
ls out/make/**/*.dmg
```

## Troubleshooting

### Build failures

1. Check Actions logs for the failing matrix OS.
2. On macOS, confirm `fetch:container-runtime` populated `resources/container-runtime/darwin-*/bin/`.
3. Confirm scripts exist: `build`, `dist:mac`, `type-check`.

### Code signing / notarization

1. Verify `MAC_CERTS` decodes to a valid P12.
2. Prefer setting `CSC_NAME` to the Developer ID Application identity.
3. Notarization requires `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` (Forge `osxNotarize` is skipped when any are missing).
