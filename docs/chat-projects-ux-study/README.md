# Chats in projects UX study

A click-through study of how chats relate to projects. Decision: [ADR 0024](../adr/0024-chats-belong-to-projects.md) (Accepted). It amends [0003](../adr/0003-workbench-chrome.md), which says to revisit the picker if threads scope to a folder. It also amends the "active project" step of the resolve order in [0017](../adr/0017-project-inference-pin.md).

| File | Role |
| --- | --- |
| [01-chats-in-projects.html](01-chats-in-projects.html) | Self-contained mock: project page, chat with a breadcrumb, picker that navigates, Move sheet, new-chat draft, All chats with a project filter and bulk move, DM folder, and a chat that is mid-reply |

## The problem

A chat stores no project. `selectHermesProject` re-points the open chat's cwd whenever the global active project changes (`WorkbenchChatScreen.tsx` `handleSelectProject`), so the rail picker silently changes the context of the chat you're in. Inference resolves from the global active project too, so switching the picker can also change which model the open chat uses.

## The proposal

1. **A chat lives in one project, or in none.** Store `projectId` on Hermes chats, channels and side chats. The cwd, sources and inference pin come from the chat's own project. Nothing reads a global active project at send time.
2. **The picker navigates.** Choosing a project opens its project page and scopes the rail's Hermes and Channels sections. Opening a chat from another project switches the rail to that project.
3. **Move is the only way to re-file.** It's reached from the title menu, the composer chip, the inspector, or bulk select in All chats. The sheet lists what changes: folder, sources and inference. It warns when inference moves from local to cloud. The transcript records the move, and the toast offers Undo. Move is disabled while a turn is running.
4. **DMs stay global.** A DM has its own *Works in* folder, and each change is marked in the thread.
5. **New chats start in the rail's project.** A draft's chip is a free picker until the first send.
6. **All chats** gains a Project column, a project filter (including *No project*) and multi-select Move.

## Build

Built 4 Oct 2026:

- **Main.**
  - `SessionMeta.projectId`, `ChannelRecord.projectId` and per-session project marks.
  - `hermesChatProjects.ts` handles one-time filing from the session's last `cwd`, Move (refused while a turn runs), Undo, and quiet re-filing for chats with no messages.
  - Each turn sets `session.cwd.set` from the chat's own project, or the gateway's default folder when it has none.
  - `resolveSessionInference` reads the chat's project. `selectHermesProject` no longer touches a session.
- **Renderer.**
  - The rail picker is *Go to project*, with per-project counts, and opens the new project page (`ProjectPane`).
  - The rail follows an opened conversation.
  - Header breadcrumb with a title menu.
  - The composer chip is fixed once a chat has messages; a DM's chip says *Works in*.
  - `MoveProjectSheet` lists what changes, with the cloud warning.
  - Transcript marks, and an Undo toast.
  - All chats gains a Project column and filter, and multi-select Move.
  - The inspector says *This chat lives in*.
- **Tests.** 16 main (`hermesChatProjects.test.ts`), 6 renderer (`projectMove.test.ts`), 3 new screen tests, and an updated inference resolver test.
- **Checked:** in the renderer harness with stubbed IPC, in dark and light. **Not yet checked against a live Hermes gateway:** the `session.cwd.set` call before each turn, `projects.for_cwd` for the default folder, and the first-launch filing from `session.list` cwd.
