# 0008. Multi-agent channels, membership, and mention-wake

- Date: 2026-09-22
- Status: Accepted
- Parent: [0002](0002-chat-as-product-home.md)
- Related: [0003](0003-workbench-chrome.md), [0004](0004-instrument-composer.md), [0007](0007-multi-agent-dms-and-roster.md)
- Amended by: [0009](0009-channel-default-is-post.md) (no-`@` send is a post, not a failed turn), [0023](0023-chat-types-and-hermes-home.md) (the built-in Hermes agent can be a member; Recent → All chats; leftovers → side chats), [0010](0010-durable-attribution-and-room-lifecycle.md) (remove, rename and delete; draft card polish)
- Sources: [`06-channels.html`](../chat-ux-study/06-channels.html) (F), [`07-agents.html`](../chat-ux-study/07-agents.html) (G)

## Context

[0007](0007-multi-agent-dms-and-roster.md) shipped identity DMs, Recent, roster create, and `@` as name-insert. Agents can be talked *to*; they cannot yet talk *together*. The multi-agent canvas and F/G recommend a second slice: persistent topic rooms with explicit membership and mention-wake, leftover → channel, and draft-from-chat. Buzz / `bot_relay.*` may later host rooms; day one must not wait on that transport.

## Decision

Ship channels inside Chat on top of 0007 (not a fourth app icon, not a restyle of A):

1. **Channels** are a left-rail section under Recent. Rows are `#slug` rooms. **New channel** creates a local room record plus one Hermes gateway session for the shared transcript. Project stays the folder chip — do not fork the room list per project.
2. **Membership is explicit.** Add from the DM agent card, roster **Add to channel**, or the channel `@` “not in channel” row. Non-members cannot be woken. Right rail on a channel shows **Members** (working / replied / quiet) above the host tree.
3. **Two wake rules.** In a channel, an agent speaks when `@`mentioned (or chain-woken by another member’s reply). Unmentioned members do not speak. In a DM, every message still wakes that agent; sibling `@` stays cosmetic (0007). A no-`@` channel send is a post (0009), not a failed turn.
4. **Local first.** Channel identity and membership live in electron-store. One gateway session holds the shared transcript; turns route with `prompt.submit`’s `profile` param. Map onto Buzz later — do not wire hosted rooms now.
5. **Default land** after ready is the last-opened room or Assistant, **never** Recent. Recent’s jump list also includes channels.
6. **Leftover → channel.** Untitled sessions may **Make channel** (existing session becomes the room transcript) in addition to **Keep as DM** (Assistant only, per 0007).
7. **Draft from chat.** An existing agent may propose a fenced `agent-draft` card; nothing is live until the owner confirms Create / Edit first. Same create path as the roster form. New agents are not auto-added to channels.

- Living Workbench chrome (0003/0004) and Recent semantics (0007) stay. Do not restyle A from F’s room layout.
- Create grammar follows 0003: **New project…** lives only in the current-project picker menu (or Choose folder… when empty). **New channel** and **New conversation** are section subhed plus buttons. **New agent** opens from the in-chat roster (All agents…), not a top-left Actions strip. F’s left-actions mock is exploration chrome, not Workbench product.

## Consequences

- Rooms are topic transcripts. Default send is a post (0009); `@` is how someone speaks now. Private memory per profile still holds — who-lines name speakers without implying shared `state.db`.
- Reject Channels | All chats tabs, unread soup, presence product, and nesting threads under an agent.
- Recent definition from 0007 is unchanged; this ADR only teaches it rooms and leftover → channel.
- Buzz transport remains a later mapping, not a day-one dependency.
