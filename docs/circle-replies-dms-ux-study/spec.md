# Circle replies and direct messages: living spec

| | |
| --- | --- |
| Status | Proposed |
| Visuals | [prototype.html](prototype.html) (click-through) |
| Started | 11 Nov 2026 |
| Builds on | [ADR 0053](../adr/0053-replies-in-circle-chats.md), [ADR 0054](../adr/0054-direct-messages-in-circles.md), [ADR 0042](../adr/0042-circle-chats.md) §4, §14, [ADR 0051](../adr/0051-circle-notifications-and-mentions.md), [ADR 0052](../adr/0052-circles-destination-and-floating-agent.md), [ADR 0038](../adr/0038-changing-circle-operations.md), [Circle chats spec](../circle-chats-ux-study/spec.md), [Circle notifications spec](../circle-notifications-ux-study/spec.md) |

## Progress

| Phase | Status | Depends on |
| --- | --- | --- |
| R1 `reply` in `apply` | Merged; dormant until a build declares format 3 | 0051 phase building format 3 |
| R2 Reply in the thread and composer | Merged; shows from format 3, not yet tried in the app | R1 |
| R3 Replies notify | Merged; not yet tried in the app | R1, Circle notifications spec phase 1 |
| D1 DM service and outbox | Merged; testnet case passes, not yet tried between two Macs | — |
| D2 DMs on the Circles destination | Merged; not yet tried in the app | D1, Circles screen spec phases 10 and 11 |
| D3 DMs notify | Merged; not yet tried in the app | D1, Circle notifications spec phase 1 |
| D4 DM unread counts | Built; not yet tried in the app | D2 |

## Replies

ADR 0053 holds the decisions: inline replies with a quote, a `{ author, id }` reference on `chat-post` at format 3, nothing of the original copied, and a reply to you counting as a mention.

### What it looks like

The reply's bubble or row carries a quote strip above its text: a 2px left rule in the original author's avatar colour, their name in the label style, and one line of the original's text in the muted colour, cut with an ellipsis. In the user's own `--bubble-mine` bubble the strip sits inside the bubble on a slightly darker fill so it reads at 3:1 against it. The strip is a button with the accessible name "Go to Maya's message". When the original is deleted or not available, the strip shows that text in italics and isn't a button.

The composer strip sits above the text box, inside the composer's brand-tinted edge, with "Replying to **Maya**", the same one-line quote and a close button labelled "Cancel reply". At the compact 320px layout the quote cuts shorter and the strip stays one line.

Replying to an unconfirmed message is allowed. The quote doesn't show the unconfirmed clock; the original does.

### Build order

**R1 `reply` in `apply`.** `cleanMessageParts` takes `reply` at format 3: shape only, malformed skips the post. A format 3 golden log gains a reply, a reply to a missing message and a malformed reply; the format 1 and format 2 golden logs stay unchanged. `test:circles` cases: below format 3 the field is dropped and the post stays; `chat-edit` with `reply` leaves the stored reply as it was; a reply to a message whose author is later removed keeps its reference.

**R2 Reply in the thread and composer.** `CircleMessage.reply`, `postCircleMessage`'s option and `useCircleChat`'s send. The toolbar's **Reply**, the composer strip and its per-channel draft, the quote strip with its four states (found, edited, deleted, not available), and going to the original with older pages loading. Mounted tests in `CircleThread`: the quote follows an edit and a delete of the original; Escape cancels; a reply survives a channel switch as a draft; below format 3 there is no **Reply**.

**R3 Replies notify.** The notifier treats `reply.author === me` as a mention for levels and titles. A unit test with fake timers: a reply to the user notifies under **Mentions only**, a reply to someone else doesn't, and a reply to one's own message never does.

### Acceptance criteria

- [x] **R1.** At format 3 a post's `reply` is stored as sent; at format 2 it is dropped, and the format 1 and format 2 golden logs are unchanged.
- [x] **R2.** A malformed `reply` skips the post, and `chat-edit` never changes a reply.
- [x] **R3.** The quote shows the original's current text, "Original message deleted" after a delete, and "Original message not available" when it can't be found, and nothing of the original is stored in the reply.
- [x] **R4.** Clicking a quote scrolls to and highlights the original, loading older messages as needed.
- [x] **R5.** A reply to the user's message notifies under **Mentions only**, and a reply to one's own message never notifies.
- [ ] **R6.** **Reply** is hidden below format 3, and **Update this Circle** lists replies. **Update this Circle** isn't built yet.

## Direct messages

ADR 0054 holds the decisions: DMs are peer signals to one person with an outbox on the sender's Mac, kept only on the two Macs and never in the Circle log. The comparison below is the record of why.

0042 §14 kept DMs out because every member's device replicates the whole Circle log and holds its key. Any DM design has to say what other members can see, when a message arrives, and what it costs everyone's disk. Two approaches are real; a third was looked at and set aside.

### A. Peer signals with an outbox

A DM goes as a peer signal addressed to one identity. `sendSignal(circleKey, topic, payload, toIdentity)` already sends only over the encrypted connection to that member's device and never through another member. The recipient's device answers with an acknowledgement. Until it does, the sender's Mac keeps the message in an outbox and sends it again whenever the recipient's device connects. Both Macs keep the conversation in their own Circles store, outside the Autobase.

