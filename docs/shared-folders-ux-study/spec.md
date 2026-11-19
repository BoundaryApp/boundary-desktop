# Shared folders: living spec

| | |
| --- | --- |
| Status | Proposed |
| Visuals | [prototype.html](prototype.html) (click-through) |
| Started | 9 Nov 2026 |
| Builds on | [ADR 0049](../adr/0049-shared-folders.md), [ADR 0032](../adr/0032-circles.md), [ADR 0042](../adr/0042-circle-chats.md), [ADR 0043](../adr/0043-circles-live-in-the-chat.md), [ADR 0024](../adr/0024-chats-belong-to-projects.md), [ADR 0028](../adr/0028-coding-folders.md), [Circle chats spec](../circle-chats-ux-study/spec.md) |

## Progress

| Phase | Status | Depends on |
| --- | --- | --- |
| 1. Folder Autobase, blob cores and `apply` | Built | None |
| 2. Mirror and file watcher | Built | 1 |
| 3a. Offers, join requests and folders in the network process | Built | 2 |
| 3b. Share sheet, add sheet, folder view and projects | Built | 3a |
| 4. Projects and the Folders list | Built | 3b |
| 5. Conflicts, history, roles and Activity | Built | 3b |
| 6. File links in Circle chat | Not started | 3b, Circle chats phase 2 |

## Goal

A member of a Circle shares a folder, and every other member can add it to their Mac as a project in two clicks. Each person always knows three things about it: who gets what they write there, whether their copy is up to date, and what happened when two edits crossed.

## Flows

**Sharing.** A Circle's rail gets a **Folders** section between Channels and People. Its **+** opens a three-step sheet. The first step asks whether to share a folder from this Mac or start an empty one in `~/Circles/<Circle>/`. Picking a folder runs a check before anything is offered. A git repository is refused, with git named as the way to share code. A folder in iCloud Drive, Dropbox, Google Drive or OneDrive is offered as a copy, because two sync engines on one folder overwrite each other. Otherwise the sheet shows the file count, the size every member will download, and the files that will stay on this Mac with the reason for each. The last step picks the default role (everyone edits, or only managers edit) and the managers. As managers are ticked, a line under them says how many must be online for changes to confirm, and warns that two managers make every change wait for both. **Share with Studio** writes the offer and selects the new folder.

**Adding.** An offered folder shows in the rail as **Not added**. Selecting it shows who shared it, its file count, its size, the member's access, and who already has it. Nothing downloads until **Add to this Mac…**, whose sheet takes a location and asks where to use it: a new project named after the folder (the default), an existing project, or no project. The sheet says what the member's role means and that the copy stays on their Mac if they leave. While it downloads, the rail row shows a percentage and the folder view a progress bar. A toast offers **Open project** when it finishes.

**Following changes.** The folder view has two tabs. **Activity** lists changes newest first by person, device and time, with file names that open the file's history. **Files** is the tree, with who changed each file last, and below it the files that stay on this Mac and why. A status strip above the tabs says one thing: up to date, downloading, a conflict, changes waiting for a manager, or read-only.

**Waiting for a manager.** A change is visible to everyone online at once and carries a clock until enough managers have seen it. When the managers needed are offline, the strip names who the changes are waiting for and says the order becomes final when they're back.

**Conflicts.** When two edits start from the same version, the strip says so and **Resolve** opens a side-by-side comparison with changed lines marked. **Keep yours**, **Keep Sam's** and **Keep both** each write ordinary changes; the version not kept stays in the file's history. Text is never merged; the sheet says how to combine them by hand.

**History.** Selecting a file opens its history in the inspector: each version with its author, device and time. **Restore** writes the old version as a new change. A version this Mac hasn't downloaded says it downloads when opened, and one held only by an offline member's Mac says whose Mac it's on.

**Roles.** The inspector's Folder tab lists the people with their roles. A manager's **Change roles** turns each role into a picker, and the quorum line updates. Readers see a strip saying their copy is read-only and who manages the folder; a file a reader changes anyway stays on their Mac, is listed under files not shared, and is never sent.

**On This Mac.** The project's Folders list marks the folder **Shared · Studio** and says who gets what's written there. Coding access starts off and says the coding agent's changes would sync too. A Hermes chat in the project shows a **Shared with Studio** tag on a tool row that wrote to the folder, and the composer hint says files written there reach the Circle.

