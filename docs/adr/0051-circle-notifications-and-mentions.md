# 0051. Notifications and mentions in Circle chats: decided on each device, mentions stored at format 3

- Date: 2026-11-10
- Status: Proposed
- Parent: [0042](0042-circle-chats.md)
- Amends: [0042](0042-circle-chats.md) §3 (a `mentions` field on `chat-post` and `chat-edit` at format 3) and its consequence on activity elsewhere, [0050](0050-gifs-in-circle-chats.md) §9 (one **Update this Circle** step instead of **Turn on GIFs**), [Circle chats spec](../circle-chats-ux-study/spec.md) non-goals on mentions and desktop notifications
- Amended by: [0053](0053-replies-in-circle-chats.md) (§2, §7: a reply to you notifies like a mention; §10: format 3 also carries `reply`)
- Related: [0038](0038-changing-circle-operations.md), [0044](0044-circle-calls.md), [Circle notifications spec](../circle-notifications-ux-study/spec.md)

## Context

A Circle's messages reach someone who isn't looking at that channel only as unread counts on the place switcher, the Circle's rail and the Chat icon. 0042 left desktop notifications undecided and named that as a consequence. Its spec lists mentions as out of scope.

Main already sees every message as it arrives. `circlesService` receives a `CircleChatUpdate` per channel whose `added` list holds messages this device sees for the first time since the Circle opened, and it keeps a read position per channel in the Circles store. `showWindowNotification` in `services/notifications.ts` shows a macOS notification and brings the window forward on click; Kanban tasks and "left the Circle" notices use it.

`added` includes backlog. A device that reconnects after an hour receives everything posted meanwhile in one update, so a notifier that showed one notification per added message would flood.

A mention has to name a member in a way every device reads the same. Display names change and can repeat, so matching "@Sam" in text can't tell two Sams apart and breaks after a rename. A token inside the text (`<@identity>`) needs no format change but shows as hex on any build that doesn't know it, and `apply` treats text as opaque, so a typed token and a picked mention look the same. `chat-post` keeps only its known fields, so a new field means a new format under 0038 §3. 0050 already claims format 3 for `media` and isn't built.

## Decision

1. **Each device decides its own notifications.** Notification settings are stored on the device in the Circles store, next to read positions. They are never Circle records, because every member can read a Circle's records.
2. **A level per Circle.** **Default**, **All messages**, **Mentions only** or **Nothing**. **Default** resolves to **All messages** when the Circle has six or fewer people, counting the user and not counting agents, and to **Mentions only** otherwise. It re-resolves when membership changes. **Nothing** silences mentions too. A separate per-Circle switch, **@channel notifies me**, on by default, decides whether @channel counts as a mention for this user.
3. **Two global switches** in a Settings section, **Notifications**: **Circle notifications** (on) turns all of them off, and **Show message text in notifications** (on) replaces the body with "New message" or "Mentioned you".
4. **What can notify.** A post, not an edit, by someone else, not deleted, newer than this device's read position for its channel. Edits never notify, so fixing a typo is silent and adding a mention to an old message wakes no one.
5. **Silent while it's on screen.** Nothing fires while the window is focused and the message's channel is open in the current place. The renderer tells main which Circle and channel it shows, and whether the window is focused, when either changes.
6. **Bursts collapse.** Main collects notifiable messages per Circle for 1.5 seconds from the first one, so every notification shows up to 1.5 seconds after its message arrives. The window is timed by main's own clock and never by a message's `at`, which is the author's clock. Three or fewer each get a notification. More than three become one summary for the Circle, such as "Book Club: 14 new messages · Maya mentioned you", which opens the channel with the newest mention, or else the newest message.
7. **What a notification says.** The title names who, where and the Circle: "Maya in #general · Book Club", "Maya mentioned you in #general · Book Club", "Maya mentioned #general · Book Club" for @channel, "Maya's Hermes in #general · Book Club" for a post with `agent`. The body is the message's text with Markdown removed, cut to 150 characters. A post that starts a call says "Maya started a call in #general"; the one-to-one ring of 0044 §4 is unchanged. A click brings the window forward, switches to the Circle's place and channel, and scrolls to the message.
8. **Format 3 adds `mentions` to `chat-post` and `chat-edit`.** It is `{ members?: string[]; channel?: true }`, with at least one of the two. `members` as sent holds 1 to 32 distinct identity keys. `apply` drops any that aren't current members when the operation applies, and stores no `mentions` when none remain and `channel` isn't set. A malformed field skips the whole operation, as a malformed `call` does. An edit replaces the message's mentions with the edit's, or clears them when the edit has none. Below format 3, `apply` drops the field as it drops any unknown one, so replaying a format 2 log gives the same view. A mention of someone who later leaves stays in the record.
9. **The text keeps what was typed.** Picking a person in the composer inserts "@Name" and records their identity. On send, the composer keeps only identities whose "@Name" is still in the text. Readers highlight "@Name" where the record lists that identity under that name; when the name has changed since, the message shows "Mentioned: Maya" under its text instead.
10. **One format 3 for mentions and media.** Format 3 is `mentions` from this ADR and `media` from 0050. No build declares format 3 until both apply, because two builds that both declared 3 but kept different fields would build different views from the same log. Mentions are built and tested first behind `supportedFormat: 3` with `CIRCLE_FORMAT` still at 2.
11. **Update this Circle.** 0050 §9's **Turn on GIFs** becomes **Update this Circle** in the Circle tab, shown to admins when the Circle's format is below the build's. Its sheet names what turns on and says that members on builds without format 3 will see the Circle stop until they update (0038 §4, §5). New Circles start at format 3 once a build declares it. Below format 3, typing `@` in a Circle channel opens nothing, and the Circle tab says an admin can update the Circle to turn on mentions.
12. **Logs carry metadata only.** The notifier logs counts, Circle keys, levels and why it stayed silent. It never logs names or text.

## Consequences

- Notifications work in every format 2 Circle as soon as phase 1 ships. In a Circle of seven or more people, **Default** means mentions only, and there are no mentions until the Circle is at format 3, so such a Circle notifies nothing by default until then. Its Circle tab says so.
- With message text on, macOS keeps message text in Notification Center's history and shows it on the lock screen as its **Show Previews** setting allows. That text has left the app's control, which is why the global switch exists.
- Anyone can @channel, so a member can notify everyone in a Circle. Each person can turn that off per Circle; a Circle with a member who abuses it has the admin's existing remedy, removal.
- Mentions wait on 0050's `media` being built before any real Circle can use them. If GIFs stall, this ADR can be amended to give mentions format 3 alone and move `media` to format 4.
- A notification shows only while the app runs. Nothing wakes a closed app; Circles have no server to send a push.
- Direct messages are still out (0042 §14). Mentions don't make a message private.
- Notifications and mentions need nothing from the agent stack, so `docs/stack-contract.md` gains no rows.
