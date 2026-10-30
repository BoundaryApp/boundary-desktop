# Updates UX study

How a Boundary user meets updates to the app and to their tools: where each update shows up, what it says, and what the user can do about it. The backend design is the [updates plan](../updates-plan.md). This study is the user-facing half, and it flags the parts of the plan that would make a poor experience.

- `index.html` is a click-through of the main scenarios: the update-available notice, the quiet indicator, the **Updates** page in its main states, the restart prompt with running work, the start-up screen while it updates, an automatic rollback, going back by hand, **Update Boundary first**, a required update, an older app on newer data, and quitting with an update waiting. It loads the live tokens (`src/renderer/styles/tokens.css`), the start-up screen's stylesheet and the workbench stylesheet, so it uses the shipped classes wherever they exist.

Serve the repo root over HTTP to view, e.g. `python3 -m http.server` then open `/docs/updates-ux-study/`.

Builds on [ADR 0029](../adr/0029-full-window-startup-screen.md) (start-up screen, quit screen, start-up notification), [ADR 0018](../adr/0018-design-tokens-and-primitives.md) (tokens and primitives) and [ADR 0003](../adr/0003-workbench-chrome.md) (icon rail).

## Who meets an update

**Someone who installed Boundary and never opens Settings.** They want a private assistant, not a system to maintain. Boundary asks once before downloading an update. After that, an update should need one click and a restart, with one line afterwards saying what changed. If an update fails, they need to hear that nothing was lost and that they don't have to do anything. They will never read a CHANGELOG, and they won't know what "the stack" is; the product calls it "your tools", as the start-up screen does.

**A power user who edits files in their tools.** They changed a SearXNG setting or added a script to the stack's tree, they may run the beta channel, and some of them attach Boundary to their own checkout in local stack mode. They want to see versions, read the technical notes, choose when an update installs, skip one that looks risky and go back when one breaks something. Above all they need to know before an update touches files they changed, and where their versions went afterwards.

**Someone halfway through a long agent task.** A research report has been running for twenty minutes, two board tasks are in progress and a coding job is editing a project. An update that restarts the tools now costs them that work. They should never be asked to restart without seeing what is running, and the default answer should be to wait.

The same person can be all three on different days, so the design can't sort users into modes. It has to keep quiet by default, put everything on one page for whoever goes looking, and stop to ask only when an action would cost the user something.

## How loud an update gets

Updates are Boundary's business. The user opened Boundary to talk to their assistant, and an update is never the reason they are there. Each surface below is louder than the one before, and each scenario uses the quietest surface that still works.

| Level | Surface | Used for |
| --- | --- | --- |
| 0 | Nothing | Checking, staging, and every failure to check or download |
| 1 | Settings → **Updates** | Versions, what's ready, what failed, preferences, going back |
| 2 | Quiet indicator: a dot on the Settings rail icon and the **Updates** tab, and the Boundary menu's **Restart to Update…** | An update is ready to install, or available when automatic updates are off |
| 3 | A notice in the workbench, shown once | An update is available, is downloading or is ready to install; an update finished installing |
| 4 | A notice that stays until closed, or a banner that returns each launch | An update was undone, files the user changed were set aside, a required or withdrawn version |
| 5 | Start-up screen stages and start-up errors | Installing on launch, undoing, an app too old for its data |
| 6 | A dialog | Only to confirm something the user started: restarting with work running, going back. Plus the one-time **Move to Applications** prompt. |

Nothing about an update becomes a system notification. The only notification is the one ADR 0029 decision 11 already sends when a start of 15 seconds or more finishes while Boundary is in the background, and an update launch is such a start. This study adds copy for the case where that start undid an update.

The indicator shows once per update. It is a static dot, not the pulsing **WorkingDot** the Chat icon uses for running agents, so "something is running" and "something is waiting for you" never look alike. Opening the **Updates** page clears it, whether or not the user installs anything. A badge that stays until the user complies teaches people to stop seeing badges, and the update installs on the next quit or launch anyway. The one exception is a required update, whose dot uses the warning colour and stays until it is installed.

