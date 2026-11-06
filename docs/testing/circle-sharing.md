# Circles: sharing, membership and trust

Two Macs. The provider has a local model connected and is in a Circle with the member; the member trusts the provider and has the shared model in their Chat stack. There is no Circles screen ([ADR 0043](../adr/0043-circles-live-in-the-chat.md)): sharing and trust are in Inference (⌘2), and a Circle is managed from the chat's place switcher and the Circle tab in the chat's inspector.

## Sharing from this Mac

Run these on the provider, in Inference.

1. With nothing shared, **Shared from this Mac** says to choose a model, with a **Share with** switch per Circle, off.
2. Tick a model and turn on **Share with** for the Circle. The panel is green and names the Circle. The member sees the model within a few seconds.
3. Press **Pause sharing**. The panel says "Paused: members can't use your models". The member's next send moves on to their next model, or says the provider isn't sharing.
4. Press **Resume sharing**. The warning goes and the member can send.
5. Turn on **Away mode**. The switch says the Mac stays awake, and the Mac doesn't sleep on its idle timer.
6. Pause with away mode on. The switch says the Mac can sleep while paused. Resume.
7. Quit the provider's model server. Within about 3 seconds the panel says the server isn't responding, and the Inference icon has an amber dot on every screen. Restart the server: the dot goes.
8. Turn off **Share with** for the Circle. The member stops seeing the offer, and the model stays ticked.
9. On an install with no local model server, or one that isn't responding, in a Circle and sharing nothing, Inference shows no **Shared from this Mac**.
10. There is no Circles icon in the rail, and ⌘5 does nothing.

## Starting and joining

1. With no Circles, open the switcher at the top of the chat rail. The menu says what a Circle is and offers **Start a Circle…** and **Join with an invite…**.
2. Start a Circle. The sheet closes and the chat switches to it, on General. With no name set yet, the sheet asks for yours first.
3. On the other Mac, **Join with an invite…** with a code for a Circle with no admin online. The sheet closes and the chat shows the waiting page, and the switcher says **Joining a Circle…**. Switch to This Mac and back through the menu's **Joining a Circle…** row: it's still waiting. Have an admin open Boundary and touch nothing there: the page moves into the Circle, and the Circle replaces the row in the menu. Until this Mac can write, the composer says it's still joining.
4. Repeat, and press **Cancel**. The row goes and the chat returns to This Mac. Bring an admin online: nothing happens, and the code still works.
5. Join with an expired code. The page says the invite didn't work, with the reason. Press **Close**.
6. In Settings, General, **Circles profile** shows your name and the connection. **Profile…** changes the name and has **Show diagnostics file**. With Circles failing to connect, the switcher's menu says so, and **Circles profile** in that line opens Settings.

## Membership in the Circle tab

1. In a Circle, press the panel button at the top right of the channel. The Circle tab lists channels, people and, for admins, **Invite someone** and open invites. **Leave** is at its foot, or **Delete** for a Circle's last member.
2. As an admin, press **Invite someone**, enter a name and press **Create code**. The sheet shows the code, says it can be copied again from the list, and names the admins who must be online. Close it: the tab's **Open invites** shows the invite by name and the code's first 9 characters, such as `For Sam · yrb7ei1ng…`. Clicking it reopens the sheet with the code masked. **Show** reveals it, **Copy** puts it on the clipboard, and **Revoke** is beside them. Restart Boundary: all of that still works. The invited person never sees the name.
   Type the same name with different case or extra spaces. Before you create it, the sheet says it replaces the open code for that name. Press **Create code**: the list has one invite for that name, with a new short code. Try the old code on a second install once this admin's device is online: it's refused.
   On a second admin's device the same invite shows `Invite` and part of its id, with no **Show** or **Copy**. Use or revoke an invite, or leave the Circle, and its code goes.
3. The rail's People `+` (admins only) opens the tab and the invite sheet together.
4. Click a person in the tab, the rail or on a message. Their view replaces the tab, with **←** and the Circle's name to go back. It shows whether they're online, their role, the models they share and **Open in Inference**.
5. As an admin, **Make admin** or **Make member** and **Remove from** the Circle are there, and **Remove** asks first, saying what they've already received stays with them. As a member, neither shows.
6. Leave a Circle. It asks first; the Circle leaves the switcher and the chat returns to This Mac.

## Trust and use

Run these on the member, in Inference's **From your Circles**.

1. The provider's model shows once, with their name, the Circles offering it and whether they're online. **Add to stack** is disabled until you trust them.
2. Turn on **Trusted**. **Add to stack** works. Add it: it joins the end of the Chat stack. Send a chat with it first in the stack: the provider's model answers.
3. Turn **Allow in private projects** on and off; a private project's chat follows it.
4. Put the provider in a second Circle with you. They still show once, with both Circles named.
5. In setup with no model of your own, join a Circle: the provider shows with both switches and **Use as default**, and no fallback button.
6. On an install in a Circle where nobody shares, **From your Circles** says so.

## Links about a shared model

Run these on a member whose Chat stack starts with the provider's model, with nothing after it.

1. Turn off **Trusted** and send a chat. The stop message names the reason and has **Open in Inference**, which opens Inference at the provider's row without changing the chat's place. Turn **Trusted** on and press **Retry** in the chat.
2. Quit Boundary on the provider and send. The stop message says they're offline and has the same link.
3. In a Circle, open a person who shares a model and press **Open in Inference**. Inference opens at their row.

## Usage and limits

Run these with a member using the provider's model.

1. On the provider, **Shared from this Mac** says no member has used your models today. Send a chat from the member. **Today** shows them with **Running** during the reply, then their requests and tokens.
2. On the member, the provider's block in **From your Circles** says what you used today. The numbers should be close to the provider's.
3. Restart the provider. The counts stay.
4. Under **Limit for everyone**, set **Requests a day** to the member's count and press **Save limit**. The member's next chat moves on to their next model. With none, it stops and says they've used today's requests.
5. Under **Limit for one person**, choose the member, set a higher **Requests a day** and save. They're marked "own limit" in the list, and they can chat again. Press **Use the limit for everyone** and they're stopped again.
6. Clear the limit. Ask a third install in the Circle to confirm it shows none of these counts.

## Alerts when a shared model changes

The member stays on a screen other than Inference, such as Chat or Settings. Each toast comes about 10 seconds after the change, lasts 8 seconds, and has **Open Inference** and a dismiss button. The provider sees none of these, because a toast never covers your own offer.

1. Quit and reopen Boundary on the member while the provider is sharing and online. No toast appears, and none in the following 30 seconds while the provider reconnects. Wait for those 30 seconds before the next step.
2. On the provider, turn off **Share with**, wait for "stopped sharing" on the member, and turn it back on. The member sees "shared" naming the provider, model and Circle, saying the model can be used now.
3. Press **Pause sharing**. The member sees that the provider paused the model. Press **Resume sharing**. The member sees that they can use it again.
4. Turn off Wi-Fi on the provider and leave it off for a minute. The member sees that the provider went offline. Turn Wi-Fi back on. The member sees that the provider is back online.
5. Turn Wi-Fi off and on again within about 5 seconds. If the connection comes back before 10 seconds pass, the member sees no toast.
6. Change two things on the provider within a few seconds, such as ticking another model and then pausing. The member sees one toast for that provider.
7. With a sheet open from Settings, press **Pause sharing** on the provider. The toast shows above the sheet. Press **Open Inference** in a later toast from the Chat screen: Inference opens at that provider's row, and the toast closes.
