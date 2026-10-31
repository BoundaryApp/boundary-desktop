# Updates plan

| | |
| --- | --- |
| Status | Prompt-first app updates decided 30 Oct 2026; later phases proposed |
| Stack requests | [0013 Stack releases Boundary can install unattended](change-requests/0017-stack-releases.md) |
| User experience | [updates UX study](updates-ux-study/README.md) |
| Started | 26 Oct 2026 |

## Progress

| Phase | Status | Depends on |
| --- | --- | --- |
| 1 Release workflow publishes update feeds | Built, not yet run | — |
| 2 Boundary asks, downloads and restarts | Built, not yet tested on a signed build | 1 |
| 3 Release candidates prove the update path | Not started | 2 |
| 4 0.0.1 is released | Not started | 3 |
| 5 The stack version comes from a signed channel file | Not started | 4 |
| 6 Going back to the previous stack | Not started | 5 |
| 7 Container engine follows the app | Not started | 2 |
| 8 Signed images and prebuilt stack images | Not started | 5, 0017 R4–R6 |

## First release: ask, download, restart

The first Boundary with an updater never downloads anything without the user's say-so:

1. At launch and every 24 hours, Boundary fetches the feed for its channel. The fetch sends no ID.
2. If the feed names a newer version that the user hasn't skipped, a button appears above Settings on the icon rail and a card opens from it once, with **Download** and **Later** ([ADR 0037](adr/0037-update-rail-button.md)). The button stays until the update installs or the version is skipped.
3. **Download** starts Squirrel. The card shows the size and that it is downloading, with no percentage and no cancel, because `autoUpdater` offers neither.
4. When the download finishes, the card says the update installs on quit and offers **Restart to update**. Boundary runs the running-work check (decision 6), stops the stack, and installs.

The stack needs no updater of its own in this release. Its ref is compiled into each build, so the first launch of a new app runs the existing provisioning path. That means stack changes reach users only with an app release, and that launch is slow. It also moves one-way data with no automatic rollback, so `db` joins the backup now rather than in phase 6.

The first release includes decisions 4, 6 and 11, the `db` backup from decision 7, and the `dataVersion` write from decision 7. A version that was never recorded can't be checked later. It leaves out the channel file, rollouts, background stack staging, going back and most of change request 0017. Bundled Podman stays on its current major and minor version until phase 7.

Until phase 5 the feed is unsigned. Squirrel still installs only a bundle that satisfies the running app's designated requirement, so a tampered feed can offer only something Boundary's Developer ID signed, and Boundary's version check blocks older ones. A compromised release workflow could ship a newer signed build, which is the case the channel file's separate key closes.

## What gets updated

Four things change on a user's Mac, on three schedules.

| Part | Released by | How it reaches the Mac today | How it changes today |
| --- | --- | --- | --- |
| Boundary (the signed `.app`) | Boundary | DMG from GitHub Releases | The user downloads a new DMG |
| The stack's tree (compose files, patches, `setup.sh`) | sovereign-agent-stack tags | Source zip of a pinned commit, unpacked into `userData/assistant-stack/project` | A new Boundary build changes `SOVEREIGN_AGENT_STACK_REF` |
| The stack's images | Upstream projects (Hermes, Hermes WebUI, n8n, Neo4j, Postgres) by tag; the rest built locally by `up --build` | Pulled or built on first start | `syncStackImagePins` copies tags from the new tree's `.env.example` |
| The container engine | Podman and Compose releases, pinned in `scripts/fetch-container-runtime.sh` | Bundled in the app; the Podman machine's OS image is downloaded by `podman machine init` | Binaries change with the app; the machine's OS never changes |

Boundary already has a careful stack upgrade path; it only runs when a new Boundary build moves the pin. `ensureSovereignProjectProvisioned` (`src/main/services/assistant/provisionSovereignStack.ts`) downloads the archive into a staging directory, checks its SHA-256, stops the containers, copies four data directories to `assistant-stack/backups/` with APFS clones, swaps the tree under a journal (`projectTreeSwap.ts`) that survives a crash, keeps the old tree as `project.previous`, and re-runs `setup.sh`. Nothing checks for a new stack release at runtime, and Boundary cannot update itself: there is no `autoUpdater`, no Forge publisher and no update feed. The release workflow uploads a ZIP described as the "auto-update companion", but nothing reads it.

