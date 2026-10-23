# 0023. Chat types: Hermes home, one-thread DMs, side chats, and Mentions

- Date: 2026-10-01
- Status: Accepted (2026-10-01)
- Parent: [0002](0002-chat-as-product-home.md)
- Supersedes: [0007](0007-multi-agent-dms-and-roster.md) §1–3 (Assistant as a DM row, Recent, leftovers), including its “reject nesting threads under Assistant” consequence (confirmed 2026-10-01)
- Amends: [0008](0008-multi-agent-channels-and-wake.md) §2, §5–6 (the base agent can be a member; Recent includes channels; leftover → channel), [0009](0009-channel-default-is-post.md) §3 (new channels start with Hermes)
- Related: [0009](0009-channel-default-is-post.md), [0014](0014-tabbed-inspector.md), [0021](0021-right-aligned-user-turns.md)
- Sources: [`docs/chat-types-ux-study/`](../chat-types-ux-study/)

## Context

Under 0007 the base agent is a DM like any personality. *New conversation* gives that agent a new standing session and demotes the old one to an untitled "leftover" that only appears in Recent. After channels (0008), Recent became the only place to find most Hermes sessions. Nothing in the chrome tells the user which kind of conversation they are in or where the other kinds are.

Users think of the two kinds of agent differently. The base agent is a place with many separate, titled chats, like ChatGPT. A personality is one ongoing relationship, like a Slack DM. Users also want to see every time they @'d a personality across channels.

## Decision

1. **Four conversation types, each with one shape.** *Hermes chat* is a sparkle square. *Channel* is `#`. *Direct message* is a filled avatar circle. *Side chat* is a dashed avatar circle. The shape appears everywhere a conversation is named: rail, header, All chats, Mentions, search and the @ menu.
2. **Hermes is a section, not a DM.** It sits first in the left rail and shows its last five chats inline. Its `+` and ⌘N start a new Hermes chat from anywhere. *All Hermes chats…* opens All chats filtered to Hermes. The base agent no longer appears under Direct messages.
3. **DMs are one thread per personality.** Direct messages `+` picks an agent; it never forks a thread. The header reads *Direct message · one ongoing thread*. Day dividers, *Jump to date* and *Search this DM* make the long thread usable.
4. **Side chats replace leftovers.** Branching a DM or channel message, and today's extra per-agent sessions, become side chats owned by that agent. They are listed in All chats and on the agent's page. Untitled base-agent sessions become ordinary Hermes chats. The word "leftover" leaves the product.
5. **Recent becomes All chats.** It is the complete history across types, with filters for type, agent and source (Telegram, CLI, WebUI, API) and search. It is still never the landing view (0007 rule kept).
6. **Mentions.** Each DM header has two tabs: *Messages* and *In channels*. In channels lists every @ to that agent in rooms, with the reply. It shows *Open in #room*, *Continue in DM*, and a reply state: Replied, No reply yet, or Replied later. A global *Mentions* rail row shows the same cards for every agent, with agent chips. Its count is unseen replies only. Posts never count. Desktop builds the index from channel user lines with `delivery: 'woke'`, `parseMemberMentions`, and the next assistant turns' `agentSlug`.
7. **DM context horizon (token budget).** A DM's window is a token budget, not a message count. When the stack trims, the transcript shows a dashed line: *{Agent}'s next reply sees from here down · about 6k of 8k tokens*. Messages above it are dimmed. The line moves as the thread grows. The composer gets a *Context: recent* chip with *whole thread, once* and *pick messages*. Per 0009, the stack owns the budget and decides where the cut falls. Desktop draws the line at the first included row id that the stack reports and never estimates it. `session.context_breakdown` already reports used/max per session, but not the cut row. Ship nothing here until the stack reports the cut.
8. **The base agent's name is “Hermes”, read from one place.** Every surface reads the built-in agent's display name, handle and mark from the built-in agent record. Nothing uses a literal. The record's default becomes *Hermes* (migrate the stored `Assistant`). The slug stays `assistant` because it is an internal, stable id that does not depend on the agent being Hermes. When the stack can swap the base agent, it fills that record from the stack. Until then, desktop hardcodes the name.
9. **Hermes can be a channel member.** The built-in agent can be added to rooms and woken with `@Hermes`, like any personality. Its turns run on the default profile (`profile: null`). **New channel** pre-checks Hermes as a member, and the user can remove it. A channel made from a Hermes chat keeps Hermes as a member. A room with zero members is still valid (0009). Hermes follows the same rules as everyone else: it is never the room's host or receipt voice, and it never replies to a post unless asked. Its @-exchanges appear in Mentions under a Hermes chip. Hermes has no DM, so *Continue in DM* reads *Continue in a Hermes chat* and opens a new chat seeded with the exchange.
10. **Old per-agent sessions become side chats.** Every non-standing session owned by a personality becomes `side`. Nothing is spliced into the DM thread.
11. **Mentions covers channels only.** DM messages never appear in Mentions or In channels, because everything in a DM is already addressed to that agent. An Activity view for agent-started messages (scheduled runs, later reads) is deferred to a later ADR. Mentions should not be renamed or widened in the meantime.

## Consequences

- `HermesConversationKind` becomes `'hermes' | 'dm' | 'side' | 'channel'`. Migration: Assistant standing DMs and Assistant leftovers become `hermes`. A personality's non-standing sessions become `side`.
- `handleNewDm` splits in two: ⌘N creates a Hermes chat, and DM `+` opens an agent picker. Message-actions Branch on a DM creates a `side` chat.
- 0014 tabs change: Hermes chat → Session + Project; Side chat → Agent + Project. The Session tab loses *Keep as DM*, which no longer means anything. *Make channel* stays, but only on Hermes chats.
- A change request to the assistant stack is needed for a DM history window (N or token budget) and a one-turn "whole thread" override.
- About 7 renderer literals (`'Assistant'` in `WorkbenchChatScreen`, `WorkbenchThread`) and the `hermesAgents` thread title should read the built-in record instead. The roster's `!agent.builtIn` gate on *Add to channel* is removed.
- If two agents share a handle, the @ menu shows the shape mark and role so the user can tell them apart. Reserve `Hermes` as a handle while it is the built-in name.
- The stack change request covers three things: the DM token budget, the first included row id per turn, and a one-turn “whole thread” override. A later request covers base-agent identity (name, handle) when swapping lands.
- Later: an Activity view may grow out of Mentions once agent-started messages exist. That needs its own ADR.
