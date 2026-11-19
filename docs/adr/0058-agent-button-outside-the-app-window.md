# 0058. The agent button outside the app window

- Date: 2026-11-12
- Status: Proposed
- Parent: [0052](0052-circles-destination-and-floating-agent.md)
- Amends: [0052](0052-circles-destination-and-floating-agent.md) §7 (where the button lives and when it shows), §8 (the window), §9 (moving it and narrow windows); the [agent window spec](../agent-window-ux-study/spec.md)'s decisions 1 to 5, 9 and 11, its non-goals and its phases 2 to 4
- Related: [0042](0042-circle-chats.md) §13, [0051](0051-circle-notifications-and-mentions.md) §5

## Context

0052 put a button with the built-in agent's chat mark over every Boundary screen, opening a floating chat window inside the app. It is reachable only while Boundary's window is open and in front. People ask their agent things, and answer their Circles, while working in other apps: a browser, an editor, a document. Switching to Boundary, finding the screen and switching back is the cost 0052 set out to remove, now paid at the app boundary instead of the screen boundary.

Closing Boundary's window on macOS today destroys it (`src/main/index.ts`, the `closed` handler). The renderer goes with it, and so does phase 1's `ChatRuntimeHost`, which holds every open agent chat's runtime, its live turn and its draft. The app keeps running with its Dock icon, and a Dock click builds a new window.

A throwaway spike on Electron 45 checked the one way of building this that keeps phase 1's shared state: the hidden main window opens two child windows with `window.open` and draws into them, so all three share one JavaScript context. Measured on this Mac:

- `setWindowOpenHandler` accepts frameless, transparent, always-on-top windows of the macOS `panel` type. The children have no parent window, so hiding the main window leaves them showing.
- With the main window hidden and `backgroundThrottling` off, a fake reply streamed into a child at full rate and every window drew at 120 frames a second. The child's text matched the shared state, and a draft typed in one window showed in the other.
- With `backgroundThrottling` on, the hidden main window's timers fell to about one a second, so a live reply would stall.
- A button window that can't take focus, shown inactive, did not take focus. The panel window took focus so the user could type.
- `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })` turns the app into a background app with no Dock icon unless `skipTransformProcessType` is set.
- By hand: the button stayed on top of a full-screen app, a click on it opened the panel with the reply still streaming, and the main window came back from the Dock with the same draft.

## Decision

1. **Closing the window hides it.** The close button and ⌘W hide Boundary's window instead of destroying it. The app keeps running with its Dock icon. A Dock click, the app menu and the panel's ⤢ bring the window back as it was. ⌘Q quits as today, stopping the stack. The window's page stays loaded while hidden, with background throttling off, so a reply keeps streaming. Ending the page when the window closes is left for later.
2. **One button, on the desktop.** The button of 0052 §7 moves out of the app window into a window of its own that floats over every app, on every Space, including full-screen apps. It shows once start-up has finished, whether Boundary's window is in front, behind or hidden, and on every Boundary screen, Chat included. There is no button inside the app window. It sits above other apps' windows and below the system's menus and alerts. It can cover Boundary's own sheets, and the user moves it.
3. **It never takes focus by itself.** Showing the button or hovering it leaves the app in front where it was. A click opens the panel, and the panel takes keyboard focus so the user can type.
4. **What it shows.** The built-in agent's chat mark at 48 pixels on a 60-pixel button, as in 0052. A dot says an agent reply arrived while the panel was closed. A count says how many Circle messages are unread, marked when any of them mentions the user, as the Circles icon does (0052 §5). The mark moves while any of the agent's turns runs. With reduced motion on, it shows a steady dot instead.
5. **Moving and hiding it.** Dragging moves it anywhere on any display, and on release it snaps to the nearest edge of that display's work area, 16 pixels in. This Mac remembers the display, the edge and the offset along it. If that display is gone, the button goes to the bottom right of the main display. The context menu offers the four corners and **Hide button**. A hidden button comes back from **Show Agent Button** in the app's Window menu or a switch in Settings.
6. **The panel.** A window of its own, anchored to the button and opening toward the middle of the button's display, at least 384 by 520 pixels and at most 480 by 720, resizable from its free corner. At the top, two tabs: **Agent** and **Circles**, opening on the last one used. The tab bar carries the agent's mark and name, ⤢ and ×.
7. **The Agent tab** is 0052 §8 and agent window spec decisions 5 to 8: the chat picker with **New chat**, the line "Only you and *name* see this. It stays on this Mac.", the thread, and the composer reading "Ask *name* · only you see this". It is the same chat Chat shows.
8. **The Circles tab** lists every Circle as the dock does (0052 §2): tile, name, bold with a count when unread, the mention mark, in name order. Choosing a Circle opens the channel last open in it, with the compact `CircleThread` header's channel picker, and its direct messages. The thread keeps the Circle composer's brand edge and the line "Everyone in *Circle* gets a copy", so it never looks like the Agent tab. Starting, joining, inviting and the Circle tab stay in the app; ⤢ opens them there. Unread clears and notifications stay silent for a channel only while it is open in the panel and the panel has focus, as 0051 §5 does for the app window.
9. **Closing the panel.** Escape, × or the button close it. Clicking into another app leaves it open, so the user can read there and type here. The chat or channel, its scroll position and its draft stay as they were. A running turn keeps running and the button shows it.
10. **⤢** opens what the panel shows in Boundary's window, brings the window forward and closes the panel, keeping the draft.
11. **Shortcuts.** ⌘J opens and closes the panel while Boundary is in front, from any screen. A system-wide shortcut is off by default; Settings can set one. It never defaults to ⌘J, which other apps use.
12. **The panel sees nothing behind it.** 0052 §10 holds across apps: nothing from another app, the screen, or a Boundary screen reaches the agent or a Circle through the panel. Paste works as in any chat. Dropping text or files onto the panel is refused. Screen sharing shows the button and the panel like any other window.
13. **One Circles state.** The panel and the Circles destination share which channel is last open in each Circle and one draft per channel or direct message, as the Agent tab and Chat share agent chats. A channel can be open in both at once and shows the same messages and draft.
14. **Where things open.** A system notification's click, a share toast's **Open** and other links keep opening Boundary's window as 0052 §6 says, since the user asked for the app. Menus, pickers and confirmations started in the panel draw in the panel. **Share to Circle…** and interrupts that fit 384 pixels (approvals, credential prompts) draw in the panel; one that doesn't fit shows a line that opens it in Boundary's window.
15. **When the stack or Circles is down.** The button stays. The Agent tab shows the same state line Chat shows when the agent can't answer, and the Circles tab the dock's line when Circles can't connect (0052 §2). While the quit screen shows, and before an update installs, the button and panel close.
16. **macOS only for now.** On Windows and Linux, closing the window keeps quitting, and 0052's in-window button stays as built. A tray icon and a desktop button there are a later decision.
17. **Behind a switch at first.** Settings gets **Keep the agent button on the desktop**. It starts on in test builds and off in release builds until it has been tried there. Turning it on gives §1 to §15. Off, the app behaves as before this ADR: closing destroys the window, and 0052's in-window button shows. Turning it off while the window is hidden brings the window back first. The switch goes once the desktop button is the default everywhere it ships.

