# Circle notifications and mentions: living spec

| | |
| --- | --- |
| Status | Proposed |
| Visuals | [mock.html](mock.html) |
| Started | 10 Nov 2026 |
| Builds on | [ADR 0051](../adr/0051-circle-notifications-and-mentions.md), [ADR 0042](../adr/0042-circle-chats.md), [ADR 0050](../adr/0050-gifs-in-circle-chats.md), [ADR 0038](../adr/0038-changing-circle-operations.md), [Circle chats spec](../circle-chats-ux-study/spec.md) |

## Progress

| Phase | Status | Depends on |
| --- | --- | --- |
| 1 Notifications | Built; not yet tried between two Macs | — |
| 2 Mentions behind format 3 | Built behind format 3; no Circle uses it until phase 3 | — |
| 3 Format 3 and **Update this Circle** | Not started | 2, and 0050's `media` in `apply` |

Phases 1 and 2 can run at the same time. Phase 3 is the only one that changes what a real Circle stores.

## Goal

People hear about a Circle message that's meant for them while they're working elsewhere, without a busy Circle buzzing all day. In a small Circle every message is meant for everyone; in a big one, only the ones that name them are. They can @ a person or a whole channel and everyone's Mac reads the same mention, whatever names change later.

## Decisions

ADR 0051 holds the format, storage and notification rules. These are the screens'.

1. **Notification banners.** macOS notifications through `showWindowNotification`, titled per 0051 §7. No sound setting of our own; macOS's per-app settings apply.
2. **Composer menu.** In a Circle channel at format 3, `@` at the start of a word opens the existing `MentionMenu`. Its first row is **@channel**, meta "Everyone in this Circle who hasn't turned it off". Then the Circle's people, excluding the user, online first, each with their presence dot and "Online" or "Away" as meta, filtered by the typed text against the name. **Enter** or a click inserts "@Name " and records the identity; **Escape** closes it. No agents and no project paths in Circle channels.
3. **Mentions in the thread.** "@Name" where the record lists that identity renders in the accent colour, medium weight; the user's own name renders bold as well. A message that mentions the user, by name or by @channel when **@channel notifies me** is on, gets a 3px accent rule on its leading edge, at least 3:1 against the page in both themes, and the new `--mention-fill` background, which differs from the hover fill and from `--bubble-mine`. A renamed mention shows "Mentioned: Maya" under the text in the muted colour (0051 §9).
4. **Rail and switcher.** A channel whose unread messages include a mention of the user shows "@" before its unread count, in the accent colour. The place switcher's row for that Circle and the Chat icon's count show the same "@". Reading the channel clears it, as it clears counts. Under [ADR 0052](../adr/0052-circles-destination-and-floating-agent.md) the switcher's row becomes the Circle's row on the Circles destination, and the "@" moves from the Chat icon to the Circles icon.
5. **Circle tab, Notifications.** A section in the Circle tab ([ADR 0043](../adr/0043-circles-live-in-the-chat.md)) with a segmented control **Default** · **All** · **Mentions** · **Nothing**, a line under it saying what applies and why ("Default: all messages, because this Circle has 5 people." / "Default: mentions only, because this Circle has 9 people."), and a switch **@channel notifies me**. Below format 3 in a Circle where the level resolves to mentions, the line adds "Mentions need this Circle updated by an admin."
6. **Settings.** A **Notifications** section in Settings with **Circle notifications** and **Show message text in notifications**, each with one line of explanation. The second says: "macOS keeps notifications in Notification Center and may show them on the lock screen."
7. **Update this Circle.** For an admin in a Circle below the build's format, a row in the Circle tab: "This Circle can use mentions and GIFs." with **Update this Circle…**. The sheet lists what turns on, says "Members on older versions of Boundary will see this Circle stop until they update," and has **Update** and **Cancel**. Non-admins see "An admin can update this Circle to turn on mentions and GIFs." with no button.
8. **Below format 3.** Typing `@` in a Circle channel opens nothing and inserts a plain "@".

## The public seam

**Main.**
- `CircleMessage.mentions: { members: string[]; channel: boolean } | null`. The shared `mentionsMe(mentions, identity, channelMentions)` says whether a message mentions the user: their identity is in `members`, or `channel` is set and the Circle's **@channel notifies me** is on. The network process builds messages and doesn't know that preference, so this isn't a stored flag.
- `CircleChannel.mentioned: boolean`: an unread message in the channel mentions the user. Main passes the preference with the read positions when it lists channels.
- `CircleSnapshot.format`: the Circle's format, so the composer knows whether mentions are on.
- `postCircleMessage` and `editCircleMessage` take the people picked in the composer and whether @channel was picked. Main keeps only identities whose "@Name" is still in the text, and refuses mentions below format 3.
- `circles:notify-prefs` reads `{ prefs: { level: 'default' | 'all' | 'mentions' | 'nothing'; channelMentions: boolean }; resolved: 'all' | 'mentions' | 'nothing'; people: number; global }` for a Circle, and `circles:set-notify-prefs` and `circles:set-notify-global` change them.
- `circles:viewing` from the renderer: `{ circleKey, channel } | null` and `focused`.
- `circles:open-message` to the renderer on a notification click: `{ circleKey, channel, ref }`.

**Renderer.** `useCircleChat` exposes `mentions` on messages and `mentioned` on channels. The composer's mention state lives in the Circle composer, not in `useMentionMenu`'s Hermes branch; the menu component is shared.

