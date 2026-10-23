# Backend notes: stop, continue, send now, queue

Checked against `nousresearch/hermes-agent:v2026.9.14`, the tag the stack's `docker-compose.yml` pins, on 2026-10-01. The desktop talks to Hermes through the JSON-RPC gateway (`src/main/services/assistant/hermes/hermesGatewaySession.ts`). Today it uses only `prompt.submit` and `session.interrupt`.

## Stop: `session.interrupt`

`tui_gateway/session_lifecycle.py::_interrupt_session_turn`

- Hard-interrupts the agent and retires the crash-recovery marker, so a resume won't auto-continue a turn the user stopped.
- **Clears the server queue** (`queued_prompt` / `queued_prompts`) and bumps `_queued_prompt_generation`, which cancels a drain already in flight.
- Denies every pending approval (`resolve_gateway_approval(..., "deny", resolve_all=True)`). This matches today's "Stop denies the approval" behavior.

## Partial reply after Stop

`agent/turn_api_call.py::handle_api_interrupt`

- If any text has streamed, it is appended as `{"role": "assistant", "content": <partial>}` and persisted (`agent._persist_session`). Reasoning blocks are stripped first.
- If nothing has streamed, the final response is the sentinel "Operation interrupted: waiting for model response (…)". `prompt_turn._turn_outcome` blanks it, so the client should show "Stopped before Hermes replied".
- The turn completes with `message.complete` carrying `status: "interrupted"`.

## Continue

There is no RPC that resumes the same generation, because nothing prefills the model with the partial. **Continue = `prompt.submit` with `display_kind: "hidden"`** and a short instruction such as "Continue from where you stopped." The model sees its saved partial in history, and the hidden kind keeps the instruction out of the transcript. The result is a new assistant row. The UI can show it as a continuation of the stopped reply, but it is not token-exact.

## Send now: `prompt.submit` on a busy session

`tui_gateway/session_auto_continue.py::_handle_busy_submit`

- Behavior follows `display.busy_input_mode`, which defaults to `interrupt`. **The stack doesn't set it**, so we get the default. The default mode:
  - **redirects** the live turn when the agent supports it (`_supports_active_turn_redirect`). The model gets "[Context from the interrupted assistant response] … Visible response before the interruption: …" followed by the new text. The result status is `redirected`.
  - otherwise, **queues the prompt server-side, then hard-interrupts**. The result status is `queued`. Attachments always take this path, and they queue without cancelling.
- Recommendation: pin `display.busy_input_mode: interrupt` in the Hermes bootstrap, so Send now can't silently turn into Queue or Steer.

## Queue: `prompt.submit` with `queued: true`

- `queued: true` forces queue mode. The source calls it the "client queue drain" flag, which never becomes a live correction.
- There is no RPC to list, edit, or remove queued items, and Stop wipes the server queue. **So the desktop owns the queue.** It holds the drafts, renders the chips, and sends the head with `queued: true` when it sees `message.complete` (status `complete`). Sending with `queued: true` also covers the race where the run hasn't fully released yet.
- On Stop, the desktop pauses its queue instead of draining it.

## Not used yet

- `session.steer`: "Inject text into the next tool result without interrupting the turn." This is a possible "Add to this run" option later.
- `session.redirect`: the explicit version of what busy `prompt.submit` does in `interrupt` mode.

## Channels

Each channel member is a separate Hermes session, so `session.interrupt` already stops one agent. Stop all is a fan-out of `session.interrupt` over the running members. Key the desktop queue by session, so channel queues and Stop all fall out of the same model.
