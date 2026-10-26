# 0030. Hermes's board is a view of Tasks

- Date: 2026-10-25
- Status: Proposed
- Parent: [0020](0020-centered-transcript-column.md)
- Spec: [task activity spec](../kanban-activity-ux-study/spec.md), Phase 4
- Stack: [CR 0012](../change-requests/0012-dashboard-sign-in.md)

## Context

Boundary's Tasks list groups kanban tasks by what you'd do about them (task activity spec, decision 2) and leaves drag-and-drop triage to Hermes's own board at the dashboard's `/kanban`. That link opened the system browser, which had no dashboard session, so every **Open board** and **Open in board** landed on a login form asking for the password in the stack's `.env`. Boundary is a one-window app, and leaving it for a password prompt to sort a few cards broke both.

Four places could hold the board: a destination on the icon rail, Settings, the right inspector, or the Tasks view itself. The rail holds app-level destinations (Chat, Services, Resources, Settings), and the Tasks row in the chat rail already leads to the same tasks. Settings holds configuration, and triage is daily work. The inspector is context for the open conversation (0014), the board isn't tied to one, and its columns don't fit at inspector width.

## Decision

1. The board is a second view of Tasks. A **List** / **Board** switch sits in the Tasks header, and each window remembers the view last used. The Tasks row in the chat rail keeps its counts. The board has no rail item, badge or Settings section.
2. The board view shows the dashboard's `/kanban?embed=1` (CR 0012 R3) in a `<webview>`. It fills the center pane and the inspector's space, and doesn't use 0020's centered column, because the board needs the width for its columns. The inspector returns when you leave the board view.
3. **Open in board** on a task page opens the board view on that task: `&task=<id>&board=<slug>` opens its drawer (CR 0012 R2), naming Hermes's current board because that's the board Boundary reads. **Back to task** in the header returns to the task page.
4. The view signs in on its own session partition (`persist:hermes-board`). Main signs in with the dashboard password it already holds and copies the session cookies into that partition. No page sees the password. When the dashboard sends the view to `/login`, main signs in again and returns to the board, at most once every 30 seconds.
5. The view stays on the board. `?embed=1` hides the dashboard's navigation but not what its session can reach, so main refuses any navigation, client-side route or new window that leaves `/kanban` and opens it in the system browser. A `<webview>` attaches only on the board partition, pointed at the board, with no preload and a sandbox.
6. **Open in browser ↗** in the Tasks header opens the board, or the task the board view opened on, in the system browser. When the stack's `.env` has `HERMES_DASHBOARD_HANDOFF_SECRET`, the link is a one-time sign-in link (CR 0012 R1). Without it, the browser may show the dashboard's login.

## Consequences

- Leaving Tasks unmounts the board view, so it loads again each time you come back.
- The embedded board shows only the dashboard's board page. Config, sessions, logs and the chat terminal open in the browser.
- A stack without the CR 0012 overlays still works: the board shows with the dashboard's own navigation, **Open in board** opens the board without the drawer, and **Open in browser** may ask for the password. Main still keeps the view on `/kanban`.
- Boundary's main window enables `webviewTag`. The attach guard in decision 5 is what keeps that to the board.
