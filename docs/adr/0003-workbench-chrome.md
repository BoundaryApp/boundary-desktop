# 0003. Workbench chrome

- Date: 2026-09-20
- Status: Accepted
- Parent: [0002](0002-chat-as-product-home.md)
- Related: [0004](0004-instrument-composer.md), [0007](0007-multi-agent-dms-and-roster.md), [0013](0013-project-sources-inspector.md), [0014](0014-tabbed-inspector.md)
- Children: [0013](0013-project-sources-inspector.md), [0014](0014-tabbed-inspector.md)

## Context

The study kit compared four windows. Workbench (A) matched the IA. Quiet Hub (B) had clearer project scanning: 28px letter glyphs and left-aligned name + host path. Review chose A’s layout and kept B’s project cards plus B’s paper tokens as a light theme.

As the project list grew, it dominated the left rail even though a project is session-wide working context (cwd / bind-mount), not a chat destination. Threads (and later DMs / Recent) stay global. Listing every folder above conversations stole space and implied navigation the product does not do.

## Decision

Ship Workbench as the chat shell:

- Icon rail for app chrome; three panels (project context + conversations, transcript, host tree).
- **Current-project picker** replaces the left-rail project list: one trigger row (glyph, name or “No project”, chevron). No plus on that row.
- One shared menu from the rail trigger and the Instrument composer project chip:
  1. **No project** — first, named, checkable, persistable (`activeId: null`)
  2. Recent projects (last used) with Quiet Hub glyphs and `~/…` path
  3. Search when the list is longer than ~8
  4. **New project…** last — same host-folder picker as the former Projects subhed plus
- Conversation sections (Direct messages, later Channels) keep the section subhed plus. Project create lives only in the picker menu (except the zero-projects empty CTA: Choose folder…).
- Dark is the default theme. A light theme remaps Workbench tokens to Quiet Hub paper colors (`#f3f1ea` / `#fffcf6` / ink). Layout does not change.
- Living spec: [`docs/chat-ux-study/01-workbench.html`](../chat-ux-study/01-workbench.html). Source for cards and light tokens: [`02-quiet-hub.html`](../chat-ux-study/02-quiet-hub.html).

## Consequences

- Do not adopt B’s header-tab chrome or conversation-first density for P0.
- Theme is a token remap, not a second layout.
- Implementation should follow the Workbench mock, not restyle from Quiet Hub wholesale.
- Do not auto-select the first leftover project after a clear. Do not reattach a folder when switching chats with no project selected.
- If threads later scope to a folder (Quiet Hub / Folder First), revisit this control — a context picker is correct only while conversations stay global.
