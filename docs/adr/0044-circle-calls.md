# 0044. Circle calls: live audio and video between members, kept nowhere

- Date: 2026-11-02
- Status: Proposed
- Parent: [0042](0042-circle-chats.md)
- Amends: [0042](0042-circle-chats.md) §3 (a `call` field on `chat-post` and `chat-edit` at format 2)
- Related: [0032](0032-circles.md), [0043](0043-circles-live-in-the-chat.md), [circles plan](../circles-plan.md) (peer signals, camera and microphone), [Circle calls spec](../circle-calls-ux-study/spec.md)

## Context

Two pieces calls need already exist. [Peer signals](../circles-plan.md#peer-signals) carry short messages between members, to everyone in a Circle or to one identity. The receiver takes the sender's identity from the connection, so a signal can't be forged by another device. Payloads are at most 4 KB of JSON, at 30 a second per peer with bursts of 60, and only main can send or listen today. [Camera and microphone](../circles-plan.md#camera-and-microphone) access is granted to the app's own page and nothing else, and macOS asks once per device. Nothing in the app uses either for calls yet.

Since ADR 0042 §10 and 0043, a Circle is a place in the chat with channels and people, and a person's panel there is about membership. Direct messages inside a Circle are deferred (0042 §14) because anything in the Circle's log can be read by every member. A call stores nothing, so it doesn't have that problem.

There is no server. Media has to go between members' Macs. WebRTC does that with echo cancellation, jitter buffers and codecs built in, and needs only an exchange of session descriptions and network candidates, which peer signals can carry. Without a relay (TURN), two Macs behind strict NATs can't connect; the circles plan already lists TURN as an open question. A session description with audio and video is often larger than 4 KB.

## Decision

1. **Media is WebRTC between members' Macs, set up over peer signals.** Offers, answers and candidates go on `call.*` topics, addressed to one identity. A message larger than one signal is compressed and, if still too large, split into numbered parts the receiver reassembles. The renderer runs the peer connections; main relays its call signals over new IPC, and only `call.*` topics cross. Media is encrypted by WebRTC's DTLS-SRTP, and because the fingerprints travel in signals the receiver attributes to a member's device, a third party can't sit in the middle.
2. **A call is a room with a mesh.** Each person in a call connects to every other. A room has a name chosen by whoever starts it: a channel's call is `channel/<id>`, a call with one person is a random id, and other screens can name their own rooms. While in a call, each device sends a `call.state` signal every few seconds with the room, whether it's muted and whether its camera is on; a device that stops sending for 15 seconds has left. Video is on for up to 6 people. A seventh person joins with audio only, and the call view says why.
3. **Calls in channels.** A Circle channel's header has **Call**. Anyone in the Circle can start or join a channel's call. Starting one posts a message to the channel with a `call` field (decision 7), which shows as "Maya started a call" with **Join** while it's live. While a channel has a live call, its row in the rail shows a live mark with the faces of who's in it, and the switcher's menu shows the mark on the Circle. Nobody is rung.
4. **Calls with one person.** A person's panel in a Circle has **Call**, as does their row in the rail's People section on hover. The other person's Mac rings with an in-app card on any screen, with **Join** and **Decline**; it rings for 30 seconds, then the caller sees "No answer". Nothing about the call enters the Circle's log, so it's as private as the two Macs.
5. **The call stays with you.** While in a call, a call bar sits at the foot of the chat rail in every place, with the call's name, mute, camera and **Leave**, and the Chat icon in the icon rail shows a live dot. On other screens the same bar floats at the bottom left. Clicking the bar opens the call view: tiles in the main area and, for a channel's call, the channel's chat beside them in the compact thread (Circle chats spec phase 7).
6. **Joining asks first.** **Join** and **Call** open a join sheet: a camera preview, microphone and camera pickers, the camera off by default, and **Join**. The sheet asks macOS for a device only when it's about to be used. A denied device shows a line that links to System Settings, and the user can join without it. Default devices and whether the camera starts on are in Settings, under **Calls**.
7. **Format 2 reserves a call marker.** `chat-post` and `chat-edit` take an optional `call` of `{ id, ended? }`, where `id` is the room's 16 to 32 hex characters and `ended` is the author's clock in milliseconds. A post with `call` may have empty text. Only the author edits, as for any message, so the starter's device adds `ended` when it sees the room empty; if it can't, readers show the call as over once no `call.state` for it arrives, without a length. This rides ADR 0042's format 2, so it costs no format of its own.
8. **What a call never does.** No recording, no transcript, no agents in calls, and no screen sharing in this ADR. The page may only use `media` (camera and microphone); screen capture would need its own permission decision.

## Consequences

- Some pairs of members won't connect until there's a relay. The call view names who can't be reached instead of failing quietly, and the spec's first phase measures how often it happens.
- Finding a Mac's public address needs a STUN server or Hyperswarm's own view of it. A public STUN server learns each member's address and when they call. The first phase decides which, and Settings says what's used.
- A mesh sends each person's video to every other person, so upload grows with the call. The 6-person video cap is a starting point the first phase checks.
- Peer signals gain a renderer path for `call.*` topics, and their rate limit now covers call setup; a burst of candidates must stay under it.
- The chat's who-lines and live marks depend on `call.state` signals, which a member who is offline never receives, so a call's length in the channel is best-effort.
- Another screen can run calls in rooms it names, with its own rules for who connects, through the same call service, the way it can mount a Circle channel through `CircleThread`.
