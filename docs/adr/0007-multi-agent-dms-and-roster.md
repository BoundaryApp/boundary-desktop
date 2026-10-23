# 0007. Multi-agent DMs, roster, Recent, and @ agents

- Date: 2026-09-21
- Status: Accepted · §1–3 and the “reject nesting threads under Assistant” consequence superseded by [0023](0023-chat-types-and-hermes-home.md)
- Superseded in part by: [0023](0023-chat-types-and-hermes-home.md) (Hermes is a section of chats; DMs are one thread per personality; Recent → All chats; leftovers → side chats)
- Amended by: [0010](0010-durable-attribution-and-room-lifecycle.md) (the roster can edit an agent)
- Parent: [0002](0002-chat-as-product-home.md)
- Related: [0003](0003-workbench-chrome.md), [0004](0004-instrument-composer.md)
- Sources: [`06-channels.html`](../chat-ux-study/06-channels.html) (F), [`07-agents.html`](../chat-ux-study/07-agents.html) (G)

## Context

Workbench today is one Hermes identity with a flat Chats list. The multi-agent exploration (F/G) and canvas recommend treating agents as people you DM or `@`, keeping Project as the host folder, and moving recency into a **Recent** destination rather than nesting threads under an agent or keeping a Channels | All chats tab. Channels (shared rooms, membership, mention-wake) are desirable but are a later slice.

## Decision

Ship the first multi-agent product slice inside Chat (not a fourth app icon):

1. **Direct messages** replace the flat Chats list. Rows are agent identities (glyph, display name, role). Built-in **Assistant** is first. DMs sort by recency. One standing DM per agent.
2. **Recent** is one always-visible rail row above where Channels will later sit. Selecting it swaps the center to a Today / Yesterday / … jump list. Default land after ready is Assistant (or later the last room), **never** Recent.
3. Untitled leftover sessions have **no standing DM row**. They live in Recent until **Keep as DM** collapses one onto Assistant, or (later) they become a channel.
4. **Roster + create** live inside Chat: display name, handle, role only. Create maps onto a Hermes profile (`profiles.create` / registry). Chrome says **Starting…**, not a fake percent. Confirm opens that agent’s DM.
5. Composer `@` has two namespaces: **Agents** above **Files** (existing path complete). In a DM, inserting a sibling `@` does not pull them into the transcript.
6. **Channels, members rail, @-wake, Add to channel, and draft-from-chat are out of scope** for this ADR.

Living Workbench chrome (0003/0004) stays. Do not restyle A from F’s room layout.

## Consequences

- Agents are private Hermes profiles with independent memory; do not ship UI-only personas on one `state.db`.
- History retrieval is Recent; the rail is people — not Letta-style agent → thread list as the app.
- Reject Channels | All chats tabs and nesting leftover threads under Assistant as standing nav.
- A later ADR for channels + membership + wake is [0008](0008-multi-agent-channels-and-wake.md); Recent stays as defined here.
