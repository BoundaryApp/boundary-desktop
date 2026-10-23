# Chat types UX study mocks

Reference windows for telling Hermes chats, channels, DMs and side chats apart, plus the Mentions view. The decision is [ADR 0023](../adr/0023-chat-types-and-hermes-home.md) (Accepted). It supersedes parts of [0007](../adr/0007-multi-agent-dms-and-roster.md) and amends [0008](../adr/0008-multi-agent-channels-and-wake.md) and [0009](../adr/0009-channel-default-is-post.md).

| File | Role | Status |
| --- | --- | --- |
| [index.html](index.html) | Study board: types, missing types, recommendation, foils, what changes, open questions | — |
| [01-chat-types.html](01-chat-types.html) | Recommended rail (A): typed sections, All chats, #room, DM with context horizon, Ana · In channels, Mentions | Accepted (ADR 0023) |
| [spec.md](spec.md) | Living build plan: phases, AC, progress | Proposed |
| [study.css](study.css) / [study.js](study.js) | Shared chrome and state switching. The chat skin is copied from the message-actions kit. | — |

Open the files over HTTP, for example with `python3 -m http.server` from the repo root (or the `docs-static` launch config), then go to `/docs/chat-types-ux-study/`. Use the title-bar buttons or the rail for states. **Light** remaps the theme and **Notes** shows the design callouts. States can be deep-linked, for example `01-chat-types.html?state=dm-ch`.

What's live in the mock: rail rows switch screens. The All chats type chips filter. The Mentions agent chips filter. *Include earlier* lifts the DM horizon. The *Context* chip opens its menu.
