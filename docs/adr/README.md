# Architecture decision records

This tree is the source of truth for decisions that should outlive a chat or a canvas. New work cites the relevant ADR instead of restating it.

Format is [Nygard](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions): Context, Decision, Consequences. Status is one of `Proposed`, `Accepted`, `Experimental`, `Superseded`, `Deprecated`.

## Tree

```
0001 Record architecture decisions
 ├── 0002 Chat is the product home after ready
 │    ├── 0015 Two stored inference connections, Settings is the destination
 │    │    └── 0016 Chat inference override and honest apply
 │    │         └── 0017 Project inference pin and resolve order
 │    │              └── 0033 Inference chains and a host-side router (amends 0016 §4)
 │    │                   └── 0035 Turn admission and a model gate in the router (proposed, would amend 0033 §5–6)
 │    ├── 0003 Workbench chrome (A + B affordances + light theme)
 │    │    ├── 0013 Project sources inspector (H + I)
    │    │    └── 0028 Coding folders (L)
 │    │    ├── 0014 Tabbed inspector (J)
 │    │    ├── 0020 Centered transcript column
 │    │    │    ├── 0021 Right-aligned user turns and message hover rows
 │    │    │    └── 0030 Hermes's board is a view of Tasks
 │    │    └── 0018 Design tokens and primitives
 │    │         └── 0019 Onboarding in the workbench frame
 │    │              └── 0029 A full-window start-up screen (supersedes 0019 §6)
 │    ├── 0004 Instrument composer (steal C)
 │    │    └── 0022 Run control in the composer
 │    ├── 0005 Folder-first create flow (D)
 │    ├── 0006 Tool-approval interrupt (E)
 │    ├── 0007 Multi-agent DMs, roster, Recent, and @ agents
 │    ├── 0008 Multi-agent channels, membership, and mention-wake
 │    │    ├── 0009 Channel default is post
 │    │    └── 0010 Durable attribution and room lifecycle
 │    ├── 0023 Chat types: Hermes home, one-thread DMs, side chats, Mentions (supersedes 0007 §1–3)
 │    ├── 0024 Chats belong to projects (amends 0003, 0017 §3, 0023)
 │    │    └── 0025 WebUI chats are filed by their workspace (amends 0024 §9)
 │    └── 0011 Resources is an icon-rail destination
 │         └── 0012 Host Compose inventory lives on Resources
 ├── 0026 The model key lives in the proxy's memory, not on disk
 ├── 0027 A host bridge gives Hermes the host's browser and capabilities
 ├── 0031 Checks on the stack contract and on drift
 └── 0032 Circles: invite-only groups that network peer to peer
      └── 0034 Sharing a local model with a Circle
            └── 0036 A shared model as the app default (amends 0033 §5)
```

| ADR | Status | Title |
| --- | --- | --- |
| [0001](0001-record-architecture-decisions.md) | Accepted | Record architecture decisions |
| [0002](0002-chat-as-product-home.md) | Accepted | Chat is the product home after ready |
| [0003](0003-workbench-chrome.md) | Accepted | Workbench chrome |
| [0004](0004-instrument-composer.md) | Accepted | Instrument composer |
| [0005](0005-folder-first-create-flow.md) | Accepted | Folder-first create flow |
| [0006](0006-tool-approval-interrupt.md) | Accepted | Tool-approval interrupt |
| [0007](0007-multi-agent-dms-and-roster.md) | Accepted · §1–3 superseded by 0023 | Multi-agent DMs, roster, Recent, and @ agents |
| [0008](0008-multi-agent-channels-and-wake.md) | Accepted | Multi-agent channels, membership, and mention-wake |
| [0009](0009-channel-default-is-post.md) | Accepted | Channel default is post |
| [0010](0010-durable-attribution-and-room-lifecycle.md) | Accepted | Durable attribution and room lifecycle |
| [0011](0011-resources-destination.md) | Accepted | Resources is an icon-rail destination |
| [0012](0012-resources-compose-inventory.md) | Accepted | Host Compose inventory lives on Resources |
| [0013](0013-project-sources-inspector.md) | Accepted | Project sources are a right-rail inspector |
| [0014](0014-tabbed-inspector.md) | Accepted | Right rail is a tabbed inspector |
| [0015](0015-inference-provider-slots.md) | Accepted | Two stored inference connections, Settings is the destination |
| [0016](0016-chat-inference-override.md) | Accepted · §4 amended by 0033 | Chat inference override and honest apply |
| [0017](0017-project-inference-pin.md) | Accepted | Project inference pin and resolve order |
| [0018](0018-design-tokens-and-primitives.md) | Accepted | Design tokens and primitives |
| [0019](0019-onboarding-in-workbench-frame.md) | Accepted · §6 and part of §1 superseded by 0029 | Onboarding in the workbench frame |
| [0020](0020-centered-transcript-column.md) | Proposed | Centered transcript column |
| [0021](0021-right-aligned-user-turns.md) | Proposed | Right-aligned user turns and message hover rows |
| [0022](0022-run-control-in-the-composer.md) | Proposed | Run control in the composer |
| [0023](0023-chat-types-and-hermes-home.md) | Accepted | Chat types: Hermes home, one-thread DMs, side chats, and Mentions |
| [0024](0024-chats-belong-to-projects.md) | Accepted · §9 amended by 0025 | Chats belong to projects |
| [0025](0025-webui-chats-filed-by-workspace.md) | Accepted | WebUI chats are filed by their workspace |
| [0026](0026-model-key-lives-in-proxy-memory.md) | Accepted | The model key lives in the proxy's memory, not on disk |
| [0027](0027-host-bridge.md) | Accepted | A host bridge gives Hermes the host's browser and capabilities |
| [0028](0028-coding-folders.md) | Proposed · amended 2026-10-07 | Coding folders: the coding agent works in folders the user grants |
| [0029](0029-full-window-startup-screen.md) | Proposed | A full-window start-up screen |
| [0030](0030-board-is-a-view-of-tasks.md) | Proposed | Hermes's board is a view of Tasks |
| [0031](0031-checks-on-the-stack-contract-and-drift.md) | Proposed | Checks on the stack contract and on drift |
| [0032](0032-circles.md) | Accepted | Circles: invite-only groups that network peer to peer |
| [0033](0033-inference-chains.md) | Accepted · amends 0016 §4 · §5 amended by 0036 | Inference chains and a host-side router |
| [0034](0034-shared-models.md) | Accepted | Sharing a local model with a Circle |
| [0035](0035-turn-admission-and-model-gate.md) | Proposed · would amend 0033 §5–6 | Turn admission and a model gate in the router |
| [0036](0036-shared-model-app-default.md) | Accepted · amends 0033 §5 | A shared model as the app default |
| [0037](0037-update-rail-button.md) | Accepted | Updates live in a rail button and card |
| [0038](0038-changing-circle-operations.md) | Accepted | Changing Circle operations after release |

