# 0019. Onboarding in the workbench frame

- Date: 2026-09-28
- Status: Accepted · §6 and the icon rail and header border in §1 superseded by [0029](0029-full-window-startup-screen.md)
- Parent: [0018](0018-design-tokens-and-primitives.md)
- Sources: [`docs/onboarding-ux-study/index.html`](../onboarding-ux-study/index.html), [`docs/design-system/index.html`](../design-system/index.html) (Setup patterns)

## Context

Setup (capability check → connect a model → start the assistant) rendered in a separate landing-page layout: gradient background, system font, 4xl–5xl headings, pill buttons, and indigo, emerald and amber used interchangeably for primary actions. It handed off to a workbench with different type, surface and accent, so first launch felt like two apps. There was no progress indicator across the three gates, the model step used three different visual languages for its choices, and copy led with internals (Compose project names, Hermes, service profiles). Every later launch showed the same setup-style page while the stack booted.

## Decision

1. Setup renders inside the workbench frame via `SetupShell`: the `.workbench` surface, the icon rail (dimmed and inert), a 42px header that is the window drag region, and a centred 560px column (720px for forms and pickers).
2. A three-step `Stepper` sits in the header: Machine · Model · Assistant. Titles are 22px (`text-heading`), one line of description in `text-fg-muted`.
3. Footer actions are fixed: Back on the left, the step's actions on the right, the primary action last. One solid button per view.
4. The model step is a single list of `ChoiceRow`s. The recommended path (OAuth provider) has a `--brand` border, a “Recommended” pill and the only `brand` button. Detected local servers are rows with a status pill and an outline button. Manual URL, local server and GPU deploy are quiet full-row buttons with a chevron.
5. Copy leads with what the user gets. Implementation detail (Compose project, Hermes API, service profiles, debug log) sits behind a “Details” or “Troubleshooting” disclosure.
6. While the assistant stack starts — in setup and on every later launch — the app renders `WorkbenchSkeleton`: the real rails and a disabled composer, with stage progress in a status strip above the composer and per-service cards behind “Show services”. When the stack is ready, `ProductApp` swaps in the live workbench in the same frame. The decision logic in `ProductApp` is unchanged.
7. The quit overlay and the Services destination use the same tokens and primitives.

## Consequences

- `SetupLayout` is deleted.
- Onboarding views no longer carry their own card chrome or back buttons; `OAuthModelPickView` drops its `onBack` prop.
- `SetupShell` reads the active step from `SetupContext` when present and renders without it (isolated tests).
- Copy changes (“Choose a model”, “Check this Mac”, “Start your assistant”) are reflected in setup tests.
