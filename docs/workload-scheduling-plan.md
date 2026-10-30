# Workload scheduling build plan

- Date: 2026-10-28, revised 2026-10-30 for the inference router
- Status: Proposed
- Decision: [ADR 0035](adr/0035-turn-admission-and-model-gate.md)
- Change request: [0018](change-requests/0018-workload-scheduling.md)
- Related: [ADR 0033](adr/0033-inference-chains.md) (chains and the router), [ADR 0034](adr/0034-shared-models.md) (shared models), [run control spec](stop-button-ux-study/spec.md) (Stop, Continue, the per-chat queue), [inference spec](inference-ux-study/spec.md), [ADR 0011](adr/0011-resources-destination.md) and [0012](adr/0012-resources-compose-inventory.md) (Resources), [ADR 0027](adr/0027-host-bridge.md) (host bridge), [task activity spec](kanban-activity-ux-study/spec.md), [coding task progress plan](coding-task-progress-plan.md)

## Goal

Someone who thinks faster than their model can answer can open chats and send prompts as fast as they like, and the app spreads that work over the inference and machine they have. The model works on what the user needs first: the chat they are looking at, or the one they marked urgent. Work the user marked for later waits, or yields, instead of slowing everything down. At any moment, from any chat, the user can see what is running, what is waiting and why, and change the order with one click.

## What happens today

Every send goes straight to Hermes. Boundary keeps no limit across chats: each send gets its own request id and calls `prompt.submit` (`startHermesChatStream` in hermesChatSessions.ts). Hermes starts each turn on its own thread. Its `max_concurrent_sessions` cap is off by default, and when set it refuses with `4090` instead of queueing. There is no semaphore around model calls. llm-proxy forwards every request on its own thread.

With one model on the chat path, requests go to the upstream directly and Boundary sees none of them. With a chain of two or more entries, they pass through the inference router in Boundary's main process (`chainRouter.ts`, ADR 0033 §5). The router has no concurrency limit either. It does tell conversations apart, by the `X-Boundary-Session` header Hermes sends when routed, and it records per-request timings in its `router.request` and `router.reply` diagnostics.

With a cloud provider this works up to the provider's rate limits. With a local model server, requests beyond the server's parallel slots wait in the server's queue and receive no tokens. LM Studio answers those requests with headers straight away and sends the first chunk only when a slot frees. Measured in Phase 0 with `parallel: 4`: of six requests sent together, all six had headers in under 0.5 s, four streamed first chunks at about 2 s, and two at about 12.5 s. Two things then go wrong:

- **Local server, direct or routed:** Hermes's stale-stream timeout for a local upstream (300 s) drops the request and retries it, because its stale clock moves only on real stream chunks. The router's 30 s header timeout doesn't fire, since headers arrive, so a queued local entry doesn't fall back. It also means the router can't move a queued request elsewhere: it has already committed to that entry. A few busy chats are slow. Dozens fail as timeouts, while the server keeps generating for callers that have gone.
- **Shared model:** the Circles gateway (`inferenceGateway.ts`, in the network process) runs members' requests one at a time in arrival order, and knows nothing about the provider's own chats, which go to the same local server. A queued member's request has no headers until its turn comes, so past 30 s the consumer's router falls back as if the model had failed. Ollama wasn't running for Phase 0, so its behaviour is untested.

Kanban workers, cron jobs, OpenCode tasks and LightRAG share the same model and are not counted anywhere.

Two limits come from how inference is applied. A send on a provider that needs an apply is refused while any reply runs: "Another reply is still running…" (`applyResolved` in sessionInference.ts), and the user has to send again. The router also serves one chain at a time. `setInferenceRouterChain` replaces it for every session, so two running chats on different chains with the same model name and context share whichever chain was set last.

Pausing does not exist. Hermes has no suspend or resume for a running turn. `session.interrupt` saves the partial reply (marked `interrupted`) and ends the turn. Interrupting a chat that is waiting on `coding_wait_for_task` does not stop the OpenCode task. OpenCode keeps running, and keeps using the model, in its own session.

