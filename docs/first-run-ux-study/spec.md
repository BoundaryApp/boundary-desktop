# First run: living spec

| | |
| --- | --- |
| Status | Decisions confirmed; phases 1 and 2 built |
| Visuals | [index.html](index.html) |
| Started | 25 Oct 2026 |

## Progress

| Phase | Status | Depends on |
| --- | --- | --- |
| 1 Optional, first-run-only setup steps | Built | — |
| 2 Folders step | Built | 1 |
| 3 Get started list | Not started | — |

## Goal

A new user reaches their first chat with a folder already connected, without being forced to. Setup stays short: it asks only what changes the first chat, and the rest of the optional setup waits in a list the user can come back to.

## Recommendation

Yes, ask for a folder on first run, but as a step inside the existing setup flow, not as a separate takeover after it. The flow already has a step sequence (`SETUP_STEPS` in `src/renderer/setup/steps/index.ts`) with a stepper, footer actions and a full-window frame. A second takeover between setup and chat would add another frame and another "done" moment.

The step goes between **Model** and **Assistant**: Machine · Model · Folders · Assistant. By then the stack is already downloading in the background (ADR 0029 §15), so the step uses waiting time the user would otherwise spend on the start-up screen.

The step can be skipped. Chats work without a project, so a hard gate would block users who only want to chat, and a skipped step costs nothing: the chat rail's empty state still offers **Choose folder…**.

## Decisions (confirmed 25 Oct 2026)

1. **Optional steps are first-run only, with one exception.** A step marked `firstRunOnly` is skipped for anyone who finished setup before the step existed. An update never shows an existing user a setup screen for something they can already do in the app. The Folders step is the exception: an upgrader who had no projects when they updated sees it once. Upgraders with projects never do.
2. **Boundary records each optional step's outcome.** The main store keeps `{ stepId: 'done' | 'skipped' }` per optional step. `isComplete` reads it, so quitting mid-step resumes there and a skip is never asked again.
3. **Setup keeps at most five steps.** Required steps (Machine, Model, Assistant) plus at most two optional ones. Anything else goes to the **Get started** list (Phase 3).
4. **The Folders step records choices; the stack applies them.** Creating a host-folder project recreates containers and registers the project with the gateway (`createHostFolderHermesProject`), so neither can run before the stack is up. The step saves the picked paths. Host folders are saved as project records straight away, so the overlay the first `compose up` writes already mounts them and that start needs no recreate. When the stack is ready, Boundary registers each project with the gateway (creating empty projects then) and opens the chat on the first. It recreates Hermes once only if the running container lacks the folders, as for an upgrader whose stack was already up.
5. **Folders are added read-only.** Coding access has consequences that belong at the moment of use (ADR 0028 §2), so the existing coding-access interrupt asks the first time a coding task needs a folder. The step says this in one line.
6. **No separate takeover for existing users.** Upgraders with no projects get the Folders step once, inside setup (decision 1); after that, the chat rail's empty state as today.

---

## Phase 1 · Optional, first-run-only steps

**Where:** `src/renderer/setup/types.ts`, `src/renderer/setup/steps/index.ts`, `src/renderer/setup/SetupContext.tsx`, the setup IPC and main store.

1. Add `optional?: boolean` and `firstRunOnly?: boolean` to `SetupStepDefinition`.
2. Store the outcome of each optional step, and whether setup had already completed before this version (one flag, written on upgrade).
3. `resolveActiveSetupStep` skips a `firstRunOnly` step when setup had already completed.
4. `SetupShell` renders **Skip for now** as a ghost button left of the primary action on optional steps.

**Acceptance**

- [x] A user who finished setup before the upgrade never sees a `firstRunOnly` step, and sees the Folders step only if they had no projects.
- [x] Skip is recorded and survives a relaunch.
- [x] The stepper shows optional steps with the same weight as required ones.

## Phase 2 · Folders step

**Where:** new `src/renderer/setup/steps/FoldersStep.tsx`, `ProductApp.tsx` (apply on ready), `hermesProjects.ts`.

1. Title "Pick folders to work in", one line of description: "Your assistant reads files where they are. You can add more later."
2. **Choose folder…** opens the system picker (multiple selection). Each pick becomes a row: glyph, folder name, `~/` path, a remove button. Rows refuse the folders ADR 0028 §5 lists, with the reason on the row.
3. **Create empty project** is a quiet secondary action, as in the chat rail.
4. Footer: Skip for now · Continue (solid; disabled with no usable rows). Setup steps have no Back between them, so the step has none either.
5. On stack ready, create the projects in order and select the first. A failure leaves the user in chat with the existing per-project error, not back in setup.

**Acceptance**

- [x] Picking two folders and finishing setup opens chat with both projects listed and the first selected.
- [x] Skipping lands in chat with the empty rail.
- [x] Too-broad folders (home, `/`, system folders) are refused before they are saved.

## Phase 3 · Get started list

**Where:** the chat's empty state (`WorkbenchThread.tsx` empty view) and a small store of dismissed items.

1. Under the empty chat, a short list of what makes the assistant more useful: connect a calendar, save a login, allow computer access, add a coding folder. Each row opens the place where it is done (the Settings tab or sheet), so the list has no forms of its own.
2. Rows tick themselves from real state (a calendar exists, a grant exists).
3. **Hide** removes the list for good. It also retires once every row is done.

**Acceptance**

- [ ] Every row opens the screen that completes it.
- [ ] Completed rows tick without a relaunch.
- [ ] Hidden or finished, the list never returns.
