# Project create progress

Creating a project from a folder on this Mac restarts the assistant's containers so they can
mount the folder. That takes as long as a `compose up --force-recreate` plus a health wait,
and the sheet used to show only a disabled **Creating…** button for all of it. With the coding
switch on, a second restart for the coding agent followed after the sheet closed, with no
progress shown.

## Decisions

**One restart.** With coding on, the project record is saved with `codingEnabled` before the
remount, and the remount recreates `opencode` and `opencode-mcp` with Hermes, `hermes-webui`
and `hermes-worker`. The separate coding remount no longer runs on create. When a granted
folder's mount already holds the new folder, the coding agent isn't recreated.

**A running coding task is asked about first.** Recreating the coding agent stops a running
task, so before the restart main checks whether one is running. If one is and the renderer
hasn't said what to do, the create is refused with the task, and the sheet offers **Allow
when it finishes** and **Stop task and allow**, the same choice as the other coding entry
points. Waiting is a step of its own, polled every 5 seconds. Before this change the project
was created at once and only the coding change waited.

**Steps show at once.** Clicking **Create project** replaces the form with a step list before
main answers. Main then sends the whole list on each change, keyed by a run id, over
`hermes-projects:create-progress`. The rows share `StepListRow` with add-on installs.

| Step | Shown when |
|---|---|
| Wait for the coding task | Coding on, a task is running, and the user chose to wait |
| Wait for another folder change | Another remount or a stack start holds the queue |
| Restart the assistant | Always |
| Wait for it to answer | Always; with coding on it also waits for the coding agent |
| Check the coding agent can open the folder | Coding on |
| Open the project | Always |

**Failures.** A failed restart marks its step failed, rolls the project back as before, and
offers **Try again** and **Copy details**. If the project is made but the coding agent can't
open the folder, the project opens behind the sheet and the sheet stays to say why, with
**Close**.

**No Hide.** The sheet stays up until the create ends. The run can't be cancelled once the
restart has started.

## Progress

| Phase | Status | Depends on |
|---|---|---|
| One restart, step events, step list in the sheet | Built | — |

## Acceptance criteria

- [x] The step list appears on click, before main's first event.
- [x] Coding on and idle: one container restart, no coding remount afterwards.
- [x] Coding on with a task running: the sheet asks; waiting shows its own step.
- [x] A failed restart shows which step failed, keeps the sheet open and offers Try again.
- [x] A coding folder the agent can't open still opens the project and says why.