## What is different about Boundary

**Stack updates are tied to Boundary's code more than a version number suggests.** Boundary's overlay (`resources/assistant/docker-compose.boundary.yml`) names the stack's services and container paths. A gateway contract generated from one Hermes version is vendored in `src/main/services/assistant/hermes/vendor/`. Boundary writes Hermes profile configs, `.env` keys and WebUI settings into the stack's tree, and `PRESERVED_PROJECT_PATHS` has to match the stack's `.gitignore`. The stack's semver does not cover these: v0.3.3 was a patch tag and moved Hermes to v0.22, which migrates Hermes state one way. A stack release is safe for a given Boundary only once someone has run that pair.

**The stack's lifetime is the app's lifetime.** Quit runs `compose down`, and launch runs `compose up`. A stack update therefore costs no extra downtime if it is applied during a launch, and an app update and a stack update can share one restart. Updating the stack while Boundary keeps running would be a new kind of interruption that Boundary does not have today.

**The stack holds state that only migrates forward.** Hermes, n8n and the Postgres services migrate their own data on start. Rolling back means restoring the data copy taken before the update, not running old code on migrated data. The current backup leaves out `data/db`, the shared Postgres cluster, and it keeps only the copy from the most recent update.

**An update can interrupt work the user didn't start.** Agent turns, kanban tasks, coding jobs and n8n workflows run in the stack. A restart prompted by an update must check for running work first. Boundary can see active Hermes sessions and kanban tasks. It cannot see n8n executions.

**Updates are large and slow, mostly because of images.** The stack tree is a few megabytes. The images are gigabytes, and `up --build` builds several of them (llm-proxy, the OpenCode images, caldav-mcp, the Hermes worker) on the user's Mac. Downloading and building can happen while the old stack is still running, because pulling and building do not touch running containers. Only the swap needs the stack stopped.

**Sovereignty constrains how checks work.** The product promise is that the user's machine and data stay theirs. An update check should reveal no more than a static file fetch does (IP address and user agent to GitHub). The check sends no install ID, and nothing reports back after an update. The user can turn checks off, stay on a version, and see what changes before applying it. Boundary keeps working with no network and with an unreachable update feed.

**The fuses rule out hot code updates.** `EmbeddedAsarIntegrityValidation` and `OnlyLoadAppFromAsar` are on, so Boundary can only run code from a signed bundle. Every Boundary update is a full, signed app bundle. Pushing renderer JavaScript without a new bundle would bypass code signing and the asar integrity check, so it is out.

**The signing identity has to stay fixed.** `safeStorage` encrypts secrets with a Keychain key that macOS ties to the app's code signature. An update signed by a different team or with a different bundle ID loses access to every stored secret. Squirrel.Mac also refuses an update whose signature does not satisfy the running app's designated requirement, so a changed identity would also stop updates.

**The code is public, and anyone can build it.** A fork must not receive Boundary's updates or trust Boundary's signing key by accident. The feed URL and the public keys are build-time settings, and builds without them have updates turned off.

## Decisions

Decisions 1 to 3, 5, 8 and 10, and the rollback half of 7, arrive after 0.0.1.

### 1. One signed channel file describes every release

Boundary publishes one JSON file per channel (`stable`, `beta`), modelled on Home Assistant's `home-assistant/version` files. It names the current app version, every stack release Boundary has tested, and which app versions each stack release works with. Boundary reads only this file to decide what to offer.

