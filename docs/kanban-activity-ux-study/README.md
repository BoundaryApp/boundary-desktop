# Task activity UX study mocks

This study shows the activity of Hermes kanban workers in Boundary. Today a task the Orchestrator files runs out of sight: the worker is a separate process, Boundary's working dot follows only its own turns, and the chat lists hide `kanban` sessions. The mocks reuse the skin and state switcher from [`../message-actions-ux-study/`](../message-actions-ux-study/).

| File | Role | Status |
| --- | --- | --- |
| [spec.md](spec.md) | Living spec: the problem, the layered answer, decisions, phases, acceptance criteria, thin-wrapper map | Proposed |
| [index.html](index.html) | Board: recommendation, the six moments, directions considered, open questions | — |
| [01-task-activity.html](01-task-activity.html) | Live mock. States: Filed in DM, Running, Quiet, Needs you, Done, Tasks list, Elsewhere | Proposed |
| [backend-notes.md](backend-notes.md) | What Hermes exposes about kanban work (dashboard plugin routes, events, worker model), with source locations | Reference |

Everything is local: the mock makes no network requests and uses only made-up tasks. Open `index.html` or `01-task-activity.html` straight from disk. You can deep-link a state, for example `01-task-activity.html?state=needs`. Turn on **Callouts** in the top bar to see the design notes.
