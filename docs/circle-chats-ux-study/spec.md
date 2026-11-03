# Circle chats: living spec

| | |
| --- | --- |
| Status | Proposed |
| Visuals | [prototype.html](prototype.html) (click-through) |
| Started | 2 Nov 2026 |
| Builds on | [ADR 0042](../adr/0042-circle-chats.md), [ADR 0043](../adr/0043-circles-live-in-the-chat.md), [ADR 0032](../adr/0032-circles.md), [ADR 0038](../adr/0038-changing-circle-operations.md), [ADR 0023](../adr/0023-chat-types-and-hermes-home.md), [ADR 0024](../adr/0024-chats-belong-to-projects.md), [circles plan](../circles-plan.md) phase 5, [chat types spec](../chat-types-ux-study/spec.md), [message actions spec](../message-actions-ux-study/spec.md) |

## Progress

| Phase | Status | Depends on |
| --- | --- | --- |
| 1 Format 2 | Built; not yet tried between two Macs | — |
| 2 Chat service | Built; not yet tried between two Macs | 1 |
| 3 Circles as places in the Workbench chat | In progress: places, the Circle rail, `CircleThread`, `useCircleChat`, the Circle tab, unread counts and **Open chat** are built; not yet tried in the app | 2 |
| 4 Typing and read marks | Built; not yet tried between two Macs | 3 |
| 5 Channels | Built; not yet tried between two Macs | 3 |
| 6 Share from a Hermes chat | Built; not yet tried in the app | 2, 3 |
| 7 Compact thread | Built; checked at 320px in headless Chromium | 3 |

Phases 4 to 7 can run at the same time once 3 lands. Bringing agents into Circles is later work with its own ADR; phase 1 stores the field it needs (ADR 0042 §12).

## Goal

Members of a Circle can talk in it from the same chat they use with their agents, with a history every member keeps and nothing on a server. When someone is in a Circle, the chat is that Circle: they always know where they are and who reads what they type. A message shows at once and says when its order isn't final yet. Nobody mistakes a Circle channel for a Hermes chat. A member can bring one thing from a Hermes chat into a Circle on purpose, and nothing else from Hermes reaches it. Other screens can show a Circle channel with the same thread and data.

## Decisions

ADR 0042 holds the storage, format, privacy and placement decisions. These are the screen's.

1. **A place switcher tops the chat rail.** It is a full-width button above everything else in the rail. In This Mac it shows a laptop tile, **This Mac** and "Projects, Hermes, your agents". In a Circle it shows the Circle's coloured tile, its name and "Circle · 4 people · 3 online", on a brand-tinted background so the rail itself looks different. When other places have unread messages, the button carries their total. Its menu lists **This Mac**, then a **Circles** heading with each Circle (tile, name, people and online count, unread count, a check on the current place), then **Start or join a Circle…** and **Manage Circles…**, which open the Circles screen. The name **This Mac** avoids "Home", which ADR 0023 uses for Hermes.
2. **This Mac's rail is today's rail.** **Go to project** sits under the switcher, then All chats, Mentions, Hermes, Channels and Direct messages, all as they are now. No Circle appears in it.
3. **A Circle's rail is that Circle.** Under the switcher come two sections.
   - **Channels**, with each channel's unread count. For admins, its `+` adds a channel.
   - **People**: every member with their avatar, **admin** where it applies, and an online dot. Online people come first and you come last. A row opens the person panel from the Circles screen spec. For admins, the section's `+` invites someone.

   Once agents can be brought in, an **Agents** section lists them as "Maya's Hermes · on Maya's Mac" (ADR 0042 §12). There is no Mentions, All chats, project picker or DM section in a Circle.
