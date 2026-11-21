# 0069. The inspector starts closed and opens on request

- Date: 2026-11-19
- Status: Proposed
- Amends: [0014](0014-tabbed-inspector.md) (adds open and closed states to the tabbed inspector)
- Related: [0013](0013-project-sources-inspector.md), [0020](0020-centered-transcript-column.md), [0023](0023-chat-types-and-hermes-home.md), [0030](0030-board-is-a-view-of-tasks.md)
- Mock: [`docs/inspector-ux-study/01-closed-by-default.html`](../inspector-ux-study/01-closed-by-default.html)

## Context

The right inspector (`RightInspector`, ADR 0014) is a 304px column beside the center pane. Its visibility is set only by CSS: `.wb-right` is `display: none` below a 1280px window and `flex` from 1280px up (`workbench.css`). The user can't open or close it. The only other rule is that the Tasks board leaves it out to use its width (ADR 0030).

What it holds, by tab (`inspectorTabsFor`):

- **Room** (channels): members with add and remove, and a project chip that switches to Project.
- **Agent** (DMs and side chats): role, a Soul excerpt, Open SOUL.md.
- **Session** (Marlow chats): **Make channel**. The header already offers it in its title menu, and as a button while the chat isn't filed in a project (`ThreadHead`).
- **Project**: source directories with Open, and banners for Not visible, Writable and Stale (ADR 0013). Outside a conversation it is the only tab.
- **Check**: a writing check result, added when the user presses **Check writing** on a reply or checks a project file.

None of this changes as a conversation goes on. ADR 0014 already made the Project tab silent when everything is fine. So on a wide window a third of the space beside the transcript shows reference material most of the time, and the centered column from ADR 0020 only gets room to center once the window is wider still.

Below 1280px the inspector can't be reached at all. Member management, Soul, project sources and their warnings are hidden, and **Check writing** sends its result to a Check tab nobody can see.

## Decision

1. **The inspector is closed until the user opens it.** It opens and closes from a toggle at the right end of the center pane's header, from **View → Toggle Details** (`toggle-inspector` in `appCommands`; the menu bar doesn't track the state, so it has one label), and with ⌥⌘0. ⌥⌘I is taken by the View menu's Toggle Developer Tools. A close button sits at the right of the tab strip. The toggle lives in each center pane's header (the conversation, the project page, All chats, Mentions, the Tasks list and a task page); it reads its state from a context the chat screen provides, so headers drawn elsewhere, such as the agent panel's, have none.
2. **Open or closed is one app-wide setting, remembered across restarts.** Only the renderer reads it, so it is stored in `localStorage` the way `busySendPref` is. Changing conversation keeps the inspector open or closed. The selected tab still resets per conversation, as ADR 0014 §1 says.
3. **Actions aimed at the inspector open it on their tab.** **Check writing** on a reply and checking a project file open it on Check. In a channel, a members button (faces and count) in the header actions opens Room. These open it and set the remembered state to open, the same as using the toggle.
4. **Project warnings show on the toggle.** When the Project tab would show Not visible, Writable or Stale, the toggle gets an amber dot, and its accessible name and tooltip name the problem. Opening the inspector while a warning shows lands on the Project tab. The header's project crumb keeps opening the project page.
5. **Below 1280px the inspector overlays the center pane** at its 304px width instead of pushing it, over a scrim. Clicking the scrim or pressing Escape closes it. At this width it starts closed in every conversation whatever the remembered state, and opening or closing it here doesn’t change that state, so an overlay doesn’t cover each conversation the user opens. From 1280px up it sits beside the center pane as today, and the centered column moves sideways when it toggles (accepted in ADR 0020).
6. **Make channel doesn't move.** It is already in the header, so the Session tab stays as a second place for it.
7. **The Tasks board still leaves the inspector out** (ADR 0030), and hides the toggle.
8. **The default is closed for everyone, existing installs included.** No migration keeps it open for people who had a wide window.

## Consequences

- On a wide window the transcript gets the inspector's 304px back, and the centered column from ADR 0020 shows at sizes where it couldn't before.
- Windows under 1280px gain the inspector: members, Soul, sources and warnings can be reached there for the first time, and a writing check's result appears.
- People who rely on the Project tab's sources list need one click or ⌥⌘0. The warning dot covers the cases where they need to look.
- The center pane's header gets two controls: the toggle in every center mode that shows the inspector, and the members button in channels. Both use `Button` (ADR 0061) and the header's existing spacing.
- `RightInspector` stays one component. Its open state and the warning signal for the toggle are lifted to `WorkbenchChatScreen`, which already passes it the Project tab's data.
- Tests: the mounted chat screen opens on Check after **Check writing**, keeps the open state across a conversation change, and closes the overlay on Escape. The toggle's warning state is tested from the Project tab's banner logic, not a copy of it.
