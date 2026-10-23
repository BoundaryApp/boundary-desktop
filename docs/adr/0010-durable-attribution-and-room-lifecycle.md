# 0010. Durable attribution and room lifecycle

- Date: 2026-10-10 (first drafted 2026-09-23)
- Status: Accepted (2026-10-10)
- Parent: [0008](0008-multi-agent-channels-and-wake.md)
- Amends: [0008](0008-multi-agent-channels-and-wake.md) §2 (membership is reversible) and §7 (the draft card), [0007](0007-multi-agent-dms-and-roster.md) §4 (the roster can edit)
- Related: [0009](0009-channel-default-is-post.md), [0014](0014-tabbed-inspector.md), [0023](0023-chat-types-and-hermes-home.md), [0024](0024-chats-belong-to-projects.md)
- Sources: [`06-channels.html`](../chat-ux-study/06-channels.html) (F), [`07-agents.html`](../chat-ux-study/07-agents.html) (G)

## Context

[0008](0008-multi-agent-channels-and-wake.md) and [0009](0009-channel-default-is-post.md) shipped local-first rooms, explicit add, mention-wake and post-as-default. [0023](0023-chat-types-and-hermes-home.md) made Hermes the built-in agent and a possible member, and [0024](0024-chats-belong-to-projects.md) filed every channel under a project.

Rooms still aren't livable. After a reload each reply names its own speaker, but while a wake streams, every woken agent's text lands in one bubble under the last speaker's name. Channels can't be renamed or deleted, agents can't be edited after they're made, and choosing a not-in-channel agent from `@` opens a sheet instead of finishing the mention. The draft card shows its raw `agent-draft` fence, and a failed Create from the card shows no error.

The first draft of this ADR (2026-09-23) predates 0023 and 0024. This version restates it in their terms.

## Decision

1. **Who-lines are per message, live too.** Speakers persist in the session map and history carries `agentSlug`, as shipped. While a room wake streams, each woken agent gets its own assistant bubble and who-line (glyph and display name) as its turn starts, so the transcript doesn't regroup when it reloads. User posts stay **You**.
2. **Remove is the lifecycle verb.** *Shipped in `a47f54c`.* The Room tab removes a member. Removing doesn't touch their profile, DM or past who-lines, and they can't be `@`-woken until added again. Hermes can be removed from a room (0023 §9).
3. **Channel rename and delete, from the title's chat menu.**
   - **Rename** changes the title and slug, keeping slugs unique, and retitles the Hermes session to match so the rail and session repair still find it.
   - **Delete** removes the room record only. Every session the room linked becomes an ordinary Hermes chat in the room's project. Hermes's `state.db` is not touched. The room's Mentions cards go with it.
   - **After delete**, land on the newest chat in the room's project, else that project's page. A room with no project uses the usual landing: last-opened, the newest Hermes chat, then an empty Hermes composer. Never All chats.
4. **Agent edit, not agent delete.** The roster and the Agent tab can change an agent's display name, handle and role. A role change updates the agent's Hermes profile, not just Boundary's record. The built-in agent isn't editable: its name comes from the stack (0023 §8), and `Hermes` stays a reserved handle. No agent or DM is deleted in this slice.
5. **`@` a not-in-channel agent** adds them to the room and inserts `@DisplayName` in one gesture. If the add fails, nothing is inserted.
6. **The draft card** stays owner-gated (0008 §7). Once the card renders, the raw `agent-draft` fence is hidden. If Create from the card fails, the create sheet opens with the error. Duplicate handles are allowed (0023); the only rejected handle is the built-in's.

Wake and post stay [0008](0008-multi-agent-channels-and-wake.md) and [0009](0009-channel-default-is-post.md). The members language stays *Member · reads later*. Don't invent presence. Don't restyle A from F.

## Consequences

- Rooms are livable: speakers stay named while streaming and after, membership is reversible, and a channel can be renamed or removed without touching Hermes memory.
- Deleting a channel loses its Mentions cards; the transcript itself is kept as a Hermes chat.
- Agent edit needs the gateway's `profiles.configure`; channel rename needs a `session.title` wrapper.
- Rejected: Buzz / `bot_relay.*`, cron, last-read, auto-reply, unread soup, presence, agent delete, and renaming the built-in agent.
- Native gateway append remains a later mapping for `channelPosts`. Keep the overlay until that API exists.
- The plan and the state of each decision on main are in [`docs/room-lifecycle-plan.md`](../room-lifecycle-plan.md).
