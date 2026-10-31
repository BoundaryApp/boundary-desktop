# Circle formats and the wipe

Two Macs on the new build, each with Circles from an earlier build.

1. Update both Macs and open Circles on each. The old Circles are gone, your display name is still there, and **Share your models** keeps its models with no Circle selected.
2. Quit and reopen on one Mac. Nothing else disappears.
3. Create a Circle on one Mac and invite the other. The invite works and both list both people.
4. Share a model and send a message through it, to confirm a new Circle does what an old one did.
5. On a third install still on rc.11, try the same kind of invite. The join is refused.

Nothing in the app writes Circle records yet, so `circleRecords.net.test.ts` covers them, and `circleUpgrade.net.test.ts` covers a Circle that stops for an update.
