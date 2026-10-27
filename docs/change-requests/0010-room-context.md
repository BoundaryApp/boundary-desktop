# 0010 · Room context: turn context on prompt.submit, platform hints, profile checks

**Serves:** channels ([ADR 0008](../adr/0008-multi-agent-channels-and-wake.md), [ADR 0009](../adr/0009-channel-default-is-post.md), [ADR 0010](../adr/0010-durable-attribution-and-room-lifecycle.md)).
**Status:** R1–R3 delivered in v0.3.3 · Boundary wired

## Background

When the user @-mentions an agent in a channel, Boundary sends one `prompt.submit` on the room's shared session with the unread posts and the @ message as its text. Nothing told the agent that it was in a channel, which channel, who else was in it, or which member it was answering as. The earlier replies in the session carry no speaker names. Hermes adds a "Current Session Context" block for its messaging gateways, but the dashboard WebSocket path that Boundary uses had no way to send one. Boundary's session source, `boundary`, also has no built-in platform hint.

## R1 · Turn context that isn't stored as the user's message (Wanted)

**Why:** the room's name, its members and the answering member exist only in Boundary. Put in the message text, they are stored in the session history on every wake.

**Ask:** an optional field on `prompt.submit` that reaches the model for that turn and stays out of `session.history`, with a capability flag so a client can check before sending it.

**Acceptance:** a turn sent with the field shows the context to the model, and `session.history` returns the user's text as typed.

**Boundary fallback:** the context line goes above the message text.

> **Stack reply (delivered, v0.3.3):** `prompt.submit` takes `context` (turn context, added to that turn's model input after the user's text and resent on later turns from the row's `api_content` sidecar). `session.create` / `session.resume` take `context` for session context, added to the system prompt. Advertised as `gateway.capabilities.client_context`. Errors: `4080` invalid, `4082` a turn is running, `4083` isolated compute-host turns.
>
> **Boundary:** each room turn sends a one-line header as turn context when `client_context` is advertised: the channel slug, the members with a short role, the member answering and, on a chain wake, who replied last. On an unpatched gateway, or on `4082`, the same line goes above the message text. Boundary sends no session context yet.

## R2 · A platform hint for a client's own source (Wanted)

**Why:** Hermes gives a session whose `source` has no built-in hint none at all, so the agent doesn't know how Boundary's chat works. The stack shouldn't carry text about any one client.

**Ask:** a supported way for a client to describe itself, or documentation of the existing one.

**Acceptance:** a client can add a hint for its own `source` without a stack change.

**Boundary fallback:** none.

> **Stack reply (delivered, v0.3.3 docs):** `agent.platform_hints.<source>` in each profile's `config.yaml`. A bare string is appended to the built-in hint, or used on its own when there is none.
>
> **Boundary:** writes `platform_hints.boundary` to the default profile when it configures its own stack, and to every agent profile it creates or configures. The key sits at the top of `config.yaml`: Hermes v0.22 reads hints there and refuses the nested `agent.platform_hints` form shown in the reply above. It describes channels, the header line, posts without an @ and hand-offs by @. Local-stack mode writes it to the developer's default profile too, since room turns run there; Hermes uses the key only for sessions whose source is `boundary`.

## R3 · `profile` on `prompt.submit` (Wanted)

**Why:** `prompt.submit` accepted a `profile` and ignored it; the turn ran on the session's profile. Boundary sent each room member's profile and assumed it applied.

**Ask:** honour `profile` per turn, or reject one that differs from the session's.

**Acceptance:** a mismatched `profile` either runs on that profile or fails with an error code.

**Boundary fallback:** none.

> **Stack reply (delivered, v0.3.3):** a `profile` that differs from the session's fails with `4081` and `data.session_profile`. A matching or omitted `profile` behaves as before. Advertised as `gateway.capabilities.prompt_profile_check`.
>
> **Boundary:** `submitPrompt` sends no `profile`. Room turns run on the default profile, which owns the room's session.

## Notes

Every room turn runs on the default profile, so a member answers with the default profile's memory and tools. Boundary sends the member's SOUL.md as turn context the first time it speaks in a room session and again when the file changes, which covers its persona. Giving each member its own profile in a room is [0011](0011-attributed-session-turns.md).