4. **Places remember.** Each place reopens the conversation last open in it. A Circle opened for the first time opens **General**. Opening something from another place switches the place: a share toast's **Open**, **Open chat** on the Circles screen, ⌘N (a new Hermes chat, in This Mac) and, later, a notification.
5. **The header names the channel and its Circle.** The Circles mark, then "Book club" and the channel in the title, and under it "Circle channel · 4 people · 3 online". On the right, one button opens and closes the inspector on the Circle's **Circle** tab ([ADR 0043](../adr/0043-circles-live-in-the-chat.md) §3, §4), where admins add, rename and remove channels. The only other header control is **Call** (Circle calls spec decision 1), and the people's avatars aren't repeated here, since the rail lists them.
6. **The composer names its audience.** The placeholder reads "Message Book club · 4 people", the composer carries a brand-tinted top edge and the Circles mark, and the footer hint reads "Everyone in Book club gets a copy". The project chip, the model chip and the `@` button are hidden: a Circle channel has no project, runs no model and, until agents can join, wakes no one.
7. **Unread counts.** Channels carry counts in a Circle's rail, Circles carry them in the switcher's menu, and the switcher shows the total for places other than the current one. The Chat icon in the icon rail shows the total across Circles as a count badge, since Circle channels are the only conversations with unread messages from other people.
8. **Unconfirmed is quiet.** An unconfirmed message has a small hollow clock after its time and a tooltip: "Waiting for admins to confirm. Its place in the chat can still change." When a channel has unconfirmed messages and no other admin's device is online, a line above the composer says "No admin is online. New messages show now and settle in order once one is." Confirmation never moves the reader's scroll position.
9. **Who-lines.** Every message has the Workbench who-line: the person's avatar and name, or **You** for the user's own. An agent's message, once agents can post, reads "Maya's Hermes" with the agent's mark. People who have left keep their name from the message, with a muted **Left** tag and no link.
10. **Message actions.** The Workbench hover row with **Copy**, and for the author **Edit** and **Delete**, and for an admin **Delete** on anyone's. Retry, Branch, Save to folder and the DM horizon don't appear. Edited messages say **edited** after the time. A deleted message reads "Deleted" or "Removed by an admin". The delete dialog says: "It disappears from the chat. Every member's Mac still holds the Circle's history, so it isn't erased."
11. **What a message can hold.** Plain text with the same Markdown as Hermes chats, minus images and raw HTML, so a message never loads anything from the network. Links open in the browser after the usual confirmation. No attachments, reactions or threads.
12. **Typing and seen.** "Maya is typing…" above the composer, from `chat.typing` signals, gone 6 seconds after the last one. Under the newest message, small avatars show who has read up to it, from `chat.read` signals received since the Circle opened. They are only ever a subset of who has read, and the tooltip says "Seen while you were online".
13. **The Circles screen links to chat.** A Circle's header there gets **Open chat**, which switches the chat to that Circle. There is no Chat tab, so the Circles screen spec's decision 14 no longer applies. Once [ADR 0043](../adr/0043-circles-live-in-the-chat.md) ships there is no Circles screen: a Circle is managed from the inspector's **Circle** tab, the switcher's menu starts and joins Circles, and model sharing is in Inference.
14. **Sharing from a Hermes chat.** Sharing is the one way text moves from This Mac into a Circle. **Share to Circle…** sits in a message's **More** menu in Hermes chats, for user and assistant messages, and is hidden when the user is in no Circle. The sheet has the Circle and channel picker (last used first), the text in an editable box with the byte limit shown when it's close, a preview line of how it will appear (with the model name for a reply), and "Everyone in this Circle gets a copy that you can't take back." **Share** posts it and leaves the user in This Mac with a toast whose **Open** switches to the Circle's channel.
15. **No DMs in a Circle.** A person's row opens their details, not a conversation (ADR 0042 §14).
16. **Leave and remove wording.** The leave dialog adds "This Circle's chats leave this Mac with it. Your messages stay in the Circle." The remove dialog adds "Their messages stay in the chat."

## The public seam

ADR 0042 §10 makes a Circle channel usable from other screens. The pieces, by their public use:

**Main.** Functions like the records API, answering with `CirclesResult`:

```ts
listCircleChannels(circleKey): Promise<CirclesResult<{ channels: CircleChannel[] }>>
getCircleMessages(circleKey, channel, { before?: MessageRef; limit?: number }): Promise<CirclesResult<{ messages: CircleMessage[]; more: boolean }>>
postCircleMessage(circleKey, channel, text, opts?: { shared?: SharedFrom }): Promise<CirclesResult<{ id: string }>>
editCircleMessage(circleKey, channel, id, text): Promise<CirclesResult>
deleteCircleMessage(circleKey, channel, author, id): Promise<CirclesResult>
onCircleMessage(handler: (event: CircleMessageEvent) => void): () => void
onCircleMessageChange(handler: (event: CircleMessageChange) => void): () => void
```