**Removing and leaving.** **Remove from this Mac…** stops syncing and asks whether to keep the files (the default) or move them to the Trash. The project stays. After the member leaves the Circle, the project's Folders row says **No longer shared**, with the date, and nothing is deleted.

**Links in chat.** A Circle message can link a file in one of the Circle's folders. The chip names the file and folder, and opens the file's history for anyone who added the folder.

## Decisions

1. **Folders sit in the Circle's rail, between Channels and People.** They belong to the Circle, like channels, and the rail is where people already look for a Circle's things (ADR 0042 §10). A Circle with no folders shows one dashed **Share a folder…** row instead of an empty heading.
2. **Selecting a folder replaces the thread with the folder view**, as selecting a channel does. Folder details live in the inspector's **Folder** tab beside the Circle tab (ADR 0043 §2), so there is no folder settings screen.
3. **The share sheet checks before it offers.** Refusals and copies happen at the check step, before people choose roles, so a refused folder costs one screen.
4. **The quorum line replaces a suggested second manager.** The sheet and the inspector say "changes confirm when both have seen them" or "2 of 3" as managers change, which is ADR 0049 §5 as amended.
5. **Adding makes a project by default.** It is the shortest path to agents working in the folder (ADR 0049 §10), and **No project for now** covers people who only want the files.
6. **The status strip shows one state at a time,** in this order: downloading, conflict, waiting, read-only, up to date. The rail row repeats it as a mark: a percentage, a warning dot, a clock or a lock.
7. **Attribution is per person and device,** never per agent. A change Hermes made shows as the member's change from their Mac; the Hermes chat's tool row is where the agent's part shows.
8. **Every place that sends content says so.** The share sheet, the add sheet, the project's Folders row, the Hermes composer hint and the tool row each name who receives what's written.

## Non-goals

- Merging text or showing a diff inside a file view. Conflicts compare two whole versions.
- Folders for some members of a Circle. Every member can read every folder (ADR 0049 §3).
- A file browser or editor inside Boundary. **Open** and **Show in Finder** hand files to the Mac.
- Stopping a share. A manager can make everyone else a reader; deleting the offer is open below.

## Risks and open questions

- **Stopping a share.** ADR 0049 has no way for the sharer to withdraw a folder from members who added it. The prototype leaves it out. If it's wanted, it needs an ADR change: remove every writer and delete the record, with members keeping their copies.
- **A change that hasn't left its author's Mac.** Contents spread only once another member's Mac has downloaded them (ADR 0049 §11). If the author closes their laptop first, everyone sees the change in the list but can't open it. The folder view needs a mark for "only on your Mac" on the author's side, like the unconfirmed clock, and the history panel already covers the reader's side.
- **Large first downloads.** A 1.2 GB folder over a home connection can take many minutes. The progress bar needs a time estimate once real numbers exist.
- **The quorum line is unfamiliar.** People may not see why two managers is worse than one or three. Watch whether anyone picks two.
- **Conflict copies in the tree.** Several unresolved conflicts make the Files tab noisy. The strip counts them, but there is no list of conflicts yet.

## Acceptance criteria

- [x] A Circle's rail lists its shared folders between Channels and People, each with a state mark, and a Circle with none shows **Share a folder…**.
- [x] The share sheet refuses a git repository, offers a copy for a folder inside a known sync tool's folder, and lists files that won't be shared with reasons, before the People step.
- [x] The People step and the Folder tab show how many managers must be online, updating as managers change.
- [x] Nothing downloads until **Add to this Mac…** is confirmed, and the add sheet makes a project by default.
- [x] The folder view shows Activity and Files, with a single status strip, and file names open the file's history.
- [x] A conflict shows in the strip, the rail and the tree, and resolving it writes ordinary changes that leave the other version in history.
- [x] Restoring a version writes a new change, and a version held only by an offline Mac says whose Mac it's on.
- [x] Readers' copies are read-only, and a reader's local change is listed as not shared and never sent.
- [ ] The project's Folders list, the Hermes composer hint and a writing tool row each say the folder is shared with the Circle.
- [x] Removing a folder from this Mac keeps its files by default, and leaving the Circle marks the folder **No longer shared** without deleting anything.
