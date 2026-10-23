# 0004. Instrument composer

- Date: 2026-09-20
- Status: Accepted
- Parent: [0002](0002-chat-as-product-home.md)
- Related: [0003](0003-workbench-chrome.md)
- Amended by: [0022](0022-run-control-in-the-composer.md) (Stop shows only during a run, in the input's corner)

## Context

Live probes showed 18,823 prompt tokens for a one-color-name turn, ~7 visible tokens, and no true LLM processing percent. Instrument (C) made that honesty the UI: overhead vs generated on a gauge, named tool + turn budget, tok/s after the first visible delta, dash when `context_max` is missing.

## Decision

Workbench uses Instrument’s composer, not a separate Instrument chrome.

The footer always shows: project chip with host path, `@`, usage (used / max and overhead vs generated when `context_max` is known), named phase, tools lever, Stop. After a turn, show in / generated / visible / TTFT. Never a fake determinate “thinking” bar. Never 0% when max is unknown.

Living spec is Workbench. Source mock: [`docs/chat-ux-study/03-instrument.html`](../chat-ux-study/03-instrument.html).

## Consequences

- Phase copy is “Preparing…”, a named tool + `turn N of max_turns`, then `N tok · X/s`.
- `context_percent` renders only when `context_max` is present.
- Cost fields stay unbound.
