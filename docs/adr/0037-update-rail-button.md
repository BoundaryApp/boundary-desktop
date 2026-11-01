# 0037. Updates live in a rail button and card

- Date: 2026-10-31
- Status: Accepted
- Related: [updates plan](../updates-plan.md), [updates UX study](../updates-ux-study/README.md), [0029](0029-full-window-startup-screen.md)

## Context

The first updater showed an update in three unconnected places: a banner above the screen, a dot on Settings and the **Updates** tab. The banner pushed the chat's thread header out of line with the title band. **Later** left only the dot, and opening the tab cleared that, so a user who had looked once had no way back except through Settings. A download hidden with **Hide** could fail with no notice. A waited-for restart went ahead the moment the last task finished, so the reply the user was waiting for could vanish as it arrived.

## Decision

1. **One button, one card.** While an update is on offer, a button sits above Settings on the icon rail and its icon shows the stage. A card opens from it, once per version and stage, and never takes focus. This replaces the banner and the dot, and overrides the study's decision 2 and its levels 2 and 3 for app updates.
2. **Later only collapses the card.** A click anywhere else does the same. The button stays until the update installs or the version is skipped. It is a control the user can act on, so the study's objection to badges that stay doesn't apply.
3. **Ready needs no answer.** The card says the update installs on quit, because Squirrel installs a downloaded update then, and **Restart to update** is the shortcut. That is the button's name everywhere, including the Boundary menu's **Restart to Update…**.
4. **A failed download reopens the card,** even after **Hide**.
5. **A waited-for restart has a last call.** When the last task finishes, Boundary counts down 30 seconds with **Restart now** and **Not now**. **Not now** leaves the update ready. A click elsewhere doesn't dismiss the last call.
6. **Boundary confirms a finished update once,** with **See what changed** opening the **Updates** page, which keeps showing that update's lines.
7. **The Updates page opens with one status card** that holds where things stand, any error and the main action. Opening the page closes the update card, because the page says the same thing.
8. **The feed says what the card needs.** Each line of `notes` is a summary line, `size` is shown beside the version, and `stackVersion` is the stack the build pins. When it differs from the running build's, the card warns that the next start takes minutes.

## Consequences

- Squirrel reports no progress, so electron-updater ([0041](0041-electron-updater.md)) fetches the zip and hands it to Squirrel over `127.0.0.1`. The bar and the rail ring follow the bytes received, and the bar loops when the feed and the response give no total, or while Squirrel checks the finished zip.
- The stack line is only as right as the checkout that writes the feed, so **Promote to stable** must run on a ref that pins the same stack as the release. The same goes for its notes.
- The restart prompt names chats by the title Hermes lists. A chat outside the 100 most recent, or on an agent profile, reads "A chat".
- The study's mock stays as the record of the earlier design.