## Host bridge research

The evidence behind [0027](0027-host-bridge.md).

| File | Role |
| --- | --- |
| [prior-art.md](../host-bridge/prior-art.md) | Research report: prior art, shipping apps, security practices |

## Chat reference mocks

These mocks are the visual record of the chat ADRs.

| File | Role |
| --- | --- |
| [index.html](../chat-ux-study/index.html) | Study board and accepted-decision summary |
| [01-workbench.html](../chat-ux-study/01-workbench.html) | Living spec for 0003 + 0004 |
| [02-quiet-hub.html](../chat-ux-study/02-quiet-hub.html) | Source for project cards and light tokens |
| [03-instrument.html](../chat-ux-study/03-instrument.html) | Source for the composer phase machine |
| [04-folder-first.html](../chat-ux-study/04-folder-first.html) | Source for 0005 |
| [05-approval.html](../chat-ux-study/05-approval.html) | Source for 0006 |
| [06-channels.html](../chat-ux-study/06-channels.html) | Source for 0007 (DMs, Recent, @ agents), 0008 (channels, members, wake), and 0009 (post default) |
| [07-agents.html](../chat-ux-study/07-agents.html) | Source for 0007 (roster, create), 0008 (Add to channel, draft-from-chat), and 0009 (post language) |
| [08-sources.html](../chat-ux-study/08-sources.html) | Living spec for 0013 (source directories + Open) |
| [09-add-source.html](../chat-ux-study/09-add-source.html) | Source for the 0013 add-folder honesty flow |
| [10-inspector.html](../chat-ux-study/10-inspector.html) | Living chrome spec for 0014 (tabs, quieter copy, contrast) |
| [phase-2.md](../chat-ux-study/phase-2.md) | Phase 2 remount shipped; leftover forbidden list |

## Resources reference mocks

These mocks are the visual record of 0011 and 0012.

| File | Role |
| --- | --- |
| [index.html](../resources-ux-study/index.html) | Study board and accepted-direction summary |
| [01-stacked.html](../resources-ux-study/01-stacked.html) | Living spec for 0011 |
| [02-quiet-meters.html](../resources-ux-study/02-quiet-meters.html) | Source for quiet density |
| [03-share-cards.html](../resources-ux-study/03-share-cards.html) | Source foil — card-per-bucket, likely reject |
| [04-compose-inventory.html](../resources-ux-study/04-compose-inventory.html) | Living spec for 0012 |
| [phase-2.md](../resources-ux-study/phase-2.md) | Follow-on: GPU and remaining attribution |

## Inference reference mocks

These mocks are the visual record for [0015](0015-inference-provider-slots.md), [0016](0016-chat-inference-override.md), and [0017](0017-project-inference-pin.md).

| File | Role |
| --- | --- |
| [spec.md](../inference-ux-study/spec.md) | Living spec, acceptance criteria, and phase progress |
| [index.html](../inference-ux-study/index.html) | Study board and accepted-direction summary |
| [01-settings.html](../inference-ux-study/01-settings.html) | Living sketch: two provider cards + app default |
| [02-chat-switch.html](../inference-ux-study/02-chat-switch.html) | Source: current-chat provider switch |
| [03-project-default.html](../inference-ux-study/03-project-default.html) | Source: project-level default + resolution |

## Design system

The design system sheet loads `src/renderer/styles/tokens.css` directly and is the living sheet for [0018](0018-design-tokens-and-primitives.md).

| File | Role |
| --- | --- |
| [index.html](../design-system/index.html) | Tokens, type, shape, primitives, and setup patterns |

## Onboarding reference mocks

This mock is the visual record for [0019](0019-onboarding-in-workbench-frame.md).

| File | Role |
| --- | --- |
| [index.html](../onboarding-ux-study/index.html) | Setup steps and start-up skeleton in the workbench frame |
