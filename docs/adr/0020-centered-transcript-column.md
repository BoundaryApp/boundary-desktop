# 0020. Centered transcript column

- Date: 2026-09-29
- Status: Proposed
- Parent: [0003](0003-workbench-chrome.md)
- Related: [0004](0004-instrument-composer.md), [0006](0006-tool-approval-interrupt.md), [0008](0008-multi-agent-channels-and-wake.md), [0018](0018-design-tokens-and-primitives.md)

## Context

The transcript pane had three horizontal axes. The empty state and starters were centered. Messages were a 720px column pinned to the pane's left gutter. The composer was a full-width bar. Sending the first message moved the content from center to left. On wide windows with the inspector closed, all spare width collected on the right, and the composer ran under empty space.

Most people arrive from ChatGPT, Claude, Gemini or Open WebUI, where a centered reading column with left-aligned text is the norm for assistant chat. Left-anchored feeds (Slack, Discord, IDE chat panels) suit logs and rooms. Dense tools such as PyGPT use full-width output. Centering changes nothing once the pane is at or below the column width plus gutters, which covers most layouts with the inspector open. It only takes effect on wide panes, which is where the left-anchored layout looked worst.

## Decision

- One reading column, centered in the transcript pane. `--chat-column` (720px) and `--chat-gutter` (36px) live in `tokens.css`. `.wb-center` derives `--chat-inline`, which is the larger of the gutter and half the spare width.
- The transcript log, the composer and the approval strip all use `--chat-inline` for their inline padding, so they share one left edge and one right edge. The @ mention menu follows the composer.
- Text stays left-aligned. Paragraphs, lists, quotes and headings keep the 62ch measure. Code blocks, tables and the agent draft card may use the full column.
- The composer floats on the pane surface. It no longer has a full-width bar or top border, and the textarea card carries the edge.
- Channels keep speaker rows inside the same column. There is no separate left-anchored layout for rooms.
- The recenter is not animated when the inspector opens or closes.

## Consequences

- The empty state, the first message and every later message sit on the same axis.
- Content can move sideways when the inspector toggles on a wide window. This is accepted in exchange for a balanced wide layout.
- Column width is one token edit. A later breakout wider than the column for code or tables would be additive.
- `docs/chat-ux-study/01-workbench.html` still shows the left-anchored transcript. Treat this ADR as the override until the mock is refreshed.
