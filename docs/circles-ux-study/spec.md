# Circles screen: living spec

| | |
| --- | --- |
| Status | Proposed; [ADR 0043](../adr/0043-circles-live-in-the-chat.md) retired the destination, and [ADR 0052](../adr/0052-circles-destination-and-floating-agent.md) brings back one for talking in Circles (phases 10 and 11) |
| Visuals | [prototype.dc.html](prototype.dc.html) (click-through source) |
| Started | 31 Oct 2026 |
| Builds on | [ADR 0032](../adr/0032-circles.md), [ADR 0034](../adr/0034-shared-models.md), [ADR 0036](../adr/0036-shared-model-app-default.md), [circles plan](../circles-plan.md), [settings spec](../settings-ux-study/spec.md) |

## Progress

| Phase | Status | Depends on |
| --- | --- | --- |
| 1 List and detail | Built; live check pending | — |
| 2 People and the person panel | Built; live check pending | 1 |
| 3 Sharing | Built; live check pending | 2 |
| 4 Invites and joining | Built; live check pending | 1 |
| 5 Links from the rest of the app | Built; live check pending | 2, 3 |
| 6 Usage | Built; live check pending | 3 |
| 7 Circle tab and person drill-in | Built; live check pending | Circle chats phase 3 |
| 8 Start and join sheets | Built; live check pending | 7 |
| 9 Retire the destination | Built; live check pending | 7, 8, settings spec phase 3 |
| 10 Circles destination for talking | Built; not yet tried in the app | 9 |
| 11 A Circle row’s menu | Built; not yet tried in the app | 10 |
| 12 The open Circle above a dock | Built; not yet tried in the app | 11 |

Phases 7 to 9 move this screen's parts into the chat and into Inference ([ADR 0043](../adr/0043-circles-live-in-the-chat.md)): membership to the chat's Circle tab, sharing, trust and use to Inference. Decisions 1, 4, 7, 8, 10, 13, 14 and 15 change there; the rest still describe the parts, wherever they're mounted. Phases 10 and 11 bring back a Circles destination that holds only Circles' conversations ([ADR 0052](../adr/0052-circles-destination-and-floating-agent.md)), as decisions 16 to 21 describe. Nothing about models comes back with it. Phase 12 splits the rail into the open Circle and a dock of every Circle, as decision 22 describes; it replaces decision 17's list.

## Goal

A user can see who is in a Circle and what each person shares, and go from "Maya shares a model" to "Maya's model answers my chats" on one screen. A provider can tell at a glance whether members can use their models, and why not.

## What the current screen gets wrong

Everything sits in one scrolling page: identity, the global sharing panel, the create and join forms, then a card per Circle. Three kinds of thing are mixed there.

Sharing to a Circle takes two controls far apart: a tick in the panel at the top and a switch in that Circle's card. Trust belongs to a person, but it appears once per Circle, so one person in two Circles has two sets of switches that change together. A member who trusts someone in Circles has to go to Settings to use the model.

## Decisions

