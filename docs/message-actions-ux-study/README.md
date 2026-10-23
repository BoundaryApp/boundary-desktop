# Message actions UX study mocks

Reference windows for the hover verbs and timestamps on chat messages, plus the keyboard layer that goes with them. The implementation plan is [`spec.md`](spec.md). Stack-side needs are in [change request 0001](../change-requests/0001-message-actions.md). The decisions are in [`docs/adr/`](../adr/README.md).

| File | Role | Status |
| --- | --- | --- |
| [spec.md](spec.md) | Living spec: phases, AC, thin-wrapper map | Proposed |
| [index.html](index.html) | Study board: recommendation, other shortcuts considered, open questions | — |
| [01-user-actions.html](01-user-actions.html) | Copy / edit / branch + timestamp on prompts. Placements: A Under, B Floating, C Head row, D Right bubble | Proposed (D Right bubble) |
| [02-assistant-actions.html](02-assistant-actions.html) | Copy / retry ▾ / branch / ⋯ on replies, plus code-block copy, tool-card reveal, quote, streaming | Proposed |
| [03-shortcuts.html](03-shortcuts.html) | ⌘/ shortcut sheet, ⌥↑ message focus, ⌘F find | Proposed |
| [study.css](study.css) / [study.js](study.js) | Shared chrome, chat skin and state switching | — |

Open the files over HTTP, for example `python3 -m http.server` from the repo root, then `/docs/message-actions-ux-study/`. A plain `file://` open also works in most browsers. Use the title-bar buttons for states. **Light** remaps the theme and **Notes** shows the design callouts. A state and a variant can be deep-linked, for example `01-user-actions.html?variant=right&state=editing`.

The mocks are live where it is cheap to make them so: hover shows the row, Copy writes to the clipboard, Edit opens the editor (Esc cancels, ⌘↵ sends), Branch switches to the branched view, and ↑ in the empty composer edits.