No update gets a dialog of its own. A dialog takes the window from whatever the user was doing, and the only update that justifies that is one the user cannot keep running without, which is the older-app-on-newer-data case. That one happens before the workbench exists, so it is a start-up error rather than a dialog.

## Words

The product says **Boundary** for the app and **your tools** for the stack, as the start-up screen does. The Podman machine or Docker Desktop is **the container engine**, as in `startupErrors.ts`. Versions appear without the stack's `v` prefix, so both read the same: Boundary 0.3.0, your tools 0.3.5. **Update** is the noun and the verb throughout; the copy doesn't switch between "upgrade", "release" and "version" for the same thing. "Install" means the step that changes what runs, "download" means the step before it. "Go back" is the manual rollback. "Undo" is only used for the automatic one, because to the user it undoes something that happened to them.

Examples below use Boundary 0.2.0 moving to 0.3.0, and your tools moving from 0.3.4 to 0.3.5. Dates are examples too.

## Scenarios

Each scenario gives the trigger, where it surfaces, the exact copy and what the user can do. Copy follows `startupErrors.ts`: a headline that says what happened in the user's terms, then one or two sentences on what it means and what to do. Product copy uses typographic apostrophes, as the shipped strings do.

### The Updates page

Every scenario lands here, so it comes first. **Updates** is a new tab at the end of Settings' tab row, after **Computer access**. It uses the existing Settings rows (`wb-settings-row`) and banners (`wb-inference-banner`).

From top to bottom:

1. A banner, only when something needs the user's attention: an update ready, an update undone, a restart waiting for work to finish, Boundary first. With nothing to say, there is no banner.
2. **Versions**: one row each for Boundary, your tools and the container engine. Each shows the running version and, when there is one, the next version and its state.
3. **What's new**, when an update is ready or was installed in the last 14 days: the plain-language summary for each version (see [Release notes](#release-notes)) and a **Technical notes** link.
4. **Preferences**: **Update automatically**, **Release channel**, **Check for updates**, and a line saying when Boundary last checked, with **Check now**.
5. **Go back**, while the copy from before the last update of your tools exists.

| Element | Copy |
| --- | --- |
| Boundary row | **Boundary** · "0.2.0" |
| Your tools row | **Your tools** · "0.3.4" |
| Engine row, bundled | **Container engine** · "Podman 5.6, comes with Boundary" |
| Engine row, Docker Desktop | **Container engine** · "Docker Desktop 4.41. You update it yourself." |
| **Update automatically** hint | "Boundary downloads updates in the background and installs them the next time it starts. It never restarts by itself." |
| **Release channel** hint | "Beta gets new versions first. They pass the same tests, but fewer people have used them." |
| **Check for updates** hint | "Boundary downloads one signed file from GitHub. It sends no ID and nothing about how you use it." |
| Last check | "Last checked 2 hours ago." |
| Check now, running | "Checking…" |
| Check now, nothing new | "Boundary and your tools are up to date." |

### Update ready, both parts

**Trigger.** With automatic updates on, Squirrel finished downloading Boundary 0.3.0 and staging finished for your tools 0.3.5.
**Surface.** The quiet indicator (level 2). The Boundary menu's **Check for Updates…** becomes **Restart to Update…**. The Settings rail icon's tooltip reads "Settings · Update ready". On the **Updates** page, a banner.
**Copy.**

| Element | Copy |
| --- | --- |
| Banner title | "Updates are ready" |
| Banner body | "Boundary 0.3.0 and an update to your tools have downloaded. Both install the next time Boundary starts, or now if you restart." |
| Boundary row | "0.2.0 · 0.3.0 is ready to install" |
| Your tools row | "0.3.4 · 0.3.5 is ready to install" |

**The user can** press **Restart to update**, read **What's new**, **Skip this version** on the tools row, or do nothing. Doing nothing is fine: quitting installs the app, and the next launch installs both.

