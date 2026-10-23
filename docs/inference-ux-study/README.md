# Inference UX study mocks

Reference windows for configuring a local LLM and OpenRouter together, switching the provider on a chat, and setting a default per project. The implementation spec is [`spec.md`](spec.md). The decisions are in [`docs/adr/`](../adr/README.md).

| File | Role | Status |
| --- | --- | --- |
| [spec.md](spec.md) | Living spec, AC, and phase progress | Phase 2 done |
| [index.html](index.html) | Study board | — |
| [01-settings.html](01-settings.html) | Living sketch: Settings Inference section (two provider cards + app default) | Accepted |
| [02-chat-switch.html](02-chat-switch.html) | Source: current-chat provider switch (composer chip / header / inspector) | Accepted |
| [03-project-default.html](03-project-default.html) | Source: project-level default + resolution explainer | Accepted |

Open `index.html` in a browser. On Settings, use **Light** for the paper remap and the title-bar states for nothing configured, local only, OpenRouter only, both, local offline, and key revoked. On Chat switch, compare A / B / C, then the shared honesty states. On Project default, use Inherit / Local / OpenRouter / Privacy lock / New project.
