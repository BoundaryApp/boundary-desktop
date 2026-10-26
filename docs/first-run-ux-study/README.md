# First-run UX study

Whether a new user should add a folder before reaching chat, and how setup grows past three steps without becoming a long wizard.

- `index.html`: the recommendation, the proposed **Folders** step in the setup frame (empty, folders picked, skipped), and the **Get started** list that holds the optional setup.
- `spec.md`: the plan, decisions and progress.

Serve the repo root over HTTP to view (the page links the token file by relative path), e.g. `python3 -m http.server` then open `/docs/first-run-ux-study/`.

Builds on [ADR 0019](../adr/0019-onboarding-in-workbench-frame.md) (setup in the workbench frame), [ADR 0029](../adr/0029-full-window-startup-screen.md) (start-up screen, background download during setup) and [ADR 0005](../adr/0005-folder-first-create-flow.md) (folder-first create flow).