Only the app part ready: "Boundary 0.3.0 is ready" / "It installs when you quit Boundary, or now if you restart." Only the tools part ready: "An update to your tools is ready" / "It installs the next time Boundary starts. **Update now** installs it without quitting; your tools stop while it does." with **Update now** in place of **Restart to update**.

### Downloading

**Trigger.** Staging is pulling images, or Squirrel is downloading. **Surface.** The notice from [Update available](#update-available) if it's still open, and the **Updates** page.

| Element | Copy |
| --- | --- |
| Your tools row | "0.3.4 · Downloading 0.3.5 · 640 MB so far" |
| Boundary row | "0.2.0 · Downloading 0.3.0" |

Compose reports a layer's size only when the layer starts (ADR 0029 decision 12), so there is no total and no time estimate. The user can wait or skip the version.

### Update available

**Trigger.** A check found a version the user hasn't skipped. This is the default path: **Update automatically** is off until the user turns it on. **Surface.** A notice in the workbench (level 3), once per version, and the quiet indicator. It doesn't take focus or block the chat.

| Stage | Notice | Actions |
| --- | --- | --- |
| Available | "Boundary 0.3.0 is available." and the release's first summary line | **Download**, **Later** |
| Downloading | "Downloading Boundary 0.3.0." | None. Squirrel gives no progress and no cancel, so the notice can be closed and the download carries on |
| Ready | "Boundary 0.3.0 is ready to install." | **Restart to install**, **Later** |

**Later** closes the notice. Boundary doesn't show it again for that version, and the **Updates** page still offers the update. A later version gets its own notice. The page:

| Element | Copy |
| --- | --- |
| Your tools row | "0.3.4 · 0.3.5 is available" with **Download** and **Skip this version** |
| Boundary row | "0.2.0 · 0.3.0 is available" with **Download** |

After **Download** the rows go through the downloading and ready states above. Nothing installs until the user restarts, uses **Update now**, or quits and relaunches.

### Boundary stays open for days

**Trigger.** An update became ready and the user hasn't quit Boundary since. Laptops sleep instead of quitting, so this is the common case, not the edge. **Surface.** The dot, once. No escalation. Chrome-style badges that change colour with age train people to ignore badges, and this update has no deadline: the user's tools keep working on the version they have. The only updates with a deadline are required ones, which have their own scenario.

When the user does quit, the quit screen (ADR 0029 decision 16) says what happens next, so the next launch isn't a surprise:

| Waiting | Quit screen line |
| --- | --- |
| Boundary | "Stopping your tools. Boundary installs its update and closes." |
| Your tools | "Stopping your tools. They update the next time Boundary starts." |
| Both | "Stopping your tools. Boundary installs its update and closes, and your tools update when it next starts." |

### Restart with work running

**Trigger.** The user pressed **Restart to update** or **Update now**, or chose to update from a required-update banner, while agent turns, board tasks or coding jobs are running (plan decision 6). With nothing running, there is no prompt: the user pressed a button that says it restarts.
**Surface.** A dialog (level 6), because the user started it and going ahead costs them work.

| Element | Copy |
| --- | --- |
| Kicker | "Restart to update" (or "Update your tools") |
| Title | "Some work is still running" |
| Lede | "Restarting stops it where it is. Boundary can wait and restart as soon as it finishes." |
| Rows | Each item by the name the user knows it by: the chat's title and "Your assistant is replying"; the task's title and "Board task, running for 12 min"; the job's title and "Coding job in ~/code/site" |
| Footnote | "Boundary can’t see whether an automation is running. A restart stops any that are." |
| Buttons | **Restart when finished** (primary), **Restart now**, **Cancel** |

**Restart when finished** returns the user to where they were and puts a banner on the **Updates** page: "Boundary restarts when 3 tasks finish" / "It installs the update as soon as they’re done." with **Restart now** and **Cancel restart**. The rail tooltip reads "Settings · Restarts when work finishes". Work started after this point is not counted. If it were, a busy board would postpone the restart forever.

### Installing on launch

**Trigger.** A launch with a staged update (plan decision 5), or **Update now**. **Surface.** The start-up screen (level 5). It is the same screen and ring as every launch. The tiles start dark, because quit stopped the containers, and light up as the new versions start. The headline changes and the stages gain two steps:

| Stage | Line under the headline |
| --- | --- |
| Headline | "Updating your tools" |
| Backup | "Saving a copy of your data first" |
| Swap and `setup.sh` | "Installing the new version" |
| Local builds (until 0013 R6) | "Building some tools on this Mac" |
| Compose | "Starting your tools" |
| Health gate | "Making sure everything works" |
| Ready headline | "Your tools are up to date" |
| Ready line | "Now on 0.3.5." |
| Several versions in one update | Hint: "This update installs 0.3.5, then 0.3.6." |

Story cards (ADR 0029 decision 6) show the update's summary lines instead of tool benefits, with the tile each line is about highlighted. On an ordinary launch the story only appears after six seconds; on an update launch it appears at once, because the wait is longer and the cards answer the question the user has: what is this?

After the workbench appears, a notice shows once in the corner of the window (level 3): "Your tools were updated to 0.3.5." with **See what changed**, which opens the **Updates** page. After an app update it reads "Boundary is now 0.3.0." and after both, "Boundary is now 0.3.0, and your tools are on 0.3.5." The notice closes after ten seconds, or when clicked. Boundary has no toast primitive yet, so this needs one.

### After a Boundary update: the container engine

**Trigger.** The first launch after an app update that changes the bundled Podman's major or minor version (plan decision 10). **Surface.** A start-up stage before the stack starts.

| Element | Copy |
| --- | --- |
| Headline | "Finishing the update" |
| Line | "Updating the container engine" |
| Hint | "This runs once after this update." |
| Error title | "Couldn’t update the container engine" |
| Error body | "Your tools run in the container engine, so they can’t start until it’s updated. Try again, and if it fails the same way, the details show what happened." |

With Docker Desktop older than the channel file's minimum, the engine row on the **Updates** page warns: "Your tools need Docker Engine 27 or later, and this Mac has 26.1. Update Docker Desktop to keep them working." Nothing else surfaces it.

### Files the user changed

**Trigger.** The tree has changed or added files that aren't preserved paths (plan decision 8). **Surface.** Before the update, on the **Updates** page. After it, a notice that stays until closed (level 4), because the user's files moved and they need to find them.

| Element | Copy |
| --- | --- |
| Before, under the tools row | "You changed 2 files in your tools. The update replaces them and keeps your versions in a separate folder." with **Show files** |
| After, notice | "Your tools were updated to 0.3.5. 2 files you changed were replaced, and your versions are in a separate folder." with **Show in Finder** |
| After, Updates page | "Your versions of 2 files are kept in a separate folder." with **Show in Finder** |

The power user sees the warning before anything happens and can skip the version. The person who never opens Settings never edits stack files, so they never see it.

### The update is undone automatically

**Trigger.** The health gate failed after installing; Boundary restored the previous tree and data and started again (plan decision 7). **Surface.** The start-up screen, then a notice that stays until closed, and the **Updates** page.

| Element | Copy |
| --- | --- |
| Start-up headline during the undo | "Undoing the update" |
| Line | "Your tools didn’t start after updating. Boundary is putting back 0.3.4 and your data as they were." |
| Ready line | "The update was undone. Your tools are on 0.3.4." |
| Notice in the workbench | "The update to your tools didn’t work, so Boundary undid it. Nothing you saved was lost." with **Details** |
| System notification, if Boundary is in the background | Title "Your assistant is ready", body "An update to your tools didn’t work and was undone." |
| Updates page banner title | "The update to your tools didn’t work" |
| Updates page banner body | "0.3.5 didn’t start on this Mac, so Boundary put back 0.3.4 and your data. Nothing you saved was lost. Boundary won’t install 0.3.5 again by itself." |
| Buttons | **Try again**, **Show details**, **Copy details** |

"Nothing you saved was lost" holds because the health gate runs before the workbench opens: the new version never served the user. The ready state on the start-up screen lasts 700ms (ADR 0029 decision 8), too short to read, so the workbench notice carries the message.

### Undoing fails

**Trigger.** The rollback itself failed. **Surface.** The start-up error screen. The backup path and log sit under **Show details**, and the backup is never deleted (plan, failure handling).

| Element | Copy |
| --- | --- |
| Title | "Couldn’t undo the update" |
| Body | "Your tools didn’t start after the update, and putting back the previous version didn’t work either. The copy of your data is kept and won’t be deleted. Try again, and if it fails the same way, the details show what happened and where the copy is." |
| Buttons | **Try again**, **Show details**, **Copy details** |

### Going back by hand

**Trigger.** The user presses **Go back…** in the **Go back** section, which shows while the backup exists. **Surface.** A dialog (level 6), then the running-work prompt if anything is running, then the start-up screen.

| Element | Copy |
| --- | --- |
| Section row | **Go back to 0.3.4** · "Puts back your tools and their data as they were on 26 Oct at 09:14, before the update. Available until 9 Nov." |
| Dialog title | "Go back to 0.3.4?" |
| Lede | "Your tools and their data return to how they were on 26 Oct at 09:14, just before the update." |
| What is lost | "Anything your tools saved after that is lost: chats and replies, what your assistant remembered, board tasks, and changes to automations." |
| What is kept | "Files in your project folders and Boundary’s own settings stay as they are." |
| After | "Boundary won’t install 0.3.5 again by itself." |
| Buttons | **Cancel**, **Go back and lose changes since 26 Oct** (destructive) |
| Start-up headline | "Going back to 0.3.4" |
| Start-up line | "Putting back your tools and your data from 26 Oct" |
| Ready headline | "Your tools are back on 0.3.4" |

The destructive button names its cost, so the user can't confirm without reading it. The date in it is the one fact the user needs to weigh: a backup from this morning costs little, one from twelve days ago costs a lot. With the backup pruned, the section reads "Going back isn’t possible. The copy from before the last update was removed on 9 Nov." Boundary itself has no **Go back**: Squirrel never installs an older app.

### Skipping a version

**Trigger.** **Skip this version** on the tools row. **Surface.** The page only. The row then reads "0.3.4 · You skipped 0.3.5. Boundary offers the next version when it comes out." with **Undo**. Skipping deletes anything staged for that version.

### Update Boundary first

**Trigger.** The newest stack release needs a newer app (plan decision 3, step 2). **Surface.** The quiet indicator once Boundary 0.3.0 is ready, and a banner on the page.

| Element | Copy |
| --- | --- |
| Banner title | "Boundary 0.3.0 brings a new version of your tools" |
| Banner body, app ready | "Restart to install Boundary. Your tools update to 0.4.0 as it starts." |
| Banner body, app downloading | "Boundary downloads 0.3.0 first. Your tools update to 0.4.0 when it installs." |
| Your tools row | "0.3.5 · 0.4.0 needs Boundary 0.3.0" |

**Restart to update** installs both in one restart. That depends on a change to the plan (open question 3). If the app update isn't offered to this Mac yet because of its rollout, the page says nothing about 0.4.0: an update the user can't get is noise.

### Required and withdrawn versions

**Trigger.** The running app is below `minimumSupported`, or in `blocked` (plan decision 1). **Surface.** A banner across the top of the workbench that returns on every launch (level 4), the warning-coloured dot, and the same banner on the **Updates** page. Never a dialog and never an automatic install.

| Element | Copy |
| --- | --- |
| Below minimum | "This version of Boundary has a security problem that 0.3.0 fixes. Boundary keeps working, but update as soon as you can." |
| Blocked | "Boundary 0.1.3 was withdrawn because of a problem. Update to 0.3.0 to keep using Boundary safely." |
| Buttons, update downloaded | **Restart to update**, **What’s fixed** |
| Buttons, not downloaded | **Download update**, then "Downloading 0.3.0…", then **Restart to update** |
| Close button tooltip | "Hide until Boundary restarts" |

The banner can be hidden for the session because the user may be mid-task, and the running-work prompt still applies when they act on it. It returns at the next launch.

### Can't check, or the check is untrustworthy

**Trigger.** Offline, GitHub unreachable, or the channel file fails its signature, serial or expiry check. **Surface.** The **Updates** page only (level 1). Offline is normal for a sovereign app, and a dot for it would be noise.

| Case | Copy |
| --- | --- |
| Offline or unreachable | "Couldn’t check for updates. Last checked 3 days ago." **Check now** then reads "Boundary couldn’t reach GitHub. Check your connection, then try again." |
| Signature or serial fails | "The update list Boundary downloaded failed its signature check, so Boundary ignored it. Your installed versions aren’t affected." |
| Expired | "The update list is out of date, so Boundary didn’t use it. It checks again later." |

The signature case gets its own wording because it's the one failure that may mean someone tampered with the file, and a power user should be able to tell it apart from being offline.

### Downloads that fail

**Trigger.** Archive checksum, image pull or build fails during staging, or Squirrel's download or signature check fails. **Surface.** The page. The row keeps the version and says why, using the headline from `describeStartupError` for the raw message:

| Case | Copy |
| --- | --- |
| Staging | "Downloading 0.3.5 stopped. Couldn’t download your tools." with **Try again** |
| App download | "Boundary 0.3.0 didn’t download." with **Try again** |
| App signature | "The downloaded Boundary 0.3.0 didn’t pass the code-signature check, so Boundary deleted it." with **Try again** |

### Not enough disk space

**Trigger.** Free space is below what staging needs. **Surface.** The page only.

| Element | Copy |
| --- | --- |
| Your tools row | "0.3.5 needs 6 GB free to download, and this Mac has 2.1 GB. Free up some space and Boundary tries again by itself." |

If an install on launch runs out of space, the start-up screen's existing **disk** error applies after the automatic undo.

### Release channel

**Trigger.** The user picks **Beta** or goes back to **Stable**. **Surface.** The page. No dialog: the hint already says what Beta means.

Going back to Stable doesn't downgrade, because Squirrel never installs an older app. The hint under the control changes to "You stay on 0.3.0-beta.2 until Stable has a newer version." until Stable catches up.

### Checks off

**Trigger.** The user turns **Check for updates** off. **Surface.** The page. The hint changes to "Boundary doesn’t check for updates, so it can’t tell you about security fixes. **Check now** still checks once." **Update automatically** is disabled while checks are off.

### Local stack mode

**Trigger.** `BOUNDARY_LOCAL_STACK=1` or `BOUNDARY_ASSISTANT_ROOT` (plan decision 11). The icon rail already shows the **Local** badge. **Surface.** The page.

| Case | Copy on the tools row |
| --- | --- |
| Attached | "Updates are off. Boundary is using the tools in ~/code/assistant, which you update yourself." |
| Version outside the app's range | "These tools report 0.4.2, and this Boundary was tested with 0.3.4 and 0.3.5. Some features may not work." |
| Version unknown (before 0013 R3) | "Boundary can’t tell which version these tools are." |

Boundary's own updates work as usual.

### Running from the disk image or Downloads

**Trigger.** `app.isInApplicationsFolder()` is false (plan decision 4). **Surface.** At first launch, a native dialog: "Move Boundary to Applications?" / "Boundary can update itself only from the Applications folder." with **Move to Applications** and **Not now**. After **Not now**, only the Boundary row on the page: "Boundary is running from Downloads, so it can’t update itself." with **Move to Applications**.

### During first run

**Trigger.** An update arrives while setup is running. **Surface.** None until setup ends. First run installs the newest certified stack directly, so there's nothing to update. An app update that downloads during setup waits for the indicator in the workbench. Boundary never restarts between setup steps, and a quit during setup installs the app as any quit does; setup resumes where it was (first-run spec decision 2).

### A withdrawn release that was already staged

**Trigger.** A later channel file sets the staged release's `rollout` to 0 or removes it. **Surface.** The page: "0.3.5 was withdrawn before it installed, so Boundary removed the download." The dot clears. This needs a plan change (open question 5).

### An older Boundary opened on newer data

**Trigger.** The user installed an older DMG by hand, and `dataVersion` is higher than the app (plan decision 7). **Surface.** The start-up error screen, before any store opens.

| Element | Copy |
| --- | --- |
| Title | "This copy of Boundary is older than your data" |
| Body | "Boundary 0.3.0 last opened your data, and this copy is 0.2.1. Install 0.3.0 or later to keep going. Nothing has been changed." |
| Buttons | **Download Boundary** (opens the releases page), **Quit** |

There's no **Try again**, because trying again can't help.

## Release notes

Stack CHANGELOGs are written for people who run the stack by hand: image tags, migration steps, environment keys. A user who never opens Settings won't read them, and the ones who do can't tell which lines change anything for them.

Boundary already certifies every stack release before it reaches a channel file (plan decision 2). The maintainer who certifies a release has run the update, so they are the right person to write two to four lines about what a user will notice. Those lines go in the channel file entry as `summary`, so they are signed with everything else and available offline once checked:

```json
"summary": [
  { "tool": "search", "title": "Faster search", "text": "Search answers sooner when some engines are slow." },
  { "tool": "memory", "title": "Memory reads PDFs", "text": "Long-term memory can take in PDF files you share." },
  { "title": "Fixes", "text": "Coding jobs no longer stop when a folder name has a space in it." }
]
```

`tool` is optional and names a start-up tile, so the story card can highlight it. The app's entry gets the same field. The summary appears in three places: **What's new** on the **Updates** page before the update installs, the story cards while it installs, and **See what changed** afterwards. `notes` stays as the **Technical notes** link for anyone who wants the full CHANGELOG. A release whose only changes are invisible gets one line saying so, written by the maintainer, not generated.

## Proposed decisions

1. **Updates surface at the quietest level that works** (the table in [How loud an update gets](#how-loud-an-update-gets)), and Boundary asks before downloading. Checking and failing to download are silent. A notice appears once per version. Nothing about an update sends a system notification of its own.
2. **One quiet indicator.** A static dot on the Settings rail icon and the **Updates** tab, and **Check for Updates…** in the Boundary menu becoming **Restart to Update…**. The dot appears when an update is ready, or available with automatic updates off, and clears once the **Updates** page has been opened. A required update's dot is warning-coloured and stays until it's installed.
3. **Settings gets an Updates tab**, last in the row, laid out as in [The Updates page](#the-updates-page).
4. **One preference covers downloading and installing.** **Update automatically** (off by default, arriving with the channel file) downloads in the background and installs at the next start. **Check for updates** controls the fetch. **Release channel** picks Stable or Beta. **Update automatically** is disabled while checks are off.
5. **The words are fixed:** Boundary, your tools, the container engine, update, install, download, go back, undo. Versions appear without a `v`.
6. **One restart installs everything that's ready.** The button is **Restart to update** wherever it appears. With nothing running, it restarts without asking.
7. **The running-work prompt defaults to waiting.** It names each chat, board task and coding job, says Boundary can't see automations, and offers **Restart when finished**, **Restart now** and **Cancel**. Waiting counts only the work running when the user chose.
8. **The start-up screen installs updates** with the stages and copy in [Installing on launch](#installing-on-launch). On an update launch the story cards show the update's summary from the start.
9. **The quit screen says what installs**, so a slower next launch is expected.
10. **After an update, one notice.** A notice that closes by itself after a normal update; one that stays until closed after an undo or when files the user changed were set aside.
11. **Release notes come from the certifier.** The channel file entry carries a signed, plain-language `summary`. A stack release can't be certified without one. The CHANGELOG is the **Technical notes** link.
12. **An automatic undo says nothing was lost** and that the version won't install again by itself, and offers **Try again** on the **Updates** page.
13. **Going back is confirmed in a dialog** that names the backup's date and time, what's lost and what's kept. The destructive button names its cost. Going back also skips that version.
14. **Required and withdrawn versions get a banner that returns each launch**, never a dialog and never an automatic install.
15. **Update Boundary first** is explained on the **Updates** page, and one restart installs both. If this Mac isn't offered the app update, the stack release isn't mentioned.
16. **Failures to check stay on the Updates page**, with separate wording for a bad signature.
17. **Check now includes this Mac in any rollout above zero.** The person pressing it is opting in, and "up to date" is then true. A release halted at zero stays halted.
18. **Local stack mode turns the tools row into an explanation**, with a warning when the attached version is outside the app's range.
19. **Boundary offers to move itself to Applications** at first launch and says on the **Updates** page why it can't update otherwise.
20. **An app older than its data stops at a start-up error** that names the version needed and offers **Download Boundary** and **Quit**.

## Open questions

1. **Long launches before 0013 R6.** Until locally built images can be built during staging, every stack update builds on launch. The user who opens Boundary to ask one question gets a launch of several minutes they didn't expect. Options: say on the **Updates** page and the quit screen that the next start takes longer (this study does); install automatically only when staging is complete and ask otherwise; or offer **Start without updating** on the start-up screen until the swap begins. The last is the most respectful of the user's time but adds a decision to the launch. Which one?
2. **Manual go-back must skip the version (plan change).** The plan marks a version failed only after an automatic rollback. After a manual go-back with automatic updates on, the next launch would install the same version again. Going back should skip it, and the study's copy assumes so.
3. **App and stack in one restart (plan change).** The plan says both can install in one restart, but staging only takes a stack entry whose `app` range includes the running app. When the release needs the new app, the old app won't stage it, so the user gets either a second update launch or a long launch that downloads everything. Staging should check `app` ranges against the app version Squirrel has downloaded, using the new release's tree. Can the old app safely pull images for a tree its overlay may not match, or should staging stop at downloading the archive in that case?
4. **The setting's name (plan change).** The plan calls it **Download updates automatically**, but it also installs on the next launch. The study uses **Update automatically** with a hint that says both.
5. **Withdrawn releases after staging (plan change).** A staged release that a later channel file withdraws or blocks should be discarded, not installed. Should the launch apply against the most recently verified channel file, and what happens when that launch is offline?
6. **Automatic patch releases** (the plan's open question). This study's answer is yes for every certified release when **Update automatically** is on. The launch is the user's consent, the backup and the health gate limit the damage, and the alternative asks the person who never opens Settings a question they can't answer. Does the product owner agree, or should releases with one-way migrations ask once?
7. **Check now and the rollout.** Decision 17 lets a manual check join a staged rollout. That weakens the rollout as a blast-radius limit for people who check often. Acceptable?
8. **Checks off hides security fixes.** With checks off, `minimumSupported` never reaches the user. The hint says so. Should Boundary still fetch the channel file for `minimumSupported` and `blocked` alone, or is off really off?
9. **New work while waiting to restart.** **Restart when finished** waits only for the work that was running. Should the kanban dispatcher hold new tasks while a restart waits, or is a busy board allowed to keep starting work until the user presses **Restart now**?
10. **Metered connections.** Background staging downloads gigabytes. On a phone hotspot that costs money. Should staging pause on networks macOS marks as low-data, and can Boundary detect that?
11. **Freeing the go-back copy.** The low-disk case would be easier if the user could remove the backup kept for going back from the **Updates** page or Resources. Should that be offered, given it ends the option to go back?
12. **Skipping an app version.** The plan lets the user skip stack versions only. With automatic updates on, a downloaded app installs on quit. Is that enough control, or does Boundary need **Skip this version** for itself too?
13. **n8n executions.** The running-work prompt can only say it can't see automations. If the stack exposes a count (plan open question), the prompt lists them like the rest.
