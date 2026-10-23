# 0009. Channel default is post

- Date: 2026-09-22
- Status: Accepted
- Parent: [0002](0002-chat-as-product-home.md)
- Amends: [0008](0008-multi-agent-channels-and-wake.md)
- Amended by: [0023](0023-chat-types-and-hermes-home.md) (New channel pre-checks Hermes as a member; zero members stays valid)
- Related: [0004](0004-instrument-composer.md), [0007](0007-multi-agent-dms-and-roster.md)
- Sources: [`06-channels.html`](../chat-ux-study/06-channels.html) (F), canvas `channel-passive-posts`

## Context

[0008](0008-multi-agent-channels-and-wake.md) shipped rooms with explicit membership and mention-wake. The no-`@` send was implemented as a failed turn: a pending buffer plus a fake assistant line (“No agent was @mentioned — members stay quiet until addressed.”). `#general` still read as a conversation with an agent. Single-player Slack’s default is the opposite — a message without `@` is a bulletin for the place. Agents may read it later. They are not the addressee. Later-read rules belong in the sibling assistant stack, not in desktop routing.

## Decision

Channel default send is a **post**. `@` remains the interrupt that asks a member to speak now (0008 wake + chain-wake unchanged). DMs stay one-turn-per-send (0007).

1. **Two verbs, one composer.** Keep Instrument (0004): project chip, `@`, tools lever. On a post, Instrument is idle — no phase, no tools run, no Stop-as-thinking. On a wake, Instrument is live and attributed. Placeholder: *Post to #slug · @ to address someone now*. Empty log: *Nothing in #slug yet. Post for the room.*
2. **A post is a room event.** Persist the user line in the channel overlay (`channelPosts`) and show it on reload. Do not stream an assistant chunk. Do not treat assistant-ui’s completion as required. `startChat` may return `posted: true` and the adapter returns without yielding.
3. **Empty membership is valid.** `#general` with zero members is a notebook. Leftover → channel does **not** auto-add Assistant. Adding a member later is how an agent becomes eligible to read the backlog (assistant rule) and to be `@`-woken (0008).
4. **Members rail language.** *Members of this room. They read posts later. @ asks someone to speak now.* Rows: *Member · reads later* until assistant ingest events exist. Do not invent presence or human unread soup.
5. **Desktop vs assistant.** Desktop owns room identity, membership, composer verb, transcript display, immediate `@`-wake, and durable posts. The sibling assistant stack owns when a member reads, how much, and whether a later read produces a reply. Do not implement cron, last-read watermarks, or auto-replies in desktop.

Living Workbench chrome (0003/0004) and Recent (0007) stay. Do not restyle A from F.

## Consequences

- Gateway has no append-without-turn API today. Posts are local-first in the room overlay and merged into history; a later wake may include unconsumed posts as model context. When assistant or the gateway grows a native append, map the overlay — do not keep a side buffer that never appears in the room.
- Reject answering a post with a system persona. A receipt, if any, is room chrome — never “Assistant.”
- 0008 remains the wake spec. This ADR only replaces the no-`@` send.
