# Shared folders: what the pinned modules do

[ADR 0049](adr/0049-shared-folders.md) left three questions about the modules for before the first phase. These answers come from `src/main/services/circles/__tests__/sharedFolderModules.net.test.ts` (part of `bun run test:circles`), run against `hypercore` 11.39.6, `autobase` 7.28.2 and `hyperblobs` 2.13.0 on macOS. Peers replicate over piped Corestore streams, the same `store.replicate` a swarm connection uses, without a testnet.

## Blobs replicate sparsely

A device that opens another device's blob core by key downloads only the blocks it reads. After reading the second of three 200 KB blobs, `core.has` reports that blob's blocks held and the other two's not. `core.clear` drops a blob's blocks from local storage, and reading it again downloads it again from a peer that has it. Decision 11 holds: a member's Mac downloads the current version of each file and older versions only when someone opens them.

When no connected peer holds a block, `blobs.get(id, { wait: false })` returns `null` at once. That is how the history panel can say a version is only on an offline member's Mac without waiting on a timeout.

Sparse replication also means a peer passes on only the blocks it holds. In `sharedFolders.net.test.ts`, an editor's change reaches a reader connected only to the manager as a new entry in the view at once, but its contents can't be read there until the manager has downloaded them. So every member's device downloads current versions as the view changes (`SharedFolders.downloadCurrent`), and a change is only on its author's Mac until someone else's has fetched it.

Blob cores need their own encryption. Autobase encrypts the folder's log and view, but a blob core is a plain Hypercore. Opened with `encryption: { key }`, its blocks are encrypted, and a device that has the core's key but not the encryption key reads only ciphertext. Each device's blob core should use the folder's encryption key, so the record that carries the folder's keys (decision 3) is enough to read it.

## Writers added and removed from `apply`

`host.addWriter(key, { indexer: false })` makes a device an editor: it becomes writable without becoming an indexer, and its entries reach the manager's view. `host.removeable(key)` is false for the only indexer, so a folder's last manager can't be removed, and an `apply` that checks it skips the operation.

A removed editor can't slip writes in while offline. In the test the editor goes offline, the manager removes it and writes again, and the editor, still writable as far as it knows, writes a file. When they reconnect, the editor stops being writable, its earlier write stays in the view, and the write it made after going offline is applied on neither side. Both views end up the same. This covers one interleaving: the removal and the offline write were concurrent, and neither device had seen the other's.

[Autobase 7: writers' entries while no indexer is online](circles-autobase-confirmation.md) still applies to managers: a majority of indexers confirms an entry, and a newly promoted indexer becomes active only after it acks while online.

## The file watcher

Node's `fs.watch(root, { recursive: true })` uses FSEvents on macOS and needs no added dependency. It reports a new file, a save by writing a temporary file and renaming it over the original, a change in place, a rename, a file in a new subfolder, and a delete, each by a path relative to the root with `/` separators.

The event type doesn't say what happened. Creates, deletes, renames and saves all arrive as `rename`, and one save can produce several events for the same path. The watcher also reported the root folder's own name once. So the mirror treats each event as a path to look at: it stats the path, hashes the file if it exists, and compares the hash with the view, after the file has been quiet for two seconds (decision 8).

`fs.watch` doesn't report what changed while Boundary was closed, and Node doesn't expose FSEvents' flag for dropped events. The mirror therefore scans the whole folder against the view when it opens, and again every 10 minutes while it runs (a starting value, to tune once real folders exist), so a missed event costs a delay rather than a lost change.