`CircleMessage` carries `channel`, `id`, `author` (identity), `name`, `agent` (null, or the agent's slug and name), `text`, `at`, `confirmed`, `edited`, `deleted` (null, `author` or `admin`), `shared` and `mine`. `MessageRef` is `{ author, id }`. `postCircleMessage` takes no `agent` until agents can post.

`onCircleMessage` is the new-message event: `{ circleKey, channel, id, author, name, agent, text, at, confirmed, mine }`, fired once per message per launch, the first time this device sees it after the Circle opened. Messages already in the view when a Circle opens don't fire; messages caught up after being offline do. `onCircleMessageChange` reports edits, deletes, confirmation and messages that disappear when their order settles.

**Renderer.** IPC under `circles:chat-*` and a `circles:chat-event` broadcast that carries one channel's changes. `useCircleChat(circleKey, channel)` returns what the thread needs: messages newest last, `loadOlder`, `typing`, `seenBy`, members, and the send, edit and delete actions.

**Thread.** `CircleThread` adapts those to an assistant-ui external store and renders the Workbench thread and composer, so a Circle channel and a Hermes chat share message rendering, who-lines, day dividers and the hover row. It takes its data from props or the hook, has no knowledge of the chat rail or places, and has a `compact` layout from 320px: a channel picker in its header, the hover row behind a **…** button, and the composer growing to five lines before it scrolls.

**Default channel.** `general`, shown as **General**, exists in every Circle with no record. An admin can rename it with a record; it can't be removed. Only admins add, rename and remove channels.

## Non-goals

- Bringing agents into a Circle, and agents reading or replying there. Format 2 stores the `agent` field (ADR 0042 §12); the Agents section, waking, approvals and what the agent sees need their own ADR.
- Direct messages between two members. A message in the Circle's log is readable by every member, so a private one needs live signals or per-recipient encryption, each with its own cost (ADR 0042 §14).
- Places changing anything outside the chat screen.
- Private channels. Every channel is readable by every member, since every member replicates the whole Autobase.
- Attachments and images, which would need a blob store in the Circle.
- Reactions, threads, replies, mentions, search, and Circle channels in All chats or Mentions.
- Sharing several messages or a whole Hermes chat at once, and anything that moves Circle messages into a Hermes chat.
- Pruning or expiring history.
- Desktop notifications. The count badges come first; notifications wait for a decision on defaults.

## Risks and open questions

- **One thread, two sources.** The Workbench thread assumes a Hermes session in places: run state, turn notes, task cards, the horizon. `CircleThread` must render none of them, and each assumption it trips over is a seam to cut in the thread, not a branch on "is Circle". This is the largest piece of phase 3.
- **Missing activity elsewhere.** Someone working in This Mac sees a Circle's messages only as counts on the switcher and the Chat icon. If that proves too quiet, desktop notifications are the answer, and they are still undecided.
- **Getting lost between places.** A Hermes chat opened from a link while in a Circle switches the whole rail. The switcher's tinted background and the header change should make that visible; testing should check people notice.
- **Mistaking where a message goes.** The place, header, composer and hint carry the difference (decisions 1, 5 and 6). If testing shows people still type Hermes prompts into a Circle, the composer's first send in a channel could confirm once.
- **Unread positions under reorder.** A device's read position is a message id. If that message disappears when its order settles, the count falls back to messages after the read position's `at`, which can be off by a few.
- **Seen-by is partial.** It shows only reads signalled while the viewer was online, so a quiet row doesn't mean unread. The tooltip says so.
- **Old builds.** A member who hasn't updated can't join a format 2 Circle; the join page says to update.
- **Scrolling while order changes.** Reorders only affect unconfirmed messages, which are near the bottom. The thread keeps the reader's position by message id, not by offset.
- **Storage growth.** See ADR 0042's consequences. A size line on the Circles screen may be needed once Circles are used for months.

## Build order

**1 Format 2.** In `circleOps.ts`: `CIRCLE_FORMAT` becomes 2; `chat-post` (with optional `shared`, `agent` and `call`), `chat-edit` (with optional `call`) and `chat-delete`; `keep` on `record-set` and its effect on `remove-member`; `identity` on `record-del`. A format 2 golden log beside the format 1 one, which stays unchanged. `test:circles` cases: a format 1 Circle skips chat and kept-record operations; a format 1 joiner is refused; posts from removed members and repeats are skipped; size limits; edit by a non-author and delete by a non-admin are skipped; kept records survive removal and an admin clears them.

**2 Chat service.** The main functions and events above, read from the view by range so opening a Circle doesn't scan its history. Each update rereads only from the oldest unconfirmed message forward. Read positions in the Circles store. IPC and the broadcast. A testnet case with three people and the admins offline: messages show unconfirmed on all sides, confirm when an admin returns, and a message from someone removed earlier in the settled order is reported gone.

**3 Circles as places in the Workbench chat.** The place switcher and its menu, the stored place and each place's last conversation, the Circle rail with channels and people, switching place when a conversation opens from elsewhere, the header's panel button and a Circle tab listing channels and people, `useCircleChat`, `CircleThread` and the seams it needs in the thread, the header, the composer's audience, unconfirmed marks, edit and delete, people who left, unread counts in the rail, the switcher and on the Chat icon, and **Open chat** on the Circles screen. Mounted tests that a Circle channel shows none of the Hermes-only controls, that This Mac's rail is unchanged, that a Circle's rail shows nothing from This Mac, and that opening a Hermes chat from a Circle switches to This Mac.

**4 Typing and read marks.** The two signal topics, sent at most once every 3 seconds while typing and once a second for reads, and the seen-by row.

**5 Channels.** Admins add channels from the rail's `+` and the Circle tab, and rename and remove them from the Circle tab, as `chat` records. Removing a channel hides it and keeps its history in the log.

**6 Share from a Hermes chat.** The **More** menu item, the sheet, and `shared` provenance. A mounted test that the posted text is exactly the box's contents and that nothing is sent on cancel.

**7 Compact thread.** `CircleThread`'s `compact` layout and the channel picker. A 320px rendering check in headless Chromium in both themes, with no horizontal scroll.

## Acceptance criteria

- [x] **1.** At format 1, `apply` skips every chat and kept-record operation, and the format 1 golden log is unchanged.
- [x] **2.** New Circles start at format 2, and a joiner whose build declares format 1 is refused with a message to update.
- [ ] **3.** A message shows on every online member's Mac at once, marked unconfirmed until a majority of admins have indexed it, and the mark clears without moving the reader's scroll.
- [x] **4.** Messages are named by author and id everywhere outside `apply`; a reorder changes no message's identity.
- [ ] **5.** Only the author edits a message. The author or an admin deletes it, and the dialog says it isn't erased.
- [ ] **6.** A removed member's messages stay in the channel under their name with a **Left** tag, and their own Mac no longer shows the Circle.
- [x] **7.** Kept records survive their member's removal, plain records don't, and an admin can delete a departed member's kept record but not a current member's.
- [x] **8.** Typing and read marks never enter the Autobase, and a device's unread counts never leave it.
- [x] **9.** **Share to Circle…** posts exactly the text in the sheet when the user presses **Share**, and nothing on cancel. No tool call, tool result, attachment, other message, session id or title is sent.
- [x] **10.** A Circle channel opens in the Workbench chat with the Circle named in the switcher, its header and composer, and shows no project chip, model chip, `@`, Retry, Branch or horizon.
- [ ] **11.** A Hermes chat and This Mac's rail look and behave as before phase 3, and no Circle appears in This Mac's rail.
- [x] **12.** `CircleThread` renders a channel at 320px from props alone, and `useCircleChat` drives it outside the chat screen.
- [x] **13.** The new-message event fires once per message with channel, sender and text, and doesn't fire for history present when the Circle opened.
- [x] **14.** Every Circle has **General** with no setup, and only admins add, rename or remove channels.
- [ ] **15.** A message never loads an image or anything else from the network when it renders.
- [ ] **16.** A message posted with an `agent` shows as that member's agent, and `apply` stores it under the posting member.
- [x] **17.** A Circle's rail shows only its channels and people. Switching place reopens that place's last conversation, and opening a conversation from another place switches to it.
- [x] **18.** The switcher shows the unread total for places other than the current one, and its menu shows each Circle's count.
- [x] **19.** A post with `call` and empty text is stored, a post with neither is skipped, and only the author can add `ended` with an edit.
