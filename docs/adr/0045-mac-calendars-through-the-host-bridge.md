# 0045. The Mac's calendars reach agents through the host bridge

- Date: 2026-11-07
- Status: Proposed
- Parent: [0027](0027-host-bridge.md)
- Related: [0006](0006-tool-approval-interrupt.md) (approval UI), [0040](0040-developer-agent-app-access.md) (the bridge doesn't know its caller), [calendar spec](../calendar-ux-study/spec.md)

## Context

Boundary connects calendars over CalDAV: the stack's `caldav-mcp` container signs in to the provider with a username and password, and Boundary registers it on each agent that has access. iCloud only accepts an app-specific password from a CalDAV client, because every Apple ID has two-factor authentication and Apple offers no OAuth scope for iCloud Calendar. Google needs OAuth for CalDAV and Microsoft 365 has no CalDAV at all, so the spec lists both as unsupported.

Native Mac apps avoid all of this through EventKit. The accounts in System Settings → Internet Accounts (iCloud, Google, Exchange and Microsoft 365, CalDAV, subscribed calendars) are already signed in and syncing, and an app reads and writes them through the system store after one Calendar permission prompt. It never handles a credential.

Hermes runs in a Linux container and can't reach EventKit. Boundary can, but only from a signed process on the Mac. Two facts about Boundary shape how:

- **The host bridge already carries host capabilities to agents** (0027): an MCP server in a `utilityProcess`, with main holding policy, approvals and the audit log.
- **The bridge doesn't know its caller** (0040): every Hermes profile holds the same `BOUNDARY_BRIDGE_TOKEN`, so a tool call doesn't say which agent made it. Calendar access is per agent.

Electron's main thread has stalled in privacy-permission waits before (a protected-folder call parked on sandboxd). Calendar data is protected the same way.

## Decision

1. **A Swift helper owns EventKit.** `boundary-calendar-helper` is a command-line binary built from `native/calendar-helper/`, shipped in the app's Resources and signed with the app and the `com.apple.security.personal-information.calendars` entitlement. Main starts it on first use and stops it at quit. It speaks JSON lines over stdin and stdout: requests `status`, `requestAccess`, `listCalendars`, `listEvents`, `search`, `createEvent`, `updateEvent`, `deleteEvent`, and an unprompted `changed` message when `EKEventStoreChanged` fires. No EventKit call runs in an Electron process.
2. **The Mac is one calendar account, provider `mac`.** It sits in Settings → Calendars beside CalDAV accounts as a card named **This Mac**. The user ticks which of the Mac's calendars agents may see, and sets Off, Read, or Read and change per agent, as for any account. There is at most one.
3. **Each agent with access gets its own entry and token.** The entry is `calendar-mac` in that agent's `mcp_servers`, pointing at a `/calendar` route on the bridge's MCP listener, with `Authorization: Bearer ${BOUNDARY_CALENDAR_MAC_TOKEN}`. The token is generated per agent, kept in `safeStorage`, and written only to that agent's `.env`. The bridge maps the token to the agent, and main checks that agent's access level and allowed calendars on every call, so a Read agent's write is refused at the bridge whatever its Hermes config says. The `/calendar` route accepts only these tokens; the general bridge token doesn't open it, and these tokens don't open the general route.
4. **The tools match `caldav-mcp`'s names and arguments where EventKit can do the same thing.** EventKit can't add or remove attendees, so those tools aren't offered. Read tools carry `readOnlyHint: true`.
5. **Hermes's gateway asks before every write.** The entry is `trust: untrusted`, as CalDAV entries are, so writes go to the gateway's approval queue and render as the existing calendar approval card (the server name starts with `calendar-`). The bridge adds no approval of its own, so nobody is asked twice. Runs with no person to ask (board workers, cron) fail closed and can only read.
6. **CalDAV stays as it is.** iCloud, Fastmail, Nextcloud and other servers keep connecting through `caldav-mcp`. Someone can connect both ways; the connect sheet suggests **Calendars on this Mac** to iCloud users and to anyone who picks Google or Microsoft 365.

## Consequences

- iCloud, Google and Microsoft 365 calendars work with no password, and Google and Microsoft 365 stop being unsupported on the Mac.
- The Mac's calendars work only while Boundary runs. With Boundary closed, calls fail with the bridge's "Boundary isn't running" error. CalDAV accounts don't have this limit.
- The build gains a Swift compile step and a second signed binary. Release CI needs Xcode command-line tools, which macOS runners have.
- The app's Info.plist gains `NSCalendarsFullAccessUsageDescription` (and `NSCalendarsUsageDescription` if Boundary supports macOS 13), and its entitlements gain the calendars entitlement.
- Agents' prompt-injection exposure grows the same way it does for CalDAV: invites are text other people write. Per-agent access and approval on every write are the mitigations, as in the CalDAV design.
- Calendar data in tests comes from a fixture store with synthetic events. Nothing in the test suite reads the developer's own calendars.

## Open questions

- In a signed, packaged build, does the Calendar prompt name Boundary when the helper asks, and does the grant hold across helper restarts? Spec phase 4 answers this before anything is built. If the prompt names the helper, it gets its own bundle identity and usage string.
- Are EventKit's event identifiers stable enough across iCloud and Google sync to hand to an agent between turns, or does the helper need `calendarItemExternalIdentifier` plus the start date?
