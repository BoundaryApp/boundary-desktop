# Inspector UX study

Proposal to start the chat inspector closed. It builds on [0014](../adr/0014-tabbed-inspector.md) (tabbed inspector) and [0020](../adr/0020-centered-transcript-column.md) (centered transcript column).

| File | Role |
| --- | --- |
| [01-closed-by-default.html](01-closed-by-default.html) | Click-through for [0069](../adr/0069-inspector-closed-by-default.md): Before / After, eight-step tour, conversation, source-state and window-width switches |

What moves out of the inspector in the After state:

- Channel members appear as faces in the conversation header. Clicking them opens the Room tab.
- Make channel, the Session tab’s only action, is already in the header’s title menu, so nothing moves for it.
- A header toggle and ⌥⌘0 open and close the inspector. Open or closed is remembered app-wide; the selected tab still resets per conversation. When the Project tab has a Not visible, Writable or Stale warning, the toggle shows an amber dot, its tooltip names the problem, and opening it lands on the Project tab.
- Check writing and choosing a file to check open the inspector on the Check tab.
- On narrow windows the inspector overlays the transcript, and clicking outside or pressing Escape closes it.
