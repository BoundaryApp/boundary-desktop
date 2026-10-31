# Bug reports: living spec

| | |
| --- | --- |
| Status | Proposed |
| Visuals | [prototype.dc.html](prototype.dc.html) (click-through source) |
| Started | 31 Oct 2026 |
| Builds on | [Design system](../design-system/index.html), [message actions spec](../message-actions-ux-study/spec.md), [stack contract](../stack-contract.md) |

## Progress

| Phase | Status | Depends on |
| --- | --- | --- |
| 1 Report sheet and GitHub hand-off | Not started | — |
| 2 Error capture and offers | Not started | 1 |
| 3 Assistant drafting | Not started | 1 |
| 4 Reporting from chat | Not started | 3 |
| 5 Duplicates and file hand-off | Not started | 1 |

## Goal

A user who hits a bug can file a useful GitHub issue in under a minute, from where the bug happened, without leaving private data in a public repository.

## Decisions

1. **The browser holds the GitHub session.** Boundary opens a pre-filled new-issue link with `shell.openExternal` through `openHttpUrlExternally`. It stores no GitHub token and registers no OAuth app. The user presses Submit on GitHub, so the last check of public text happens on the page that publishes it.
2. **Boundary never says a report was sent.** It can't see GitHub after the hand-off. Settings lists these as **Opened in GitHub**, with **Open again**.
3. **An issue form carries the label.** `labels` in the URL needs permission to label issues, and GitHub answers a request without that permission with a 404. `.github/ISSUE_TEMPLATE/bug_report.yml` sets `bug`, and the link uses `template=bug_report.yml`. It has one `report` text field, filled from the link. The title uses `title`.
4. **Reports start from a fixed list of fields.** The collector copies named fields from `persistDebugLog` records: time, area, message, error name, and stack frames with paths reduced to repo-relative form. It drops `data` by default, because `stderr` and `stdout` there can echo anything. `redactSecrets` then runs over the result, along with new rules for home paths, host names and account names.
5. **Chat content stays out by default.** Reports use what the user typed in the sheet or said to the skill in that request. The collector reads no session content, and no prompt, reply or tool result goes into a report. The text of one reply goes in only when the user turns on **Text of this reply**. Screenshots are off by default because they can show chats.
6. **The sheet works without the assistant.** **Write it myself** is always available. When the stack is down it's the only path, and the sheet says why. Drafting never blocks reporting.
7. **The sheet names where the draft goes.** Before drafting it names the model. For a cloud model it also says the description and redacted errors go to that provider.
8. **The assistant asks at most one question.** The question has tap answers and **Skip**.
9. **Offers scale with what the user can see.** See the next section. Nothing is offered for an error with no visible effect.
10. **One sheet, every entry point.** Each entry point opens the same three steps with a different starting context: Describe, Review, Submit on GitHub.

## Entry points and offers

| Trigger | Source today | What the user sees |
| --- | --- | --- |
| User noticed a bug | none | Help › **Report a Bug…** (⇧⌘B), bug button at the foot of the rail |
| Reply is wrong | message actions | **Report this reply** on the reply |
| User asks in chat | none | `report-bug` skill, draft card in the transcript |
| Reply failed | turn error surface | **Report** beside **Retry** |
| Feature failed twice in 10 minutes, off-screen | to be added per feature | Toast with **Report**, **Not now**, **Don't ask for this error** |
| Window hit the error boundary | `ErrorBoundary` in `mount.tsx` | Recovery screen with **Reload and report**, **Reload** |
| Renderer process gone | `render-process-gone` | Same offer after the window returns |
| Main process exited on an error | `uncaughtException` | Banner on next launch |
| Unhandled rejection, no visible effect | `unhandledRejection` | Nothing; listed in Settings |

The Help menu stays usable during setup and start-up, when the rail is inert.

An error's signature is its name, area and top three normalised frames. A signature is offered once per app run, and never again after **Don't ask for this error**. A toast waits until the composer is empty and no sheet is open, and stays until the user acts. **Offer to report problems** in Settings turns off toasts and banners. Inline **Report** buttons and the recovery screen stay.

## Report contents

