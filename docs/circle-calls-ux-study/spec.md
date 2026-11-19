# Circle calls: living spec

| | |
| --- | --- |
| Status | Proposed |
| Visuals | `call`, `joincall` and `ring` scenes in the [Circle chats click-through](../circle-chats-ux-study/prototype.html) |
| Started | 2 Nov 2026 |
| Builds on | [ADR 0044](../adr/0044-circle-calls.md), [ADR 0042](../adr/0042-circle-chats.md), [ADR 0043](../adr/0043-circles-live-in-the-chat.md), [circles plan](../circles-plan.md) (peer signals, camera and microphone), [Circle chats spec](../circle-chats-ux-study/spec.md) |

## Progress

| Phase | Status | Depends on |
| --- | --- | --- |
| 1 Transport check | Done: two-Mac runs across networks; ADR 0044 §9 records the decision (STUN server, then the Circles connection) | — |
| 2 Call service | Done: `useCircleCall`, `CallStage` and a test call in the call check sheet. Two Macs across networks ran the test call, its controls and leaving, over a direct path and over the Circles tunnel | 1 |
| 3 Calls with one person | Built, with ring alerts outside the window and the call view opening on join; two-Mac runs pending | 2, Circle chats phase 3 |
| 4 Calls in channels | Not started | 3, Circle chats phases 1 and 7 |
| 5 Calls settings | Not started | 3 |

## Goal

Two or more members of a Circle can talk, with or without video, from where they already are in the chat, with nothing kept anywhere. Anyone can see that a channel has a call going and who's in it. A call keeps going while the user moves around the app, and it's always clear how to mute or leave.

## Decisions

ADR 0044 holds the transport, privacy and format decisions. These are the screen's.

