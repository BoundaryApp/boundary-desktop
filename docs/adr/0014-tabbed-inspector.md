# 0014. Right rail is a tabbed inspector

- Date: 2026-09-25
- Status: Accepted
- Parent: [0003](0003-workbench-chrome.md)
- Related: [0013](0013-project-sources-inspector.md), [0007](0007-multi-agent-dms-and-roster.md), [0008](0008-multi-agent-channels-and-wake.md)
- Sources: [`10-inspector.html`](../chat-ux-study/10-inspector.html) (J)

## Context

[0013](0013-project-sources-inspector.md) put source directories on the Workbench right rail. The shipped chrome then stacked room members, leftover actions, the agent role card, and the sources inspector in one scroll, plus always-on teaching copy, Files / Live rows, and Coming soon retrieval modes. Dark secondary text (`#8e8e96` / `#63636c` on `#161618`) failed small-text contrast. J in the chat UX kit proposed conversation-aware tabs and a silent happy path.

## Decision

The right rail is **one inspector** with tabs that match the active conversation. Do not stack Room, Agent, Session, and Project in one scroll.

1. Tabs shown: Channel → Room + Project (default Room). Named DM → Agent + Project (default Agent). Assistant → Agent + Project (default Project). Untitled leftover → Session + Project (default Session). Reset the selected tab when the conversation identity changes. Do not persist tabs.
2. Project tab keeps the 0013 model (source directories with Open, mount honesty, extras not in the picker). Visual: no file list, no Index preview, no always-on teaching copy, no Files / Live rows, no Coming soon retrieval. Banners only for Not visible, Writable, or Stale. Ready returns no next-step card.
3. Agent tab shows Role (roster one-liner) and a Soul excerpt from `profiles.describe`. Open SOUL.md reveals the host file. Skip Soul on built-in Assistant unless describe returns one. Do not invent a second identity system.
4. Room tab is members, then a project chip that jumps to Project. Session tab is Keep as DM / Make channel only.
5. Dark contrast lifts secondary text to meet AA against the panel (`#c4c4cc` muted, `#9e9ea8` faint).
6. Living chrome spec: [`docs/chat-ux-study/10-inspector.html`](../chat-ux-study/10-inspector.html). H remains the 0013 state machine. I remains the add-folder source.

## Consequences

- Product chrome ships J’s tabs, quieter Project pane, Role + Soul, and contrast tokens.
- LightRAG / `retrieval: both` stay hidden until the indexer accepts them (0013 / phase-2).
- Extra folders still never appear in the picker or composer chip.
- Do not restyle A’s left rail from F. Do not edit Soul in the rail — Open the file.