## Terms

- **Turn slot:** one turn's right to be running. Boundary admits turns up to the turn limit.
- **Model slot:** one model request in flight to a chain entry. The router's **gate** admits requests up to each entry's model limit and makes the rest wait in priority order.
- **Held:** a send that Boundary has accepted but not yet submitted to Hermes, because no turn slot is free, it needs an apply, or the user asked it to wait. Held is a cross-chat state. It is separate from the run control spec's per-chat **Queue**, which holds follow-ups behind a turn already running in the same chat (that spec's decision 2 is unchanged).
- **Priority:** **Now**, **Normal** (the default) or **Later**.
- **Yielding:** a running turn whose next model request the gate is holding back. Hermes doesn't know; the turn stays alive.
- **Paused:** a turn the user stopped. It yields first. If it has to wait longer than the gate's wait budget, Boundary interrupts it and owes it a Continue.
- **Workload:** the list of running, held, yielding and paused work across the app.

## Decisions

ADR 0035 records these. Confirm them before Phase 1.

1. **Two layers.** Turn admission, in main, decides which chats run. The gate, in the router, decides which model request goes next. Each covers the other's gap: admission can't order calls inside running turns, and the gate alone would let hundreds of turns pile up behind it.
2. **The router is on the chat path whenever an entry has a limit.** That means any local or shared-model entry, including a one-entry local chain. This amends ADR 0033 §5. A one-entry cloud chain stays direct, so it has no gate, and with Boundary closed it keeps working as it does today. A one-entry chain keeps the hard stop of ADR 0016 §4: being routed doesn't make it a fallback chain. Going onto the router is an apply, so it happens at set-up or a model change, not during a send.
3. **Limits belong to the entry.** One setting per model: **Requests at once**, which defaults to what the server reports (LM Studio's `GET /api/v1/models` gives `loaded_instances[].config.parallel`) and otherwise to 1. A shared model's limit is 1, because the provider's gateway runs one request at a time and anything more waits there with the 30 s header timer running. Cloud entries have no gate limit by default. The turn limit is derived: model limit + 1 on a limited entry, because a turn spends part of its time in tools and uses no model. Cloud-only chats default to 6 turns. Phase 5 lowers the effective limits while the machine is under pressure.
4. **Gate order.** Now, then Normal, then Later. Within a priority: the chat the user is looking at, then requests inside a running turn ahead of those opening a turn, then oldest first. A request that has waited longer than the age limit goes next regardless, so Later work can't starve past Hermes's stale timeout.
5. **Attribution.** The header value says who a request belongs to: a conversation's root session id, `kanban:<task>` for a board task. Requests from OpenCode carry a header Boundary sets in its OpenCode config. A request with no attribution, such as LightRAG, counts as Normal. Boundary maps runtime session ids to root ids when it registers a turn with the gate.
6. **Pause is a yield first.** Pause tells the gate to hold the turn's model requests. The turn finishes its current model call and tool, then waits, with its state intact in Hermes. No interrupt and no Continue, so a short pause costs nothing. When the hold nears the wait budget, Boundary converts it: it interrupts the turn and owes it a Continue (`CONTINUE_PROMPT`). Automatic yielding uses the same mechanism, without the conversion.
7. **Waiting past the budget is an error to avoid, not a queue.** Hermes's stale clock moves only on real chunks, so a gated request must be released within the stale timeout. The turn limit keeps normal waits short, the age limit bounds Later, and the conversion bounds Pause. Boundary sizes the stale timeout through the setting it already writes (`agent.local_stream_stale_timeout`, ADR 0033 §8).
8. **Busy is not failure, unless the user says so.** The gate waits at a full entry. It doesn't fall back. Holding requests at the gate instead of in the local server's queue is what makes this possible: a request the server has accepted can't move, and one still at the gate can. The opt-in setting **Use the next model when busy** lets a new turn at Now or Normal priority start on the chain's next entry when the first is full. Later work never does. This extends ADR 0033 §6's reasons for moving down the chain, and §7 still keeps a turn on the entry it started with.
9. **A held send creates its chat at once.** The session is created (`session.create` claims no Hermes slot) and the chat appears in the rail with its title and a **Held** marker, so the user can move on and come back. Only `prompt.submit` waits. The user's text is kept in Boundary's main store until it is submitted, like a draft.
10. **Held turns drain from main, in the background.** This differs from the run control spec's decision 2, which keeps follow-up queues draining only while their chat is open. That decision was about follow-ups appearing in a conversation the user isn't watching. A held send is the first message of a turn the user already saw go out, and the rail shows it moving from **Held** to running.

## How it fits together

```
renderer composer ──send──► main: workloadScheduler ──admit──► runJsonRpcTurn ──► prompt.submit ──► Hermes
                                 │  turn slots, held store,                                           │
                                 │  priorities, foreground chat                                       │
                                 │                                                                 llm-proxy
                                 │ registers turns:                                                   │
                                 │ session → priority, chain                                          ▼
                                 └──────────────────────────► main: inference router ── gate ──► chain entries
                                                                  per-entry model slots          (local, peer, cloud)
       inputs:                                                         ▲
         limits per entry (Settings → Inference)                       │ asks for a model slot
         outside work: session.active_list, board tasks,        Circles gateway (network process):
           OpenCode GET /session/status                         members' requests on a shared model
         host pressure (Phase 4)

  scheduler + gate ──► 'workload:changed' ──► renderer: rail markers, composer notice, Workload panel
```

The router's gate sees every model request that reaches a limited entry, including those from board tasks, cron, OpenCode and LightRAG. That makes the gate the source of truth for how busy a model is. Phase 3's outside-work signals only name the work.

## Phases

Each phase lands as its own commits and passes `bun run check` before the next starts. Each phase ends with a short checklist for in-app testing.

### Phase 0: measure on the router

1. **Done.** `router.request` records requests in flight per entry when each request arrives. `gateWaitMs` joins it with the gate in Phase 1.
2. **Done, and it corrected this plan.** A queued LM Studio request doesn't miss the header timeout (see **What happens today**), so load doesn't spill to the next entry on its own. In this test all four parallel requests ran about as fast as one, with short prompts, so a limit of 1 would have wasted three slots. LM Studio reports its limit, which is why decision 3 reads it.
3. **Open, needs the app.** Measure main-process lag (the lag probe) while streaming through the router. Decision 2 sends every local user's tokens through main, and the app's responsiveness is part of the goal. If lag shows, move the router into a utility process before Phase 1, as Circles does with its network process.
4. **Partly done.** A `test:stack` case runs a real agent turn against a fake model server and confirms the header carries the session id. Still unconfirmed: what a board task sends, and that a compacted chat keeps its root id. Decision 5 and Phase 3 rely on these, so check them before Phase 3.

### Phase 1: admission and the gate

1. **Gate.** `router/modelGate.ts` is pure logic with fake timers in its tests: per-entry limits, the order in decision 4, the age limit, release on end and on client close. `completions` in chainRouter.ts acquires a slot before `runChainAttempts`' attempt for each entry, so the header timer measures the upstream only, and releases it when the reply ends (the `finishOnce` path) or the attempt fails.
2. **Router on the path.** Extend the plan from `planInferenceChain` so a one-entry local chain is routed but not a fallback chain: `RouterChain` gets per-entry limits, and `ensureResolvedInferenceReady` keeps the local-unreachable stop for it. `session_affinity_header` is written whenever routed, as now. Migrate existing local installs at their next apply.
3. **With Boundary closed.** Push the local upstream as the route's `fallbacks` entry behind the router (stack v0.3.7, change request 0014 R1), as ADR 0033's consequences describe for OpenRouter, so board tasks and cron keep their model. Boundary doesn't push fallbacks yet. This needs that step first. The proxy also falls back on the router's own 503, which skips the gate. That's acceptable for a local upstream.
4. **Scheduler.** `hermes/workloadScheduler.ts` in main keeps turn slots, the held list and each item's priority. `startHermesChatStream` asks it for a turn slot before `runJsonRpcTurn`. If none is free, the stream returns `{ success: true, held: true }` with the session id, and the turn starts later from main. The renderer adapter treats a held start as a run that hasn't begun yet. Releasing a slot happens in the same `finally` that calls `endRunningTurn`.
5. **Sends that need an apply.** `applyResolved`'s refusal becomes a hold: the send waits, with the reason shown ("Switching to OpenRouter restarts the assistant. Waiting for 1 reply to finish"), and applies when no turn is running. New turns behind it wait too, so it isn't starved.
6. **A chain per session.** The router keeps `session → RouterChain`, with the app chain for unattributed requests. The scheduler registers a turn's chain before submitting. Two chats on different chains then run side by side when Hermes sees the same model name and context (ADR 0033 §9). This closes the second gap change request 0014 R3 names.
7. **Held store.** Held text and priority live in `hermesAgentStore` keyed by session id, so a restart keeps them. On start-up, held items are re-admitted in order. Logs record ids, priorities, wait times and counts only, never text.
8. **Rail and chat.** The rail shows **Held** (a hollow dot) beside the working dot from `hermes-chat:running`. An open held chat shows the user's message and, under it, "Waiting for the model · 2 ahead" with **Run now** and **Cancel**. **Run now** starts the turn over the turn limit, at Now priority. **Cancel** returns the text to the composer. A running turn whose request is waiting at the gate shows "Waiting for the model" in place of the preparing phase, which is more than Hermes can report.
9. **Same chat.** A send to a chat whose own turn is running goes to the run control spec's per-chat queue, not here.
10. **Tests.** Unit tests cover the gate and scheduler: admission order, release on success, failure and cancel, restart recovery, **Run now** over the limit, the age limit. Router tests drive real sockets, as `chainRouter.test.ts` does. A mounted-runtime test covers a held chat opening and then going live.

### Phase 2: priorities, yielding and pause

1. **Priority control.** Holding the send button, or ⌥⇧↵, opens **Send now · Send · Send later**, which map to Now, Normal and Later. The chosen priority shows as a chip on the composer and on the chat's rail row. It can be changed from the rail's context menu while the chat is held, running or paused. A change reaches the gate at once, including for requests already waiting.
2. **Busy notice.** When the composer of a new or idle chat would be held, a line above it says what is in the way before the user sends: "The model is busy with 2 chats: *Refactor auth* (Later, 34 min) · *Trip research* (Normal, 2 min)". Each name links to its chat. The actions are **Send after them**, **Pause *Refactor auth* and send**, and **Send anyway**. The numbers come from the gate.
3. **Later yields.** A Now or Normal request goes ahead of waiting Later requests with no user action. That's the gate's order, and a Later turn only waits for one model call to finish. When the turn limit stops a send and a Later turn is running, the scheduler offers to pause it, or does so if the user turned on **Pause later work automatically**.
4. **Pause and resume (decision 6).** Pause is in the rail's context menu and in the busy notice. A paused chat shows "Paused by you · resumes when the model is free" with **Resume now**. Resuming a yielded turn releases its requests. A converted turn sends the hidden Continue and records the reply-ending marker the run control spec defines (`stopped`), with "Paused" text.
5. **Gate wait spike.** Test whether the router can extend a hold past the stale timeout by answering a streaming request with a 200 and empty-delta chunks while it waits. Hermes's `_count_chunk` would have to count them, and the router would give up passing an upstream's status through (it would have to report a failure inside the stream). If it works, a pause rarely needs converting, and the Continue path becomes the exception. If not, decision 6 stands.

### Phase 3: the Workload panel and outside work

1. **Outside work.** Names for what the gate already sees:
   - live Hermes sessions Boundary didn't start, from `session.active_list` (in the vendored contract; confirm the `status` field in the pinned image);
   - running board tasks, from the kanban store, matched to `kanban:<task>` requests at the gate;
   - busy OpenCode sessions, from `GET /session/status` (the check codingAgentBusy.ts already makes).

   Each counts against the turn limit while it runs. A cloud-only chat has no gate, so there these counts are estimates: a board task blocked on a tool isn't using the model.
2. **Workload panel.** It opens from the busy notice and from a new entry under the Chat icon. It lists everything running, held, yielding and paused, with priority, age, where it came from (chat, board, coding task, WebUI, Circle member), which chain entry it's on, and the current tool when known (`hermes-chat:running` already carries it). Its actions are the ones each source supports: Pause, Resume, Run now, Cancel, priority, and Stop for board tasks.
3. **Coding tasks.** A chat waiting on `coding_wait_for_task` shows the OpenCode task as its own row. OpenCode reaches the model through llm-proxy, so its requests reach the gate too. Boundary adds a fixed header to its OpenCode provider config (`updateOpenCodeLocalConfig`), and llm-proxy forwards it. Confirm that OpenCode sends provider headers and how long it tolerates a silent request. Pausing then holds OpenCode's requests at the gate, for all OpenCode work at once, because the header can't tell two tasks apart. A task that needs to stop for longer uses change request 0018 R1. Until R1 lands, Boundary calls OpenCode's abort for the session and resume sends `coding_continue_task` through the Continue prompt. Confirm the abort endpoint against the pinned OpenCode version before building. With no working path, the row offers Stop only and says so.
4. **Board work.** "Later" work that doesn't need a chat can go to the board. **Send later → Add to the board** files a kanban task with low priority. The dispatcher claims tasks in `priority DESC, created_at ASC` order and caps runs with `kanban.max_in_progress`, whose default has no cap on macOS. Boundary sets it to the turn limit when the entry is limited, through Hermes's config validation per the stack contract rules. The gate gives `kanban:<task>` requests Later priority unless the user changes it.

### Phase 4: shared models

1. **Consumer.** A `peer` entry has a model limit of 1 (decision 3). An offer's quota can raise it if it names a concurrency.
2. **Provider.** The gateway asks main's gate for a slot on the shared model's local entry before forwarding a member's request. Members rank below the provider's Normal work and above Later, because a person is waiting on the other end. The provider's own chats no longer race members for the server. The gateway lives in the network process, so this crosses its existing IPC. If main doesn't answer, the gateway keeps today's one-at-a-time behaviour.
3. **Busy answer.** When a member's request would wait longer than the consumer's 30 s header timeout, the gateway answers 429 before the reply starts, as it does for quotas (ADR 0034 §5). The consumer's router falls back or tries again, and doesn't wait on a request that is about to time out.
4. **Settings.** The sharing queue in Settings (ADR 0034 consequences) reads from the gate. The provider's Workload panel lists members' requests by name.

The Autobase is untouched: gate state stays on each machine, and offers change only if the concurrency field in step 1 is added.

### Phase 5: host pressure

1. **Signals.** These come from Electron's `powerMonitor`: thermal state (`getCurrentThermalState`, `thermal-state-change`), battery (`isOnBatteryPower`) and system idle time (`getSystemIdleTime`). Memory pressure comes from macOS's memory-pressure level (confirm the API: `kern.memorystatus_level` or a dispatch source in the host bridge). The Resources sampler's CPU and memory per bucket are reused, sampled every 10 s while work is held instead of only while the Resources screen is open.
2. **Rules.** Under serious thermal state or critical memory pressure, each local entry's effective limit drops by one (never below one), and Later work doesn't start. On battery, Later work waits unless the user allowed it. Models on another machine aren't affected. The busy notice names the reason: "Holding later work: the Mac is running hot".
3. **When idle.** Later work can be set to **Run when I'm away**. It starts after 10 minutes of system idle time on power, and yields again when the user comes back and Now or Normal work is waiting.
4. **Model memory.** A local model loaded with a larger context or more parallel slots uses more memory. The Resources screen shows the LLM bucket. The **Requests at once** help text points there instead of guessing a number.

### Phase 6: time and the agent

1. **Not before.** **Send later → Tomorrow morning / Tonight / Pick a time** sets a not-before time on a held item. Boundary converts it to an ISO time. If the app won't be running, the fallback is a Hermes cron job via `cron.manage` with an ISO `schedule`, which delivers to the same session. Which one to use is an open question (below).
2. **Workload tool for the agent.** A host-bridge tool lets the Orchestrator list the workload and pause, resume or reprioritise items, so "pause the refactor until tonight and do this first" works in chat. Each action that pauses or cancels someone else's work goes through the existing approval flow (ADR 0027).

## Privacy and logging

Held prompt text stays in Boundary's main store until submitted and is deleted on submit or cancel. The gate reads the session header and the entry, never message content. It may look at the last message's role, as `opensNewTurn` already does. Logs, the turn log, router diagnostics and lag lines carry request ids, session ids, priorities, slot counts, wait times and reasons, never text or titles. The Workload panel shows chat titles the rail already shows.

Decision 2 puts local traffic on a Boundary listener it didn't pass through before. It's the same hardened loopback listener chains use (ADR 0027 §2). Privacy-locked projects still cut the chain before the router plans attempts (ADR 0033 §4), and **Use the next model when busy** can't cross that cut.

## Stack contract

New dependencies to add to `docs/stack-contract.md` in the phase that starts using them: the affinity header's `kanban:<task>` value and the proxy's `fallbacks` push (Phase 1), `session.active_list` and `kanban.max_in_progress` (Phase 3), `cron.manage` (Phase 6), and OpenCode's provider headers and session abort (Phase 3). Each is confirmed in the pinned image before use.

Live checks: `test:stack` covers the session header on a real turn. Phase 1 adds one that sends three prompts to three new sessions with a local limit of 1, and asserts that the upstream never sees two requests at once and that all three complete. Phase 2 adds pause and resume of a running turn, yielded and converted. Phase 3 adds an OpenCode hold.

## Dependencies

- Run control Phase 1 (Stop, Continue, reply-ending markers) is built. Pause conversion reuses it.
- Run control Phase 2 (per-chat Queue) is independent. The two share the composer menu, and Phase 2 of this plan adds its rows next to that spec's rows.
- Circles plan Phase 2 (router and chain UI) is in progress, with its live proxy case not started. Phase 0 here should use that case.
- Pinned stack v0.3.7 or later for route `fallbacks`.
- Change request 0018 R1 for a long OpenCode pause; Boundary has a fallback.

## Open questions

- **Servers that don't report a limit.** LM Studio reports `parallel`. Check Ollama. Where a server reports nothing, the gate's timings could detect the limit: time to first byte that jumps as in-flight rises means the limit is too high. `router.reply`'s `firstByteMs` and `router.request`'s `inFlight` already give that data.
- **The model name Hermes sees.** Different first entries give Hermes different model names, so those chats still need an apply and can't run side by side (Phase 1, step 6). A stable name for routed chats would remove that, at the cost of Hermes's per-model handling (ADR 0033 §8 keeps the first entry's name on purpose).
- **Auxiliary calls.** Hermes's title and compression calls carry the session header too, so they queue with their turn. A long compression at Later priority holds that turn's context. Check whether they need their own rule.
- **Not-before when the app is closed.** Boundary's held store only drains while the app runs. Hermes cron runs as long as the stack runs. Which matters more depends on whether the stack stays up after Boundary quits.
- **Same-session queue.** Hermes's own `queued: true` FIFO could hold follow-ups, but it has no priority and runs as soon as the turn ends, regardless of limits. The gate still orders its model requests, which may be enough.