1. **Call in the header.** A Circle channel's header has **Call**, a labelled button left of the panel button. While the channel has a live call it reads **Join**, with the faces of who's in it.
2. **The call message.** Starting a channel's call posts "Maya started a call" with a phone mark and **Join**. When the call ends it reads "Call · 14 min", or "Call ended" when its length isn't known.
3. **Live marks.** A channel with a live call shows a small green phone and up to three faces in the rail. The Circle's row in the switcher's menu shows the green phone too. The Chat icon shows a green dot while the user is in a call.
4. **Calling one person.** **Call** on a person's panel, on their People row (on hover) and in the header of the direct conversation with them, beside the panel button. It shows only while that person is online. The call's room is private: its `call.state` goes to the other person only, and a third member who learns the room's name is ignored. The caller sees the call bar with "Calling Sam…" until Sam joins or 30 seconds pass, then "No answer" with **Try again** and **Close**. If Sam declines, the bar reads "Sam declined" with the same two buttons. When the other person leaves a call with one person, the call ends on this Mac too, whether or not it had connected. During a call, the person it's with has no **Call**; **Call** for someone else, or **Join** on another ring, asks "Leave the call with Sam?" with **Leave and call** (or **Leave and join**) and **Cancel**. **Call** on someone who is ringing you joins their call.
5. **The ring card.** On the callee's Mac, on any screen, a card at the bottom right: the caller's face and name, the Circle's name, **Decline** and **Join**. It doesn't ring while the user is in another call; the caller sees "Sam is in another call". **Join** tells the caller, who then waits up to 60 seconds for Sam to arrive, so Sam has time to choose devices. If Sam has several Macs, all of them ring; joining on one stops the rest, and declining on one makes the caller cancel, which stops the rest. While Boundary's window isn't in front (another app is, or the window is hidden or minimized), a ring also shows a system notification, "Maya is calling" over "Book club · just you two", with **Answer** and **Decline**; bounces the Dock icon; and plays a ring, two soft chimes every three seconds, drawn in the app so no sound file ships. **Answer** brings the window forward and acts like **Join** on the card; **Decline** acts like the card's **Decline**; clicking the notification brings the window forward with the card showing. Each ring gets one notification. The ring stops, the bouncing stops and the notification is withdrawn when the ring ends (the caller cancels or stops, Sam answers on another Mac, declines, or the ring runs out) and when the window comes to the front. While the window is in front only the card shows.
6. **The join sheet.** Title "Join the call in General" or "Call Sam". A camera preview (or the user's initials when the camera is off), a microphone level meter, microphone and camera pickers, a camera switch that starts off, and **Join**. If macOS has denied a device: "Boundary can't use the microphone. Turn it on in System Settings › Privacy & Security." with **Open System Settings**, and **Join without microphone**.
7. **The call bar.** At the foot of the chat rail in every place: the call's name ("Book club · General" or "Sam"), a duration, mute, camera and **Leave**. Clicking its name opens the call view; opening it from another screen goes to Circles. Placing a call (**Join** in the sheet after **Call**, or **Try again**) and answering a ring (**Join** in the sheet) open the call view too, once the devices are open; switching from one call to another keeps it open. On other screens it floats at the bottom left with the same controls.
8. **The call view.** Tiles fill the main area: video, or the person's face and name with a speaking ring when their camera is off. Each tile marks muted people. A channel's call has the channel's chat beside the tiles in the compact thread. The controls sit under the tiles: mute, camera, devices, **Leave**, and **Back to chat**, which keeps the call going in the bar and, for a call with one person, opens the direct conversation with them. The view lives in the Circles screen's main area.
9. **Who can't be reached.** A person the device can't connect to shows as a tile with "Can't reach Priya from here" and **Try again**. The call goes on for everyone else.
10. **Over six.** From the seventh person, video is off for everyone joining after, and the view says "Video is on for up to 6 people. You joined with audio."
11. **Leaving a place mid-call.** Switching place or screen keeps the call. Leaving or being removed from the Circle ends it on that Mac. Quitting the app asks first while a call is live.

## Non-goals

- Screen sharing, recording, transcripts, captions.
- Agents in calls.
- A relay for members who have no Circles connection between them.
- Calls between people who share no Circle.
- Alerting for a ring while Boundary has no window. With the window closed (not hidden), the page that receives rings isn't running, so nothing on that Mac rings and the caller sees "No answer". Ring alerts cover a window that is in the background, hidden or minimized.

## Risks and open questions

- **Address discovery.** Decided in ADR 0044 §9: a public STUN server, which learns who calls when, and the Circles connection as the fallback path. Hyperswarm's view of the address never connected across networks.
- **Connection rate.** Any two members with a Circles connection can call. Members without one (both behind randomizing NATs) can't until the Circles connection gets a relay.
- **Thin links.** Below WebRTC's lowest bitrate, video loses packets instead of stepping down. A throttled hotspot lost more than half of tunnel video in phase 1.
- **Signal size and rate.** An offer with video can pass 4 KB, so it's compressed and split (ADR 0044 §1). Trickled candidates can arrive in bursts, and the send limit is 30 a second, so the call service batches them.
- **Mesh load.** Six people with video send five streams each. Phase 1 checks this on the slowest Mac and connection we have.
- **Ringing someone who's away.** A ring now alerts while the window is in the background, hidden or minimized, but not while Boundary has no window. macOS shows **Answer** and **Decline** as buttons only for alert-style notifications; with banners they sit under **Options**, and with notifications off for Boundary only the sound and the Dock remain.

## The public seam

The call service is generic, like the chat seam in the Circle chats spec.

**Main.** `call.*` signals relayed to and from the renderer that owns the call, and nothing else.

**Renderer.** `useCircleCall(circleKey)` returns the rooms with live calls in that Circle and who's in each (from `call.state`), and `join(room, { audio, video })`, which returns a call with `participants`, `localStream`, `remoteStreams`, `mute`, `camera`, `leave` and per-person connection state. `CallStage` renders tiles for a call and takes its call from props. A room is any string; the chat uses `channel/<id>` and random ids for calls with one person, and another screen can choose its own rooms and decide whom to connect to.

## Build order

**1 Transport check.** A spike on two and then three Macs on different networks: connection rate with host candidates only, with a public STUN server, and with candidates from Hyperswarm; session description sizes compressed and split; audio delay; six-way video on the slowest Mac. The outcome decides address discovery and confirms or changes the 6-person cap, recorded in ADR 0044.

**2 Call service.** The `call.*` topics, compression and parts, the renderer relay, the mesh with STUN and tunnel candidates (ADR 0044 §9), `call.state`, `useCircleCall` and `CallStage`. A unit test of the parts reassembly (missing part, repeat, out of order, too many parts), and a testnet case where three devices join a room and one leaves.

**3 Calls with one person.** The join sheet, the ring card, the call bar in the chat rail and floating, the call view without chat, **Call** on the person panel and People rows, quitting during a call, and the media permission states. Mounted tests for ring, decline, no answer and leave.

**4 Calls in channels.** **Call** and **Join** in the header, the `call` field on posts and edits (written in Circle chats phase 1), the call message, live marks in the rail, the switcher and the Chat icon, the call view with the compact thread, unreachable tiles, and the video cap.

**5 Calls settings.** Settings › **Calls**: default microphone and camera, camera on when joining, and what address discovery uses.

## Acceptance criteria

- [x] **1.** A call's media goes directly between members' Macs, and no call content or `call.state` enters the Circle's log.
- [x] **2.** A call setup signal from a device that isn't a current member of the Circle is dropped.
- [x] **3.** A session description larger than one signal arrives whole, and a part that never arrives fails the setup with a message instead of hanging.
- [x] **4.** The camera is off when joining unless Settings says otherwise, and macOS is asked about a device only when it's first used.
- [x] **5.** A user can join without a denied device, and the sheet links to System Settings.
- [x] **6.** A call keeps going across places and screens, and the call bar is visible on every screen.
- [x] **7.** A ring shows on any screen, stops after 30 seconds, and the caller sees "No answer".
- [ ] **8.** A channel's live call shows in the rail and the switcher's menu with who's in it, and disappears within 15 seconds of the last person leaving.
- [ ] **9.** The call message reads as started while live and as ended afterwards, with a length when the starter's device saw the end.
- [ ] **10.** Someone who can't be reached shows as such, and the call goes on for the others.
- [ ] **11.** The seventh person joins with audio only and is told why.
- [x] **12.** `CallStage` renders a call from props alone, and `useCircleCall` joins a room named by its caller.
- [x] **13.** A ring that arrives while the window isn't in front shows one notification with **Answer** and **Decline**, bounces the Dock and plays a ring that repeats, and all three stop when the ring ends or the window comes to the front. Nothing new happens while the window is in front.
- [x] **14.** Answering a ring and placing a call open the call view, in the Circles screen, from any screen.
