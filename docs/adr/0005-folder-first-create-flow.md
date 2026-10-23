# 0005. Folder-first create flow

- Date: 2026-09-20
- Status: Accepted
- Parent: [0002](0002-chat-as-product-home.md)
- Related: [0003](0003-workbench-chrome.md)

## Context

Workbench lists projects above leftover chats. Folder First (D) makes the host folder the first act: Choose folder… → Connecting folder… → permission failure or chats inside that directory. Review wants that create flow as an experiment, not as a replacement of Workbench chrome yet.

## Decision

Prototype D’s lifecycle on top of Workbench:

1. Empty: “Work with a folder on this Mac” + Choose folder… (primary) and Create empty project (secondary).
2. Connecting: do not open an empty composer while the bind-mount is mid-flight.
3. Permission: Docker file-sharing (or equivalent) failure names the host path and the fix. Files are not copied.
4. Ready: folder is the scope; threads belong to it.

Source mock: [`docs/chat-ux-study/04-folder-first.html`](../chat-ux-study/04-folder-first.html). Do not restyle D into A until this experiment is accepted or rejected.

## Consequences

- P0 can still ship Workbench with a New project button that opens the host picker.
- The experiment answers whether “open a folder” is clearer than a mixed project + loose-chat list.
- Accepted 2026-09-28. The empty rail offers Choose folder… (primary) and Create empty project (secondary, a named project under Boundary’s data folder). Where 0003 says “New project”, the folder-first flow is the create path.