- **Who sees what.** Nobody else sees the message or that it was sent. Nothing enters the Circle log.
- **When it arrives.** Only while both Macs are online and connected to each other. A message to someone whose laptop is shut waits in the sender's outbox until they overlap. The UI says "Waiting for Maya to come online", then "Delivered".
- **Size.** Signals are limited to 4 KB of JSON, so a DM's text is capped at about 3 KB, a quarter of a channel message, unless it is split into several signals.
- **Format.** None. It ships in any build, at any Circle format, and old builds ignore the topic.
- **Edits and deletes.** Edit and delete go as signals too, and are best effort: the other Mac applies them if it receives them.
- **Leaving.** A DM conversation lives with its Circle on each Mac and goes when either person leaves or is removed. Messages still in an outbox are dropped.
- **Limits.** Two members whose Macs can't connect directly, because of their networks, can't exchange DMs at all; calls (0044) have the same limit. Each member has one device per Circle today, so there is no second device to keep in sync.

### B. Encrypted operations in the Circle log

A DM is a new `dm-post` operation at a new format, holding the text sealed to the recipient with an X25519 key derived from their identity key. Every member replicates it; only the recipient can open it. The sender keeps the plain text on their own Mac.

- **Who sees what.** Every member sees, permanently, who wrote to whom, when, and how long each message was. A removed member keeps that record.
- **When it arrives.** Whenever the recipient's Mac syncs with any member, so a message sent while the recipient is offline reaches them later through someone else. Confirmation follows the admins, as channel messages do.
- **Size.** Up to the channel limit of 12 KB, plus about 100 bytes of overhead, stored on every member's disk for the life of the Circle.
- **Format.** A new operation, so a new format. It would ride format 3 only if decided before format 3 ships, and it brings new crypto to review: key derivation, sealing, and refusing a `to` that isn't a member.
- **Edits and deletes.** Like channel messages: stubs in the log, never erased.
- **Exposure over time.** There is no forward secrecy. Anyone who ever gets the recipient's identity secret can open every DM ever sent to them, from any member's copy of the log.

### C. A two-person log beside the Circle (set aside)

A separate Autobase shared only by the two people, set up over a signal. It keeps metadata private and syncs an ordered history, but delivery still needs both Macs online at once, since no third device holds it. Over A it adds multi-device sync, which Boundary doesn't need while a member has one device per Circle, at the cost of a second kind of log with its own lifecycle and connections.

### Comparison

| | A. Signals and outbox | B. Encrypted operations |
| --- | --- | --- |
| Others see who wrote to whom | No | Yes, permanently |
| Arrives while the recipient is offline | No: waits for both online | Yes, via any member |
| Disk cost for other members | None | Every DM, forever |
| Needs a format | No | Yes |
| Longest message | About 3 KB | 12 KB |
| Works between Macs that can't connect directly | No | Yes |
| New cryptography | None | Key derivation and sealing |

### What it looks like

The **Direct messages** section and each DM's header, composer, delivery states and notifications are in ADR 0054 §5 to §10. The DM thread, `DirectThread`, shares the channel thread's message rows, day dividers, hover toolbar, edit box, delete dialog and composer parts, with no unconfirmed clock, reactions or mentions, and a delivery line under the user's messages instead of seen-by avatars: Waiting, Sending or Not delivered on each that hasn't arrived, and Delivered on the newest. A reply shows a one-line quote of the message it answers; clicking it scrolls to the original and highlights it for two seconds. Messages waiting in the outbox show at 70% opacity with "Waiting for Maya to come online" under them.

### Build order

**D1 DM service and outbox.** The five topics and their shape checks, the per-Circle encrypted store, the outbox with resend on connect and every 30 seconds, batched acknowledgements, dedupe, and deletion on leave and removal. Main's functions follow the channel seam: `listDirectConversations(circleKey)`, `getDirectMessages(circleKey, identity, { before?, limit? })`, `sendDirectMessage`, `editDirectMessage`, `deleteDirectMessage` and an `onDirectEvent` event, with IPC under `circles:dm-*` and a `circles:dm-event` broadcast. Unit tests with fake timers for resend and acknowledgement, and a program-level test that a malformed or oversized signal is dropped. The `test:circles` testnet case from ADR 0054's consequences.

**D2 DMs on the Circles destination.** The section, **Message** in the person's panel and row, the header, composer and hint, delivery states, the 3 KB countdown, edit and delete with their dialogs, and the read-only conversation after someone leaves. Mounted tests that a DM shows none of `@`, GIFs or share, and that a channel shows no DM controls.

**D3 DMs notify.** DMs in the notifier under ADR 0054 §10. A unit test that a DM notifies under **Mentions only** and not under **Nothing**.

**D4 DM unread counts.** ADR 0054 §12: a read position per conversation in the DM file, `unread` on each conversation, `circles:dm-read`, a count on each DM row except the open one, and DM unread added to the Circle's count in the list and on the Circles icon. Unit tests that the count is the other person's live messages after the read position and that the position only moves forward; mounted tests for the row count, the Circle's count and marking the open conversation read.

### Acceptance criteria

- [ ] **D1.** No DM, edit, delete, acknowledgement or typing mark ever enters the Circle log, and a third member online throughout receives none of them.
- [ ] **D2.** A DM sent while the recipient is offline arrives once when both are next online, including after either app restarts in between.
- [ ] **D3.** Text past 3 KB can't be sent, and a received signal of the wrong shape or size is dropped before the renderer.
- [ ] **D4.** The delivery state moves from waiting to sending to delivered as the recipient connects and acknowledges.
- [ ] **D5.** Deleting an undelivered message removes it from the outbox; deleting a delivered one removes it from the other Mac at the next overlap.
- [ ] **D6.** Leaving a Circle deletes its DMs from this Mac, and the person who stays sees the conversation read-only with a **Left** tag.
- [ ] **D7.** DM logs hold counts and timing only.
