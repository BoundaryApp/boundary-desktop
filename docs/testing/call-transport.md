# Call transport check

Phase 1 of the [Circle calls spec](../circle-calls-ux-study/spec.md). Its results decide how calls find each Mac's address and whether video stays capped at 6 people, and they get recorded in [ADR 0044](../adr/0044-circle-calls.md).

Each run makes real WebRTC connections between two members, set up over peer signals, in five modes:

| Mode | How each Mac learns addresses |
| --- | --- |
| **Local addresses** | Only its own. Connects on one network, and across networks only where nothing in the way blocks it. |
| **STUN server** | Asks `stun.cloudflare.com`, which learns both Macs' public addresses and when they checked. |
| **Hyperswarm address** | Uses the address the Circles network already knows, on the call's own port. Works only where the router keeps that port. |
| **Circles tunnel** | None. Each Mac's WebRTC sends to a UDP port on `127.0.0.1` that the Circles network opens, and the packets cross the existing Circles connection. Connects wherever the Circles connection does. |
| **STUN, then tunnel** | The STUN server's addresses plus the tunnel, at the lowest priority. A direct path wins when one works; otherwise the call goes through the tunnel. |

The media is a quiet tone and a moving test picture, so no camera or microphone is used and macOS asks for nothing. Results hold numbers and fixed words only. They show in the sheet and go to `circles-diagnostics.log` as `call.check` events, so they're safe to paste.

Each run can be one of three kinds:

| Button | What it does | Time |
| --- | --- | --- |
| **Check connection** | One audio connection in each of the five modes, one after another. | About a minute |
| **Video load (5 streams)** | Five connections with video both ways at once, the load of a six-person call, in the mode picked under **Mode for video runs**. | About 25 seconds |
| **Long call (3 min)** | One connection with video both ways, held for three minutes, in that same mode. Shows whether a call stays up, and whether it moves between the tunnel and a direct path. | About 3 minutes |

Video and long runs take a sample every 5 seconds and log each one as a `call.sample` event.

## Setup

Every Mac in a run needs a build with the check (the first release after it merged) and must be in the same Circle, online. The check is off unless the app starts with `BOUNDARY_CALLS_CHECK=1`, so on each Mac quit Boundary, then start it from Terminal:

```bash
BOUNDARY_CALLS_CHECK=1 /Applications/Boundary.app/Contents/MacOS/Boundary
```

A build with another app name has its own path under `/Applications`; use that instead. Leave the Terminal window open while you test, since closing it quits the app.

To check the flag took, open the Circle in the chat, press the panel button in the header, and look for **Call check…** at the foot of the Circle tab. A Mac without it doesn't answer offers.

Type each Mac's network into **This Mac's network** at the top of the sheet, for example "home Wi-Fi" or "phone hotspot". It goes only into that Mac's exported report and names the file. Change it whenever the Mac moves to another network, and export first.

## Two Macs on different networks

Put one Mac on home Wi-Fi and the other on a phone hotspot, or anywhere else that isn't the same network.

1. On the first Mac, open **Call check…**, pick the other person and press **Check connection**. It takes about a minute and adds five rows, one per mode. The other Mac adds five rows of its own, as `answerer`, in its sheet.
2. Press it twice more, so each mode has three tries.
3. Run the same from the second Mac, since some routers behave differently in each direction.
4. On the slower Mac, set **Mode for video runs** to **Circles tunnel** and press **Video load (5 streams)**. Leave both Macs alone while it runs. Repeat it with each other mode that connected in steps 1 to 3.
5. With **Mode for video runs** on **Circles tunnel**, press **Long call (3 min)**. Then set it to **STUN, then tunnel** and press it again.
6. On both Macs press **Export report…** and save the file. Send both files.

The export is the thing to keep. **Copy results** copies the sheet's rows only.

## Two Macs on one network

Put both on the same Wi-Fi, change **This Mac's network** on both, and repeat steps 1, 4 (tunnel only) and 6. This is the baseline: **Local addresses** should connect here.

## Three Macs

With a third Mac on a third network if you can, run **Check connection** from each Mac to each of the other two, so every pair is tried from both ends.

## Forcing a call onto the tunnel

**Join test call** always offers the STUN server with the tunnel at the lowest priority, so on most networks it connects directly and the tunnel sits idle. To see a call fall back, take the STUN server away by pointing its name at this Mac:

```bash
echo "127.0.0.1 stun.cloudflare.com" | sudo tee -a /etc/hosts
```