| Item | Default | Delivered by |
| --- | --- | --- |
| Description and expected result | Always | Link |
| App version, macOS version, chip, current screen | On | Link |
| Recent errors, last 10 minutes | On | Link |
| Full log | Off | File dragged onto the issue |
| Screenshot of this window | Off | File dragged onto the issue |
| Text of one reply | Off, message report only | Link |

GitHub answers an over-long link with 414 and publishes no limit, so Phase 1 measures a working limit. When a draft passes it, Boundary moves the errors to a file and keeps the description in the link. The file hand-off comes in Phase 5; until then the errors go to the clipboard.

**Copy report** and **Save as file** cover users with no GitHub account.

## Assistant drafting

The skill is `report-bug`. Boundary's main process builds the bundle under decisions 4 and 5, and the skill turns the bundle and the user's words into a title and body. It doesn't read logs, sessions or files itself.

Hermes loads skills from `~/.hermes/skills` and from `skills.external_dirs`. `_validate_config_key` accepts that key on the pinned image, and `agent/skill_utils.py` reads it. Sheet drafting and chat drafting still need a design:

- **Delivery:** the external directory must be visible inside the container. If that needs a mount, it goes in a change request under `docs/change-requests/`.
- **Sheet drafting:** a draft shouldn't appear in the user's chat list. Phase 3 confirms in Hermes's source how to run a turn outside it.
- **Chat drafting:** the skill needs a read-only way to fetch the bundle from Boundary. The host bridge is the likely route; Phase 4 confirms it.

Phase 3 adds each of these to the stack contract table and names its `test:stack` case or manual flow.

## Duplicates

Before Review, Boundary searches open issues using the error name and area only, never the description. Search without a token is limited to 10 requests a minute. A failed or rate-limited search shows nothing and doesn't delay Review. **Add to that issue** opens the issue and copies the report for pasting as a comment.

## Open work outside the UI

- Add window `error` and `unhandledrejection` listeners in the renderer. Neither exists today.
- Write a run marker that lets the next launch detect an exit after `uncaughtException`.
- Add a main-owned problem list, on this Mac only, holding allowlisted fields. Cap: 50 entries or 14 days.
- Make `formatShortcut` handle `CmdOrCtrl+Shift+B`. It strips only `CmdOrCtrl+` today and would print `⌘Shift+B`.
- Replace the `ErrorBoundary` fallback. It sits above the product state, so **Reload and report** stores a pending report in main, reloads, and opens the sheet on mount.

## Phases

**Phase 1.** Issue form, collector with redaction, Describe and Review with **Write it myself**, hand-off screen, Help menu item, shortcut and rail button, copy and save. Measure the link limit, and test whether GitHub keeps the pre-filled text through sign-in.

**Phase 2.** Renderer listeners, signatures, problem list, recovery screen, launch banner, inline **Report**, toast, Settings section.

**Phase 3.** `report-bug` skill, delivery to the stack, drafting and the one question in the sheet, model notice, stack-down path.

**Phase 4.** Skill use from chat, draft card, **Report this reply**.

**Phase 5.** Duplicate search. Drag files out of the app with `webContents.startDrag`, after testing the drop on GitHub in Safari, Chrome and Firefox.

## Acceptance criteria

- [ ] No GitHub token, cookie or browser data is read or stored.
- [ ] A user without triage rights opens the link and sees the form filled in, and the submitted issue has the `bug` label.
- [ ] A signed-out user reaches the filled-in form after signing in, or the hand-off screen says what to do instead.
- [ ] Fixture logs holding a secret, home path, host name and chat text produce a report with none of them.
- [ ] No code path passes session content to the collector.
- [ ] A report can be filed with the stack stopped.
- [ ] The sheet names the model before any data reaches it, and states the provider for a cloud model.
- [ ] A signature prompts once per run, and never after **Don't ask for this error**.
- [ ] An error with no visible effect produces no prompt.
- [ ] A toast never appears while the user is typing, tested with fake timers.
- [ ] A crash in the mounted runtime reaches the recovery screen, and **Reload and report** opens the sheet with the error attached.
- [ ] An exit after `uncaughtException` shows the banner once on next launch.
- [ ] A draft over the link limit still opens GitHub with the description intact.
- [ ] Text the user edits in Review is the text in the link.
- [ ] A failed duplicate search leaves Review unchanged.
- [ ] Every control shows `--focus-ring`, and reduced motion stops the drafting animation.
