# 0018. Design tokens and primitives

- Date: 2026-09-28
- Status: Accepted
- Parent: [0003](0003-workbench-chrome.md)
- Sources: [`docs/design-system/index.html`](../design-system/index.html), [`src/renderer/styles/tokens.css`](../../src/renderer/styles/tokens.css)

## Context

The workbench (0003) had hand-tuned `--wb-*` tokens scoped to `.workbench`. Setup and onboarding used raw Tailwind zinc/indigo/emerald, a marketing gradient and 4xl–5xl headings, so first launch looked like a different app from the one it hands off to. The shadcn primitives in `components/ui` referenced `bg-primary`, `border-input` and similar classes, but Tailwind v4 had no `@theme` and never loaded `tailwind.config.ts`, so those classes produced no CSS; every call site overrode colors inline. Inside the workbench CSS the scales had drifted to 10 font sizes, 8 weights and 10 radii, with no transitions and no focus-visible rules.

## Decision

1. `src/renderer/styles/tokens.css` is the only place raw values live. Tokens sit on `:root` and are semantic: `--surface-0/rail/1/2/hover`, `--line`, `--text`, `--text-muted`, `--text-faint`, `--brand`, `--brand-dim`, `--solid-bg/fg`, `--ok/warn/danger` (+ `-dim`), and the transcript instrument colors from 0004.
2. Scales are fixed:
   - Type: 11 / 12 / 13 / 15 / 22 px (`--size-2xs … --size-heading`), plus 16.5 px serif for assistant prose only.
   - Weights: 400 / 560 / 650.
   - Radius: 6 / 8 / 12 px and a full pill.
   - Space: multiples of 4.
   - Motion: `--dur-fast` 120 ms (hover, press), `--dur-panel` 200 ms (sheets, tabs), one `--ease`. Both collapse to 0 under `prefers-reduced-motion`.
   - Focus: one `--focus-ring`.
3. `src/index.css` exposes the tokens to Tailwind through `@theme inline` (`bg-surface-1`, `text-fg-muted`, `text-ui`, `bg-brand-dim`, …) and maps the shadcn names (`background`, `primary`, `muted`, `border`, `ring`, …) onto the same tokens. `tailwind.config.ts` is deleted.
4. The primary action is the solid light button (`--solid-bg`), as in the workbench. Violet (`--brand`) marks selection, the active destination and a recommended path; it is not the default button color.
5. `components/ui` primitives are the building blocks for product chrome: Button (`default`, `brand`, `outline`, `secondary`, `ghost`, `destructive`, `link`), Callout (`Alert`), Pill (`Badge`, with `dot`), Card, Input, Textarea, Label, Tabs, Progress, Select, Dialog, DropdownMenu, Toaster. New screens use them before writing new button or card CSS.
6. Workbench and Resources CSS use token names directly; the old `--wb-*` variables are removed.
7. A light theme is defined under `:root[data-theme='light']` with the Quiet Hub paper values accepted in 0003. Settings → Appearance offers System / Light / Dark (default System). The main process stores the choice and sets `nativeTheme.themeSource`, so the title bar, menus, `prefers-color-scheme` and the pre-paint window background match; the renderer mirrors it in `localStorage` so first paint uses the right palette.

## Consequences

- Inline Tailwind palette colors (`zinc-*`, `indigo-*`, `emerald-*`, `amber-*`, `red-*`) in product and setup code are a review flag.
- A change to a color or size is one edit in `tokens.css`, visible on the living sheet (`docs/design-system/index.html` loads the same file).
- Onboarding moves into the workbench frame under [0019](0019-onboarding-in-workbench-frame.md).
