# Calendar connect: living spec

The visual source is [click-through.html](click-through.html). What the stack and Hermes need is in [change request 0006](../change-requests/0006-calendar-connect.md).

| | |
| --- | --- |
| Status | Proposed 20 Oct 2026 |
| Visuals | [click-through.html](click-through.html) |
| Backend | Checked against stack `v0.3.3`, the running `hermes` container, and `gelse/caldav-mcp` v0.1.1 source |
| Started | 20 Oct 2026 |

## Progress

| Phase | Status | Depends on |
| --- | --- | --- |
| 0 Spike: the gateway path | Done 21 Oct 2026 (sandbox) | — |
| Stack pin to `v0.3.3` | Done 21 Oct 2026 (in-app upgrade test pending) | — |
| 1 Connect and read | Built 21 Oct 2026; in-app check pending | 0, pin |
| 2 Changes with approval, broken sign-ins | Built 25 Oct 2026; in-app check pending | 1 |
| 3 Chat entry point, Services | Built 25 Oct 2026; in-app check pending | 1 |

## The problem

The stack can give agents a calendar. `caldav-mcp` (`ghcr.io/gelse/caldav-mcp`) runs in the `calendar` Compose profile, holds no credentials itself, and reads the CalDAV URL, username and password from `X-Caldav-*` headers on each call. The stack's bootstrap turns each `compose/caldav-mcp/accounts/<slug>.env` into a Hermes MCP server `caldav-<slug>` on the default, `api-server` and `browser` profiles (`compose/hermes/bootstrap-api-profile.sh`, `register_caldav_mcp_servers`).

None of that is reachable from Boundary:

- **Boundary's managed stack leaves the `calendar` profile out** (`BOUNDARY_ASSISTANT_COMPOSE_PROFILES` in `src/shared/assistantStackConstants.ts`), and `CALDAV_MCP_ENABLED` defaults to 0.
- **Setup means editing a file and running `make hermes-reload`**, which re-runs both bootstraps and recreates `hermes`. It takes about two minutes, and chats stop answering while it runs.
- **A wrong password fails silently.** Nothing tests the sign-in: `make doctor` checks that the file looks filled in and never contacts the server. Placeholder values are skipped with a log warning.
- **Users must know the CalDAV URL.** There is no discovery; `docs/calendar.md` lists typical URLs per provider.
- **Access is all or nothing.** Every account goes to every profile the bootstrap knows. Boundary agents get none, because `AGENT_MCP_SERVERS` (`src/main/services/assistant/hermesAgentMcpServers.ts`) copies only `opencode`, `searxng` and `todos`.

## Goal

Someone with an iCloud, Fastmail or Nextcloud calendar connects it from Boundary in about three minutes, most of which is getting an app password from their provider. They choose which agents can read it and which can change it, every change is approved first, and a password that stops working says so on the account card instead of failing inside a chat.

## Non-goals

- **Google Calendar and Microsoft 365.** Google's CalDAV endpoint needs OAuth, and Microsoft doesn't offer CalDAV. The provider step lists both as unsupported with the reason.
- **A calendar view in Boundary.** Agents read the calendar. People keep using their calendar app.
- **Choosing calendars within an account.** caldav-mcp shows every calendar on the login. The sign-in step lists them so this is visible. CR 0006 R5 asks for an allowlist.
- **Calendar changes from board workers and cron.** Hermes's approval gate fails closed when there's no person to ask, so those runs can read but not write. That's the safe default.

## Surfaces

| Moment | Surface | Scene |
| --- | --- | --- |
| Asks about the calendar with none connected | Hermes says it can't see one and shows a **Connect a calendar** card | 1 |
| Manages calendars | **Settings → Calendars**, a new tab after Passwords & Logins | 2, 7 |
| Connects | A three-step sheet: provider, sign in (with a test), access per agent | 3–5 |
| Waits | A checklist on the account card while Boundary registers the calendar | 6 |
| Uses it | Reads show a tool chip naming the account and day. Changes raise an approval card | 8 |
| Checks the service | **Services** lists Calendar with its status and links to Settings | Services |

## Thin-wrapper map

