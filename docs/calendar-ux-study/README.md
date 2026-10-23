# Calendar connect UX study

This study lets people connect a CalDAV calendar (iCloud, Fastmail, Nextcloud or any CalDAV server) from Boundary and choose which agents can read or change it. The stack already ships the bridge, `caldav-mcp`, but the only way to set it up is to edit an account file and run `make hermes-reload`.

| File | Role | Status |
| --- | --- | --- |
| [spec.md](spec.md) | Living spec: the problem, decisions, the thin-wrapper map, phases and acceptance criteria | Proposed |
| [click-through.html](click-through.html) | Click-through of the whole flow: ask in chat, Settings → Calendars, the three-step connect sheet, connecting, the account card, calendar work in chat, Services | Proposed |
| [../change-requests/0006-calendar-connect.md](../change-requests/0006-calendar-connect.md) | What the stack and Hermes would need to change | Open |

The mock is local and makes no network requests. It uses made-up accounts (`sam@example.com`) and events. Open `click-through.html` from disk and use the scene buttons in the top bar, or click through the mock's own buttons. Two switches in the bar show the failure states: **iCloud rejects the password** (scene 4) and **Password stops working later** (scene 7). The panel under the window explains the current scene and lists the gaps between the design and today's code.
