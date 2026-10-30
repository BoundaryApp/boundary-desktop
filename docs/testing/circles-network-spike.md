# Circles network spike check

Phase 0 of the [circles plan](../circles-plan.md) is done when a packaged, signed and notarized Boundary loads every native addon in its network process on a clean Mac, and two Macs on different networks replicate a Hypercore. These checks cover both. They need two Apple silicon Macs, at least one of which has never had a Boundary development checkout, on different networks (a home connection and a phone hotspot will do).

The network process starts only when `BOUNDARY_CIRCLES_SPIKE` is set at launch:

| Value | What the process does |
| --- | --- |
| `load` | Loads the addons, logs them, and stays idle. |
| `seed` | Also creates a Hypercore, appends one block each launch, logs its key and serves it. |
| a 64-character hex key | Also fetches that Hypercore from peers and logs each block. |

In `seed` and key modes, each connection also runs an unordered-message probe: both sides send 1,000 numbered 64-byte messages over `trySend`, 50 a second, and about 24 seconds after connecting each logs what arrived from the other.

Every report goes to the debug log, `~/Library/Logs/Boundary/boundary-debug.log`, as JSON lines with `"area":"circles-network"`. Follow them with:

```bash
tail -f ~/Library/Logs/Boundary/boundary-debug.log | grep '"area":"circles-network"'
```

The Hypercore lives in `~/Library/Application Support/Boundary/circles-spike/`. Delete that folder to start over.

When a step fails, note the step, what you saw and the time. If the app never opens, check the newest `Boundary-*.ips` or `Electron-*.ips` in `~/Library/Logs/DiagnosticReports` for "Code Signature Invalid" before anything else.

## 1. Build signed and notarized

1. With the Developer ID certificate in the keychain and `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` set, run `bun run dist:mac`.
2. Check the signature and the notarization ticket on the built app:

   ```bash
   codesign --verify --deep --strict --verbose=2 out/Boundary-darwin-arm64/Boundary.app
   ```

   ```bash
   spctl --assess --type execute --verbose=4 out/Boundary-darwin-arm64/Boundary.app
   ```

   - `codesign` ends with "satisfies its Designated Requirement". `spctl` says "accepted" and "source=Notarized Developer ID".
3. Check one addon's signature:

   ```bash
   codesign -dv --verbose=4 out/Boundary-darwin-arm64/Boundary.app/Contents/Resources/app.asar.unpacked/node_modules/rocksdb-native/prebuilds/darwin-arm64/rocksdb-native.node
   ```

   - It names the Developer ID authority and your team identifier, and shows `flags=0x10000(runtime)`.
4. List the unpacked addons:

   ```bash
   find out/Boundary-darwin-arm64/Boundary.app/Contents/Resources/app.asar.unpacked -name '*.node'
   ```

   - Among them are `sodium-native`, `udx-native`, `rocksdb-native`, `fs-native-extensions`, `quickbit-native` and `simdle-native`, each only under `prebuilds/darwin-arm64/`.

Fails if: `spctl` rejects the app, or any `.node` file is unsigned or signed by someone else.

## 2. The addons load on a clean Mac

1. Copy the DMG from step 1 to the clean Mac, install Boundary into Applications, and open it from Finder once. Quit it.
   - Gatekeeper opens it without a warning beyond the usual "downloaded from the Internet" prompt.
2. In Terminal on that Mac, start it with the spike in `load` mode:

   ```bash
   BOUNDARY_CIRCLES_SPIKE=load /Applications/Boundary.app/Contents/MacOS/Boundary
   ```

3. In a second Terminal window, follow the log as above.
   - A `forked` line, an `autobase ready` line with `"writable":true`, then `all native addons loaded` with `sodium-native`, `udx-native` and `rocksdb-native` in `loaded` and an empty `missing`.
   - Activity Monitor lists a process named **Boundary Circles Network**.
4. Quit Boundary from its menu.
   - The log shows `exited` with `"code":0`.

Fails if: the log shows `start failed` or `native addons missing`, the app quits on its own, or a crash report appears.

## 3. Two Macs replicate a Hypercore

1. On Mac A, start Boundary with `BOUNDARY_CIRCLES_SPIKE=seed` and follow the log.
   - `seeding hypercore` gives a `key` (64 hex characters) and a `length`, then `announced on topic`.
   - If macOS asks whether Boundary may accept incoming connections, allow it, and note that it asked.
2. Copy the key to Mac B, on the other network. Start Boundary there with `BOUNDARY_CIRCLES_SPIKE=<key>` and follow the log.
   - `looking for peers`, then `peer connected` within a minute, then one `block` line per block with text starting "Boundary circles spike block 0", then `replicated` with the same length as Mac A.
   - Mac A's log shows `peer connected` at about the same time.
   - About 24 seconds after `peer connected`, each Mac logs `unordered probe` with `sent`, `received`, `unique`, `lost`, `duplicates` and `outOfOrder`. Copy both lines into your notes: they are the loss and reordering on this path. Loss above zero is a result, not a failure.
3. Quit Boundary on Mac A, then start it again with `seed`.
   - Mac A logs a `length` one higher. Mac B, still running, logs `peer connected` again, the new `block`, and `replicated` with the new length.
4. Quit both.

Fails if: no `peer connected` line appears on either Mac after two minutes, Mac B's `replicated` length never matches Mac A's, or a connection that stays up for 30 seconds logs no `unordered probe` line. Note each network's type (home router, hotspot, office) and whether either side is behind a VPN, since hole punching depends on the NAT.

Boundary also writes Circles events to its own file on every run. [Circles diagnostics](circles-diagnostics.md) says what is in it and how to collect it from both Macs.
