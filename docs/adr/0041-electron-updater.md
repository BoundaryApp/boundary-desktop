# 0041. App updates use electron-updater

- Date: 2026-11-01
- Status: Accepted
- Related: [updates plan](../updates-plan.md) decision 4, [0037](0037-update-rail-button.md)

## Context

The updates plan chose Electron's built-in `autoUpdater` and ruled out electron-updater because it belongs to electron-builder and has no documented Forge integration. Boundary then grew a download of its own to show progress: it fetched the zip, served it from `127.0.0.1` with a rewritten JSON feed, and let Squirrel read it. electron-updater's `MacUpdater` does the same thing, and also checks `sha512` before Squirrel sees the zip. Squirrel's JSON mode compares versions by `NSNumericSearch`, which needed a `rc.999999` label on the beta feed so an RC would accept its final release. electron-updater hands Squirrel the zip through the default server type, where Squirrel doesn't compare versions, and compares by semver itself.

Reading version 6.8.11's source settled the Forge question. The library needs no electron-builder output at runtime except a cache folder name from `app-update.yml`, and `updateConfigPath` can point that anywhere.

## Decision

1. **electron-updater checks and downloads, and Squirrel still installs.** It runs with `autoDownload` off, so nothing downloads until **Download**. The generic provider reads `<channel>-darwin-<arch>-mac.yml` beside the existing feeds. Squirrel still refuses a bundle that fails the running app's designated requirement.
2. **Packaging doesn't change.** Boundary writes `app-update.yml` to `userData` at launch and sets the feed in code. Each instance's cache folder has its own name.
3. **The workflows write both formats until nobody runs 0.0.1-rc.13.** That build and earlier ones read the JSON feed and install the next release through Squirrel's JSON mode. The zip is the same file either way, so the first electron-updater release reaches them unchanged.
4. **Channel files are JSON in a `.yml` file.** electron-updater parses them with `js-yaml`, which accepts JSON, so the script needs no YAML writer. They carry `stackVersion` beside the standard keys.
5. **Ready still means Squirrel has the update.** electron-updater's `update-downloaded` fires before Squirrel has looked at the zip, so it only moves the card to **Checking**. Electron's own `update-downloaded` moves it to ready.
6. **Boundary keeps its own stall check.** The library's timeout waits for a `socket` event that Electron's `net` doesn't emit, so a dead connection would hang with no way to cancel. Sixty seconds with no bytes cancels the download.
7. **The personal key stays off the zip.** `requestHeaders` applies to every request, so Boundary clears it before downloading.
8. **Each launch removes the old updater's leftovers.** Builds through 0.0.1-rc.13 download into `boundary-update-*` in the system's temporary folder, and quitting mid-download leaves that folder behind. Boundary removes any older than a day, because a younger one may be an older instance still downloading. Squirrel's own cache stays, because it still installs every update.

## Consequences

- `rc.999999` stays only in the JSON feed, and goes when that feed does.
- The finished zip stays in `~/Library/Caches/<name>-updater/pending` until the next update replaces it. A retry reuses it if its `sha512` still matches.
- A check can take up to the library's request limits, where Boundary's own fetch stopped at 15 seconds.
- On an unsigned build, Squirrel's `setFeedURL` throws inside electron-updater's server callback, where Boundary can't catch it. Builds with a feed are signed, so this reaches only a misconfigured local build.
- Differential downloads stay off: they need a blockmap that the Forge zip doesn't have.
