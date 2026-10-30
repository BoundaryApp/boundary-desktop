# 0015 · Approval for every tool call a model reply asks for, when the reply says so

**Serves:** [circles plan](../circles-plan.md), [ADR 0034](../adr/0034-shared-models.md) §3.
**Status:** Open

## Background

Boundary lets members of a Circle share a local model with each other. Another member's model can then serve a turn in the user's chat, through Boundary's inference router. The provider's Mac sees the prompt, and its reply drives the user's agent: Hermes runs the tool calls in it, including the terminal and, through the host bridge, the user's browser. A provider with a modified model server could have the consumer's agent run commands.

ADR 0034 §3 gives each provider a **Trusted** setting. Without it, every tool call with side effects in a turn that provider served should wait for the user's approval, whatever the session's approval mode.

What was checked in the pinned Hermes image (`nousresearch/hermes-agent:v0.22.5`, read-only):

- `approvals.mode` is `manual`, `smart` or `off` (`tools/approval_context.py`, `_VALID_MODES`; default `smart` in `hermes_cli/config_defaults.py`).
- The approval gate in `tools/approval.py` covers terminal commands that `tools/approval_detection.py` finds dangerous by pattern, plus `approvals.deny` globs and the permanent allowlist (`tools/approval_floors.py`). File writes are gated only for a few protected paths (`agent/file_safety.py`, `is_write_approval_required`), and memory and skill writes by `write_approval` (`tools/write_approval.py`).
- No setting, gateway method or per-session state asks before every side-effecting tool call, and nothing ties approval to which model or upstream produced the reply.

## R1 · A reply can ask for approval of every side-effecting tool call it contains (Wanted)

**Why:** the router knows which upstream answered each model call, and Hermes knows which tool calls came from which reply. Neither alone can gate tool calls by who produced them. A response header from the model endpoint joins the two, and is useful to any stack user who routes some calls to a model they don't fully trust.

**Ask:** when a chat completion response carries `X-Hermes-Approve-Tools: all`, Hermes treats every tool call in that reply that can change anything (terminal, file writes, browser actions, MCP tools not marked read-only, memory and skill writes, sending messages) as needing approval through the normal approval flow, with the same choices as today. `session` and `always` choices made for such a reply apply only to calls from replies that carry the header. Read-only tools (file reads, search, listing) run as usual. YOLO, `approvals.mode: off` and the permanent allowlist do not bypass it. Where nobody can answer (cron, single query, unattended platforms), the calls are denied, as `cron_mode: deny` does.

**Acceptance:** with a stand-in upstream that returns a `terminal` call and the header, a gateway session in `smart` mode with YOLO on asks for approval before running it; without the header it runs as today. A `read_file` call in a reply with the header runs without asking. The approval request names the tool and says the reply came from a model that asked for approval.

**Boundary fallback:** an untrusted provider's model doesn't serve at all. The router treats its chain entries as stale (`provider-untrusted`), and the chain editor and Circles screen say the entry is skipped until the user trusts that person. When R1 lands, Boundary's router adds the header to replies from untrusted providers, and the entries serve again. Code that goes away: the `provider-untrusted` stale reason in `src/main/services/inference/chain/resolveChain.ts` and its copy in `src/renderer/product/chat/ChainEditor.tsx`.

## R2 · Say which tools count as side-effecting (Later)

**Why:** R1 needs a line between tools that change something and tools that only read. Boundary would show the same line to the user ("this reply wants to run 3 tools that change things").

**Ask:** expose, per tool in a session's tool list, whether Hermes treats it as side-effecting for R1, for example a `side_effects: boolean` in the gateway's tool listing.

**Acceptance:** the listing marks `terminal`, `write_file` and browser actions true, and `read_file` and `search_files` false.

**Boundary fallback:** none needed until Boundary shows the count.