## How it is built

The spike's shape. The main window's page opens the button and the panel with `window.open` and renders into them with React portals, so they read the same stores as the app: `ChatRuntimeHost`, the Circle stores, drafts, unread counts. Main's `setWindowOpenHandler` gives them their options (frameless, `type: 'panel'`, always on top at the `floating` level, the button transparent and unfocusable, both without a parent window), then sets `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })`. Main owns where the windows sit, using the `screen` API, and the page asks it over IPC. The children get the app's stylesheets copied into their documents. The main window runs with `backgroundThrottling: false`.

The spike drew plain DOM. Much of the real UI binds to the global `document` and `window`: dismiss handlers, menus and pickers that portal to `document.body`, `document.hasFocus()` for 0051 §5's silence, and the app's keyboard shortcuts. Each has to take the document it renders in, or its listeners and popovers land in the hidden main window. The first build step renders the real Agent thread, a menu and the Circle composer in a child window to size that work. If it turns out unworkable, the fallback is a second page for the panel that leases chat state from the main page over IPC, at the cost of carrying the live turn across as phase 1 did within one page.

## Consequences

- The agent's chats stay one state across Chat, the Agent tab and the hidden window, because there is one page. A crash of that page takes the button and panel with it. The app reloads the page, which reopens the button.
- With throttling off, the hidden page keeps running animation frames and timers at full rate. Work that only matters on screen, such as animations and animated marks, has to pause on a hidden-window signal from main, or the hidden app costs battery.
- With the switch on, 0052's in-window button and its pieces stop showing: `AgentButton` inside `ProductReadyShell`, the in-window spot, the Circle composer's right margin and the narrow-window sheet (0052 §9, spec decision 11). They stay for the switch's off state and for Windows and Linux (§16, §17), so 0052's agent window spec phases 3 and 4 are still built for them. The mark's 48-pixel size and phase 1's runtime host are used by both.
- Two code paths while the switch exists: close behaviour in main, and which button the shell mounts. Tests cover both.
- The button is always on screen, so it covers something in every app. Snapping, the corners and **Hide button** leave the user in charge.
- Circle messages can now be sent from over another app. The brand edge, the audience line and the separate tab are what keep 0042 §13's line between a private agent chat and a message every member gets.
- Out of scope: ending the page when the window closes, a menu bar icon, the agent reading the screen (still its own ADR), and chats with agents other than the built-in one.
