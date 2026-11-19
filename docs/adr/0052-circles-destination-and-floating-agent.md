# 0052. A Circles destination for talking, and the built-in agent over every screen

- Date: 2026-11-10
- Status: Proposed
- Parent: [0042](0042-circle-chats.md)
- Amends: [0042](0042-circle-chats.md) §10 (places and the switcher); [0043](0043-circles-live-in-the-chat.md) §1 (no Circles destination), §7 and §8 (start, join and no-Circles in the switcher's menu); [0051](0051-circle-notifications-and-mentions.md) §5 and §7 (where silence and a click resolve); the [Circle chats spec](../circle-chats-ux-study/spec.md)'s decisions 1 to 4, 7 and 13
- Revised: 2026-11-12, §2 (the open Circle stays at the top of the rail, above a dock of every Circle in name order)
- Related: [0014](0014-tabbed-inspector.md), [0023](0023-chat-types-and-hermes-home.md), [Circles screen spec](../circles-ux-study/spec.md)

## Context

0042 §10 made each Circle a place in the Workbench chat, reached from a switcher at the top of the chat rail, and 0043 retired the Circles destination so that the switcher was the only way in. In use, two problems showed.

Circles are hidden. The switcher shows one total for every other place, and the Chat icon one total for all Circles. Which Circle is talking, and whether someone mentioned you, takes opening the menu. A user in 20 or more Circles scrolls a dropdown.

The agent is out of reach. A Circle's rail has no chats with the built-in agent, by design (0042 §10, §13), so asking the agent something while reading a channel means switching to This Mac and back. People do this often.

0043 removed the old Circles destination for two reasons. Two ways led into one Circle: the destination and the switcher. And the destination mixed who is in a Circle with which models answer this Mac's chats. Both are now settled elsewhere: sharing, trust and use live in Inference (0043 §2), and membership lives in the Circle tab (0043 §3–5). A destination that only holds Circles' conversations brings back neither problem, provided it is the only way in.

0042 §13 still holds: a chat with the agent stays on this Mac, a Circle message goes to every member and can't be taken back, and the two must never be mistaken for each other.

## Decision

1. **Circles is a destination again, for talking in Circles.** It sits in the icon rail after Chat. It is the only way into a Circle. Chat shows This Mac alone, and the place switcher goes. Shortcuts follow the rail: ⌘1 Chat, ⌘2 Circles, ⌘3 Inference, ⌘4 Services, ⌘5 Resources.
2. **Its rail shows the open Circle above a dock of every Circle.** The top of the rail belongs to the open Circle: its tile, name and the ⋯ menu of §3, then its channels, direct messages and shared folders, which scroll together. Switching Circles changes what this area shows and nothing about where it is. Below a drag grip, the dock lists every Circle by name, under **Circles** with `+` for the start and join sheets of 0043 §7 and a search field that filters by name. Each row has the Circle's tile and name; a Circle with unread messages is bold with its count and, from 0051, a mention mark. The order never changes as messages arrive or are read. When unread rows are scrolled out of the dock, a chip with their number scrolls to the nearest. This Mac keeps the dock's height. A join in progress is a **Joining a Circle…** row at the top of the dock, opening the waiting page of 0043 §7. With no Circles, the dock fills the rail, says what a Circle is and offers both sheets. When Circles can't connect, a line under the dock's heading says so and links to the **Circles profile** row in Settings.
3. **A row's ⋯ menu.** **Invite someone…** (admins), **Circle details**, which opens the Circle tab, the notification level from 0051 §2, and **Leave…**. Each opens the Circle tab or the sheet it already has, so management stays in one place.
4. **A Circle's screen is unchanged otherwise.** The channel, its header with the panel button, and the Circle tab as 0043 §3–5 describe them. Nothing on the Circles destination changes a model setting.
5. **Counts.** The Circles icon carries the unread total across Circles, marked when any of it mentions the user. The Chat icon no longer counts Circle messages. Each Circle reopens on the channel last open in it.
6. **Links into a Circle open the Circles destination.** A share toast's **Open** (0042 §9), a notification's click (0051 §7) and any other link that switched to a Circle's place open Circles at that channel. 0051 §5's silence applies while the channel is open on the Circles destination with the window focused. ⌘N opens a new chat in Chat.
7. **The built-in agent floats over every screen.** A button holding the built-in agent's chat mark sits over every screen after start-up, bottom right by default, except on Chat, where the agent's chats are the screen. It sits under sheets and dialogs. A dot on it says a reply arrived while it was closed, and the mark moves while a turn runs. ⌘J opens and closes it from anywhere.
8. **It opens a floating window.** At least 384 by 520 pixels, anchored to the button and opening toward the middle of the screen. It holds the agent's name and mark, a picker of the agent's recent chats with **New chat**, a line saying only the user and the agent see it and that it stays on this Mac, the thread, and a plain composer reading "Ask *name* · only you see this". ⤢ opens the same chat in Chat. Escape or the button closes the window, and the chat and its draft stay as they were. It is the same chat Chat shows, not a copy.
9. **The button can move.** Dragging it snaps it to the nearest edge, and this Mac remembers where. Its context menu offers the four corners, so it can be moved without dragging. Below a 720-pixel-wide window, the floating window opens as a full-height sheet from the button's side.
10. **The window sees nothing behind it.** No Circle message, channel or other screen's content reaches the agent through the window. The user can paste text in, as in any chat. **Share to Circle…** stays the one way from an agent chat into a Circle. Letting the agent read what's on screen, with the user's say-so, is a decision for its own ADR.

## Consequences

- §2 first had the open Circle's channels expand under its row, with Circles that had unread messages listed again in an **Unread** group. In use, the rail jumped: the channels opened at a different height for each Circle, and reading a Circle moved it out of **Unread** while the user was looking. A Circle area in a fixed place and a dock in name order trade the **Unread** group for bold rows and the chip.
- The Circle code that 0042 built into Chat moves to the Circles destination: the Circle place component, the thread and the Circle tab move as they are, and the place switcher, the place store's Circle half and the chat screen's Circle branch go. The start and join sheets and the joining page move from the switcher to the list.
- 0043's other decisions hold: models in Inference, membership in the Circle tab, profile in Settings, no Circles screen for managing Circles. This destination has no **Sharing** row, no person panel with models and no list footer.
- 0042 §13 holds without places. Circle channels and agent chats are never in the same list: one is on Circles, the other in Chat or the floating window. The window is visibly private, and the Circle composer keeps its brand edge and audience line.
- The agent's chats can be open in two surfaces at once, Chat and the floating window, so both read one chat store and a send in either shows in both.
- The button can cover content in its corner. It snaps to edges, the Circle composer keeps a right margin for it at its default spot, and sheets cover it.
- The built-in agent's mark is drawn at 14, 18 and 24 pixels today (`BuiltinAgentMarkProps`). The button needs a larger size, so the seam gains one.
- Shortcuts change from 0043's: ⌘2 moves from Inference to Circles, and the others shift by one.
- The Circle chats spec's decisions 1, 2, 3, 4, 7 and 13 change. The [Circles screen spec](../circles-ux-study/spec.md) builds the destination in phases 10 and 11, and the [agent window spec](../agent-window-ux-study/spec.md) builds decisions 7 to 10.
