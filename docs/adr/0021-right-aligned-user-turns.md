# 0021. Right-aligned user turns and message hover rows

- Date: 2026-09-29
- Status: Proposed
- Parent: [0020](0020-centered-transcript-column.md)
- Related: [0003](0003-workbench-chrome.md), [0008](0008-multi-agent-channels-and-wake.md), [0018](0018-design-tokens-and-primitives.md)

## Context

0020 put every message on one left edge in a centered 720px column. Prompts and replies shared that edge, and each prompt carried a "You" label, so the log read like a document rather than a back-and-forth. Hermes WebUI and ChatGPT, where many users come from, put the user's turns on the right. The message-actions study ([docs/message-actions-ux-study/](../message-actions-ux-study/index.html), option D) also needed a place for per-message time and verbs that does not reflow the log.

## Decision

- User turns hug the column's right edge. The bubble fits its text, up to 80% of the column. Text inside stays left-aligned, so 0020's "text stays left-aligned" still holds.
- User turns have no "You" label. Alignment says who spoke. This applies in DMs and channels. Agent turns keep their speaker label and the full column.
- Each message has a hover row in the 28px gap below it. Showing the row never moves text.
  - A prompt's row aligns to the bubble's right edge: time, then verbs.
  - A reply's row aligns left: verbs, then time at the far end.
  - The row appears on hover (after 60ms) and whenever keyboard focus is inside the message.
  - The latest reply's verbs stay visible. No row shows on a reply that is still streaming.
- Message time comes from the Hermes transcript. A message with no stored time shows none. Load time is never used as a stand-in.
- "Today", "Yesterday" or a date divides messages from different local days.

## Consequences

- The log reads as turns at a glance, and the prompt label is gone.
- Very long pasted prompts are narrower than before. Collapsing them behind "Show more" is a follow-up in the message-actions spec.
- Later verbs (Edit, Retry, Branch) slot into the same rows without new layout.
- `docs/chat-ux-study/` mocks still show left-aligned prompts. Treat this ADR as the override.
