# 0011 · Attributed turns: speaker names on assistant rows, and appending turns to a session

**Serves:** channels ([ADR 0008](../adr/0008-multi-agent-channels-and-wake.md), [ADR 0010](../adr/0010-durable-attribution-and-room-lifecycle.md)); follows [0010](0010-room-context.md).
**Status:** R1 wanted (Boundary keeps the shared session) · R2 answered by upstream hosted rooms, which Boundary isn't adopting yet

## Background

A Boundary channel is one Hermes session on the default profile, shared by every member. Each member's turn runs there, so it gets the default profile's tools and memory whatever agent was @-mentioned. Boundary sends the member's SOUL.md as turn context (0010 R1), which fixes the persona and nothing else. Two consequences:

- **Tools.** A member whose profile has extra toolsets doesn't get them in a room. The orchestrator agent's profile is the only one with `kanban` in its toolsets, so @-mentioning it in a room gives it no kanban tools.
- **Memory.** Memory lives under each profile's home (`memories/`). A member that saves something in a room saves it to the default profile's memory, and never sees its own.

Running each member in its own profile means one session per member. The room's transcript is then split across those sessions, and nothing in the gateway can put one member's reply into another member's session or into a shared session. So the client has to keep the whole transcript itself and re-send each member everything it missed as text. The asks below let a session hold a multi-speaker transcript, so the client doesn't have to.

Hermes already has an `author` field on the API server, but it labels the user side of a turn and only for memory (`_request_turn_author`), and a client that sends `_turn_author` on `prompt.submit` gets `4124` ("stamped by the gateway, never by a client").

## R1 · Speaker names on assistant rows (Wanted)

**Why:** several agents reply in one session. The model sees all the earlier replies as its own, and a client has to keep its own record of which reply came from whom.

**Ask:** an optional `speaker` on `prompt.submit` (for example `{ id, display_name }`, same cleaning as turn authors) that is stored on the assistant rows the turn produces. `session.history` returns it, and later turns show the model the earlier replies with their speaker's name.

**Acceptance:** after two turns with different `speaker` values, `session.history` returns each assistant row with its speaker, and the third turn's model input labels both earlier replies.

**Boundary fallback:** speaker records per session in electron-store, matched to assistant rows by order, and a header line naming who replied last.

> **Stack reply (on hold):** if channels move to hosted rooms, the room log already carries the speaker, and each member's prompt labels earlier replies, so R1 isn't needed there. It would only help today's shared default-profile session. Tell us if you plan to keep that session for some channels. In that case we'd build `speaker` on `prompt.submit` as an overlay: stored in the assistant rows' `display_metadata`, returned by `session.history`, with a stable name label in what the model sees, and refused while a turn is running.

> **Boundary (reply):** please build R1. Boundary is keeping the shared session for every channel (see the reply under R2), so `speaker` on `prompt.submit` is the change that helps now. The shape you describe fits: stored in `display_metadata`, returned by `session.history`, a stable name label in what the model sees, and refused while a turn runs. Please advertise it in `gateway.capabilities`, as `client_context` is. Boundary will then send each member's handle and display name as the speaker and drop its own speaker records and the header's "last reply was from" once the gateway labels replies itself.

## R2 · Append turns to a session without running one (Wanted)

**Why:** a member's turn can run in its own profile's session, but its reply also has to reach the room's shared session (and the other members' sessions) so the next speaker sees it.

**Ask:** a method such as `session.append { session_id, rows: [{ role, content, speaker? }] }` that adds rows to a session's history without running the agent. It is refused while a turn runs in that session, as `context` is (`4082`). It returns the new row ids. Rows are stored as if they had been produced in that session, so `session.history`, compression and `history_budget` treat them like any other row.

**Acceptance:** after appending an assistant row with a speaker to session A, `session.history` on A returns it with that speaker, and the next `prompt.submit` on A shows it to the model in order.

**Boundary fallback:** every member runs on the default profile (current behaviour). Without R2, per-member profiles would need Boundary to store all room replies itself and rebuild the room view, reload, Stop all, edit, retry and branch around that store.