1. **List and detail.** The Circles destination has a 256px list and a detail pane, like the chat rail. The list holds **Sharing**, then the user's Circles, then a line with their name, connection state and **Profile**. Opening the destination restores the last selection.
2. **Each thing lives with its owner.** Models, pause and away mode belong to this Mac, so they're on **Sharing** and not in any Circle. An offer belongs to a person, so it's on that person's row. Trusted and Private belong to a person across Circles (ADR 0034 §3), so they're in the person panel.
3. **A Circle's page is its people.** Each row shows the person's presence, role, models and whether the user trusts them. There is no separate shared models list. A dot is green only when that person's model can be used now, amber when they're online and paused, and grey when offline.
4. **The person panel is one component.** A 320px panel on the right opens from a Circle's row and from a row in **Sharing**, so the list stays in view and the user can move between people. It holds the two switches, the person's models with **Use as default** and **Add as fallback**, and, for an admin viewing a Circle, **Make admin**, **Make member** and **Remove**. Setup's Model step (ADR 0036) and the Models destination's **Trust Maya** use the same content.
5. **Use comes after trust, in place.** The use buttons stay disabled until the provider is Trusted, as main already requires (ADR 0036 §3), and the line under them says so. Turning Trusted off for the model in use leaves it chosen but stale (ADR 0036 §5), and the panel says chats can't use it.
6. **Sharing has two sections.** **Shared from this Mac** holds status, **Pause sharing**, the server's models, a switch per Circle and **Away mode**. **From your Circles** lists every model offered to the user, one row per person and model, with its state. With no local model and nothing shared, the first section is gone.
7. **The You row stays a shortcut.** It has a **Share here** switch, the same state as the switch on **Sharing**. It appears only when the user can share.
8. **Sharing is not the Models destination.** The settings spec's Models destination is where the user orders what answers their chats. **Sharing** is what they offer and what's on offer. The Local entry there shows a status line that links here, and the controls stay in one place, because a switch in Settings caused a failed two-Mac test. When Models ships, the two use buttons become **Add to stack**, as "fallback" leaves the UI then.
9. **Words.** The UI says **Allow in private projects** for the Private setting, because "Private" reads oddly on a person. **Trusted** stays. The code and ADRs keep `private`.
10. **Start or join, once.** With no Circles the detail pane is a welcome screen: name, **Start a Circle**, **Join with an invite**. After that, both live behind **+** in the list.
11. **Invites are a sheet.** It creates a code with an optional **Who is it for?** label, says which admins must be online, and lists open invites by label. The label stays on this device and never enters the Autobase. Codes aren't stored after they're made, so the sheet says to copy the code now, and a lost code means revoking and making another.
12. **Joining has its own state.** A join shows a **Joining…** row and a waiting page, and it survives leaving the screen. **Cancel** stops it. Failures show on that page.
13. **Problems reach the user wherever they are.** A sharing problem sets a warning dot on the Circles icon, and **Sharing**'s status line in the list names it. A banner on **Sharing** carries the fix.
14. **No tab bar.** Circle chats open in the Workbench chat instead of a Chat tab here ([ADR 0042](../adr/0042-circle-chats.md) §10), and a Circle's header gets **Open chat**, which switches the chat to that Circle. This replaces the earlier plan for a Chat tab. Once phase 9 ships there is no Circles screen, and the Circle tab in the chat's inspector takes this page's place ([ADR 0043](../adr/0043-circles-live-in-the-chat.md)).
15. **Diagnostics moves to Profile.** So do the display name and renaming.
16. **Circles is in the icon rail again, after Chat.** It is the only way into a Circle, and Chat shows This Mac alone with no place switcher. Shortcuts follow the rail: ⌘1 Chat, ⌘2 Circles, ⌘3 Inference, ⌘4 Services, ⌘5 Resources. ⌘N still opens a new chat in Chat.
17. **The list is the Circles rail.** It is 256px, like the chat rail. From the top: **Circles** with `+`, a menu of the start and join sheets from phase 8, a search field that filters Circles by name, a **Joining a Circle…** row while a join waits, **Unread** with Circles that have unread messages, those that mention the user first, then by unread count, then **All Circles** with its count, by name. A Circle with unread messages appears in both groups. Each row has the Circle's tile, name, unread count and, with a mention of the user unread, "@" before the count. The open Circle's row expands in place, once, under the row where it first appears, to its channels with their counts and its shared folders, and admins get the channels' `+`; every other Circle stays one row. With nothing chosen, Circles opens the first Circle by name without remembering it as a choice. People move out of the rail into the Circle tab, which the header's panel button opens. The **Unread** group is hidden when empty, and search hides both headings and lists matches by name. Decision 22 replaces this list from phase 12.
18. **No Circles, and no connection.** With no Circles the list says what a Circle is and offers **Start a Circle…** and **Join with an invite…**, and the main area shows the same. When the Circles process can't connect, a line under the heading says so and links to the **Circles profile** row in Settings.
19. **A Circle's screen is phase 7's.** The channel, its header with the panel button, and the Circle tab, unchanged. Each Circle reopens on the channel last open in it, a Circle opened for the first time opens **General**, and opening Circles reopens the Circle last open.
20. **A row's ⋯ menu.** On hover or focus a row shows ⋯, also opened by the row's context menu: **Invite someone…** (admins), **Circle details**, a **Notifications** submenu with the four levels of the Circle notifications spec decision 5, and **Leave…** (**Delete Circle…** for its last member, as in the tab). Each opens the Circle tab or the sheet it already has.
21. **Counts move to the Circles icon.** It carries the unread total across Circles, with "@" when any of it mentions the user. The Chat icon no longer counts Circle messages.
22. **The open Circle stays put; every Circle sits in a dock below it.** Decision 17's list made the rail jump: the open Circle's channels opened under whichever row came first, so at a different height for each Circle, and reading a Circle moved it out of **Unread** while the user looked. The rail now has two parts in fixed places.
    - **The Circle area** is the top. A header holds the open Circle's tile, name and the ⋯ menu of decision 20. Under it, **Channels** with counts and the admins' `+`, **Direct messages**, then **Folders** with **Share a folder…**, scroll together. Switching Circles changes what the area shows; the header and the first channel stay where they were. While the joining page is open, the header reads **Joining a Circle…** and the area holds nothing else; a join doesn't know the Circle's name until it's let in.
    - **The dock** is the bottom, under a drag grip. From the top: **Circles** with `+` (the start and join menu of decision 17), a search field, the **Joining a Circle…** row and **Leaving…** notes while they last, then every Circle by name. A Circle with unread messages is bold with its count, and "@" before the count for an unread mention. The open Circle's row is selected and has no count, since its channels carry it. Rows keep their order as messages arrive and are read. Search filters the dock and nothing above it. Each row keeps decision 20's ⋯ menu.
    - **The chip.** When rows with unread messages are scrolled out of the dock, a chip at its bottom edge reads "3 unread ↓" (or ↑ when they're above) and scrolls the nearest into view. It goes when none are hidden.
    - **Height.** The dock opens about six rows tall. Dragging the grip resizes it; it can't go below three rows or leave the Circle area fewer than four. This Mac keeps the height. In a window too short for both minimums the dock gives way first, then both scroll.
    - **No Circles.** The Circle area goes and the dock fills the rail with decision 18's explanation and both sheets. The can't-connect line sits under the dock's heading.
    - **Links don't move the dock.** A share toast's **Open**, a notification's click or a row's ⋯ action opens the Circle in the Circle area. The dock doesn't scroll to its row.
    - **What goes.** The **Unread** group, the **All Circles** heading and its count, and channels expanding under a Circle's row.

## Where each flow goes

| Flow | Today | Proposed |
| --- | --- | --- |
| First visit | Name form, then two forms | Welcome screen |
| Create or join again | Forms always on the page | **+** in the list |
| Invite | Inline code; open invites by id | Sheet with labels |
| Join | Busy button in a form | **Joining…** row and waiting page |
| Change role, remove | Buttons on every row | Person panel |
| Leave | Button on the card | **Leave** in the Circle's header |
| Share a model | Tick at the top, switch in the card | **Sharing**; **Share here** as a shortcut |
| Pause, away mode | Panel at the top | **Sharing** |
| Use a shared model | Trust in Circles, pick in Settings | Person panel |
| Setup with no model | Offer rows and a separate picker | Join, then person panel content |
| Local server stops | Panel warning on this screen | Icon dot, list status, banner |
| A chat stops on a shared model | Message with the reason | Message links to the person panel |
| Provider checks usage | Not built | Table on **Sharing** |

## Non-goals

- Sharing different models with different Circles. `CircleSharing` holds one model list.
- New Autobase operations. Nothing here changes `apply`.
- Renaming a Circle, and avatars. Both need a Circle or member field that doesn't exist.
- Invite links, which ADR 0032 allows. Codes stay until links are designed.
- The composer chip's list. The settings spec owns it.

## Risks and open questions

- **One model, two Circles.** A chain entry names a Circle as well as a provider, so one row can stand for two possible entries. **Use** saves the first Circle offering it where the provider is online, or the first offering it otherwise. Leaving that Circle makes the entry stale even if another Circle still offers the model. The router could look for the offer in any shared Circle, which needs a check against ADR 0033 §10.
- **Cancel stops only a waiting join.** Nothing is kept, because a device isn't in a Circle until an admin admits it. Once it's admitted, cancelling does nothing and the join finishes.
- **Offers stay published as available** when the provider's server is down. Members see a model that fails until they try it. Fixing that is a network change outside this spec.
- **Tokens depend on the server.** Tokens come from each reply's `usage` field. A server that leaves it out counts requests only, so a token limit never stops its members.
- **Short windows.** The dock's three rows and the Circle area's four need about 330px under the titlebar. The main window sets no minimum height, so below that both parts scroll, as decision 22 says. Setting a minimum height is a separate choice.
- **Window width.** Icon rail, list and panel leave about 640px at a 1280px window. The panel should cover the detail pane below that width. The minimum window size needs checking.

## Build order

**1 List and detail.** The shell, the welcome screen, **+**, Profile. Existing cards move into the detail pane unchanged, and the sharing panel moves to **Sharing**. No new IPC.

**2 People and the person panel.** New rows replace `MemberRow` and `OfferRow`. Setup moves to the shared panel content. Add the use buttons through `chooseSharedModel` and the chain's fallback path.

**3 Sharing.** The two sections, **Share here**, the deduplicated list of offers. Rewrite `docs/testing/circle-sharing.md`.

**4 Invites and joining.** The sheet, labels in main's Circles store, join state outside the form, cancel.

**5 Links from the rest of the app.** A navigation request that names a person or **Sharing**, used by the chain editor, the chat's stop message and the Local card. The icon dot.

**6 Usage.** Who is running or queued, requests and tokens today, and daily limits (ADR 0034 §5). Members see only their own totals.

**7 Circle tab and person drill-in.** The Circle tab from Circle chats phase 3 gains invites, **Leave** and the membership panel inside it with **Back**, opened from the tab, the rail's People and who-lines, with **Open in Inference** for what a person shares.

**8 Start and join sheets.** **Start a Circle…** and **Join with an invite…** in the switcher's menu, the **Joining…** row and its waiting page in the chat area, and the no-Circles menu.

**9 Retire the destination.** Once Inference (settings spec phase 3) holds Sharing and per-person trust: remove the Circles icon and `CirclesScreen`, move the warning dot to Inference, add the **Circles profile** row to Settings, and point every navigation request that named the Circles screen or a person's panel at the Circle tab or Inference. Re-check criteria 1, 3 and 8 against the new places.

**10 Circles destination for talking.** The Circles icon after Chat and the shortcut shift in `useAppShortcuts.ts`, `appCommands.ts` and the app menu. The list of decisions 17 and 18. The Circle place, `CircleThread` and the Circle tab move from the Workbench chat to the destination as they are; the place switcher, the Circle half of the place store and the chat screen's Circle branch go, and the start and join sheets and the joining page move to the list. Every link that switched to a Circle's place opens the destination at that channel: the share toast's **Open**, a notification's click, and the Circle tab's links. The viewing report of the Circle notifications spec comes from the destination, so a channel open there with the window focused stays silent. Counts move to the Circles icon. Rewrite criteria 1 and 14 for the destination, and mounted tests that Chat shows no Circle anywhere, that a share toast's **Open** lands on the channel, and that the Circles icon's count matches the list.

**11 A Circle row's menu.** The ⋯ menu and its context-menu twin, each item opening the Circle tab section or sheet it names.

**12 The open Circle above a dock.** Decision 22. `CirclesList` splits into the Circle area's header and the dock, and `CirclePlace` hands the Circle area its channels and folders in place of the `expanded` slot. The dock's height is a renderer preference on this Mac; it needs no IPC and no change to the Circles process. The chip watches which unread rows are in view. Mounted tests in `CirclesScreen.test.tsx`: reading a channel and a new message arriving leave the dock's order unchanged; switching Circles keeps the header and the first channel at the same offset; the chip appears with the right count and direction and scrolls to the row; a link to a Circle doesn't scroll the dock; the grip's height survives a remount and respects both minimums. Rewrite the cases that assert the **Unread** group and the expanded row. Criterion 18 is re-checked in the app.

## Acceptance criteria

- [x] **1.** A user with two Circles can switch between them from the Circles list, and leaving Circles and coming back reopens the Circle and channel last open.
- [x] **2.** Someone in two Circles appears with one set of switches, and a change shows in both Circles at once.
- [x] **3.** A member can trust a provider and add their model to the Chat stack without leaving Inference.
- [x] **4.** Use buttons stay disabled until the provider is Trusted, and main refuses the choice if the renderer is wrong.
- [x] **5.** A paused provider's dot is amber on the Circle page and in **Sharing**, and a provider who is offline is grey.
- [x] **6.** A user with no local model and nothing shared sees no **Shared from this Mac** and no **Share here**.
- [x] **7.** Turning off a Circle's switch on **Sharing** turns off **Share here** in that Circle, and the reverse.
- [x] **8.** With the local server stopped, the Inference icon shows a dot from any screen, and the panel in Inference says the server isn't responding.
- [x] **9.** An invite's label never appears in the Circle's log or on another device.
- [x] **10.** A join in progress survives navigating away, shows its failure on return, and can be cancelled.
- [x] **11.** The chat's stop message for a shared model opens that person's panel.
- [x] **12.** Only admins see role and remove actions, and the remove dialog keeps the wording ADR 0032 requires.
- [x] **13.** Usage counts appear only on the provider's and that member's own Macs.
- [x] **14.** Every Circle, invite, join and member is reachable from the Circles list, the Circle tab or a sheet, and nothing on Circles manages models.
- [x] **15.** No control in a Circle place changes a model setting; sharing, trust and use are only in Inference.
- [x] **16.** A link about a person's model opens Inference at their row without changing the chat's place.
- [x] **17.** Circles is reachable from the icon rail and ⌘2, Chat shows no Circle, and a Circle opens nowhere else.
- [ ] **18.** A user in 25 Circles sees how many have unread messages without scrolling, from the bold rows in view and the chip, and search finds one by name. (Before phase 12: sees which have unread messages without scrolling.)
- [x] **19.** A share toast's **Open** and a notification's click open the Circles destination at the right channel and scroll to the message.
- [x] **20.** No notification fires for a channel open on the Circles destination while the window is focused.
- [x] **21.** The Circles icon shows the unread total and "@" for an unread mention; the Chat icon counts no Circle message.
- [x] **22.** Every item in a row's ⋯ menu opens the same Circle tab section or sheet as its control in the tab.
- [x] **23.** Switching between any two Circles leaves the Circle area's header and first channel where they were.
- [x] **24.** No row in the dock changes place when a message arrives or a channel is read.
- [x] **25.** With unread rows scrolled out of the dock, the chip says how many and which way, and clicking it brings the nearest into view.
- [ ] **26.** The dock's height survives quitting and reopening the app, and neither part of the rail drops below its minimum.
