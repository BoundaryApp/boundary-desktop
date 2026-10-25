# Start-up screen study

Visual record for [ADR 0029](../adr/0029-full-window-startup-screen.md).

- `index.html` is an interactive simulation of the start-up screen: first run, a quick launch, a slow launch that brings in the tool story, and an error. It loads the live tokens (`src/renderer/styles/tokens.css`) and the screen's own stylesheet (`src/renderer/product/startup/startup.css`).

Serve the repo root over HTTP to view, e.g. `python3 -m http.server` then open `/docs/startup-ux-study/`.
