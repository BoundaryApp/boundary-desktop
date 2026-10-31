# Circles diagnostics

Every Boundary run writes what Circles do to `~/Library/Logs/Boundary/circles-diagnostics.log`, one JSON object per line. When the file passes 20 MB it moves to `circles-diagnostics.log.1` and a new one starts, so the two files hold the last 20–40 MB. **Show diagnostics file** on the Circles screen opens the folder in Finder.

The file holds metadata only: event names, counts, sizes, timings, status codes and model ids. People, devices and Circles appear as the first 8 hex characters of their keys, which are the same in both Macs' files. Peer addresses appear as a class (`loopback`, `lan`, `cgnat`, `link-local`, `public`, `ipv6`), never the IP. Names, invite codes, keys, prompts and replies are never written.

## Collecting a two-Mac run

1. Note the time on each Mac when you start, so the files can be lined up (`t` is UTC).
2. Run the test, and note the time of anything that looks wrong.
3. On each Mac, quit Boundary, then copy `circles-diagnostics.log` (and `.1` if it exists) and `boundary-debug.log` from `~/Library/Logs/Boundary/`. Name the copies by Mac.

## Fields on every line

| Field | Meaning |
| --- | --- |
| `t` | Wall-clock time (UTC) when the event happened. |
| `ms` | Milliseconds since this Boundary run started, for ordering within one file. |
| `run` | This run of Boundary; a new value means the app restarted. |
| `src` | `main` (the app) or `net` (the Circles network process). |
| `ev` | The event. |

A run starts with `run.start`: app version, whether it's packaged, Electron, macOS release, CPU count and memory.

## Events

**Network process** (`src: net`)

| Event | When |
| --- | --- |
| `net.ready` | The process is up: this identity and device. |
| `net.circles-open` | Stored Circles opened, with a first health record. |
| `net.heartbeat` | Every minute: event-loop lag, memory, each peer (replicating, channel, age, rtt, address class), each Circle (members online, offers, view and signed length, indexers), the gateway queue, the DHT's view (firewalled, randomized NAT), and peer signals since the run began: messages and bytes per topic this device sent or listens to, and drops by reason (`malformed`, `not-member`, `unknown-topic`, `rate`). Signals get no event of their own, because they can arrive several times a second. |
| `net.stopping` | A last health record before quitting. |
| `dht.nat-update`, `dht.network-change`, `dht.persistent` | The DHT learned its public address, the network changed, or this node became reachable. |
| `circle.topic-flushed` | A Circle's topic was announced; `ms` is how long that took. |
| `circle.state` | A Circle's members, offers, invites, writability or indexer status changed. |
| `circle.created`, `invite.created` | Created here. |
| `invite.admit` | An admin's device answered an invitee: `added`, `re-confirmed`, `revoked`, `used`, `expired`, `bad-intro`, `unknown-invite`. |
| `join.request`, `join.paired`, `join.writable`, `join.refused` | The invitee's side, with time since the request. |
| `peer.connect`, `peer.close`, `peer.error` | A connection. `peer.close` has its length, rtt, bytes and packets each way, and retransmits. |
| `peer.replicate`, `peer.drop-removed` | Replication started with a device, or a removed device was dropped. |
| `removal.notice-sent`, `removal.notice-ignored`, `circle.removed-here` | An admin told a device it was removed, a device ignored a notice from someone who isn't an admin, or this device closed a Circle it was removed from. |
| `link.attach`, `link.open`, `link.close`, `link.refused-unknown` | The inference channel to a device: who opened it, how long until both sides had it, requests made and served. |
| `offer.published`, `offer.withdrawn`, `share.upstream` | This user's sharing. |
| `shared.request`, `shared.head`, `shared.end`, `shared.cancel`, `shared.no-link` | The consumer's side of a shared-model call: time to head, time to first chunk, bytes, chunks, outcome. |
| `gateway.request`, `gateway.queued`, `gateway.start`, `gateway.upstream-head`, `gateway.done`, `gateway.failed`, `gateway.refused`, `gateway.cancel`, `gateway.drop-peer`, `gateway.models` | The provider's side: who asked, the request's shape (message and tool counts), time waiting in the queue, the model server's status and timings, bytes sent back, refusal reasons. |

**App** (`src: main`)

| Event | When |
| --- | --- |
| `main.net-forked`, `main.net-ready`, `main.net-exit`, `main.net-start-failed` | The network process's lifecycle. |
| `main.request` | Each call into the network process: its op, outcome and time. |
| `main.sharing-sync`, `main.away-blocker`, `main.provider-settings` | Sharing choices applied, sleep held or released, Private and Trusted changes. |
| `main.shared-request`, `main.shared-head`, `main.shared-end`, `main.shared-cancel`, `main.shared-refused` | A shared-model call as the router sees it. |
| `chain.plan` | Each time a chain is planned: every entry with its stale reason and privacy, and whether the result is direct, routed or refused. |
| `router.request` | Each model call through the router: session (8 characters), message and tool counts, requests already in flight per entry, the chain, each attempt's outcome and time, the entry that served, and whether it fell back. |
| `router.reply` | The served reply finished: bytes, time to first byte, and whether it ended, the upstream failed or the client hung up. |

## Following one message

A chat message answered by a shared model shows up on the consumer as `router.request`, `main.shared-request` and `shared.request`, then on the provider as `gateway.request`, `gateway.queued`, `gateway.start`, `gateway.upstream-head` and `gateway.done`, then on the consumer as `shared.head`, `shared.end`, `main.shared-end` and `router.reply`.

`shared.*` on the consumer and `gateway.*` on the provider share an `id` and the connection's device prefix: the consumer's `device` is the provider's device, and the provider's `device` is the consumer's. The `main.shared-*` events have the app's own `id`, so match them to `shared.*` by order and time.
