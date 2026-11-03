# Call transport check

Phase 1 of the [Circle calls spec](../circle-calls-ux-study/spec.md). Its results decide how calls find each Mac's address and whether video stays capped at 6 people, and they get recorded in [ADR 0044](../adr/0044-circle-calls.md).

Each run makes real WebRTC connections between two members, set up over peer signals, in three modes:

| Mode | How each Mac learns addresses |
| --- | --- |
| **Local addresses** | Only its own. Connects on one network, and across networks only where nothing in the way blocks it. |
| **STUN server** | Asks `stun.cloudflare.com`, which learns both Macs' public addresses and when they checked. |
| **Hyperswarm address** | Uses the address the Circles network already knows, on the call's own port. Works only where the router keeps that port. |

The media is a quiet tone and a moving test picture, so no camera or microphone is used and macOS asks for nothing. Results hold numbers and fixed words only. They show in the sheet and go to `circles-diagnostics.log` as `call.check` events, so they're safe to paste.

## Setup

Every Mac in a run needs a build with the check (the first release after it merged) and must be in the same Circle, online. The check is off unless the app starts with `BOUNDARY_CALLS_CHECK=1`, so on each Mac quit Boundary, then start it from Terminal:

```bash
BOUNDARY_CALLS_CHECK=1 /Applications/Boundary.app/Contents/MacOS/Boundary
```

A build with another app name has its own path under `/Applications`; use that instead. Leave the Terminal window open while you test, since closing it quits the app.

To check the flag took, open the Circle in the chat, press the panel button in the header, and look for **Call check…** at the foot of the Circle tab. A Mac without it doesn't answer offers.

Note each network as you go, for example "home Wi-Fi", "phone hotspot", "office". Also note each Mac's model, because the load run measures the slowest one.

## Two Macs on different networks

Put one Mac on home Wi-Fi and the other on a phone hotspot, or anywhere else that isn't the same network.

1. On the first Mac, open **Call check…**, pick the other person and press **Check connection**. It takes about 30 seconds and adds three rows, one per mode. The other Mac adds three rows of its own, as `answerer`, in its sheet.
2. Press it twice more, so each mode has three tries.
3. Run the same from the second Mac, since some routers behave differently in each direction.
4. On the slowest Mac, set **Video load mode** to a mode that connected and press **Video load (5 streams)**. It takes about 25 seconds and sends five video streams each way, the load of a six-person call. Leave both Macs alone while it runs.
5. On both Macs press **Copy results** and paste them into a note, labelled with the Mac and its network.

## Two Macs on one network

Put both on the same Wi-Fi and repeat steps 1 and 4. This is the baseline: **Local addresses** should connect here.

## Three Macs

With a third Mac on a third network if you can, run **Check connection** from each Mac to each of the other two, so every pair is tried from both ends.

## What to look for

- **Result**: `host → host`, `srflx → host` and so on name the kinds of address the connection used. `Failed at answer` means the other Mac never answered (check its flag). `Failed at ice` means both Macs had each other's addresses and still couldn't reach each other, which is what a relay would fix.
- **Connect**: time from sending the offer to connected.
- **Round trip** and **Audio delay**: audio delay is half the round trip plus how long the receiver buffers audio. Under 150 ms is comfortable for talking.
- **Parts**: how many signals the session description needed after compression. More than 1 is fine.
- **Video fps** on the load run: frames sent / received per stream. Near 30 / 30 means the Mac kept up. A `(cpu)` or `(bandwidth)` after it says what held sending back.

## Logs

The same results are in each Mac's diagnostics file, with the app's CPU use at the moment each arrived:

```bash
grep -h '"ev":"call.check"' ~/Library/Logs/Boundary/circles-diagnostics.log* | tail -40
```

The DHT's view of each network, which helps explain the **Hyperswarm address** mode:

```bash
grep -h '"ev":"dht.nat-update"' ~/Library/Logs/Boundary/circles-diagnostics.log* | tail -5
```

Both commands print metadata only, so their output is safe to share.
