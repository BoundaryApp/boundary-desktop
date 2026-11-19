# 0055. The container engine is sized to what is turned on

- Date: 2026-11-11
- Status: Proposed
- Related: [0046](0046-cancel-or-undo-long-running-actions.md) (cancel and undo), [add-ons spec](../addons-ux-study/spec.md) decision 4 (the fit check)

## Context

On a Mac without Docker Desktop, Boundary runs the stack in its own Podman machine, a libkrun VM started by `krunkit`. Until 2026-11-11 every machine got 12 GiB. On an 8 GB Mac, `podman machine init` refused that size, so the stack could not start without Docker. New machines now get half the Mac's memory, between 4 and 12 GiB, and a machine is never shrunk.

Measured on a 12 GiB machine running the default stack (no LightRAG, Neo4j, n8n or add-ons):

- The containers used about 2.3 GB idle. After a long web search they peaked at 3.1 GB in all, with Hermes at 1.2 GB (under its 3 GiB limit), and the VM had 2.6 GB in use and no out-of-memory kills.
- After the first start's image pulls, the VM had 3.0 GB in use and 8.6 GB of file cache, and macOS charged `krunkit` 10 GB (`footprint`).
- After `drop_caches` in the VM, the VM had 9.0 GB free and `krunkit` stayed at 9.0 GB, unchanged 75 seconds later. `krunkit` runs with no balloon device, so memory the guest has touched is not returned to the Mac.

So the machine's size is close to what it costs the Mac, whatever runs in it. A size that suits a user with every add-on on wastes several GB for a user with none, and a size that suits the second leaves no room for the first.

Quit stops the machine (since 2026-11-09), so every launch boots it cold. `podman machine set --memory` needs a stopped machine, which at launch costs nothing extra. Mid-session, a resize means stopping the stack, the machine, resizing, and starting both again: about two minutes, going by the stop, boot and `compose up` times in the debug logs. The app itself stays open.

The add-on page already works out an engine size that would fit (`assessAddonFit`'s `suggestedEngineMiB`) but can only tell the user to give the engine more memory "in its settings", which Boundary doesn't have.

## Decision

1. **One function decides the machine's size.** The size is the core stack's need (4 GiB: the measured 3.1 GB peak plus about 0.5 GB for the VM) plus the reservation of each optional service and add-on that is turned on, plus 1 GiB of headroom, rounded up to a whole GiB. With nothing optional on, that is 5 GiB. It is at least 4 GiB and at most what the Mac can spare: its memory minus the larger of 4 GiB and a quarter of it (4 GiB on an 8 GB Mac, 12 on 16, 24 on 32). The function lives in `src/shared`, and the launch, the add-on fit check and the card in §4 all call it. The fit check's own constants (`HOST_RESERVE_MIB`, `RESIZE_STEP_MIB`, `RESIZE_OVERHEAD_MIB`) go.
2. **Each launch resizes the machine before starting it, in both directions,** when the size from §1 differs from the machine's by at least 1 GiB. The start-up screen shows it under the provision stage, and the debug log records the old size, the new size and what set it.
3. **Turning something on that doesn't fit resizes the machine in place, without restarting the app.** The add-on install, and the LightRAG and n8n switches, offer **Make room** when the size from §1 is larger than the machine's and the Mac can spare it. The offer says the assistant pauses for about two minutes. It waits for agent work that is running, offering **When the task finishes** as the restart bar does. The app then stops the stack, stops the machine, resizes it, starts both, and shows the start-up progress screen until the stack is ready, then carries on with the install. When the Mac can't spare the size, the page says which add-on to turn off instead.
4. **Turning things off gives memory back at the next launch, or now if the user asks.** When the machine is at least 2 GiB larger than §1's size, a card offers **Give back N GB now**, which runs the same steps as §3 without the install, and **Later**, which leaves it to the next launch. The card shows once per change, not on every launch.
5. **A resize in progress can be cancelled until the machine stops** (0046 §5–6). After that, the steps run to the end, since stopping half way would leave no stack at all. A failed resize starts the machine at its old size and says so.
6. **Docker Desktop's VM is not Boundary's to size.** With system Docker, the fit check reads Docker's memory and, when an add-on won't fit, points to Docker Desktop's Resources settings.

## Consequences

- During a resize, the assistant, its tools, and agents shared with a Circle are unavailable for about two minutes. Circles itself runs on the Mac and keeps working.
- Each resize also restarts the VM, which hands its file cache back to the Mac. The cache then grows back towards the machine's size.
- An 8 GB Mac gets a 4 GiB machine whatever is turned on, so the add-on page will say most add-ons don't fit there.
- §1 needs each optional service's reservation. Add-ons have one in the catalog (`reserveMiB`, from CR 0020 R2). LightRAG and n8n set no compose limit, so they reserve estimates (3 GiB for LightRAG with Neo4j, 1 GiB for n8n) until they are measured.
- A machine created at 12 GiB before this decision shrinks at its next launch if less is turned on.

## Plan

**Phase 0: measurements.** Done for the default stack after a long web search (the figures above). Still to read: a coding turn, LightRAG and n8n, and a first start on a new machine.

**Phase 1: size at launch.** The §1 function in `src/shared/engineSizing.ts`, the reservations of what is on, and a resize to that size before the machine starts: in either direction while it is stopped, and only upwards while it is running. Moving the add-on fit check onto the function is left to phase 2, which replaces its resize suggestion.

**Phase 2: make room in place.** Done for Twenty's install: **Make room and install** on its page when only memory is short and the engine can grow, the wait for running agent work, the restart behind the start-up screen with the add-on's reservation held as pending (so the machine's start grows it instead of shrinking it back), cancel until the stack stops, and a start at the old size when the larger one fails. The fit check's suggested size now comes from §1, or from what the stack uses plus the add-on when that is larger, and the restart takes that size as its floor. Still to do: the LightRAG and n8n switches, which turn services on without a fit check, and Actual and Bitwarden, whose installs don't run one.

**Phase 3: give memory back.** The §4 card, shown after a change that leaves the machine 2 GiB or more too large.

Each phase names its live check. None of this is covered by `test:stack`, which runs on system Docker; the manual check is a packaged build started with `BOUNDARY_EMULATE_NO_DOCKER=1`.
