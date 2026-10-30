# 0035. Turn admission and a model gate in the router

- Date: 2026-10-30
- Status: Proposed
- Parent: [0033](0033-inference-chains.md)
- Amends, if accepted: [0033](0033-inference-chains.md) §5 and §6
- Related: [0016](0016-chat-inference-override.md), [0022](0022-run-control-in-the-composer.md), [0034](0034-shared-models.md), [workload scheduling plan](../workload-scheduling-plan.md), [run control spec](../stop-button-ux-study/spec.md)

## Context

Nothing between Boundary and a model server limits how many turns or model calls run at once. Hermes starts a thread per turn. Its `max_concurrent_sessions` is off by default and refuses with `4090` rather than queueing, and it has no semaphore around main chat completions. `llm-proxy` forwards every request on its own thread.

A local model server queues what it can't run. LM Studio sends headers for a queued request straight away and no chunks until a slot frees (measured with its `parallel: 4`). Hermes's stale clock moves only on real stream chunks, so a queued request is dropped at the stale timeout and retried. The router's header timeout doesn't fire, so the request stays on that entry. The provider's gateway for a shared model ([0034](0034-shared-models.md)) runs one request at a time, sends no headers while a request is queued, and doesn't know about the provider's own chats, so a long queue there reads as a failed entry to the consumer's router ([0033](0033-inference-chains.md) §6).

Hermes has no pause. `session.interrupt` saves the partial reply and ends the turn, and it doesn't stop an OpenCode task the turn is waiting on.

Boundary controls two points on this path: when it calls `prompt.submit`, and, since [0033](0033-inference-chains.md), the router, which runs in its main process and sees each model request with the header naming its conversation. A one-entry chain doesn't use the router today.

## Decision

1. **Two layers.** A scheduler in main admits turns, up to a turn limit, and holds the rest. A gate in the router admits model requests to each chain entry, up to that entry's model limit, in priority order. Admission keeps the number of waiting turns small. The gate orders calls inside the turns that are running.
2. **The router is on the path whenever an entry has a limit.** This amends [0033](0033-inference-chains.md) §5. Local and shared-model entries are limited, so a one-entry local chain goes through the router. A one-entry cloud chain stays direct. A routed one-entry chain still has the hard stop of [0016](0016-chat-inference-override.md) §4.
3. **Limits belong to the entry.** A local entry's limit is a user setting, which defaults to the parallel limit the server reports, or 1 if it reports none. A shared model's is 1. Cloud entries have none by default. The turn limit is the model limit plus one on a limited entry, because a turn spends part of its time in tools, and 6 for cloud.
4. **Priorities are Now, Normal and Later.** The gate serves them in that order. Within a priority it serves the foreground chat, then requests inside a running turn, then the oldest. A request past the age limit goes next, so no request reaches Hermes's stale timeout.
5. **Requests are attributed by header.** The affinity header names a conversation's root session id or a board task (`kanban:<task>`). OpenCode's requests carry a fixed header from its provider config. An unattributed request counts as Normal.
6. **Pause is a hold at the gate.** The turn finishes its current model call and tool, and its next request waits, with its state intact in Hermes. If the hold nears the wait budget, Boundary interrupts the turn and later sends the Continue prompt ([0022](0022-run-control-in-the-composer.md)). Yielding to higher-priority work uses the same hold, without the conversion.
7. **A full entry is not a failed entry.** The gate waits. It doesn't move the request down the chain. This keeps [0033](0033-inference-chains.md) §6's fallback reasons as they are, unless the user turns on **Use the next model when busy**, which adds one: a new turn at Now or Normal priority may start on the next entry when the first is full. That is a separate consent from a chain's standing consent to fall back on failure, because it can spend money while the first entry is healthy. [0033](0033-inference-chains.md) §7 still keeps a turn on its entry, and §4's privacy lock still cuts the chain.
8. **The router keeps a chain per session.** Sessions register their chain before their turn is submitted, and unattributed requests use the app chain. Chats on different chains run side by side when Hermes sees the same model name and context.
9. **Held sends create their chat and drain from main.** The session exists and the chat is in the rail at once, with only `prompt.submit` waiting. This differs from the run control spec's decision 2, which keeps per-chat follow-ups draining only while their chat is open. A held send is a turn the user already saw go out, and the rail shows it start. A send that needs an apply is held until no turn is running, instead of refused.
10. **A provider's own work goes first.** The gateway takes a model slot from the same gate. Members rank below the provider's Normal work and above Later.

## Consequences

- Local users' tokens now pass through Boundary's main process. If that shows as lag, the router moves to a utility process. The plan measures this before building.
- With Boundary closed, a routed local entry has no router, so board tasks and cron lose their model unless the local upstream is pushed as the route's fallback behind the router. The proxy's fallback also fires on the router's own 503, which skips the gate for that request.
- Going onto the router is an apply, so existing local installs move at their next apply.
- Turn limits undercount cloud capacity, which is acceptable because a cloud-only chat has no gate and the limit is a setting.
- A short pause costs nothing and leaves no marker in the transcript. A long pause is an interrupt and a new turn, and reads as one.
- The gate holds requests silently from Hermes's point of view, so waits must stay under the stale timeout. Boundary already sets that timeout, and a keep-alive from the router is a spike in the plan, not a promise here.
- Holding requests pauses all OpenCode work together, and only for as long as OpenCode tolerates a silent request. A long pause of one task needs change request [0018](../change-requests/0018-workload-scheduling.md) R1 or a direct abort.
- The router becomes the place that knows how busy a model is. The busy notice, the Workload panel and the provider's sharing queue read from it.