```json
{
  "schema": 1,
  "channel": "stable",
  "serial": 42,
  "issued": "2026-10-26T18:00:00Z",
  "expires": "2026-12-25T18:00:00Z",
  "app": {
    "version": "0.2.0",
    "summary": ["Chats remember which project they belong to after a restart."],
    "notes": "https://github.com/BoundaryApp/boundary-desktop/releases/tag/v0.2.0",
    "rollout": 25,
    "minimumSupported": "0.1.0",
    "blocked": ["0.1.3"],
    "feeds": {
      "darwin-arm64": "https://…/darwin/arm64/RELEASES.json",
      "darwin-x64": "https://…/darwin/x64/RELEASES.json"
    }
  },
  "stack": [
    {
      "version": "v0.3.5",
      "ref": "<commit sha>",
      "archive": { "url": "https://…/sovereign-agent-stack-v0.3.5.tar.gz", "sha256": "<hex>" },
      "app": ">=0.2.0 <0.4.0",
      "upgradeFrom": ">=v0.3.0",
      "kind": "patch",
      "rollout": 100,
      "summary": ["Research reports cite their sources inline."],
      "notes": "https://github.com/kaxline/sovereign-agent-stack/blob/v0.3.5/CHANGELOG.md",
      "backup": ["hermes", "n8n", "rag_storage", "neo4j", "db"]
    }
  ]
}
```

`stable.json.minisig` sits next to it, an Ed25519 signature in minisign format. Boundary embeds two public keys so the signing key can rotate. Boundary rejects the file if:

- the signature does not verify against either embedded key;
- `serial` is lower than the last serial it accepted, which stops a replay of an older file;
- `expires` has passed.

When the file is rejected or can't be fetched, Boundary offers nothing and keeps running what it has. HTTPS and a GitHub account are not enough on their own. With the signing key held outside the workflow that builds releases, a compromised workflow or account cannot ship to users.

The constants in `src/shared/assistantStackConstants.ts` remain as the stack version that ships with each build. First run uses them when the channel file is unreachable, and any launch falls back to them when no channel file has ever verified.

`summary` holds the release notes users read: a few plain-language lines a maintainer writes when adding the entry. The stack's CHANGELOG is written for people running the stack by hand, so `notes` links to it as technical detail and Boundary never shows it as the summary.

`rollout` is a percentage. On first launch Boundary picks a random number from 0 to 99, stores it and never sends it anywhere. A release is offered when that number is below `rollout`. Raising `rollout` widens a release, and setting it to 0 halts one. `blocked` app versions are told to update even outside the rollout. `minimumSupported` is for security fixes: below it, Boundary shows a persistent prompt to update. It never updates without the user's agreement.

### 2. Boundary certifies stack releases

A stack tag reaches users only after a Boundary maintainer adds it to a channel file. Adding it means running the new stack with the current Boundary build: a first install, an upgrade from the previous stack version with real data in it, and the chat, kanban and project smoke checks. The stack keeps its own release process. Boundary decides when users get a release, the same way it does today with the pin, but without having to ship a new app build.

A stack release that needs Boundary code changes, such as a renamed service, a new mount in the overlay or a gateway contract change, goes out with a new app version. Its `app` range starts at that version.

### 3. The control plane updates first, with one version of skew

Boundary is never older than the stack it runs. Boundary picks a stack release in this order:

1. Take the newest `stack` entry whose `app` range includes the running app version (or the app version Squirrel has already downloaded, see below), whose `upgradeFrom` includes the installed stack version, and whose `rollout` includes this install.
2. If a newer entry exists that needs a newer app, Boundary offers the app update first and says it brings new tools.
3. If the installed stack is outside every `upgradeFrom` range, Boundary steps through intermediate releases. Each step is its own backup and swap, and the user sees one update.

When the app update has finished downloading, Boundary picks the stack release for the downloaded version, not the running one, so both install in one restart. The running app stages only what does not depend on its own code: it downloads and checks the archive and pulls the images the stack's own compose files name, without Boundary's overlay. The new app builds local images and applies the update on its first launch.

Each app version supports the stack version it was certified with and the one before it. That way, a failed stack update can roll back to the previous stack under the new app. An app downgrade can then run on the stack it left behind.

### 4. Boundary updates itself with Squirrel.Mac and a static feed

Electron's built-in `autoUpdater` on macOS uses Squirrel.Mac with `serverType: 'json'`. `update.electronjs.org` is ruled out because it has no channels, and electron-updater because it belongs to electron-builder and has no documented Forge integration.