One Mac is enough: with no server-reflexive address on one side, the pair has nothing to connect to. Quit Boundary and start it again with the flag, so Chromium drops the name it cached, then run **Check connection**. **STUN server** should now fail and **Circles tunnel** pass. Gathering takes its full 5 seconds on the blocked Mac, against about 120 ms when the server answers, so these runs are slower.

If STUN still connects, Chromium resolved around the hosts file. Block the port instead, which also catches a server reached by address:

```bash
cat /etc/pf.conf > /tmp/stun-block.conf
echo "block drop out quick proto udp to any port 3478" >> /tmp/stun-block.conf
sudo pfctl -E -f /tmp/stun-block.conf
```

That blocks port 3478 for every app on the Mac. Afterwards, remove the line from `/etc/hosts` and, if you used the packet filter, `sudo pfctl -f /etc/pf.conf && sudo pfctl -d`.

## Test call

The sheet's **Test call** joins a real call, with the camera and microphone, with everyone in the Circle who presses it. It uses the call service the call screens will use: a STUN server for addresses, then the Circles connection when no direct path works. macOS asks for the microphone and camera the first time.

1. On two Macs, ideally on different networks, open **Call check…** and press **Join test call** on both.
2. Each Mac shows a tile for itself and one for the other person, with video both ways once connected. Talk for a minute and listen for echo or gaps.
3. Press **Mute** on one Mac: the other shows **Muted** on that tile. Press **Camera off**: the other shows that person's face instead of video.
4. Add a third Mac if you can, and check every Mac shows everyone.
5. Press **Leave** on one Mac, or close its sheet. The others drop that tile at once. Quit the app on one Mac instead, and the others drop its tile within 15 seconds.

A tile that reads "Can't reach … from here" means no path worked; press **Try again** once, and note the networks if it stays.

Each connection in a call writes a `call.connect` line when it connects and a `call.end` line when it ends, to the same diagnostics file as the check. `call.connect` has the path (`direct` or `tunnel`), the candidate types, `role` (whether this Mac offered or answered), `ms` to connect and `rttMs`. `call.end` has the call's length in `seconds`, the path at the end, `pathSwitches`, and loss, bitrate each way and video freezes over the call. Both carry only short session and identity prefixes:

```bash
grep -hE '"ev":"call\.(connect|end)"' ~/Library/Logs/Boundary/circles-diagnostics.log* | tail -20
```

## What to look for

- **Result**: `host → host`, `srflx → host` and so on name the kinds of address the connection used. `Failed at answer` means the other Mac never answered (check its flag). `Failed at ice` means both Macs had each other's addresses and still couldn't reach each other, which is what a relay would fix.
- **(tunnel)** or **(direct)** after the result, in the two tunnel modes: whether the connection ended on the tunnel or a direct path. `Failed at tunnel` means this Mac couldn't open its tunnel port, usually because the Circles connection to that member was down.
- **Connect**: time from sending the offer to connected.
- **Round trip** and **Audio delay**: audio delay is half the round trip plus how long the receiver buffers audio. Under 150 ms is comfortable for talking.
- **Parts**: how many signals the session description needed after compression. More than 1 is fine.
- **Video fps** on the load run: frames sent / received per stream. Near 30 / 30 means the Mac kept up. A `(cpu)` or `(bandwidth)` after it says what held sending back.
- **ICE checks**: connectivity checks answered / sent, across every address pair ICE tried. A failed row uses the last reading taken while ICE was still trying, because the failed pairs leave WebRTC's stats once it gives up. `0 / 40` on a failed row means no check ever came back on any path, so packets were blocked or never reached the other Mac. A failed row with answers means some path worked one way but ICE still gave up.
- **Loss**: inbound packets lost over the measured window.
- **Tunnel counts**, in the copied results and the report only: `tunnelMtu` is the Circles connection's largest packet, `tunnelPackets` what crossed the tunnel each way, `tunnelSplit` packets sent as two halves because they didn't fit one, and `tunnelDropped` packets lost inside the tunnel (a half that never arrived, or one that arrived before WebRTC had sent anything).

## What the report holds

**Export report…** writes one JSON file per Mac, by default on the Desktop:

- this Mac's app version, Electron and Chrome versions, macOS version, model, chip, cores and memory;
- the network label;
- every row in the sheet;
- every Circles diagnostics event from this launch of the app.

Those events include each result and sample, plus:

- `call.tunnel-sample` every 5 seconds while a tunnel is open: the Circles process's timer lag, CPU, memory and per-peer tunnel counts;
- the DHT's view of the network (`dht.nat-update`);
- Circles connections opening and closing (`peer.connect`, `peer.close`);
- the minute heartbeat (`net.heartbeat`) with memory and per-Circle counts.