## Non-goals

- Direct messages (0042 §14).
- Mentioning agents in a Circle. Bringing agents into Circles has its own ADR (0042 §12).
- @here, @admins or user groups.
- Per-channel notification levels. The level is per Circle.
- A Mentions pane inside a Circle place.
- Notifications while the app is closed. Circles have no server to push from.
- Notification sounds or Do Not Disturb rules beyond what macOS provides.
- Dock badge counts.

## Risks and open questions

- **Big format 2 Circles stay silent.** Until format 3, a Circle of seven or more notifies nothing on **Default**. The Circle tab says so; if people miss messages, the threshold or the default can change without a format.
- **The six-person line.** It's a guess at where "everyone talks to everyone" stops. People can override it per Circle, and the line under the control always says why.
- **Mentions wait on GIFs.** Phase 3 needs 0050's `media` in `apply`. If that stalls, amend 0051 so mentions take format 3 alone.
- **Text in Notification Center.** With text on, message text sits in macOS's notification history, outside the app. The global switch is the answer; whether the default should be off is open.
- **Catch-up summaries.** The 1.5-second window and the more-than-three rule are tuned for a reconnect, not for a lively channel. A busy small Circle could send three banners in a row every few seconds; the per-Circle level is the remedy.
- **Read positions under reorder.** A message can count as unread after its order settles (Circle chats spec, risks). The notifier uses the same comparison, so it can notify for a message the user already saw scroll past. Rare, and only for unconfirmed messages.

## Build order

**1 Notifications.** `services/circles/circleNotifier.ts` with a pure core: given a Circle's members, level, read positions, the viewing state and a batch of added messages, it returns the notifications to show, using an injected clock for the 1.5-second window. Wiring in `circlesService` from the existing chat updates to `showWindowNotification`. Notification preferences in `circlesStore`. `circles:viewing`, `circles:notify-prefs` and `circles:open-message` over IPC. The Circle tab's Notifications section, the Settings section, and the click switching place and channel. Unit tests of the core under fake timers; a mounted test of the Circle tab section; a lifecycle test that `circles:open-message` switches place, opens the channel and scrolls to the message.

**2 Mentions behind format 3.** The `mentions` field in `circleOps.ts` (shape, limit, current members, edit replaces), applied only when the Circle's format is 3 or more. `CircleMessage.mentions`, `CircleChannel.mentioned`, the composer menu, the thread rendering and the "@" marks. Tests use `supportedFormat: 3` and Circles created at format 3; `CIRCLE_FORMAT` stays 2. The notifier counts `mentions.me` from here on.

**3 Format 3 and Update this Circle.** Once 0050's `media` applies: `CIRCLE_FORMAT` becomes 3, the **Update this Circle** row and sheet calling `setFormat`, the join refusal for builds below 3, and a new frozen `fixtures/circleOpsFormat3.json` with posts and edits carrying `mentions` and `media`. `circleOpsFormat1.json` doesn't change.

## Manual check

Two Macs, A and B, in one Circle of two people, on a build with phases 1 and 2 (mentions need a Circle created at format 3, so this part waits for phase 3).

1. On A, open a Hermes chat. On B, post in #general. A shows "B in #general · Circle name" with the text.
2. On A, open #general and focus the window. B posts again. A shows nothing.
3. On A, set the Circle to **Mentions**. B posts without a mention: nothing. B posts "@A hi": A shows "B mentioned you…".
4. On A, turn off **Show message text in notifications**. B posts: A's body reads "New message".
5. Quit A. B posts 10 messages. Start A: one summary, "Circle name: 10 new messages".
6. Click a notification: A switches to the Circle and channel and scrolls to the message.

A's log lines for these, metadata only:

```bash
grep -E "circle-notify" ~/Library/Logs/Boundary/boundary-debug.log | tail -20
```

## Acceptance criteria

- [x] **1.** A post by someone else, newer than the read position, notifies when the Circle's level allows it, and never while its channel is open in a focused window.
- [x] **2.** **Default** resolves to all messages with six or fewer people and to mentions with seven or more, and the Circle tab says which and why.
- [x] **3.** Edits, deletes, the user's own posts and history present when the Circle opened never notify.
- [x] **4.** More than three notifiable messages for one Circle within 1.5 seconds produce one summary, which opens the channel with the newest mention or else the newest message.
- [x] **5.** With **Show message text in notifications** off, no notification contains message text, and with **Circle notifications** off, none is shown.
- [x] **6.** Notification preferences never enter the Circle's log or records.
- [x] **7.** At format 3, `apply` stores the mentioned current members (sent as 1 to 32) and/or `channel`, drops the others, skips a malformed field's operation, and an edit replaces the set. Below format 3, `apply` drops the field and the format 1 golden log is unchanged.
- [x] **8.** The composer in a format 3 Circle channel offers @channel and the Circle's people, and posts only identities whose "@Name" is still in the text.
- [x] **9.** A message that mentions the user is marked in the thread, and its channel shows "@" in the rail, the switcher and the Chat icon until read.
- [x] **10.** **@channel notifies me** off stops @channel from notifying or marking for that user in that Circle.
- [ ] **11.** Only an admin sees **Update this Circle…**, and the sheet warns that members on older builds will see the Circle stop.
- [x] **12.** Notifier logs contain no names and no message text.