`checkForUpdates()` downloads as soon as it finds an update, so it can't serve as the check behind the first prompt. Boundary fetches the feed itself, compares `updateTo.version` with its own version by semver, and calls `checkForUpdates()` only after the user chooses **Download** (or, once phase 5 ships, after the channel file verifies and the rollout includes this install).

**Feed.** One file per channel and architecture, read without credentials:

```json
{
  "currentRelease": "0.0.1-rc.10",
  "releases": [
    {
      "version": "0.0.1-rc.10",
      "updateTo": {
        "name": "Boundary 0.0.1-rc.10",
        "version": "0.0.1-rc.10",
        "pub_date": "2026-11-02T18:00:00Z",
        "url": "https://github.com/BoundaryApp/boundary-desktop/releases/download/v0.0.1-rc.10/Boundary-darwin-arm64-0.0.1-rc.10.zip",
        "sha256": "<hex>",
        "size": 324000000,
        "notes": "Plain-language lines shown in the card, one per line.",
        "stackVersion": "v0.3.7"
      }
    }
  ]
}
```

Squirrel discards a download that doesn't match `sha256`.

**Hosting.** Feeds are assets on one fixed prerelease, `update-feed`, in the public repository: `beta-darwin-arm64.json` and `stable-darwin-arm64.json`. Zips stay on their tagged releases. `/releases/latest/download` won't work, because GitHub leaves prereleases out of it. Forge's `macUpdateManifestBaseUrl` won't work either, because it fetches the manifest during `make` and writes the zip's URL under the manifest's base. A step in the release workflow writes the feed instead. Replacing an asset can leave a short gap where the feed returns 404, which Boundary treats as an unreachable feed.

The feed's base URL is the build setting `BOUNDARY_UPDATE_FEED_URL`. Builds without it have updates off. Only `darwin-arm64` is built today, so other architectures get no updates.

A build of Boundary for a private group can set `BOUNDARY_UPDATE_KEY_REQUIRED=1`. **Updates** then asks for a personal key, stored with `safeStorage` and sent as a bearer token on feed requests, so its checks identify the person. Squirrel sends no custom headers with the zip request, so such a feed must give each client a URL that needs no credentials. Public builds send no key. `BOUNDARY_APP_ID`, `BOUNDARY_APP_NAME` and `BOUNDARY_INSTANCE` give a build its own identity, so it installs beside Boundary with separate data, logs, Podman machine and Compose project. `BOUNDARY_APP_ICON` sets its icon.

**Release candidates to their final version.** In JSON mode Squirrel doesn't use semver. It compares the running version with `currentRelease` using `NSNumericSearch`, and skips the update when the running version sorts later. That ordering puts `0.0.1-rc.9` after `0.0.1`, so an RC refuses its own final release. RC to RC works, and so does a final release to the next RC. The beta feed carries a final release under a label that sorts higher, while `updateTo` names the real version:

```json
{
  "currentRelease": "0.0.1-rc.999999",
  "releases": [
    {
      "version": "0.0.1-rc.999999",
      "updateTo": { "version": "0.0.1", "url": "https://…/Boundary-darwin-arm64-0.0.1.zip", "...": "..." }
    }
  ]
}
```

After that update Squirrel alone would offer the same release again. Boundary's check reads `updateTo.version`, sees nothing newer, and never calls `checkForUpdates()`. The stable feed needs no label, because no one on stable runs an RC. Step 0 of [Testing before 0.0.1](#testing-before-001) proves this, and if it fails, RC testers install the final release from the DMG.

**Restart.** `quitAndInstall()` closes windows before `before-quit` fires, so the quit screen and `runQuitTeardown()` in `src/main/index.ts` would not run first. **Restart to update** shows the quit screen, runs the teardown, sets the flag that lets `before-quit` pass, and then calls `quitAndInstall()`. That call waits for every window to close, so the window stops holding itself open for the quit screen at that point. If Squirrel hasn't taken over after 30 seconds, Boundary exits, and the update installs then. Choosing **Quit** with a downloaded update keeps the normal path, which ends in `app.exit(0)`. Step 0 checks that the update still installs that way.

