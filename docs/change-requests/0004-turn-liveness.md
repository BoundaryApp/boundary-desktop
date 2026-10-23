# 0004 · Turn liveness: a heartbeat while a turn runs, and a one-session status query

**Serves:** chat turn state in Boundary (the "waiting for a reply" line, the working dot, reloading a reply that finished in the background).
**Status:** R1–R2 delivered (stack overlay on `feat/turn-liveness`, unreleased)

## Background

Boundary used to end a turn on its own side after a fixed 10 minutes. On 2026-10-12, a local LM Studio model was still running a turn after 10 minutes: tool calls and text had streamed every minute until the cap. Boundary marked the turn as finished and stopped listening while Hermes kept going, so the reply never appeared until the chat was reopened.

Boundary now waits for 3 minutes without events, then asks Hermes whether the session is still running (see the fallback below). It works, but it relies on two things the gateway doesn't really offer today:

- **No events while one model call is in flight.** `_start_usage_ticker` (`tui_gateway/server.py`) skips a tick when the usage counters haven't changed ("counters frozen (one long API call in flight)"). A slow local model processing a long prompt, or generating a tool call, can be completely silent for minutes. A client can't tell a slow turn from a dead one without polling.
- **No cheap per-session status.** The only way to ask "is this session still working?" is `session.active_list`. It builds an item for every live session, including the title (a DB read) and a `preview` of the conversation. Boundary needs one field for one session and has to throw the preview away. `session.status` returns only a human-readable `output` string.

## R1 · Heartbeat while a turn runs (Wanted)

**Why:** a client should know a turn is alive without polling, however long a single model call takes.

**Ask:** while `running` is true for a session, emit an event for it at least every 30–60 s, even when the usage counters are frozen. For example, re-send `session.usage` on a slower cadence when nothing has changed, or add a small `turn.heartbeat` event `{ session_id, running: true, turn_started_at }`. It must carry no transcript content.

**Acceptance:** during a single model call that runs over 5 minutes with no tokens, a gateway client receives an event for that session at least every 60 s, and none after `message.complete`.

**Boundary fallback:** after 3 minutes without events, Boundary polls `session.active_list` (R2), every 3 minutes for as long as the turn stays quiet. With R1 in place the poll would almost never run.

> **Stack reply (delivered):** `turn.heartbeat` every 30 s while running (`HERMES_TURN_HEARTBEAT_S`), payload `{running, status, turn_started_at, idle_s, interval_s}`, never after `message.complete`. Hermes aborts a turn idle for 600 s and sends the usual completion, so about two missed intervals mean a lost stream, not a dead turn. Advertised as `gateway.capabilities.turn_heartbeat` / `turn_heartbeat_s`.
>
> **Boundary:** when advertised, any heartbeat resets the quiet timer, and the window is 2.5 intervals (75 s at 30 s) instead of 3 minutes.

## R2 · One-session status query (Wanted)

**Why:** polling should be cheap and should return no conversation content.

**Ask:** a method (or a structured result on `session.status`) that takes `{ session_id, profile? }` and returns `{ status: LiveSessionStatus, running: boolean, turn_started_at: number | null }` for that one session. Answer with `status: 'idle'` / `running: false` when the session isn't live, rather than an error.

**Acceptance:** one call returns the state of one session, with no title, preview or message text in the response, and it matches `_session_live_status` (`waiting` while an approval or clarify prompt is pending).

**Boundary fallback:** `HermesGatewaySession.getLiveStatus` in `src/main/services/assistant/hermes/hermesGatewaySession.ts` calls `session.active_list` and picks out the session by `id` or `session_key`. It switches to the new method once it lands.

> **Stack reply (delivered):** new method `session.live_status {session_id?, session_key?, profile?}` → `{session_id, session_key, status, running, turn_started_at, idle_s}`, from memory, no title or preview. A session that isn't live answers `idle`. `session.status` is unchanged. Advertised as `gateway.capabilities.session_live_status`.
>
> **Boundary:** `getLiveStatus` uses `session.live_status` when advertised. The `session.active_list` fallback stays for unpatched gateways until the overlay ships in a stack release Boundary requires.

## Notes

Both items are changes to Hermes itself (`nousresearch/hermes-agent`, pinned at `v2026.9.14` in `docker-compose.yml`). They need either a patch carried by the stack or an upstream change.
