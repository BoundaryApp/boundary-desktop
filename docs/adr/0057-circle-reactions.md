# 0057. Reactions in Circle chats, stored as kept member records

- Date: 2026-11-11
- Status: Proposed
- Parent: [0042](0042-circle-chats.md)
- Amends: [Circle chats spec](../circle-chats-ux-study/spec.md) decision 11 and its non-goals on reactions
- Related: [0038](0038-changing-circle-operations.md), [0050](0050-gifs-in-circle-chats.md), [0051](0051-circle-notifications-and-mentions.md)

## Context

In a small group, an emoji reaction is the lightest reply there is. Without one, members acknowledge with "+1" and "ok" messages that raise everyone's unread count. The Circle chats spec rules reactions out (decision 11).

A reaction has to reach every member, so it lives in the Circle's Autobase. There are two places for it.

A new chat operation, such as `chat-react`, would let `apply` check the emoji and store reactions beside their message, so a page of messages reads its reactions in the same range. It needs a new format under 0038 §3. 0050 and 0051 already share format 3, which no build declares until GIF `media` applies, and 0050 §9 asks that format 3 changes ship together so a Circle moves once. Reactions in format 3 would wait for GIFs.

Circle records exist at every format. A `member` record is written only by its member, `keep: true` lets it outlive the member's removal at format 2, and a value holds up to 16 KB of JSON. `apply` checks a record's size and nothing else, so the reader has to check the contents. Record keys sort by scope and member before app and key, so a reader can't fetch one message's reactions by range. The network process already reads every record of an open Circle on each view update and keeps them in memory.

## Decision

1. **Reactions are kept member records.** Each member writes one record per message they react to: app `reactions`, scope `member`, `keep: true`. The key is `m.` followed by the first 40 hex characters of the SHA-256 of `channel`, `author` and `id` joined by `/`. The value is `{ channel, author, id, name, emoji: [{ e, at }] }`, where `name` is the reactor's display name when they wrote it and `at` is the reactor's clock. Removing a member's last emoji on a message deletes the record. No Autobase operation changes and no format is raised.
2. **The reader checks every record.** Main ignores a whole record unless `author` is 64 hex characters, `id` is a message id, `channel` is a record name, the key matches the hash of those three, `emoji` holds 1 to 20 entries with distinct `e`, each `e` is one emoji (`/^\p{RGI_Emoji}$/v`) and each `at` is a positive safe integer. The key check stops one record from posing as another message's. Reactions on a message this device doesn't hold, or holds as deleted, aren't shown.
3. **Twenty emoji per member per message.** The reaction popover refuses a twenty-first and says so. A record with more is ignored.
4. **Reactions outlive their member.** `keep: true` means a removed member's reactions stay, as their messages do. Readers show a reactor who is still a member under the name in the Circle's member list, because the `name` in the record is the reactor's own claim. Only after the member leaves do readers show the stored `name`, with a **Left** tag. An admin can delete a departed member's record under 0042's kept-record rules, but the screen doesn't offer it.
5. **Reactions to your messages count as unread.** The device's read position for a channel gains `reactionsAt`, set from this device's clock when the channel is marked read. A channel's unread count is its unread messages plus the reactions by other members, on the user's own messages that aren't deleted, whose `at` is later than `reactionsAt`. Taking a reaction back removes it from the count. The count reaches the place switcher and the Chat icon as message counts do.
6. **Reactions never notify.** 0051 §4 is unchanged: only posts notify. A reaction is never a mention.
7. **The picker loads nothing from the network.** Six quick picks (👍 ❤️ 😂 😮 😢 🙏) and a full picker from `frimousse`. The picker's emoji data is `emojibase-data`'s English `data.json` and `messages.json`, bundled into the renderer as a chunk that loads when the picker first opens and handed to Frimousse through its `resolveEmojiData` option. Nothing is fetched: the packaged renderer loads from `file://`, where fetching a data file isn't reliable, and Frimousse's jsDelivr default would be refused by the renderer's `connect-src 'self'` anyway.

## Consequences

- Reactions work in every format 2 Circle as soon as they ship, and don't wait on format 3.
- Each reaction toggle appends a record write of a few hundred bytes to the log. A member's reactions to a message are one record, so toggling rewrites it whole.
- Reactions add to the records the network process already reads in full on every view update, and are indexed by message each time. At the size of a Circle this is small. If it shows up in timings, a later format can move reactions into a chat operation stored beside the message.
- Validation runs on every reader, in code `apply` doesn't share. Two builds that check emoji differently can show different reactions from the same records, which is harmless because nothing is ordered or counted by `apply`. Readers on an older Unicode table ignore records with newer emoji until they update.
- `at` is the reactor's clock. A reactor whose clock runs behind by more than the time since the user last read won't raise that user's unread count. A reactor whose clock runs more than two minutes ahead has those reactions left out of the unread count.
- An open channel marks itself read again when a reaction to one of the user's messages arrives, including a message older than what the thread has loaded. The thread takes the latest reaction time from the messages that chat events report as changed, as well as from loaded ones. Counting unread only for messages the open thread would show was the other option; it was not taken because the thread can scroll back to any message, so no cut-off matches what the user can see, and a reaction to an old message would go uncounted when the channel is closed too.
- Two of one member's devices reacting to the same message at once keep whichever write the Autobase orders last.
- `circleOpsFormat1.json` and `circleOpsFormat2.json` don't change.
- Reactions need nothing from the agent stack, so `docs/stack-contract.md` gains no rows.
