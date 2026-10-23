# Onboarding UX study

Visual record for [ADR 0019](../adr/0019-onboarding-in-workbench-frame.md).

- `index.html` — the three setup steps and the start-up skeleton, drawn with the live tokens (`src/renderer/styles/tokens.css`).
- Shared patterns (Stepper, ChoiceRow, Callout, Pill) live on the design-system sheet: `docs/design-system/index.html`.

Serve the repo root over HTTP to view (the page links the token file by relative path), e.g. `python3 -m http.server` then open `/docs/onboarding-ux-study/`.