Each result also carries:

- what ICE tried (candidates on each side by type, pairs by outcome, checks sent, answered and received);
- media quality over the run (loss, jitter, bitrate each way, available bandwidth, dropped frames, freezes, repair requests, concealed audio);
- how often the call changed path;
- CPU use by process kind (main, renderer, GPU, utility processes);
- the DHT's view of this Mac's network (firewalled, randomizing NAT);
- the Circles connection to that member (address class, round trip, retransmits, MTU, age).

The report holds metadata only: no addresses, names, keys or message text. Results from both Macs match on their 8-character `run` id, which the log's `call.check` and `call.sample` lines carry as `check`, since a log line's own `run` names the app launch. Events carry wall-clock times in `t`, and a sample's seconds since it connected are in `atS`.

## Logs

The same results are in each Mac's diagnostics file, with the app's CPU use at the moment each arrived. A build with another app name keeps it under `~/Library/Logs/<app name>/` instead:

```bash
grep -h '"ev":"call.check"' ~/Library/Logs/Boundary/circles-diagnostics.log* | tail -40
```

Samples and tunnel samples:

```bash
grep -hE '"ev":"call\.(sample|tunnel-sample)"' ~/Library/Logs/Boundary/circles-diagnostics.log* | tail -40
```

The DHT's view of each network, which helps explain the **Hyperswarm address** mode:

```bash
grep -h '"ev":"dht.nat-update"' ~/Library/Logs/Boundary/circles-diagnostics.log* | tail -5
```

These commands print metadata only, so their output is safe to share.

## Calls with one person

Phase 3 of the [Circle calls spec](../circle-calls-ux-study/spec.md). These steps need no `BOUNDARY_CALLS_CHECK`; start both Macs normally. Both Macs need a build with calls with one person, must be in the same Circle, online, and on different networks (for example home Wi-Fi and a phone hotspot). Call them Mac A and Mac B, and sign in as different people.

After the steps that connect or end a call, read what the call logged:

```bash
grep -hE '"ev":"call\.(connect|end)"' ~/Library/Logs/Boundary/circles-diagnostics.log* | tail -20
```

For a build with another name, use its name in place of `Boundary`. The lines hold paths, timings and counts only.

Steps 13 to 16 also read what the ring alerts logged on the Mac being called:

```bash
grep -h '"area":"calls"' ~/Library/Logs/Boundary/boundary-debug.log* | grep '"message":"ring ' | tail -20
```

Each line is `ring notified` (with how many notifications it showed), `ring alert started` or `ring alert stopped` (with whether the window was in front), and counts only: no rooms or names. Before those steps, allow notifications for Boundary in System Settings › Notifications on Mac B, turn off Focus, and set the alert style to **Alerts** so **Answer** and **Decline** show as buttons (with **Banners** they sit under **Options**).

1. On Mac A, open Mac B's person panel and press **Call**. The join sheet opens and macOS asks for the microphone, not the camera. The camera switch is off. Press **Join**. The call view opens in the Circles screen's main area, and Mac A's call bar reads "Calling Sam…" (with Mac B's person's name).
2. On Mac B, on the **Settings** screen, a ring card appears at the bottom right with the caller's name, the Circle's name, **Decline** and **Join**. Press **Decline**. The card goes. On Mac A the call view closes and the bar reads "{name} declined" with **Try again** and **Close**. Press **Try again**: the call view opens again.
3. On Mac B, switch to **Chat**. The card appears there too. Leave it alone for 30 seconds. The card goes, and Mac A's bar reads "No answer" with **Try again** and **Close**. Press **Close**.
4. Call again from Mac A's People row (hover the row, press **Call**), and on Mac B press **Join** on the ring card. The join sheet opens on Mac B with the level meter moving when you speak. Turn the camera switch on: macOS asks for the camera and a preview shows. Press **Join**. Mac B goes to the Circles screen with the call view open. Within a few seconds both bars show a running time, and each side hears the other. The camera starts off in the sheet each time. Run the log command. It lists a `call.connect` line on each Mac with the path and setup time.
5. Call again. On Mac B press **Join** on the ring card, then leave the sheet open for 40 seconds before pressing **Join** in it. Mac A's bar keeps reading "Calling Sam…" past the usual 30 seconds, and the call connects when Mac B joins. Press **Leave** on Mac B. Mac A's call ends too, and the log shows a `call.end` line on both Macs.
6. While Mac B is in a call with a third member, call Mac B from Mac A. Mac B shows no ring card, and Mac A's bar reads "{name} is in another call".
   Then end the third member's call, open the join sheet for each other on Mac A and Mac B, and press **Join** on both at the same moment (count down together). Neither bar reads "is in another call" and neither Mac shows a ring card. Within a few seconds both bars show a running time in one call.
