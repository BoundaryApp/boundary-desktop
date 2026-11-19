# 0046. Long-running actions can be cancelled or undone

- Date: 2026-11-08
- Status: Accepted
- Related: [add-ons spec](../addons-ux-study/spec.md), [0022](0022-run-control-in-the-composer.md) (Stop for a chat run)

## Context

Installing Twenty runs six steps that together can take over half an hour: the image pull may run for 30 minutes, `compose up` and the health check for 5 minutes each, and `crm.sh init` for 10. Until now the progress view had no way out. A user who clicked Install by mistake, or changed their mind a second later, had to wait for the run to finish or fail before **Undo install** appeared. The same holds for any action that runs for minutes while the user watches.

Some actions can't be reversed. Removing Twenty deletes its database, attachments and keys. Once a delete step has run, nothing in Boundary can put the data back.

## Decision

1. **An action that shows progress offers a way out while it runs.** Cancel is the default. When an action is quick and its effects can be reversed, an undo afterwards serves instead, such as Turn off after an install that finished.
2. **Cancel returns the Mac to how it was before the click, as far as Boundary can.** What the run keeps on purpose, such as downloaded images for the next try, is named in the result. A cancel that couldn't restore something says what is left and offers the same recovery as a failure.
3. **Cancel stops the running step, not the next one.** Boundary stops the child process it's waiting on (Compose gets SIGTERM, then SIGKILL after 5 seconds) and ends any wait between polls at once. The exception is a step whose interruption would leave things worse than finishing it, such as `compose stop` part way through. That step finishes first, and the control says so.
4. **Cancelling has its own state and its own result.** The control turns into a disabled "Cancelling…", the run's status line says so, and the end is a cancelled result rather than a failure or a success. The step that was running shows as cancelled.
5. **An irreversible action keeps the user's agency up to the point of no return.** It asks first, with a typed confirmation when it deletes data. Its reversible steps run first. It offers Stop until its first irreversible step starts, and Stop leaves everything not yet deleted in place. After that point it doesn't offer Stop. It reports exactly what was deleted, and a retry resumes from the step that failed.
6. **The control disappears at the last point it can take effect.** Main refuses a cancel after that point, and the view shows the refusal. A step that can't be stopped without leaving the system broken, such as the assistant's own restart, isn't cancellable.
7. **New long-running work says in its design how it is cancelled,** and its tests cancel it at each step that can be cancelled.

### Add-ons

- **Install** offers **Cancel install** from the first step until the restart step. A cancel during the download, `compose up`, the health check or `crm.sh init` stops that step at once; one during the fit check or the flag write takes effect when it returns. If the run had reached the start step, Boundary then removes the containers (`compose rm -s -f`), parks the local workspace file and records Twenty off, as **Undo install** does. The data folder and the downloaded images stay.
- **Remove and delete data** offers **Stop before deleting** while it stops and removes the containers. The running `compose stop` or `rm` finishes, and the run ends before deleting anything. Twenty is off with its data in place, and the pending list says what Turn off would. Once a delete step starts, the button is gone.

## Consequences

- SIGTERM reaches `bash` running `crm.sh`, not the Compose commands the script started. Those run until the rollback removes the containers they work in.
- A cancel during `crm.sh init` leaves what Undo install leaves after a failed setup: the data folder, and whatever the script had written to the stack's `.env` and the workspace file, which is parked.
- These add-on actions still can't be cancelled: Start (up to 5 minutes of health checks), Turn off, Undo install, workspace connect, and the restart step. Each needs its own design under this decision.
- A cancel that arrives just as the run passes its last cancellable step is refused, and the run carries on to the restart step.
