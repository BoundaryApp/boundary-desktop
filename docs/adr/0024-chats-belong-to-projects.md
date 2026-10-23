# 0024. Chats belong to projects

- Date: 2026-10-04
- Status: Accepted (2026-10-04)
- Parent: [0002](0002-chat-as-product-home.md)
- Amends: [0003](0003-workbench-chrome.md) (the current-project picker), [0017](0017-project-inference-pin.md) §3 (which project's pin applies), [0023](0023-chat-types-and-hermes-home.md) §2 and §5 (the rail's Hermes section, All chats)
- Amended by: [0025](0025-webui-chats-filed-by-workspace.md) (a WebUI chat's workspace is its cwd for §9; WebUI chats filed before are filed again once)
- Related: [0013](0013-project-sources-inspector.md), [0014](0014-tabbed-inspector.md), [0016](0016-chat-inference-override.md)
- Sources: [`docs/chat-projects-ux-study/`](../chat-projects-ux-study/)

## Context

0003 made a project "session-wide working context", and threads stayed global. Its last consequence said to revisit the picker if threads ever scoped to a folder.

In practice the picker rewrote the open chat. Choosing a project called `selectHermesProject` with the open session, which moved that chat's working folder. Inference resolved from the global active project at send time (0017 §3). So switching the picker while a chat was open silently changed that chat's folder, sources and, with a pin, its model. Users read a chat started inside a project as belonging to it. The product did not agree.

## Decision

1. **Every conversation stores its project.** Hermes chats, side chats and channels have a `projectId`, or `null` for *No project*. It is set when the conversation starts:
   - A new chat (⌘N, the section plus, the empty composer) starts in the project the rail is showing.
   - A branch and *Make channel* keep the source chat's project.
   - *New channel* starts in the rail's project.
   - It never changes except by Move (6).
2. **The chat's project is the only one that applies to it.**
   - Before each turn, Boundary sets the session's working folder from the chat's project with `session.cwd.set`. A chat with no project gets the gateway's default folder.
   - Inference resolves as chat override → **the chat's project's pin** → app default.
   - The gateway's global active project no longer decides anything for a chat.
3. **The rail picker navigates.** It is titled *Go to project*. Choosing a project opens its **project page**, and the rail's Hermes and Channels sections show that project's conversations. Opening a conversation from elsewhere (All chats, Mentions, a branch link) switches the rail to that conversation's project. Picking a project never changes the open chat.
4. **Project page.** The page has three parts: a composer that starts a chat in this project, the project's chats, and its channels. *No project* has the same page for unfiled conversations. The inspector's Project tab (0013, 0017) describes the project being viewed.
5. **Where a chat's project shows:**
   - **Header:** a breadcrumb, *project / title*. The project crumb opens the project page, and the title opens the chat menu.
   - **Composer:** the project chip is fixed once the chat has messages, and clicking it opens Move. Until then, it is a picker.
   - **Inspector:** the Project tab says *This chat lives in*.
6. **Move to project… is the only way to re-file.** It is reached from the title menu, the composer chip, the inspector, and bulk selection in All chats. Before moving, the sheet lists what changes:
   - the working folder
   - the sources
   - the inference that will apply, with a warning when it goes from local to the cloud (the cloud-disclosure rule)

   A move adds a marker to the transcript: *Moved from A to B · path*. The marker is shown in the transcript but never sent to Hermes. The toast offers Undo. Move is refused while a turn is running in any of the chats being moved.
7. **DMs stay global.** A DM is one ongoing thread per agent (0023 §3), so it can't belong to a project. It is always listed and has its own *Works in* folder, stored on the DM and set from its composer chip. Each change adds a marker to the transcript. A side chat branched from a DM starts in the DM's folder.
8. **All chats** gains a project column, a project filter (*Any project*, each project, *No project*), and multi-select Move.
9. **Existing conversations are filed once.** A conversation with no stored project is filed under the project whose container path holds the session's last `cwd` from `session.list`. Otherwise it goes in *No project*. The result is saved, so later picker changes can't move it. Conversations whose project is removed show as *No project*.

## Consequences

- `SessionMeta` gains `projectId`, and session id migrations carry it with the chat override. `ChannelRecord` gains `projectId`. Project markers are stored per session, like inference marks.
- New IPC `hermes-chat:move-to-project` (`sessionIds`, `projectId`, optional `undo`). `createHermesChat`, `createChannel` and a first send with no session accept `projectId`.
- `selectHermesProject` no longer takes a session. It only sets the rail's project and the gateway's active project. The renderer stops calling it on every thread open.
- 0003's consequence "do not reattach a folder when switching chats" is now built in: folders follow the chat, not the switch.
- Mentions stays global. Telegram, WebUI and API chats are filed by the cwd rule, which in practice usually means *No project*.
- Removing a project leaves its conversations in place, shown under *No project*. Their stored id is kept, so they would reappear if a project with that id came back.
