# 0025. WebUI chats are filed by their workspace

- Date: 2026-10-06
- Status: Accepted (2026-10-06)
- Parent: [0024](0024-chats-belong-to-projects.md)
- Amends: [0024](0024-chats-belong-to-projects.md) §9 (how an unfiled conversation finds its project) and its consequence on WebUI chats

## Context

0024 §9 files a conversation once, under the project whose folder holds the session's last `cwd` from `session.list`. A chat started in Hermes WebUI never had that `cwd`:

- WebUI keeps its chats in its own JSON store. They don't reach `state.db`, so `session.list` has no row and no `cwd` for them.
- Boundary lists them from WebUI's `/api/sessions`, and read only the id, title and dates.

So every WebUI chat was filed under *No project*, even when the user had picked a folder in WebUI's workspace picker. WebUI stores that folder on each chat as `workspace`. It is a container path, the same form as a project's `containerPath`.

WebUI also has a `project_id` field. It is WebUI's own grouping, not a folder, and is not used here.

## Decision

1. **A WebUI chat's `workspace` is its `cwd`.** Filing under 0024 §9 uses it the same way it uses the `cwd` from `session.list`. When the gateway also lists the chat but has no `cwd` for it, the WebUI workspace is kept.
2. **Chats filed before this are filed again, once.** The first chat list that includes WebUI chats re-runs §9 for each WebUI chat stored as *No project* that has no move marks. A chat whose workspace matches a project moves to it. Others stay where they are. The pass is recorded, so it never runs again.
   - A chat someone moved by hand has a mark and keeps its place. Quiet moves (0024 §5, the composer chip) only happen before a chat has messages, so a WebUI chat never has one.
   - No mark is added for this filing. The chat was never meant to be in *No project*.
3. **Filing is still once.** Changing the workspace in WebUI later does not move the chat in Boundary. Move (0024 §6) is still the only way to re-file.

## Consequences

- `mapWebuiCompactRow` reads `workspace` into `cwd`. `mergeHermesThreadLists` keeps WebUI's `cwd` when the gateway row has none.
- The per-stack agent store gains `webuiRefiledAt`, set the first time a list includes WebUI chats.
- 0024's consequence "Telegram, WebUI and API chats are filed by the cwd rule, which in practice usually means *No project*" no longer holds for WebUI. A WebUI chat lands in the project whose folder was picked there. Telegram and API chats are unchanged.
- A WebUI workspace that matches no Boundary project files the chat under *No project*, as before.
