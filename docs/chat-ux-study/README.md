# Chat UX study mocks

Reference windows for the Hermes Chat UX study. Decisions are in [`docs/adr/`](../adr/README.md).

| File | Role | ADR |
| --- | --- | --- |
| [index.html](index.html) | Study board | — |
| [01-workbench.html](01-workbench.html) | Living spec (layout, B cards, C composer, light toggle, Approve phase) | 0003, 0004, 0006 |
| [02-quiet-hub.html](02-quiet-hub.html) | Source: glyphs, left-aligned cards, paper tokens | 0003 |
| [03-instrument.html](03-instrument.html) | Source: composer phase machine | 0004 |
| [04-folder-first.html](04-folder-first.html) | Source: folder-first create flow | 0005 |
| [05-approval.html](05-approval.html) | Source: tool-approval interrupt variants | 0006 |
| [06-channels.html](06-channels.html) | Source: DMs, Recent, @ agents (0007); channels, members, wake (0008); post default (0009); who-lines, room lifecycle (0010) | 0007, 0008, 0009, 0010 |
| [07-agents.html](07-agents.html) | Source: roster, create (0007); Add to channel, draft-from-chat (0008); post language (0009); agent edit (0010) | 0007, 0008, 0009, 0010 |
| [08-sources.html](08-sources.html) | Living spec: project sources inspector (hub / not visible / writable / ready / stale) | 0013 |
| [09-add-source.html](09-add-source.html) | Source: add-folder flow (pick → mount honesty → refresh) | 0013 |
| [10-inspector.html](10-inspector.html) | Living chrome spec: tabbed inspector (Room / Agent / Session / Project) | 0014 |
| [12-coding-folders.html](12-coding-folders.html) | Source: coding-agent (OpenCode) folder access — add folder, new folder, project folder, in-chat grant, Settings overview | 0028 |

Open `index.html` in a browser. On Workbench, use **Light** for B’s palette and the title-bar phases for C’s composer and the 0006 approval interrupt. Open E for the approval variants. F and G are sources for [0007](../adr/0007-multi-agent-dms-and-roster.md) (DMs + roster + Recent), [0008](../adr/0008-multi-agent-channels-and-wake.md) (channels, membership, wake, draft-from-chat), and [0009](../adr/0009-channel-default-is-post.md) (channel default is post). H is the 0013 state machine; I is the add-folder source. J is the living chrome spec for [0014](../adr/0014-tabbed-inspector.md). Do not put extra folders in the project picker. In-app remount notes: [phase-2.md](phase-2.md).