> **Stack reply (use `groups.*`):** we're not adding `session.append`. Hosted rooms already deliver what R2 is for, and we tested it on v0.22.5 with a two-member room (`default` and `orchestrator`):
>
> - **Profile per member:** each member turn ran with its own profile's SOUL, toolsets and memory. The orchestrator got all 16 kanban tools, including `kanban_update` and `kanban_archive`, and a `kanban_list` call succeeded. The default member got no kanban tools.
> - **Memory:** a `memory` write in the orchestrator's room turn landed in `profiles/orchestrator/memories/MEMORY.md`, not in default's.
> - **What each member sees:** only the messages it hasn't seen, with other members' replies labelled `@handle: text` and the user's as `User (user): text`. Each member keeps its own transcript of the room in its `Group:` session.
> - **Attribution:** `groups.log` returns each reply as a `message.member` event carrying its `member_id`.
>
> The flow: `groups.create { room_id, name, members: [{ member_id, profile, handle, display_name }] }`, then `groups.send { room_id, event_id, payload: { thread_id, text } }` per user message. Read replies with `groups.log { room_id, since_seq }` and progress with `groups.state` (`driver_status.working`, `counts`, `member_activity`). `groups.stop`, `groups.retry` and `groups.approve` cover Stop, retry and approvals.
>
> Constraints that come with it, all upstream's:
>
> - **Roster:** 2–6 members, each on a distinct profile. Two members can't share the default profile.
> - **Rounds:** a user message starts a Discussion. A message with no @-mention goes to every member, and one with mentions goes only to those members. A later round runs only for members another member @-mentions. Each Discussion is capped at 3 rounds and 10 member replies, and a member replies `(pass)` when it has nothing to add.
> - **No push events:** room changes aren't sent as events, so poll `groups.log` and `groups.state`.
> - **Payload:** `groups.send` takes only `thread_id`, `text` and `attachments`. There's no `context` field and no user display name. A member's own SOUL loads natively, so the 0010 R1 turn context isn't needed in a room.
>
> Not tested yet: approvals raised during a room turn, whether a member's reply streams to a WebSocket client while it's written, and whether a kanban wake turn in a member's `Group:` session reaches the room log. If any of these blocks Boundary, or the Discussion policy doesn't fit ADR 0008's wake model, tell us which part. A narrow overlay on `groups.*` fits the stack better than a second transcript mechanism.
>
> **Why not `session.append`:** it is more than a row insert. A live session holds its history in memory, so the append would have to update that copy as well as the database. Reloading a session merges consecutive same-role rows, so two members' replies would become one message. Appended user rows would also shift the turn numbers that rewind and edit use. And retry or edit in a shared session that never runs its own turns would rerun the turn in the default profile.

> **Boundary (reply):** agreed on not adding `session.append`, and thanks for the hosted rooms test. We read the driver's source on v0.22.5 to check the untested parts, and channels won't move to `groups.*` yet. Three things each block it:
>
> - **No live replies.** A member turn runs on a hidden `room_plumbing` session with no client transport. Its `message.delta`, tool and approval frames go only to the `on_room_member_activity` plugin hook, not to a WebSocket client or the room log. Boundary channels stream each reply with its speaker and tool calls as they run. On hosted rooms a reply would appear whole, found by polling `groups.log`.
> - **Fixed roster.** `validate_roster` takes a frozen 2–6 member roster, and no method adds or removes a member. Boundary rooms add and remove members (ADR 0008, ADR 0010).
> - **Two members minimum.** Boundary rooms with no agents (ADR 0009) or one agent are common, and would have to stay on the shared session either way.
>
> Smaller gaps:
>
> - **Working folder.** Member sessions are created without a cwd, so a room bound to a project wouldn't run there.
> - **Attachments.** These are refused on the same-install route (`attachments_unsupported_on_route`).
> - **Approvals.** Only `once` and `deny` are offered, and found by polling `groups.state`.
> - **Posts.** A message without an @ starts a Discussion for every member, where in Boundary it is a post that wakes no one (ADR 0009).
> - **(pass) replies.** These would need hiding.
>
> If hosted rooms are to replace channels later, these are the narrow overlays on `groups.*` it would take:
>
> 1. Member activity frames (deltas, tool start and complete, approval requests) sent to a WebSocket client that watches the room.
> 2. Room log events pushed to a watching client instead of polled.
> 3. A room working folder, applied to every member session.
> 4. Attachments on the same-install route.
> 5. Adding and removing members after create.
> 6. A send that wakes only the @-mentioned members, or no one, with the text still added to the room log.
>
> None of these is requested now. Boundary keeps its fallback: every member on the default profile, with the 0010 header and the member's SOUL.md as turn context. The known gap is that a member's own toolsets and memory don't apply in a room. Today that matters for the orchestrator, which has no kanban tools there.

## Notes

With R1 and R2, a room would keep its shared session as the transcript. A member's turn runs in a hidden session in its own profile (`session.set_hidden` exists already), given what it missed as turn context, and its reply is appended to the shared session with its speaker. Hermes's hosted rooms (`Group: <room_id>`, one hidden session per member profile) solve the same problem for rooms across separate installs. They need grants and a peer transport, which is more than one client on one machine needs.

R1 helps without R2: it labels replies in today's shared session and lets Boundary drop its speaker records.

> **Stack reply (correction):** hosted rooms need grants and a peer transport only for members on another install (RoomLink). For members on the same install there's a same-gateway Discussion driver, and the dashboard process starts it at boot. Over the same `/api/ws` connection Boundary already uses, `groups.capabilities` reports `driver: true`. A room can seat `default` and any profile under `profiles/`. The stack's per-profile gateway pin doesn't change that, and no `hosted_rooms.profiles` config is needed.
>
> That driver is the design in these Notes. The room's event log is the transcript. Each member runs in a hidden `Group: <room_id>` session (source `bot_room`) in its own profile, and is prompted with the room messages it hasn't seen yet. Checked against Hermes Agent v0.22.5, the stack's pin, with `scripts/test-hosted-rooms.py` run with the stack's gateway and kanban overlays applied.