Squirrel.Mac cannot update an app that runs from the DMG or from a translocated path. On first run Boundary checks `app.isInApplicationsFolder()` and offers `app.moveToApplicationsFolder()`.

The release workflow also adds a build provenance attestation (`actions/attest-build-provenance`), so anyone can check a download with `gh attestation verify`. The app does not check attestations at runtime. Code signing and the channel file already cover integrity there.

Windows and Linux are out of scope while the bundled engine is macOS-only. When they come: MSIX (Forge v8 replaces the AppX maker with `@electron-forge/maker-msix`) and Azure Artifact Signing on Windows, and the distribution's package manager on Linux.

### 5. Stack updates download in the background and apply on the next launch

A stack update has two parts. Staging runs while the stack is up. The apply step runs on launch.

**Staging**, once the user has agreed to the update, or automatically if they turned on automatic updates:

1. Download the archive, check its SHA-256 against the channel file, and unpack it into `assistant-stack/staging/<ref>`. `ensureSovereignProjectProvisioned` already does this; it moves out of the launch path.
2. Pull the new tree's images with `compose pull` against the staged tree, using the running stack's project name and environment. Running containers are not touched.
3. Build the locally built images from the staged tree, tagged with the new ref so they do not replace the running stack's `:local` tags. This needs the stack to accept an image tag variable (0013 R6). Until then, building stays in the apply step, as today.
4. Write `staged.json` with the ref, the image digests pulled, and when staging finished. The Updates page shows the update as ready.

If a staged release disappears from the channel file, or its `rollout` drops to 0, before it is applied, Boundary deletes the staged tree and its `staged.json`. A withdrawn release is never installed.

**Applying**, at the next launch, when `staged.json` names a ref newer than the installed one and staging finished. Boundary never starts an unfinished staging during launch; it starts the installed version and resumes staging in the background:

1. The start-up screen shows an **Updating your tools** stage (ADR 0029 decision 5 copy style).
2. Back up every directory in the entry's `backup` list, including `db` (decision 7).
3. Check the current tree for local changes (decision 8).
4. Swap the trees with the existing journal, re-run `setup.sh`, run `syncStackImagePins`, and run `compose up`. Because the stack is already down after quit, no stop is needed.
5. Health gate: Hermes `/health` within the existing 300-second limit. Then the gateway handshake, then `gateway.capabilities` naming the expected stack version (0013 R3).
6. On a pass, record the new version as installed and start the backup's retention clock. On a failure, roll back automatically (decision 7) and record the version as failed. Boundary does not offer that version again until a newer one comes out or the user retries from the Updates page.

Applying on launch keeps the update inside the downtime the user already has. It also means an app update and a stack update can apply in one restart: Squirrel replaces the bundle on quit, and the new app applies the staged stack as it starts.

The user can also choose **Update now** from the Updates page. That runs the running-work check, stops the stack, applies the update and starts the stack again, without quitting Boundary.

### 6. Check for running work before a restart

Before **Restart to update**, **Update now** or a `minimumSupported` prompt restarts anything, Boundary looks for active Hermes sessions (`session.active_list`, or heartbeats where the stack has 0004), kanban tasks in a running state, and coding agent jobs. If any are running, the prompt names them and offers to wait until they finish or to restart anyway. A restart that waited counts down 30 seconds after the last task, with **Restart now** and **Not now**. A normal quit doesn't change: it stops the stack as it does today. n8n executions are not visible to Boundary yet (see open questions).

### 7. Back up before every stack update, and roll back the pair

The backup in `stackDataBackup.ts` gains `db` in the first release. The containers are stopped and Postgres shut down cleanly, so an APFS clone of the cluster directory is consistent. 0013 R7 asks the stack to confirm this or provide a dump hook. The `backup` list comes from the channel entry, so a release that adds stateful data can extend it without an app update. Boundary keeps the backup and `project.previous` for 14 days after a healthy update, or until the next update, whichever is later. Resources shows how much space they hold.

Rolling back restores both halves: the previous tree and the data copy, and with them the previous image pins. Data written after the update is lost. An automatic rollback after a failed health gate loses nothing, because the new stack never became healthy. A manual rollback from the Updates page says what will be lost before it runs, and marks the version skipped, so automatic updates do not reinstall it on the next launch. Images built locally for the previous ref are kept until the backup is pruned, so a rollback needs no rebuild once phase 8's ref-tagged builds exist.

