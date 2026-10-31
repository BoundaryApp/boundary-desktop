# Autobase 7: writers' entries while no indexer is online

[ADR 0032](adr/0032-circles.md) §7 says Boundary marks a Circle's entries unconfirmed until an admin's device indexes them, and leaves Autobase's behaviour to be checked in phase 0 of the [circles plan](circles-plan.md). This is that check, read from `autobase` 7.28.2's README and source (`node_modules/autobase`), then run on a Circle over a local HyperDHT testnet (see the end of this page).

## What a writer's entry does with no indexer online

A writer appends to its own Hypercore whether or not any indexer is online. Every peer that has the block adds it to the linearizer's tip (`lib/linearizer.js`, `addHead`: `this.tip.add(node)`), and only indexer nodes feed the consensus (`if (node.writer.isActiveIndexer) this.consensus.addHead(node)`).

The view applies tip nodes straight away. `ApplyState.update` (`lib/apply-state.js`) walks the indexed nodes and then the tip, and calls the `apply` handler for both. Each entry it passes carries `indexed: false` when it came from the tip. So members see each other's entries in the view while every admin is offline, with nothing ordered for good.

Those entries can move. When new causal information arrives, Autobase undoes the view back to the last indexed point and reapplies in the new order (`if (u.undo) await this.undo(u.undo)`). The README's "Reordering" section says the same: changes to the view "will be undone and reapplied on top of the new ordering".

## What confirms an entry

An entry is ordered for good once a **majority of indexers** have acknowledged it. `Consensus` sets `this.majority = (indexers.length >>> 1) + 1` (`lib/consensus.js`), and `_isConfirmed` returns false until that many indexers have acked. Indexers ack by appending, either their own entries or `null` ack nodes: `base.ack()` is indexer-only, and an indexer with a local writer runs an ack timer (`DEFAULT_ACK_INTERVAL = 10_000` ms in `index.js`) and acks sooner after 4 updates in which it appended nothing itself (`DEFAULT_ACK_THRESHOLD`, `_triggerAckAsap`).

Past that point, `base.signedLength` gives the length of the system core that a quorum of indexers has signed; the README says "the system up until this point will not change". Each view core has its own `signedLength` (`lib/store.js`, `listViews`).

## What this means for Circles

- **One admin online is not always enough.** With one or two admins, one online admin is a majority. With three or four it takes two; with five, three. ADR 0032 §7 says "until an admin's device indexes them", which holds only for Circles with one or two admins.
- **Marking unconfirmed entries.** For a view block, compare its index with the view core's `signedLength`: blocks at or past it are unconfirmed. The `indexed` flag in `apply` says the same for the nodes being applied, but a view built by `apply` has to record it itself, and must stay deterministic (README: the view may only be derived from the `open` store).
- **Order can change.** The UI should not treat an unconfirmed entry's position as final, such as numbering messages or anchoring replies by position, until it is confirmed.
- **Unconfirmed entries survive restarts.** They sit in each writer's own Hypercore, so a member who restarts still has them, and they replicate to anyone online.

## On a Circle with three admins

`src/main/services/circles/__tests__/circleConfirmation.net.test.ts` (part of `bun run test:circles`) runs four people on a testnet: three admins and a member. With two admins offline, an invite the online admin writes reaches the member's view at once, and the view's `signedLength` on both sides is still short of it at that point. The check reads it once rather than watching it over time. When a second admin restarts from disk and reconnects, the entry is confirmed on both sides, and the restarted admin still has everything it held before.

The run also showed something the source reading missed. **Promoting a member to admin does not make their device an active indexer straight away.** The system view lists it as an indexer at once, but Autobase only makes it active after that device acks while online. If promoted admins go offline before that, the indexer set changes in steps when they come back. In one such run the active set reached two indexers, the restarted admin's device was not one of them, and nothing was confirmed for two minutes while the other promoted admin stayed offline. `CircleNetwork.confirmation()` reports whether this device is an active indexer, and the check waits for all three before taking any offline.

At the 10-second ack interval Boundary uses, over three runs, a promoted admin's device took 31 to 41 seconds to become an active indexer, and an entry took 29 to 54 seconds to be confirmed after the second admin came back. Autobase pushes its ack timer back on every update (`lib/timer.js`, `bump`), so a busy Circle acks later rather than sooner.

For phase 5 this means an unconfirmed mark can show for close to a minute in normal use. A newly promoted admin should also count as an admin for confirmation only once their device is an active indexer.

## Builds that disagree

Two peers on Autobase 7.28.2, one whose `apply` knew an operation and one whose `apply` didn't, replicating over a pipe. `circleUpgrade.net.test.ts` repeats the stopping cases on a testnet.

When the older peer skips the entry, the linearizer still agrees: both reach the same `indexedLength`, because order doesn't depend on `apply`. The views don't agree. With both as indexers, `signedLength` stops on the view and both sides log `INVALID_SIGNATURE`, and a new peer joining logs it too. With the older peer as a member, its view is wrong with no warning, and the admin carries on normally. Reopening the older peer on the newer build fixes neither case, because the indexed entry is never applied again.

When the older peer calls `host.interrupt` on the entry, it stops there. Reopened on the newer build, it applies the entry and the views match, and signing resumes when it's an indexer. An interrupted indexer stops acking, so it counts against the majority above until then. The README says an interrupt closes the Autobase; in 7.28.2 `base.closed` stays false, the view stays readable, and `append` throws.

[ADR 0038](adr/0038-changing-circle-operations.md) is the rule built on this.
