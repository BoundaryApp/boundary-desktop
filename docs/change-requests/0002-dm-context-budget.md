# 0002 · DM context budget, the visible cut, and base-agent identity

| | |
| --- | --- |
| From | Boundary desktop |
| To | [Sovereign agent stack](https://github.com/kaxline/sovereign-agent-stack) maintainer |
| Serves | [docs/chat-types-ux-study/spec.md](../chat-types-ux-study/spec.md) (Phases 4 and 7b) · decision [ADR 0023](../adr/0023-chat-types-and-hermes-home.md) |
| Opened | 1 Oct 2026 |
| Status | R1–R2 delivered (2 Oct 2026); R3–R5 open |

## Context

Boundary is splitting conversations into four kinds:

- **Hermes chats**: many titled sessions with the base agent.
- **Channels**: rooms.
- **DMs**: *one* ongoing session per personality profile, kept for months.
- **Side chats**: separate sessions run by a personality.

A DM's session keeps growing. The user has decided that what a personality sees on each turn is a **token budget**, not a message count. They also want the transcript to show honestly where that budget cuts off: a line reading *"Ana's next reply sees from here down"*.

What we can see in the gateway contract today:

- `session.compress` summarises older history and reports before/after messages and tokens.
- `session.context_breakdown` reports `context_used` / `context_max` per session.
- Neither says **which transcript row is the first one the model will see** on the next turn. Neither lets a DM have its own budget.

Boundary will not estimate this itself. Doing so would mean keeping a second model of the agent's context, and the line would lie whenever Hermes compresses.

---

## R1 · A per-session (or per-profile) history token budget

**Priority:** Blocking for spec Phase 7b.

**Why.** A personality's DM should send that agent only the recent part of the thread, plus whatever memory and summary Hermes keeps, so cost and latency stay flat as the thread grows.

**Ask.** A way to set a history budget, in tokens, for a session or a profile. When a turn's history would go over it, Hermes trims or compresses the older part using its own mechanism (compression summary or window). Accept it on `session.create` / `session.resume`, or as a profile config key. Tell us which, and its default.

**Acceptance.** For a DM session with a budget of B, the history the model receives (excluding system prompt, memory and tools) stays at or under B on every turn, and older rows are still returned by `session.history`.

**Boundary fallback.** None. DMs behave as today, and no horizon is drawn.

**Delivered (2 Oct 2026).** `history_budget` (a positive integer of tokens) is set on `session.create` and `session.resume`. It isn't a profile key: a profile also runs side chats. Omitting it on create, or sending `null`, means no budget. On resume, omitting it keeps the stored budget and `null` clears it. `0`, negatives and non-integers are RPC error `4028` and leave the session unchanged. The budget counts the history sent, including any summary, but not the system prompt, memory or tools. Two cases can go over it: the newest user message is always sent, and a tool call is never split from its results. The stack overlay is `compose/hermes/history_budget.py`, tested by `scripts/test-history-budget.py`. Boundary sends 8,000 for DMs on create and on every resume.

## R2 · Report where the cut falls

**Priority:** Blocking for spec Phase 7b.

**Why.** Boundary draws the line exactly at the first row the model will see, and labels it correctly when the older part is summarised rather than dropped.

**Ask.** On `session.context_breakdown`, and ideally on `message.complete` for the turn, return:

- `history_budget`: the R1 budget
- `history_tokens`: tokens of history sent
- `history_first_row_id`: the first transcript row included verbatim
- `history_summarised`: a boolean, true when rows before that point are represented by a compression summary

**Acceptance.** After any DM turn, `history_first_row_id` matches a `row_id` in `session.history`. Every row from it onward was sent verbatim; none before it was, apart from the summary.

**Boundary fallback.** Feature-detect the fields. Without them, no line and no context chip.

**Delivered (2 Oct 2026).** With the overlay running, `session.context_breakdown` (the cut for the next reply) and `message.complete` (the cut that turn sent) always carry all four fields at the top level. `history_budget: null` means no horizon. The stack's rule for drawing: a numeric budget, and either `history_summarised` is true or `history_first_row_id` isn't the first row of `session.history`. Boundary reads `session.context_breakdown`.

## R3 · One-turn overrides

**Priority:** Wanted.

**Why.** The context chip offers *the whole thread, once* and, later, *pick messages*.

**Ask.** `prompt.submit` params that apply to a single turn:

- `history_budget_override: 'full' | number`
- `include_row_ids: number[]`, which pins older rows into this turn's history

**Acceptance.** The override applies to exactly one turn. The next turn uses the session budget again. R2's fields reflect what was actually sent.

**Boundary fallback.** Those chip options stay hidden.

## R4 · Session search

**Priority:** Wanted. Serves spec Phase 4.

**Why.** All chats will list every conversation. Title-only search finds little once there are hundreds of chats.

**Ask.** A `session.search { query, limit, profile? }` returning session ids, titles and a matching snippet with `row_id`, across all profiles Boundary uses.

**Boundary fallback.** Client-side search over titles, agent names and channel slugs.

## R5 · Base-agent identity

**Priority:** Later, when the stack can swap the base agent.

**Why.** Boundary calls the base agent "Hermes" in a single built-in record and never in UI literals. If the stack lets users run a different base agent, Boundary should read its name from the stack.

**Ask.** Expose the base agent's `display_name`, `handle` and, optionally, a short role on `gateway.ready` or `config.get`.

**Boundary fallback.** The hardcoded "Hermes" record (spec Phase 1).