Squirrel.Mac never installs an older app. A user can install an older DMG by hand. To make that safe, Boundary writes the highest app version that has opened its data (`dataVersion` in the main store). An app older than its data version shows a start-up error that names the version it needs, rather than running against stores it does not understand.

### 8. Local changes to the stack tree are kept, not overwritten

Advanced users edit stack files. Right after unpacking a release, Boundary records a SHA-256 for every file in the tree in `.provision.json`. Before a swap, it compares the tree against that list. Changed or added files that are not preserved paths or files Boundary writes itself are copied to `assistant-stack/backups/local-changes-<ref>`. The update summary lists them. This needs nothing from the stack. In the longer term, the stack's release metadata (0013 R2) supplies the preserved paths instead of Boundary's hard-coded `PRESERVED_PROJECT_PATHS`.

### 9. Boundary's own data migrates forward with a version

Boundary's stores need the same discipline when the app updates. Each electron-store file gets a `schemaVersion` and uses electron-store's `migrations` option. Today only `openai-onboarding` has a version, and no store has migrations. Packaged builds replace the ad-hoc `ALTER TABLE` statements in `src/main/db/connection.ts` with numbered migrations shipped in the app and recorded in a migrations table. Migrations run before any window loads, and a failed migration stops start-up with an error rather than continuing on half-migrated data.

### 10. The bundled engine follows the app

The Podman binaries change only with an app update. When an update changes the bundled Podman's major or minor version, the first launch after it runs `podman machine os upgrade` on the `boundary` machine before starting the stack. That command moves the machine's OS to the client's major.minor, and refuses a downgrade. It appears as its own start-up stage. Docker Desktop users update their own engine. The channel file can name a minimum Docker Engine and Compose version, and Boundary shows a warning when the running engine is older.

### 11. The user stays in control

Settings gets an **Updates** page:

- the running versions of Boundary, the stack, and the engine;
- the channel (Stable or Beta);
- **Update automatically** (off by default), which downloads in the background and installs at the next start, and **Check now**;
- skipping a version;
- going back to the previous stack while its backup exists, from phase 6.

Asking first is the default because nothing leaves or lands on the user's Mac without their say-so, and stack updates can run to gigabytes. **Update automatically** ships with phase 5, once the health gate and automatic rollback exist. Turning checks off stops the fetch entirely. Boundary never applies an update without either the user's agreement or a launch they started.

A fresh install picks its channel from its own version: a prerelease version starts on Beta, any other on Stable. The choice is stored, so it survives updates, and a tester stays on Beta after moving to a final release until they change it.

Local stack mode (`BOUNDARY_LOCAL_STACK=1`) and a `BOUNDARY_ASSISTANT_ROOT` override turn stack updates off. They still read the attached stack's version (0013 R3) and warn when it is outside the running app's range.

## Release flow

Every Boundary release is built once. Promotion changes which feed names it and never rebuilds it, so the bundle that was tested is the bundle that ships.

1. A version bump on the public repository's `main` builds, signs and notarizes the app. The workflow publishes the DMG and ZIP as a GitHub prerelease, attests them and writes the beta feed. This holds for final versions as well as RCs.
2. Testers on Beta are offered it. A final version on the beta feed uses the label from decision 4.
3. **Promote to stable**, a manual workflow that takes a version, marks the release as Latest and non-prerelease, and writes the stable feed from the assets already on that release.

A bad release can be taken out of a feed, but Squirrel never installs an older app, so anyone who has it needs a newer one. From phase 5 the channel file adds rollout percentages and blocked versions.

## Testing before 0.0.1

Each step must pass before the next. Step 0 uses no public release. Version numbers assume rc.8 is still the newest public release.

