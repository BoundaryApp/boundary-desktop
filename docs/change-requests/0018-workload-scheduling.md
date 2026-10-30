# 0018 · Workload scheduling: pausing coding tasks

**Serves:** [workload scheduling plan](../workload-scheduling-plan.md), [ADR 0035](../adr/0035-turn-admission-and-model-gate.md).
**Status:** Open

## Background

Boundary holds new turns when the model is busy, and its inference router orders model requests by priority. That covers everything that reaches a limited chain entry, so this request no longer asks for priority or a concurrency limit in `llm-proxy`, which an earlier draft of it did.

Boundary can hold OpenCode's requests at the router, but only for all OpenCode work at once, and only for as long as OpenCode tolerates a silent request. Interrupting a Hermes turn that waits on `coding_wait_for_task` ends the wait, but the OpenCode session keeps running.

## R1 · Pause and resume a coding task in opencode-mcp (Wanted)

**Why:** a long coding task is often the work the user wants to put off. Pausing the chat that started it doesn't stop it.

**Ask:** `coding_pause_task(task_id)` aborts the task's OpenCode session at the current step and marks the task `paused`, keeping its session. `coding_continue_task` on a paused task resumes it in the same session with a short instruction to carry on. `coding_get_task_status` reports `paused`. `coding_wait_for_task` on a paused task returns at once with `status: "paused"`.

**Acceptance:** pausing a running task stops OpenCode's session within 10 s (`GET /session/status` reports it idle), and continuing it resumes in the same session id.

**Boundary fallback:** Boundary calls OpenCode's session abort on the loopback port for the task's session (found as in change request 0013), and resume sends `coding_continue_task` through the chat's Continue prompt. opencode-mcp still believes the task is running until its wait returns, so the chat may show a failed wait before it resumes.