7. With Mac B's person signed in on a second Mac as well (Mac C), call from Mac A. Both Mac B and Mac C show the ring card. Press **Join** on Mac B. The card on Mac C goes within about 12 seconds, and the call connects on Mac B only. Repeat with Boundary in the background on Mac C: its notification is withdrawn and its ring and Dock bouncing stop within about 12 seconds of Mac B joining. Call again and press **Decline** on Mac C: Mac A's call is cancelled and Mac B's card goes.
8. In a call, press **Mute**: it becomes **Unmute**, and the other Mac shows the muted mark on your tile. Press **Camera on**: the other Mac shows your video. Press **Devices** in the call view and pick another microphone; the other side keeps hearing you. Press **Camera off**.
9. Move through the app's screens during a call. The call bar is at the foot of the chat rail and the Circles rail where they show, and floats at the bottom left on the other screens, with **Mute**, **Camera on** and **Leave** each time. Click the name in the bar: the call view opens in the Circles screen's main area, with the tiles, "Call · 2 people · 4:12 · nothing is recorded or kept" (with the real time) and the controls under them. Press **Back to chat**: the direct conversation with the other person opens, and the call keeps going in the bar. Open the direct conversation header and check that **Call** is there when no call is on, beside the panel button.
10. In a call, have the other person press **Leave**. Your call ends within a few seconds, and your bar goes.
11. In a call, press Command-Q. A dialog reads "You're in a call" and "Quitting leaves it.", with **Quit** and **Cancel**. Press **Cancel**: the app and the call stay. Press Command-Q again and **Quit**: the app quits and the other Mac's call ends. Start Boundary again, and no dialog appears when you quit with no call.
12. Run the denied-device steps of [media access](media-access.md) on Mac A so the microphone is denied, then call Mac B. The sheet shows "Boundary can't use the microphone. Turn it on in System Settings › Privacy & Security." with **Open System Settings** (it opens the Microphone pane) and **Join** reads **Join without microphone**. Press it: the call connects without a microphone. Repeat with the camera denied: turning the camera on shows the same line with "camera", and the switch goes back to off.

13. On Mac B, click another app (Finder) so Boundary is in the background but its window is still showing. Call Mac B from Mac A. On Mac B a notification appears, "{name} is calling" over "{Circle} · just you two"; the Dock icon bounces; and a ring of two soft chimes plays every three seconds. Wait 15 seconds: no second notification appears, though Mac A rings again every 5 seconds. Press **Answer** on the notification. Boundary comes to the front with the join sheet "Call {name}" open and no ring card; the ring and the bouncing stop. Press **Join**: the call view opens and the call connects. Leave. Run the ring alert log command: one `ring notified` with `shown` 1, one `ring alert started` and one `ring alert stopped`.
14. Put Boundary in the background on Mac B again and call from Mac A. Press **Decline** on the notification. Boundary stays in the background, the ring and the bouncing stop, the notification goes from Notification Center, and Mac A's bar reads "{name} declined". Call again and click the notification's text instead of a button: Boundary comes forward with the ring card showing, and the ring stops.
15. On Mac B, hide Boundary with Command-H and call from Mac A: the notification, the ring and the bouncing start. Press **Leave** on Mac A while it rings: on Mac B the ring and the bouncing stop at once and the notification goes from Notification Center. Then minimize Boundary's window on Mac B, call again and let it ring out: everything stops 30 seconds after the ring started, and Mac A reads "No answer". Do the same once with the window closed by the red button while **Keep the agent button on the desktop** is on (the window hides and keeps running): the ring alerts the same way. Run the log command and send the lines.
16. With Boundary's window in front on Mac B, call from Mac A. Only the ring card shows: no notification, no ring and no bouncing. While the card shows, switch to another app: the notification appears and the ring starts. Switch back to Boundary: the ring stops and the notification goes, and the card is still there. Switch away again: the ring starts, with no second notification. Press **Decline** on the card.
17. From the **Chat** screen on Mac A, open the direct conversation with Mac B's person and press **Call**, then **Join** in the sheet. Boundary goes to the Circles screen with the call view open. On Mac B, join from the ring card while on **Settings**: Mac B goes to the Circles screen with the call view open too.

Send the log lines of step 4 from both Macs and of steps 13 and 15 from Mac B, and which steps differ from what is written here.
