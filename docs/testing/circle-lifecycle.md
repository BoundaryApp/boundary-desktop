# Circle lifecycle

Two Macs and a new Circle. The admin creates it; the other Mac is the member. Do the steps in order, because each leaves the Circle ready for the next. Note the time of anything that looks wrong; [Circles diagnostics](circles-diagnostics.md) says what to collect.

## Invites

1. On the admin, press **Invite someone** and join with the code on the member. Each sees the other online.
2. The code disappears from the admin's panel once it's used, and **Open invites** doesn't list it.

## Leaving and joining again

3. On the member, press **Leave** and confirm. The Circle leaves the member's screen, and the admin's member list drops to one.
4. Create a new invite and join with it on the member. The join finishes within 60 seconds.
5. On the member, tick a model and turn on **Share with** if it has a local model, or skip to step 6. The admin sees the offer.
6. Quit and reopen Boundary on the member. The Circle is still there, and the member shows as online on both Macs.

A `join.not-writable` line in `circles-diagnostics.log` during step 4 is a failure.

## Leaving while the admin is offline

7. Quit Boundary on the admin. On the member, press **Leave** and confirm. The Circle leaves the member's screen, and the place switcher's menu lists "Leaving" with the Circle's name and "Finishes when an admin is online".
8. Quit and reopen Boundary on the member. The "Leaving" row is still there.
9. Open Boundary on the admin, with the member's Boundary still open. Within a few seconds the admin's member list drops to one, the admin gets a notification that the member left the Circle, and the "Leaving" row goes from the member's place switcher. A `member.left` line in the admin's `circles-diagnostics.log` and a `circle.left` line in the member's show that each side finished.
10. Invite the member back for the next section.

## Removing a member

11. On the admin, press **Remove** next to the member and confirm. The sheet says what they've received stays with them. The Circle leaves the member's screen within a few seconds.
12. Invite the member back, then quit Boundary on the member.
13. On the admin, remove the member, then reopen Boundary on the member. The Circle leaves the member's screen once they connect, and doesn't return after another relaunch.

## Changing roles

14. Invite the member back and press **Make admin**. The member can now press **Invite someone**. They create a code and don't use it.
15. On the first Mac, press **Make member** on that person. The unused code stops working: joining with it from a third install, or after the member leaves, is refused.
16. On the first Mac, press **Leave** while it is the only admin. The sheet shows "The last admin can't leave. Make someone else an admin first." and the Circle stays.

## Deleting a Circle

17. With the member still in the Circle, the admin's card shows **Leave**, not **Delete Circle**.
18. Remove the member. The admin's card now shows **Delete Circle**, not **Leave**.
19. Create a second Circle on the admin, to check that deleting leaves it alone.
20. On the first Circle, press **Delete Circle**, read the sheet and confirm. The Circle leaves the screen and doesn't return after a relaunch. The second Circle is still there and **Invite someone** gives a code.

Fails if: a rejoin hangs, the Circle is missing after a relaunch in step 6, a removed Circle returns, a leave made while the admin was offline never reaches them, a code works after its creator is demoted, or **Delete Circle** shows while someone else is in the Circle.
