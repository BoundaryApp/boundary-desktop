# Agent window: living spec

| | |
| --- | --- |
| Status | Proposed |
| Visuals | None in the repo yet |
| Started | 11 Nov 2026 |
| Builds on | [ADR 0052](../adr/0052-circles-destination-and-floating-agent.md) §7–10, [ADR 0058](../adr/0058-agent-button-outside-the-app-window.md), [ADR 0042](../adr/0042-circle-chats.md) §13, [ADR 0023](../adr/0023-chat-types-and-hermes-home.md), [ADR 0024](../adr/0024-chats-belong-to-projects.md), [Circles screen spec](../circles-ux-study/spec.md), [Circle chats spec](../circle-chats-ux-study/spec.md) |

## Progress

| Phase | Status | Depends on |
| --- | --- | --- |
| 1 A chat open outside Chat | Built; not yet tried in the app | — |
| 2 The button | Built; not yet tried in the app. Until phase 3 it opens Chat | — |
| 3 The window | Not started | 1, 2 |
| 4 Narrow windows | Not started | 3 |
| 5 UI in another document | Built; not yet tried in the app | — |
| 6 The switch, and closing hides the window | Built; not yet tried in the app | — |
| 7 The desktop button | Built; not yet tried in the app | 5, 6 |
| 8 The panel's Agent tab | Built; not yet tried in the app | 7 |
| 9 The panel's Circles tab | Built; not yet tried in the app | 7 |
| 10 Pausing hidden work and shortcuts | Built; not yet tried in the app | 6, 8 |

Phases 1 and 2 can run at the same time. Phases 5 to 10 build [ADR 0058](../adr/0058-agent-button-outside-the-app-window.md): on macOS, with **Keep the agent button on the desktop** on, the button and a panel float over every app, and decisions 1 to 5, 9 and 11 below give way to that ADR. With the switch off, and on Windows and Linux, phases 2 to 4 hold. Phase 8 builds the agent chat view that phase 3 reuses. Nothing here depends on the Circles destination, but the window is most useful once Circles has its own screen (Circles screen spec phase 10).

## Goal

A user on any screen, most often a Circle channel, can ask their agent something without leaving that screen, and come back to the same chat later from the same button or from Chat. Nobody mistakes the window for a Circle channel, and nothing from the screen behind it reaches the agent.

## Decisions

ADR 0052 holds what the button and window are and what they see. These are the screen's.

1. **Where the button shows.** Over every screen once start-up has finished, except Chat. It stacks above screen content and below sheets, dialogs and menus, so a sheet always covers it. It is 60 by 60 pixels with the built-in agent's chat mark at 48 pixels, as in the mockups, on the raised surface with a 1px border and the shadow sheets use.
2. **What it says.** Its label is "Ask *name*" with ⌘J in the tooltip. A dot in the accent colour on its top right says a reply arrived while the window was closed; opening that chat clears it. While a turn runs in any of the agent's chats, the mark plays the running animation `WorkingDot` uses in Chat, and stops when the turn ends. With reduced motion on, it shows the dot steady instead.
3. **Moving it.** Dragging moves it freely, and on release it snaps to the nearest edge of the window's content area, 16 pixels in, never over the icon rail. While dragging, the four corners show as outlined slots and the edge it will snap to is highlighted. Its spot is stored on this Mac as an edge and an offset along it, so it lands in the same place at any window size. The context menu offers **Bottom right**, **Bottom left**, **Top right** and **Top left**. A click that moves less than 4 pixels opens the window instead of dragging.
4. **Its default spot.** Bottom right. At that spot the Circle composer reserves a right margin so the button never covers the send button. Chat needs none, since the button isn't there. Elsewhere it can cover content, and the user moves it.
5. **The window.** It opens from the button toward the middle of the app window, at least 384 by 520 pixels and at most 480 by 720, and the user can resize it from its free corner. It holds, from the top:
   - the agent's mark and name, a chat picker, **New chat**, ⤢ and ×
   - a line: "Only you and *name* see this. It stays on this Mac."
   - the thread, laid out for 384 pixels as `CircleThread`'s compact layout is
   - a composer whose placeholder reads "Ask *name* · only you see this", with no project chip and no brand edge
6. **Which chat.** It opens on the chat last open in the window, or, the first time, the most recent chat with the agent. The picker lists the agent's recent chats, newest first, with their projects. **New chat** starts one as ⌘N does in Chat, in the same project.
7. **One chat, two views.** The window shows the same chat Chat would, with its history, approvals and interrupts. A message sent in either shows in both. ⤢ opens the chat in Chat and closes the window, keeping the draft.
8. **Closing.** Escape, × or the button close it. The chat, its scroll position and its draft stay as they were. A running turn keeps running and the button shows it.
9. **Focus.** Opening moves focus to the composer, and closing returns it to the button. ⌘J opens and closes it from any screen but Chat, where it does nothing.
10. **Nothing passes through.** The window takes no input from the screen behind it: no drag and drop from a Circle message, no selection, no **Ask about this**. Paste works as in any chat. **Share to Circle…** in a message's **More** menu is the only way out, as in Chat.
11. **Narrow windows.** Below 720 pixels of app window width, the window opens as a full-height sheet from the button's side, 384 pixels wide or the full width below 420.

