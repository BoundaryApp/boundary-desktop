# 0038. Changing Circle operations after release

- Date: 2026-10-31
- Status: Accepted
- Related: [0032](0032-circles.md), [Autobase 7: builds that disagree](../circles-autobase-confirmation.md#builds-that-disagree)

## Context

`applyCircleNodes` runs on every peer and must give every peer the same view, and earlier builds skipped any operation they didn't know. On Autobase 7.28.2 that skip is permanent: a peer that skipped an indexed entry never applies it, even after it updates. An interrupted peer recovers in full once a newer build reopens the Circle.

Interrupting on any unknown operation would let one member stop everyone by appending junk.

## Decision

1. **Each Circle has a format,** kept in the view's `circle` entry. `CIRCLE_FORMAT` is the highest format a build can apply, and new Circles start at it.
2. **What an operation does at a format never changes,** because anyone joining replays the whole log. That covers validation limits such as `MAX_NAME`. `circleOps.golden.test.ts` pins format 1, and its file isn't updated to make a change pass.
3. **A later build adds or changes an operation behind a new format.** It raises `CIRCLE_FORMAT` and applies the new behaviour only when the view's format has reached it. Every build still skips the operation before then, so they agree.
4. **Only an admin's `set-format` moves a Circle,** one way, and a build that can't apply the new format stops with `host.interrupt`. An unknown operation is still skipped, so nothing a member appends can stop a peer.
5. **A stopped Circle** stays open and readable at what it last applied, refuses writes, and says on the Circles screen that the app needs updating. The next launch on a newer build continues from the entry that stopped it.
6. **An admin's device refuses a joiner** whose declared format is below the Circle's.
7. **Dependency updates count.** `autobase` and `hyperbee` are pinned exactly, and updating either needs the same care, since view blocks and signatures must match between builds.
8. **Circles from before this ADR are wiped once** at Circles start, keeping the identity, name, provider settings and sharing settings. Those builds skip what they don't know, and they have no format to raise.

No build moves a Circle's format yet; `CircleNetwork.setFormat` has no request or UI. The first change that needs format 2 decides when an admin's device sends it.

## Consequences

- An admin who hasn't updated holds up confirmation wherever they're needed for a majority: in a two-admin Circle, entries stay unconfirmed until they update.
- Stopping can happen on an entry whose order isn't final. If a reorder cancels it, such as the admin having been demoted first, the next launch continues past it.
- An rc.11 install can still create Circles. A newer build that joins one finds a `create` with no format, skips it, and stays in the Circle with nothing in its view.
- Adding an operation costs a format and a two-sided release, so a feature that can live in an existing operation, such as a [Circle record](../circles-plan.md#circle-records), should.
