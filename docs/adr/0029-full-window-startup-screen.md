# 0029. A full-window start-up screen

- Date: 2026-10-25
- Status: Proposed
- Supersedes: [0019](0019-onboarding-in-workbench-frame.md) §6, and the icon rail and header border in §1
- Parent: [0019](0019-onboarding-in-workbench-frame.md)
- Mock: [`docs/startup-ux-study/index.html`](../startup-ux-study/index.html)

## Context

ADR 0019 rendered start-up as `WorkbenchSkeleton`: the real rails and a disabled composer, with progress in a strip above it. On first run the wait is several minutes (downloading the stack, host setup, pulling and starting eleven containers), and for all of it the user looked at an app they could not use. The progress strip named internals (“Initialize Hermes”, “Start containers”) and nothing said why setup was slow or what the user would get at the end.

Progress-indicator research gives the constraints. Feedback of any kind makes a wait feel shorter and keeps people waiting longer ([NN/g](https://www.nngroup.com/articles/progress-indicators/)). A bar that stalls or moves backwards reads as broken, and an explanation softens a stall (Amer & Johnson, 2016). Apps with long loads use the time to teach: Slack shows quotes, Discord shows tips, and Discord's users complain that tips vanish before they can be read.

## Decision

1. While the assistant stack starts, the app renders `StartupScreen` full-window: no icon rail, rails or composer. The whole screen is the window drag region.
2. The centre is a ring of seven tool tiles inside a dashed “boundary”: Assistant, Search, Research, Memory, Automations, Coding and Model. Each tile maps to its containers (`STARTUP_TOOLS`) and shows their combined state: dashed while waiting, an arc travelling round it while starting, filled with a small pop when every container is healthy, amber on error. The animation is driven by real container state, never by a timer.
3. A small assistant face sits in the middle. It glances toward the tile being worked on or described, blinks, smiles when the stack is ready and goes flat on error.
4. One bar shows overall progress. Stages without measurable progress fill on an easing curve that never reaches the stage's end; container stages follow container progress. The screen keeps a high-water mark so the bar never moves backwards. There is no percentage or time estimate, because the stages do not report enough to make one honest.
5. Copy is plain language: “Downloading your tools”, “Setting things up on this Mac”, “Starting your tools”. After a minute in one stage a hint says it is still going. Raw lifecycle messages and per-container cards sit behind **Show details**, which opens by itself on error.
6. Story cards say what each tool gives the user, one at a time, nine seconds each, pausing on hover or focus and not auto-advancing under reduced motion. The tile for the current card is highlighted, and clicking a tile or a dot shows its card. A **Why does this take a while?** disclosure explains the one-time setup.
7. First run (the setup flow's last step) always shows the story. Later launches show only the ring, headline and bar, and add the story if start-up passes six seconds.
8. When the stack becomes ready, `ProductApp` holds the screen in its ready state for 700ms so the change is seen, then swaps in the workbench. The setup step uses the same ready state in place of its “Opening Boundary…” page.
9. Under `prefers-reduced-motion` all start-up animation stops; state still shows through colour and fill.
10. On error, the headline and line under it come from `describeStartupError`, which reads the raw message for known causes (disk full, port in use, container engine down, rate limit, download unavailable, offline, damaged download, Python missing, update blocked, health timeout, setup or Compose failure) and falls back to a general message. The raw text sits under **Show details** with a **Copy details** button.
11. When a start that took at least 15 seconds ends in ready or error while no Boundary window is focused, the main process shows a system notification and bounces the dock icon. Clicking the notification brings the window forward.
12. While Compose pulls images, the main process totals layer bytes and the screen shows “1.2 GB downloaded · 9 MB/s” under the stage line. The line hides after ten seconds without new bytes. Compose reports a layer's size only when that layer starts, so the screen shows no total or time estimate.
13. Each finished start-up stage writes one debug-log line (stage, duration, whether the start included host setup, bytes downloaded), so the progress curves in decision 4 can be tuned from real runs.
14. Setup uses the same chrome-free frame: no icon rail and no header or footer borders, with the three-step stepper in a borderless drag area. The first-run start-up screen shows the same stepper at the top.
15. The stack starts downloading once the Mac passes its check. While the user is still on the earlier setup steps, the right of the setup header shows the stack's stage and bytes downloaded, then “Your tools are ready” or that they hit a problem.
16. Quitting shows the start-up screen in reverse: tiles go dark as their containers stop, the assistant falls asleep, and the bar fills as the stop completes. Per-container cards sit under **Show details**.

## Consequences

- `WorkbenchSkeleton` and its `wb-skel-*` styles are deleted; `wb-skel-pulse` stays for other loading placeholders.
- The study mock in `docs/onboarding-ux-study/` still shows the 0019 skeleton and the icon rail in setup; this ADR overrides those parts of it.
- `ProductIconRail` keeps its `disabled` mode, though nothing renders it disabled now.
- Tool benefits are product claims. When a tool is added to or removed from the stack, `STARTUP_TOOLS` changes with it; a test checks that every stack container belongs to exactly one tool.
