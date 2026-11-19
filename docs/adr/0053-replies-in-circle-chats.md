# 0053. Replies in Circle chats: a reference to the earlier message, stored at format 3

- Date: 2026-11-11
- Status: Proposed
- Parent: [0042](0042-circle-chats.md)
- Amends: [0042](0042-circle-chats.md) §3 (a `reply` field on `chat-post` at format 3), [0051](0051-circle-notifications-and-mentions.md) §2, §7 and §10 (a reply to you notifies like a mention; format 3 also carries `reply`), [Circle chats spec](../circle-chats-ux-study/spec.md) decisions 10 and 11 and its non-goal on replies
- Related: [0038](0038-changing-circle-operations.md), [0050](0050-gifs-in-circle-chats.md), [Circle replies and DMs study](../circle-replies-dms-ux-study/spec.md)

## Context

A Circle channel has no way to answer a particular message. In a busy channel "yes" can mean any of the last ten messages, and the only workaround is Markdown's `>` typed by hand, which copies text that the original's author may later edit or delete.

0042 §4 names a message by `author/id` everywhere outside `apply`, because positions change until a message is confirmed. The view already keeps an index from `author/id` to position per channel (`chatIndexKey`), so any device can find a message from that pair.

`chat-post` keeps only the fields it knows (`cleanMessageParts`), so a new field needs a new format under 0038 §3. No build declares format 3 yet. `CIRCLE_FORMAT` is 2, mentions (0051) are built behind `supportedFormat: 3` for tests, and GIFs (0050) are not built. 0051 §10 already holds format 3 back until both of its fields apply, so a third field added before then costs no extra format and no extra two-sided release.

Two shapes are common in chat apps. Inline replies, as in Signal, WhatsApp and iMessage, put the answer in the channel with a quote of what it answers. Threads, as in Slack, move the answer into a side conversation with its own unread state. Circles are small groups, and their channels are one stream that everyone reads. Threads would add a second list per channel, a second unread count and a panel, and they split a small conversation in two.

## Decision

1. **Replies are inline.** A reply is an ordinary message in the channel that points at an earlier message in the same channel and shows a quote of it above its own text. There are no threads, no side panel and no per-thread unread state.
2. **Format 3 adds `reply` to `chat-post`.** It is `{ author, id }`: a 64-character hex identity and a message id of the same pattern as `chat-post`'s own `id`. `apply` checks shape only and stores the pair on the message. It does not check that the target exists, because a target that is still unconfirmed can settle after its reply, and a reply must not vanish when that happens. A malformed `reply` skips the whole operation, as a malformed `call` does. `chat-edit` never adds, changes or removes a reply. At formats 2 and below, `apply` drops the field as it drops any unknown one, so replaying a format 2 log gives the same view.
3. **Same channel only.** `reply` names no channel; readers look the target up in the reply's own channel. A reply to a message in another channel, or to a message that was never posted, shows as unavailable (decision 5).
4. **Nothing of the original is copied.** The quote is read from the target's current record each time it renders: the author's name as the record holds it, then the first line of its text with Markdown removed, cut to 120 characters. A call shows "Call", a GIF shows "GIF". An edited original shows its new text, and a deleted one shows "Original message deleted", so deleting a message also takes it out of every quote of it.
5. **When the original can't be found.** Until the target replicates, or when it disappears because its author's removal settled before it (0042 §6), the quote reads "Original message not available" and isn't a link. It fills in on the next update that brings the target.
6. **Starting a reply.** **Reply** joins Copy, Edit and Delete in the message's hover toolbar, for any message that isn't deleted, the user's own included, and for unconfirmed ones. It puts a strip above the composer, "Replying to Maya" with the quote and a close button, and focuses the composer. Escape or the close button cancels. The reply belongs to the channel's draft, so switching channels and back keeps it. Sending clears it.
7. **Going to the original.** Clicking a quote scrolls to the original and highlights it for two seconds, loading older pages as it goes, back to the channel's first message at most. If the target isn't found, the quote changes to the unavailable text of decision 5.
8. **A reply to you notifies like a mention.** Each device checks `reply.author` against its own identity, so nothing new is stored. Under 0051 §2, **Mentions only** notifies for a reply to the user's message, and **Nothing** stays silent. The title reads "Maya replied to you in #general · Book Club", or "Maya's Hermes replied to you…" for a post with `agent`. A reply to one's own message never notifies. The Circles icon's mention mark (0052 §5) counts replies to the user too.
9. **One format 3 for mentions, media and replies.** 0051 §10 extends to `reply`: no build declares format 3 until all three apply. **Update this Circle** (0051 §11) lists replies among what turns on. Below format 3, **Reply** isn't in the toolbar. If format 3 has to ship before replies are built, replies move to format 4 with the same rules.
10. **The seam.** `CircleMessage` gains `reply` (null, or a `MessageRef`), `postCircleMessage`'s options gain `reply`, and `onCircleMessage` carries it, so another screen that mounts `CircleThread` gets replies with no further work. `useCircleChat`'s send takes an optional reply.

## Consequences

- Format 3 now waits on three features. Mentions are built, so GIFs and replies are what hold it back. Replies are the smallest of the three in `apply`: one shape check and one stored field.
- A reply adds about 100 bytes to its operation, which every member replicates for the life of the Circle.
- The stored pair is enough for a later "replies to this" view, but finding them would scan the channel. An index from a target to its replies would change what the view stores, so it would need its own format.
- A reply can point at a message the replier saw while it was unconfirmed. If that message disappears when the order settles, the reply stays and its quote reads "Original message not available".
- Typing `>` by hand still works at every format and still copies text.
- Reactions are being designed separately and face the same format question. If they need an operation or field, the cheapest time to add it is the same format 3.
- Replies need nothing from the agent stack, so `docs/stack-contract.md` gains no rows.