## Non-goals

- The agent reading what's on screen, even with the user's say-so. That needs its own ADR.
- Chats with agents other than the built-in one, and Hermes channels or DMs.
- A detached window outside the app window, and a button outside the app, except as [ADR 0058](../adr/0058-agent-button-outside-the-app-window.md) builds them behind its switch.
- Starting a call, sharing a folder or any other Chat action not on a message.

## Risks and open questions

- **A turn started in the other view.** The Workbench chat's runtime streams only turns it started, and loads a reply it didn't stream once the turn ends. A turn started in the window and then opened in Chat with ⤢ would show no text until it finishes. Phase 1 has to carry the live turn across, not only the history.
- **Interrupts in 384 pixels.** Approvals, credential prompts and coding-access choices were laid out for Chat's width. Each one either fits the compact thread or shows a line that opens it in Chat. Phase 3 lists which.
- **The button covering content.** Snapping and the corner menu leave the user in charge, but a default spot that covers something important on one screen needs a per-screen margin like the composers'. Testing should look for it.
- **Two surfaces, one draft.** Decision 7 needs the draft to belong to the chat, not the surface, so typing in the window and then opening Chat shows the same text. Since the button is hidden on Chat, both are never on screen at once; if that changes, the draft needs one owner.

## Build order

**1 A chat open outside Chat.** Pull what the Workbench chat holds for the open agent chat (history, the running turn, the draft) into state that a second surface can mount. Chat keeps working as it does. A mounted test with two surfaces on one chat: a message sent in one shows in the other, and a turn started in one streams in the other.

**2 The button.** The overlay layer above screens and below sheets, the button, its dot and running state, ⌘J in `useAppShortcuts.ts` and the app menu, drag, snap, the stored spot and the corner menu. The built-in agent's mark gains a 48-pixel size in `BuiltinAgentMarkProps`, and the default mark draws at it. The Circle composer's right margin at the default spot. Until phase 3, pressing the button or ⌘J opens Chat.

**3 The window.** Anchoring, resize, the header and picker, the privacy line, a compact layout for the Workbench thread and composer, ⤢, closing and focus. The list of interrupts that open in Chat.

**4 Narrow windows.** The sheet below 720 pixels, checked at 640 and 400 pixels wide in both themes in headless Chromium.

**5 UI in another document.** Dismiss handlers, popovers, select and tooltip portals, shortcuts and focus checks take the document they render in. A check that the real thread, a menu and the Circle composer work in a child window decides whether ADR 0058's one-page approach goes ahead.

**6 The switch, and closing hides the window.** The Settings switch with its per-build default, close hiding the window, background throttling off while the switch is on, and the desktop windows closing before quit and update installs.

**7 The desktop button.** Main opens the button and panel windows for the page, places them on a display and remembers the spot. The button's drag, snap, corners, **Hide button**, reply dot, running mark and Circle unread count.

**8 The panel's Agent tab.** Tabs, header, closing and focus, refused drops, the agent chat view with its picker, privacy line and ⤢, and the list of interrupts that open in Boundary's window.

**9 The panel's Circles tab.** The Circle list, the compact Circle thread with its channel picker and direct messages, last channel and drafts shared with the Circles destination, and silence for the channel the focused surface shows.

**10 Pausing hidden work and shortcuts.** Animations and loops that only matter on screen pause while the window is hidden. ⌘J toggles the panel, and Settings can set a shortcut from any app.

## Acceptance criteria

- [ ] **1.** The button shows on every screen but Chat, and every sheet and dialog covers it.
- [ ] **2.** ⌘J opens the window from any screen but Chat and closes it again, and focus goes to the composer and back to the button.
- [x] **3.** A message sent in the window shows in Chat for the same chat, and the reverse.
- [x] **4.** A turn started in the window and opened in Chat with ⤢ keeps streaming.
- [x] **5.** A reply that arrives while the window is closed puts a dot on the button, and opening that chat clears it.
- [x] **6.** The button lands where it was dropped after a restart and after the app window is resized, and the corner menu moves it without dragging.
- [ ] **7.** At its default spot the button covers neither composer's send button.
- [ ] **8.** Nothing from a Circle channel, or any other screen, enters a message the user didn't type or paste.
- [ ] **9.** The window reads "only you see this" in its line and placeholder and carries no Circle brand edge.
- [ ] **10.** Below 720 pixels wide the window opens as a sheet, with no horizontal scroll at 400 pixels.
- [ ] **11.** With the desktop switch on, closing Boundary's window hides it, a Dock click brings it back as it was, and ⌘Q quits with the panel open.
- [ ] **12.** The button shows over another app in full screen and on every Space, and showing or hovering it leaves that app in front.
- [ ] **13.** A reply streams in the panel while Boundary's window is hidden, and ⤢ opens the same chat in Chat with the draft kept.
- [x] **14.** The button lands where it was dropped after a restart, and moves to the main display's bottom right when its display is gone.
- [ ] **15.** A Circle message sent from the Circles tab shows the brand edge and "Everyone in *Circle* gets a copy", and the Agent tab never does.
- [x] **16.** The switch defaults on in test builds and off in release builds, and turning it off while the window is hidden shows the window.
