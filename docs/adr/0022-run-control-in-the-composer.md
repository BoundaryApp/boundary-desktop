# 0022. Run control in the composer

- Date: 2026-10-01
- Status: Proposed
- Parent: [0004](0004-instrument-composer.md)
- Related: [0006](0006-tool-approval-interrupt.md), [0021](0021-right-aligned-user-turns.md)

## Context

0004 put Stop in the composer footer at all times. When idle it was disabled but looked live, and the composer had no Send button: Enter was the only way to send. The run-control study ([docs/stop-button-ux-study/](../stop-button-ux-study/index.html)) compared three placements for a Stop that appears only during a run. It chose **A · Morph**, the pattern used by ChatGPT, Claude and LM Studio. Hermes saves a stopped turn's streamed text but not why it ended ([backend-notes.md](../stop-button-ux-study/backend-notes.md)).

## Decision

- **One button in the input's bottom-right corner.** It shows Send ↑ while idle and Stop ■ while a run is in flight. It is one element whose glyph and label change, so keyboard focus survives the swap. Nothing else in the composer moves when a run starts or ends.
- **Send** is dimmed until there is a draft. **Stop** has a ring tracing it while the agent works. While an approval waits, the ring pauses and turns amber, and Stop denies the approval as before (0006).
- **No Stop while nothing runs.** The button is hidden while connecting, while the assistant restarts, and while the offline prompt shows.
- **Stop ignores clicks for 350 ms** after the send that started the run, so a double-click on Send can't stop it.
- **Esc stops a run from anywhere in the chat pane,** but only when nothing else claims it: an open menu or list closes first, and a selection's Quote popover clears first. The composer input's own Esc-cancel is off.
- **A cut-short reply says how it ended:**
  - **Stopped by you:** a grey square. It offers Continue while it is the latest reply Hermes holds.
  - **Stopped before *agent* replied:** used when no text had arrived.
  - **Interrupted by your next message:** an accent ↳ and a faded last line, with no Continue.
  - Boundary records the ending per Hermes row, so the marker survives a reload.
- **Continue is a new turn.** It is a hidden `prompt.submit` (`display_kind: "hidden"`), and Hermes picks up from the saved partial. Hidden rows never render as prompts.
- **The next send waits** until Hermes confirms the stopped turn has ended, up to 3 s.

## Consequences

- 0004's footer no longer shows Stop. The rest of 0004 stands.
- The composer gains a visible Send, for mouse users and newcomers.
- Continue's text is a separate reply under the stopped one, not a seamless continuation of it.
- A stop that lands before any text leaves nothing in Hermes, so that marker does not survive a reload.
- Enter while running (Send now, Queue, Add to this run) builds on this in run-control Phases 2–3.
