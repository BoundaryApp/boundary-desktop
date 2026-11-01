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
2. The centre is a ring of seven tool tiles inside a dashed “boundary”: Assistant, Search, Research, Memory, Automations, Coding and Model. Each tile maps to its containers (`STARTUP_TOOLS`) and shows their combined state: outlined while waiting or starting, filled with a small pop when every container is up, amber on error. During a start the outline is the tool's own progress bar, and it follows time the way the main bar does: it runs toward when this Mac's earlier starts of this kind had the tool's last container reported `Started` or `Healthy`. A tool this Mac hasn't timed runs toward the milestone that compose's dependencies put it before. A late tool stops short of full, what Compose reports (created, started) moves the outline ahead, and image pull progress doesn't, because one finished layer says little about the image. Only a done tool fills. Without start timing, as when quitting, a working tile shows an arc travelling round it.
3. A small assistant face sits in the middle. It glances toward the tile being worked on or described, blinks, smiles when the stack is ready and goes flat on error.
4. One bar shows overall progress, and it follows time. A start passes six milestones: preparation done, the first container started, each of the two Hermes bootstraps finished, Hermes started, and the stack up. Each stretch between milestones takes the share of the bar that it takes of a typical start, so half the bar means about half the wait. A stretch running late stops short of its milestone, and one running early jumps ahead when the milestone arrives. The bar stands at 97% when the stack is up and fills when the model is connected. The screen keeps a high-water mark so the bar never moves backwards. There is no percentage.
5. Copy is plain language: “Downloading your tools”, “Setting things up on this Mac”, “Starting your tools”. After a minute in one stage a hint says it is still going. Raw lifecycle messages and per-container cards sit behind **Show details**, which opens a panel on the window's right edge. In a window at least 1000px wide the panel docks beside the column, and it opens by itself on error. In a narrower window it covers the column and opens only when clicked. The screen never grows taller than the window or scrolls.
6. Story cards say what each tool gives the user, one at a time, nine seconds each, pausing on hover or focus and not auto-advancing under reduced motion. The tile for the current card is highlighted, and clicking a tile or a dot shows its card. **Why does this take a while?** opens a popover over the story card that explains the one-time setup.
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
17. A typical start comes from the median of this Mac's last five finished starts of the same kind: first run, new containers (after an update, or with none kept), or a relaunch with containers kept. Only durations are stored. Before a kind has a finished start, built-in defaults from rc.13 set the bar.
18. Under the stage line, a loose estimate says what is left: “About 4 minutes left”, “A couple of minutes left”, “About a minute left” or “Almost ready”. It is the typical remainder at the latest milestone, scaled by how this start compares so far and running down from there. A figure only steps down. Well past the expected end it says “Taking longer than usual”. With no finished start of this kind it says “This usually takes a few minutes”, and a download line takes the place of the estimate while images download.

## Consequences

- `WorkbenchSkeleton` and its `wb-skel-*` styles are deleted; `wb-skel-pulse` stays for other loading placeholders.
- The study mock in `docs/onboarding-ux-study/` still shows the 0019 skeleton and the icon rail in setup; this ADR overrides those parts of it.
- `ProductIconRail` keeps its `disabled` mode, though nothing renders it disabled now.
- Tool benefits are product claims. When a tool is added to or removed from the stack, `STARTUP_TOOLS` changes with it; a test checks that every stack container belongs to exactly one tool.