| Need | Stack or Hermes provides | Boundary adds |
| --- | --- | --- |
| Calendar bridge | `caldav-mcp` service in the `calendar` profile, built from upstream commit `ce880c5` (native arm64), reachable at `http://caldav-mcp:8080/mcp` inside the Compose network | Adds `calendar` to the Compose profiles and starts (and the first time, builds) the service when the connect sheet opens, without touching `hermes`. |
| Sign-in test | The caldav-mcp container, which has the Python `caldav` client the agent uses. `docker compose exec -T caldav-mcp python -` runs a script from stdin (CR R4 answer) | A short probe script sent on stdin with the URL, username and password, also on stdin, never in argv or the environment. It tries `/.well-known/caldav` when the URL has no path, then lists the calendars (name, color, whether it's read-only). It prints one JSON line: ok with calendars, rejected (401, 403), or unreachable with the error. |
| Registration | `hermes -p <profile> config set mcp_servers.<name> '<json>'`. Hermes resolves `${VAR}` header values from the profile's `.env` when it connects | One entry per agent with access, named `calendar-<slug>` (decision 2), set with `buildHermesConfigSetExec(..., { secret: true })` as `copyDefaultMcpServers` does. The entry: the URL, the three `X-Caldav-*` headers with the password as `${BOUNDARY_CALENDAR_<SLUG>_PASSWORD}`, `tools.include` (decision 5), `trust: untrusted`, `timeout: 60`, `connect_timeout: 30`. Not `mcp.servers.set_api_key`, which replaces the headers (Phase 0, S1). |
| Password | The profile's `.env`, read when a server connects | Writes `BOUNDARY_CALENDAR_<SLUG>_PASSWORD` into each granted profile's `.env` on disk, as `hermesProvision.ts` writes the bridge tokens. Keeps its own copy in `safeStorage` so it can provision a newly granted agent or re-provision after a reset. Never in argv or logs. |
| Load without a restart | New sessions discover new servers themselves. `reload.mcp` reconnects every profile's servers | Calls `reload.mcp` with `confirm: true` after a change to an existing entry (access, password, removal). Adding a calendar needs none, but Boundary calls it anyway so open chats get the tools. |
| Health | Gateway `mcp.servers.status`: `connected`, tool count | Shows the card's status. The MCP connection stays up when the password is wrong, so Boundary also re-runs the probe when the tab opens and once a day. |
| Approval for changes | `trust: untrusted` sends every tool without `readOnlyHint: true` to the gateway's approval queue. caldav-mcp marks its 8 query tools read-only and its 6 mutations not. Since `v0.3.3` the request carries `mcp: { server, tool, arguments, tool_call_id }` (redacted, capped) and `choices: ["once", "deny"]` | `ApprovalInterrupt` renders a calendar variant when `mcp.server` starts with `calendar-`: the verb from `mcp.tool`, the event's title, time and calendar from `mcp.arguments`, and the account from the server name. |
| Removal | Gateway `mcp.servers.remove` per profile. It leaves the `.env` key | Removes the entry from every profile, deletes the `.env` key and the `safeStorage` copy, calls `reload.mcp`, and drops `calendar` from the Compose profiles when the last account goes. |

## Decisions (confirm before Phase 1)

1. **Calendars is its own Settings tab** (`SettingsTab` gains `'calendars'`, after `'passwords'`). Like logins, these are real accounts with a secret, so they follow the Passwords & Logins pattern: a list, an add sheet, actions on each row. *Recommended over* a generic Connections page, which would hold one kind of connection today. Rename the tab when a second kind arrives.
2. **Boundary registers calendars per agent itself, not through the stack's account files.** The stack's path needs `CALDAV_MCP_ENABLED=1`, an account file and a two-minute reload. It also gives every account to every profile it knows, and keeps the password in two plain-text files. Writing the entry and the `.env` key the way the host bridge does registers per agent and needs no restart (Phase 0), and the password lives only in the `.env` of profiles that have access. Entries are named `calendar-<slug>` with `BOUNDARY_CALENDAR_<SLUG>_PASSWORD`, so the bootstrap's `reconcile_caldav_accounts`, which deletes any `caldav-*` entry without an account file, never touches them, even in local-stack mode with `CALDAV_MCP_ENABLED=1`. The stack documents and tests this as a supported path (CR R6). Boundary never registers on `api-server`, and registers only after the first bootstrap has created it: a calendar entry on the default profile when `api-server` is cloned is copied without its password and fails. *Recommended.*
3. **Provider first, URL hidden.** iCloud, Fastmail and Nextcloud fill the URL in (Nextcloud asks for the host). "Other CalDAV server" takes a host or full URL, and the probe follows `/.well-known/caldav`. The URL stays editable under **Server address**.
4. **Nothing is saved until the sign-in test passes.** The test runs inside the caldav-mcp container, so it uses the same client and network as the agent. Opening the connect sheet starts the service (building it the first time), so the build overlaps with choosing a provider and fetching an app password. If the service isn't up when the user presses **Test sign-in**, the button reads "Starting the calendar service…" until it is. A rejected sign-in blocks the step, and its copy names the likely cause (for iCloud, the Apple ID password instead of an app-specific one). For iCloud, a password that doesn't match the app-specific format (`abcd-efgh-ijkl-mnop`) warns before any network call, with **Test anyway**. An unreachable server also blocks, with the error, since an agent couldn't reach it either.
5. **Access is per agent: Off, Read, or Read and change.** Read is the stack's 8 query tools in `tools.include`; Read and change is all 14. Hermes defaults to Read and change and every other agent to Off, including agents created later. *Recommended over* one switch for all agents, because calendar invites are text other people write (the credential plan lists them as a prompt-injection source).
6. **Every change asks first.** All entries are `trust: untrusted`, so creating, updating, moving or deleting events and adding or removing attendees raises an approval. Reads never ask. Per ADR 0006, the card offers only the choices the gateway sends.
7. **The chat entry point is a host-bridge tool, not a keyword match.** The `boundary` bridge gains `offer_setup({ kind: "calendar" })`, listed only while no calendar is connected. Its description tells the model to call it when someone asks about their schedule. Boundary renders the call as the **Connect a calendar** card. *Recommended over* matching words like "calendar" in the renderer, which would misfire on questions about calendars in general.
8. **The name is how people address the account.** The slug is the name lowercased, with each run of characters outside `[a-z0-9]` turned into one hyphen; names must be unique. The card shows "Check my *Personal* calendar" so people with two accounts know what to say.
9. **Cloud inference is named at the access step.** Giving access to an agent whose model is in the cloud shows that events it reads (titles, notes, attendees) go to that provider, reusing `cloudInferenceCopy.ts`.

---

## Phase 0 · Spike: the gateway path

No UI. Run each check against the running stack with a throwaway Radicale account on `example.com`-style synthetic data, never a real calendar, and record the answers in the Log.

- **S1** `mcp.servers.add` on a named profile accepts `headers` with a `${VAR}` value, `tools.include`, `trust`, `timeout` and `connect_timeout`, and `mcp.servers.list` shows them back.
- **S2** `mcp.servers.set_api_key` with `env_var: BOUNDARY_CALENDAR_TEST_PASSWORD` writes that key to the profile's `.env`, and the header resolves on the next call without restarting `hermes` (with or without `reload.env`).
- **S3** After `reload.mcp`, a new session on that profile has the tools, including a profile with no open session. Note whether an open session sees them too.
- **S5** `mcp.servers.remove` deletes the entry. Record whether the `.env` key stays, and how Boundary can remove it if it does.
- **S6** On Apple Silicon, how long the first build of caldav-mcp takes on a clean machine, and that `caldav_list_calendars` answers in under 3 s.
- **S7** How caldav-mcp uses its container `TZ` (the stack defaults it to UTC). If events come back or are created in the wrong zone, the overlay sets `TZ` from the host's zone. The approval example in the stack's docs shows a start time with no offset, so check what zone it is read in.
- **S8** The probe script through `docker compose exec -T caldav-mcp python -` returns calendars for a good password, "rejected" for a bad one and "unreachable" for a wrong host. Nothing about the password shows in `docker inspect`, the process list or the container log.

**Acceptance**
- [x] 0.1 S1–S3 and S5–S8 each have an answer in the Log.
- [x] 0.2 If S1, S2 or S3 fails, decision 2 is switched to the fallback and the click-through's scene 6 is updated before Phase 1 starts. (None failed. S1 changed how Boundary writes the entry, not whether it can.)

## Phase 1 · Connect and read

**Where:**
- new `src/main/services/assistant/calendar/caldavProbe.ts` and its probe script (the sign-in test, run in the caldav-mcp container)
- new `src/main/services/assistant/calendar/calendarAccounts.ts` (account list in `electron-store`, passwords in `safeStorage`, gateway registration)
- IPC in `src/main/services/assistant/calendar/ipcHandlers.ts`, `preload.ts`, a renderer `CalendarIPCService.ts`
- `src/shared/assistantStackConstants.ts` (the `calendar` profile) and `resources/assistant/docker-compose.boundary.yml` (`TZ` on caldav-mcp from the Mac's zone, Phase 0 S7)
- `src/renderer/product/settingsNavigation.ts`, `ProductSettingsScreen.tsx`
- new `src/renderer/product/CalendarsPanel.tsx`, `ConnectCalendarSheet.tsx`
- `src/main/services/assistant/hermes/hermesAgents.ts` and `hermesGatewaySession.ts` (`mirror_exclude` on new agents)

1. **Settings → Calendars:** the empty state, the account card (status dot and pill, provider and URL, account, masked password, calendars, access, the "In chat" line), **Test**, **Change access** and **Remove** with an inline confirm.
2. **Connect sheet** (decisions 3, 4, 5, 8, 9): provider, sign in with the probe, access. Read and Off only in this phase; Read and change appears in Phase 2.
3. **Connecting** checklist: saved the sign-in, gave access, checked Hermes can read it (`mcp.servers.status` shows the entry connected with 8 tools). The calendar service is already running by then (decision 4).
4. **New agents:** `profiles.create` gets `mirror_exclude: ["BOUNDARY_CALENDAR_*"]` (sent since the pin move), so `mirror_credentials` copies the model credentials without calendar passwords. Granting a new agent access writes its password into that agent's `.env`.
5. **Privacy:** passwords, event titles, notes and attendees never reach `console.*`, the debug logs or telemetry. Log account slugs and statuses only.

**Acceptance**
- [ ] 1.1 Connecting a Radicale test account with Read for Hermes takes under 15 s from **Connect** (after the first build), and Hermes answers "what's on Thursday" from it in a new chat without a `hermes` restart.
- [ ] 1.2 A wrong password is rejected at the sign-in step and nothing is written to any profile.
- [ ] 1.3 An agent set to Off has no `calendar-*` entry and no `BOUNDARY_CALENDAR_*` key, including one created after the calendar was connected.
- [ ] 1.4 Remove deletes the entry and key from every profile, and with no accounts left, the next stack start doesn't start caldav-mcp.
- [ ] 1.5 Grep of the debug log after connecting and one calendar question finds no password and no event text.

## Phase 2 · Changes with approval, broken sign-ins

1. **Read and change** in the access step, mapped to all 14 tools with `trust: untrusted` (decision 6).
2. **Approval card** for calendar writes (`mcp.server` starts with `calendar-`): the verb from `mcp.tool` ("add an event", "move an event", "delete an event", "invite someone"), the title, time and calendar from `mcp.arguments`, and the account from the server name. The buttons are **Add event** (or the matching verb) for `once` and **Don't add** for `deny`. An argument the card doesn't recognise falls back to the generic approval layout.
3. **Broken sign-in:** when the daily probe or the tab-open probe gets a 401, the card turns red with the date it last worked, the likely cause for that provider, and **Replace password** first.
4. **Replace password** reuses the sign-in step (with the test) and re-provisions every profile with access.

**Acceptance**
- [ ] 2.1 Asking Hermes to add an event raises one approval. Declining leaves the calendar unchanged and Hermes says it didn't add it.
- [ ] 2.2 No read tool raises an approval.
- [ ] 2.3 Changing the test account's password turns the card red within a day, or immediately when the tab opens.
- [ ] 2.4 Replace password restores reads without a restart.

## Phase 3 · Chat entry point, Services

1. **`offer_setup`** on the host bridge (decision 7), rendered as the **Connect a calendar** card. **Connect calendar** opens the sheet over Settings → Calendars, and closing it returns to the chat.
2. **Services** lists Calendar: "Starts when you connect a calendar" when off, its status when on, and a link to Settings → Calendars.
3. **Read-only replies:** an agent with Read that's asked to change an event says it can't and links to the access settings. This comes from the agent's tool list, so it needs no code beyond checking the wording in its SOUL.

**Acceptance**
- [ ] 3.1 With no calendar connected, "what do I have on Thursday" shows the card, and "how do Hebrew calendars work" doesn't.
- [ ] 3.2 After a calendar is connected, `offer_setup` is no longer listed for any agent.

## Open questions

- Should Hermes default to Read and change, or to Read with a nudge the first time someone asks for a change? The mock uses Read and change because every change asks first.
- Should **Remove** also tell people how to revoke the app password at the provider? The mock does this for iCloud only.
- Kanban workers get reads only (non-goals). If the Orchestrator should file "book the meeting" tasks, that needs an approval route for board runs first.
