# Stop-button UX study mocks

Explores removing the always-visible **Stop** button from the composer cluster (`wb-stop` in `src/renderer/product/chat/WorkbenchThread.tsx`) in favor of a run control that appears only while the agent is working. The mocks reuse the skin from [`../message-actions-ux-study/study.css`](../message-actions-ux-study/study.css) and its state switcher, `study.js`.

| File | Role | Status |
| --- | --- | --- |
| [spec.md](spec.md) | Living spec: decisions, phases, acceptance criteria, thin-wrapper map | Proposed |
| [index.html](index.html) | Board: chosen direction, placements, behavior table, backend summary, channels | — |
| [01-run-control.html](01-run-control.html) | Live mock. Placements: Today, A Morph, B Cluster, C Pill. States: idle, typed, thinking, streaming, tool, approval, Enter mid-run (Send now / Queue / Keep editing), queued, stopped (paused queue) | Proposed (A Morph) |
| [backend-notes.md](backend-notes.md) | What Hermes's gateway does on Stop, Continue, Send now and Queue, with source locations | Reference |

Everything is local: the mock inlines the shared skin and makes no network requests (system or locally installed IBM Plex fonts, no Google Fonts). Double-click `index.html` or `01-run-control.html` to open it in your browser straight from disk, or serve the folder with `python3 -m http.server`. A placement and state can be deep-linked, for example `01-run-control.html?variant=morph&state=approval`. In the mock, type and press Enter to start a fake run, then press Stop or Esc.