| Step | Build | What it proves |
| --- | --- | --- |
| 0 Local rehearsal | Three local builds signed with the Developer ID certificate, not notarized: `0.0.1-rc.900`, `0.0.1-rc.901` and `0.0.1`. `BOUNDARY_UPDATE_FEED_URL` points at a static server on `127.0.0.1` | Squirrel accepts the feed. Both restart paths work. The label moves `rc.901` to `0.0.1`, and `0.0.1` isn't offered it again. The failure cases below |
| 1 rc.9 | First public build with the updater and the feed setting. Installed from the DMG, because rc.8 and earlier can't update themselves | The release workflow's feed step, and a real install from a notarized DMG |
| 2 rc.10 | A small visible change | The whole flow from the card to the restart, over GitHub, on a Mac with a running stack and real work in progress |
| 3 rc.11 | Moves `SOVEREIGN_AGENT_STACK_REF` to the next stack tag | An app update moves the stack on first launch, and the backup includes `db` |
| 4 0.0.1 candidate | Final version, published as a prerelease and on the beta feed only. It isn't Latest, and nobody on Stable sees it | The labelled feed over GitHub, and that the signed, notarized 0.0.1 bundle runs |
| 5 0.0.2-rc.1 | Version bump only, on the beta feed | The 0.0.1 bundle can update itself. A Mac on 0.0.1 still has Beta stored, so it gets this build. Without this step, the first proof would be a real release |
| 6 Promote 0.0.1 | **Promote to stable** on the bundle from step 4 | A fresh DMG on a clean Mac starts on Stable, finds nothing newer, and never sees 0.0.2-rc.1 |

Steps 0 and 2 also cover these cases. In each, Boundary keeps running the version it has.

| Case | Expected |
| --- | --- |
| Offline, or the feed returns 404 | No card; the **Updates** page says it couldn't check |
| Zip doesn't match `sha256` | Squirrel discards it; the card reopens with **Try again** |
| Update signed with an Apple Development certificate | Squirrel refuses it; the running app is unaffected |
| Running from the DMG | No download offered; the page offers **Move to Applications** |
| Work running at **Restart to update** | The running-work prompt names it |
| **Later**, then quit | Nothing installs, the card doesn't reopen for that version, and the rail button stays |
| Downloaded, then **Quit** | The update installs, and the next launch runs the new version |
| Skipped version | No button or card for it; a newer version gets them |

## Failure handling

| What fails | What Boundary does |
| --- | --- |
| Feed or channel file unreachable, signature bad, serial older, or expired | Offers nothing, keeps running the installed versions, and notes it in the debug log. The Updates page says when it last checked successfully. |
| App update download or signature check | Squirrel reports an error; the Updates page shows it with **Try again**. The running app is unaffected. |
| Archive download or SHA-256 mismatch | Staging stops and deletes the staged tree. Nothing installed changes. |
| Image pull or build during staging | Staging stops, the update stays available, and **Try again** restarts from the failed step. |
| Disk space below what staging needs | Staging doesn't start; the page says how much space is needed. |
| Health gate after applying | Automatic rollback to the previous tree and data, then a normal start. The version is marked failed and the start-up screen says the update was undone. |
| Crash or power loss mid-swap | The existing `.upgrade.json` journal finishes or reverses the swap on the next launch. |
| Rollback itself fails | The start-up error screen keeps the backup path and the debug log under **Show details**. Boundary never deletes a backup it could not restore. |

## Open questions

- **Certification runs.** GitHub's macOS runners may not run a Podman machine, which needs nested virtualization. Certification may need a self-hosted Mac or a Linux runner with Docker, which would leave the bundled engine untested.
- **Signing key custody.** Who holds the channel signing key, and how is the second key stored for rotation?
- **Automatic patch releases.** Once **Update automatically** exists, should stack patch releases apply without asking, or should every stack update ask once?
- **n8n executions.** Boundary cannot see running n8n workflows. Is n8n's REST API reachable from Boundary with the stack's credentials, or should the stack expose a count?
- **Security fixes with checks off.** With checks off, `minimumSupported` and `blocked` never reach the user. Boundary could still fetch the channel file for those two fields alone.
- **Long launches before 0013 R6.** Until locally built images can be built during staging, the first launch after a stack update builds them, which can take minutes. The start-up screen could offer **Start without updating** before the swap begins.
