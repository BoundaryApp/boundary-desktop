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
| 1 Report sheet and GitHub hand-off | Built 8 Nov 2026; in-app check pending | — |
| 2 Error capture and offers | Not started | 1 |
| 3 Assistant drafting | Not started | 1 |
| 4 Reporting from chat | Not started | 3 |
| 5 Duplicates and file hand-off | Not started | 1 |
| 6 Report endpoint | Not started | 1 |

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
11. **The build chooses where reports go.** Decisions 1 to 3 describe a repository target. A build can name an endpoint instead, and then decisions 1 to 3 don't apply to it (see Report targets). A build never switches targets at runtime and never falls back to the other one.

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

GitHub publishes no limit. On 8 Nov 2026 it answered new-issue links up to about 6,900 characters, returned 500 just over 7,000 and 414 from 12,000, so the working limit is 6,000 characters, which leaves room for a signed-in browser's larger headers. When a draft passes it, Boundary moves the errors to a file and keeps the description in the link. The file hand-off comes in Phase 5; until then the errors go to the clipboard.

**Copy report** and **Save as file** cover users with no GitHub account.

## Report targets

Two build-time settings choose the target, read the way `BOUNDARY_UPDATE_FEED_URL` is.

| Setting | Target | Default |
| --- | --- | --- |
| `BOUNDARY_REPORT_REPO` | Pre-filled issue link to `owner/name` | `BoundaryApp/boundary-desktop` |
| `BOUNDARY_REPORT_URL` | `POST` to this endpoint | Empty |

When `BOUNDARY_REPORT_URL` is set, it wins and the repository setting is ignored. A fork that sets neither repository nor endpoint gets **Copy report** and **Save as file** only.

An endpoint build changes the sheet in five places:

- **Authentication:** the request carries the build's update feed key as a bearer token. A build with an endpoint and no stored key shows **Add your update key in Settings › Updates to send reports**, and still offers copy and save.
- **The last step:** it's **Send report** instead of **Submit on GitHub**. Review is the last check before the report leaves the Mac.
- **Review:** it says who reads the report, where a repository target warns that the issue is public.
- **Confirmation:** the endpoint answers with a reference, and the sheet shows it. Unlike the repository target, the endpoint target can say the report was sent. Settings lists these as **Sent**, with the reference.
- **Files:** the full log and the screenshot go in the request as attachments, so Phase 5's drag hand-off isn't needed.

The request holds the title, the body and any attachments. It doesn't add the reporter's identity, because the endpoint already has it from the key.

A failed send (network, 5xx) keeps the report in a local queue, at most 20 reports, and retries on the next app start. A 401 means the key was revoked, and the report stays queued until a new key is added. A queued report can still be copied or saved, but never opened as a GitHub link.

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

**Phase 6.** `BOUNDARY_REPORT_REPO` and `BOUNDARY_REPORT_URL`, the endpoint request with the feed key, the five sheet changes, the send queue.

## Acceptance criteria

- [x] No GitHub token, cookie or browser data is read or stored.
- [ ] A user without triage rights opens the link and sees the form filled in, and the submitted issue has the `bug` label.
- [ ] A signed-out user reaches the filled-in form after signing in, or the hand-off screen says what to do instead.
- [x] Fixture logs holding a secret, home path, host name and chat text produce a report with none of them.
- [x] No code path passes session content to the collector.
- [x] A report can be filed with the stack stopped.
- [ ] The sheet names the model before any data reaches it, and states the provider for a cloud model.
- [ ] A signature prompts once per run, and never after **Don't ask for this error**.
- [ ] An error with no visible effect produces no prompt.
- [ ] A toast never appears while the user is typing, tested with fake timers.
- [ ] A crash in the mounted runtime reaches the recovery screen, and **Reload and report** opens the sheet with the error attached.
- [ ] An exit after `uncaughtException` shows the banner once on next launch.
- [x] A draft over the link limit still opens GitHub with the description intact.
- [x] Text the user edits in Review is the text in the link.
- [ ] A failed duplicate search leaves Review unchanged.
- [ ] Every control shows `--focus-ring`, and reduced motion stops the drafting animation.
- [ ] A build with `BOUNDARY_REPORT_URL` never opens a GitHub link, including after a failed send.
- [ ] A failed send keeps the report queued and retries on the next start, and a 401 asks for a new key.
- [ ] The feed key is sent only to the report endpoint and the update feed.
