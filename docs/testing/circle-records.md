# Circle formats and the wipe

Two Macs on the new build, each with Circles from an earlier build.

1. Update both Macs and open Circles on each. The old Circles are gone, your display name is still there, and **Sharing** keeps its models with no Circle selected.
2. Quit and reopen on one Mac. Nothing else disappears.
3. Create a Circle on one Mac and invite the other. The invite works and both list both people.
4. Share a model and send a message through it, to confirm a new Circle does what an old one did.
5. On a third install still on rc.11, try the same kind of invite. The join is refused.

## Models from wiped Circles

Run these on an install that had a shared model from an old Circle as its default. Run them once on an install updating from before the wipe, and once on an install that already wiped on rc.13.

1. Give it a fallback before updating. After the update, open Settings, Inference. The old model is gone from the app default list and from Fallbacks, the fallback is now the default, and a chat sends through it.
2. Repeat with no fallback and a connected provider. That provider is now the default.
3. Repeat with no fallback and no provider. Settings says no model provider is connected. A send stops and says no model is chosen and where to choose one.
4. Quit and reopen. Join a new Circle, make its shared model your default, then leave that Circle. The model stays selected with "You’re no longer in that Circle", and nothing clears it at the next start.
5. A project or chat with a fallback from an old Circle no longer lists it.

Nothing in the app writes Circle records yet, so `circleRecords.net.test.ts` covers them, and `circleUpgrade.net.test.ts` covers a Circle that stops for an update.
