# 0040. Developer-only agent access to app state

- Date: 2026-11-01
- Status: Proposed
- Parent: [0027](0027-host-bridge.md)
- Related: [0006](0006-tool-approval-interrupt.md) (approval interrupt), [0033](0033-inference-chains.md) (chains and router), [0034](0034-shared-models.md) (Private and Trusted), [bug report spec](../bug-report-ux-study/spec.md)

## Context

Developers working on Boundary want to ask Hermes why the app is misbehaving. Hermes can't answer, because none of its host tools ([0027](0027-host-bridge.md) §7) report app state, logs or settings.

Four facts shape the design:

- **A tool result goes to a model.** The result enters the session and is sent to whichever model serves the next call. With a cloud model or a shared model, it leaves the Mac.
- **The bridge doesn't know its caller.** Every Hermes profile holds the same token, and MCP sessions only tell processes apart. A tool call doesn't say which chat, agent or turn made it.
- **The stack has one inference route at a time.** The router and `llm-proxy` hold one chain for the whole stack ([0033](0033-inference-chains.md) consequences). A routed chain is in `setInferenceRouterChain`. A direct route bypasses the router, and `lastAppliedLlm` records its slot and endpoint.
- **The debug log isn't safe to hand over.** `readDebugLogTail` returns up to 256 KB of raw records. Their `data` fields can hold `stderr` and `stdout`, and the session header holds paths and `argv`.

## Decision

1. **Developer builds only.** The tools exist when `envFlag('BOUNDARY_AGENT_APP_ACCESS') ?? !app.isPackaged` is true, read once at startup, the same pattern as `BOUNDARY_LAG_PROBE`. A release build leaves them out of `tools/list` and refuses a call to them. There is no Settings control, so people using a release never see the feature. Hermes runs in a container and can't set this variable.

2. **Only local models and Trusted shared models.** Each call passes a model gate in main. The tools stay listed, as the list doesn't change during a session (0027 §7), and a call that fails the gate returns a refusal that names the entry at fault.
   - Every entry that could serve must qualify, not only the first. A cloud fallback fails the gate, because fallback needs no further consent (0033 §3). An offline shared model that could come back counts.
   - A `local` slot qualifies when `upstreamIsLocal` accepts its endpoint. The endpoint must also parse, because `upstreamIsLocal` answers true for a URL it can't read. A `local` slot aimed at a remote host fails.
   - A `peer` entry qualifies when its provider is Trusted (0034 §3). `openrouter` and `infrastructure` never qualify.
   - The gate reads the applied route: the router's chain when routed, `lastAppliedLlm` otherwise.
   - With no applied route, or in local-stack mode, the gate refuses. A developer's own stack keeps its model settings, so Boundary can't tell what serves it.

3. **Four levels of access, all behind decisions 1 and 2.**

   | Level | Tools | Consent |
   | --- | --- | --- |
   | Status | `get_app_status` | None |
   | Diagnostics | `get_recent_problems` | Approval interrupt, with **Always allow** |
   | Propose | `show_in_app`, `offer_action` | The user's click on a card |
   | Act | Typed tools, one per action | Approval interrupt, every time |

   Status and diagnostics ship first. Act tools start with restarting one stack service and changing the current chat's model, and are built only for actions developers keep accepting as Propose cards.

4. **`get_app_status` returns a fixed snapshot.**
   - Fields: app version, open screen and sheet, stack service health, turn state, the applied chain's model names and update state.
   - It carries ids only, never chat titles, composer text or message content.
   - The renderer publishes the screen and sheet to main, which holds no such record today.
   - The result describes what is on screen, not the caller's chat, because the bridge can't tell them apart.

5. **`get_recent_problems` uses the bug report collector.** It returns the collector's fixed fields (spec decisions 4 and 5): time, area, message, error name and repo-relative stack frames, with `data` dropped and secrets redacted. It never reads log files directly, and no code path gives it session content.

6. **The agent proposes and Boundary draws.** `show_in_app` takes a screen from a fixed list. `offer_action` takes an action from a fixed list and shows a card under the reply, as `offer_setup` does. The card's text is Boundary's own, never text the agent wrote.

7. **The agent can't widen its own authority.** No tool at any level reaches:
   - bridge grants and tokens, approval modes, or the agent browser's site policy;
   - calendar and coding-folder access;
   - secrets and passwords;
   - Circles membership, trust and model sharing;
   - installing updates.

   Raw IPC, script evaluation in the renderer and window screenshots stay out as well.

8. **Everything goes to the audit log.** Status, diagnostics and refusals by the gate are recorded like any other bridge call (0027 §7).

## First build

The first build has `get_app_status` and `get_recent_problems`. Status omits turn state. `get_recent_problems` reads the debug log tail through a stand-in for the bug report collector: time, area, message, error name and error code, with home folder, host name and account name removed. It has no stack frames. It catches no renderer error that stays in the renderer, because those listeners don't exist yet.

## Consequences

- **Earlier results can still reach another model.** The gate checks the route at call time. Tool results stay in session history, so a chat that later moves to a cloud model sends them along. Redaction carries this risk, which is why decisions 4 and 5 use fixed fields.
- **Trusted doesn't mean Private.** Trusted accepts that a person's model can run the agent's tools. Private accepts that they can read prompts (0034 §3). A Trusted provider who isn't Private receives diagnostics under this decision.
- **Prompt injection stays possible on a local model.** A page can still steer the agent to call these tools and send the result out. Developer builds and redaction limit what that yields. They don't prevent it.
- **Local-stack mode gets no access yet.** Decision 2 refuses there, and `bun run dev:local-stack` is a common developer setup. Lifting that needs a way to read the stack's real upstream.
- **It can't help when the stack is down.** The tools need Hermes and a model. Logs and **Write it myself** in the bug report sheet remain the route for those failures.
- **Bug report chat drafting stays open.** That flow (spec Phase 4) serves every user on any model, so it can reuse the collector but not these tools or this gate.
- **The collector replaces the stand-in.** When bug report Phase 1 ships, `get_recent_problems` moves to it and keeps its name. The renderer also needs the `error` and `unhandledrejection` listeners from Phase 2 before UI failures appear.
- **Tool descriptions cost context.** They count against local models' context, so the list stays short.
- **No new stack contract entry.** These are Boundary's own tools on the existing `mcp_servers.boundary` server. Each tool's live check is named when it's built.
