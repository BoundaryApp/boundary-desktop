# Sharing controls on the Circles screen

Two Macs. The provider has a local model connected and is in a Circle with the member; the member trusts the provider and has the shared model as their default.

1. On the provider, with nothing shared, open Circles and select **Sharing** in the list. **Shared from this Mac** says to choose a model, with a **Share with** switch per Circle, off. Select the Circle: its **You** row has a **Share here** switch, off.
2. On **Sharing**, tick a model and turn on **Share with** for the Circle. The panel is green and names the Circle, and the list says "Sharing 1 model". The Circle's **Share here** is on. The member sees the model within a few seconds.
3. Press **Pause sharing**. The panel says "Paused: members can't use your models" and the list says **Paused** with an amber dot. On the Circle's page the **You** row says the same and its dot is amber. The member's dot for that offer turns amber and their next send says the provider isn't sharing.
4. Press **Resume sharing**. The warnings go and the member can send.
5. Turn on **Away mode**. The switch says the Mac stays awake, the **You** row on the Circle's page shows **Away mode**, and the Mac doesn't sleep on its idle timer.
6. Pause with away mode on. The switch says the Mac can sleep while paused. Resume.
7. Quit the provider's model server. Within about 3 seconds the panel says the server isn't responding and offers **Open Settings**, and the Circles icon has an amber dot on every screen. Restart the server: the dot goes.
8. In Settings, Inference, the Local card has one status line and **Open Circles**, with no sharing controls. It opens **Sharing**, and the line follows pause and resume.
9. On the Circle's page, turn off **Share here**. **Share with** on **Sharing** turns off too. The member stops seeing the offer, and the model stays ticked.
10. On an install with no local model server, or one that isn't responding, in a Circle and sharing nothing, **Sharing** shows only **From your Circles**, and the **You** row has no **Share here** switch.
11. On an install in no Circle, Settings' line says to create or join a Circle, and **Open Circles** shows the welcome screen with both forms.

## The list

1. With two Circles, select each in the list. One page shows at a time. Go to Chat and back: the same Circle is selected.
2. Press **+**, start a Circle. The sheet closes and the new Circle opens.
3. Press **+**, enter a code for a Circle with no admin online, and press **Join**. The sheet closes, the list shows **Joining…** and the page says **Joining the Circle** and that it finishes on its own once an admin has Boundary open. Go to Chat and back: it's still joining. Have an admin open Boundary and touch nothing there: the page moves to the Circle as soon as the admin's device admits this one, with no **Cancel**, and the list shows the Circle. "Finishing joining" shows under the people, and **Leave** and **Share here** are disabled until it goes. If it takes over a minute, the note says this Mac is still catching up and you can read the Circle in the meantime.
4. Repeat, and press **Cancel**. The **Joining…** row goes. Bring an admin online: nothing happens, and the code still works.
5. Join with an expired code. The page says **Couldn’t join** with the reason. Press **Dismiss**.
6. Press **Profile**. Change your name, and press **Show diagnostics file**.
7. As an admin, press **Invite someone**, enter a name and press **Create code**. The sheet shows the code, says it can be copied again from the list, and names the admins who must be online. Close it: the page shows the invite by name and the code's first 9 characters, such as `For Sam · yrb7ei1ng…`. **Manage** reopens the list with the code masked. **Show** reveals it, **Copy** puts it on the clipboard, and **Revoke** is beside them. Restart Boundary: all of that still works. The invited person never sees the name.
   Type the same name with different case or extra spaces. Before you create it, the sheet says it replaces the open code for that name. Press **Create code**: the list has one invite for that name, with a new short code. Try the old code on a second install once this admin's device is online: it's refused.
   On a second admin's device the same invite shows `Invite` and part of its id, with no **Show** or **Copy**. An invite made before this build looks the same on its own device. Use or revoke an invite, or leave the Circle, and its code goes.
8. Leave the selected Circle. The next Circle opens, and with none left the welcome screen shows.

## People and the person panel

Run these on the member, with the provider sharing a model.

1. Open the Circle. The provider's row shows their model and **Not trusted**. Click the row: a panel opens on the right, and the list stays in view.
2. **Use as default** is disabled and says to trust the provider. Turn on **Trusted**. The row changes to **Trusted** and the buttons work.
3. Press **Use as default**. The switch progress shows in the panel, then the model reads "Your default model". Send a chat: the provider's model answers.
4. Turn **Trusted** off. The panel says it's still your default but chats can't use it. Turn it back on.
5. Choose another default in Settings, then press **Add as fallback** in the panel. It changes to **In your fallbacks**, and Settings lists it.
6. Put the provider in a second Circle with you. Their panel shows one set of switches, one row per model, and both Circles in its header.
7. As an admin, open a member's panel. **Make admin** and **Remove** are there, and **Remove** asks first. As a member, neither shows.
8. In setup with no model of your own, join a Circle: the provider shows with both switches and **Use as default**, and no fallback button.

## From your Circles

Run these on the member.

1. **Sharing** lists the provider's model once, with the provider's name, its context and the Circles offering it. A provider in two Circles still has one row per model.
2. The label follows the provider: **Not trusted** before you trust them, **Ready** after, **Paused** when they pause, **Offline** when they quit, and **Your default** once chosen.
3. Click a row. The person panel opens with their switches and models, without **Make admin** or **Remove**.
4. The list's **Sharing** row counts what's available, such as "1 available", when you aren't sharing.
5. On an install in a Circle where nobody shares, **From your Circles** says so.

## Links into Circles

Run these on a member whose default is the provider's model, with no fallback.

1. Turn off **Trusted** and send a chat. The stop message names the reason and has **Open in Circles**, which opens **Sharing** with the provider's panel. Turn **Trusted** on and press **Retry** in the chat.
2. Quit Boundary on the provider and send. The stop message says they're offline and has the same link.
3. In Settings, hover a shared model that can't serve, in the app default list and under Fallbacks. A text link **Open in Circles** appears. Press Tab until it has focus: it appears for the keyboard too. Rows that can serve show no link.
4. With **Trusted** off, click the row in the app default list. Circles opens on **Sharing** with the provider's panel, and the default doesn't change.
5. Turn **Trusted** on, pause sharing on the provider, and click the row. Circles opens on **Sharing** with no panel, and the default doesn't change.
6. Leave the Circle. The row says you're no longer in that Circle and to choose another model, has no link, and can't be clicked.
7. With a provider you don't trust, open **Add a fallback** in Settings. Their model is dimmed and says it can't be used until you trust them. Add it: it's listed as skipped. Trust them and a send can reach it.

## Usage and limits

Run these with a member using the provider's model.

1. On the provider, **Sharing** says no member has used your models today. Send a chat from the member. **Today** shows them with **Running** during the reply, then their requests and tokens.
2. On the member, the provider's panel says what you used today. The numbers should be close to the provider's.
3. Restart the provider. The counts stay.
4. Under **Limit for everyone**, set **Requests a day** to the member's count and press **Save limit**. The member's next chat moves to their fallback. With no fallback, it stops and says they've used today's requests.
5. Open the member's panel from a Circle's page on the provider, set a higher **Requests a day** and save. The member can chat again. Press **Use the limit for everyone** and they're stopped again.
6. Clear the limit. Ask a third install in the Circle to confirm it shows none of these counts.

## Alerts when a shared model changes

The member stays on a screen other than Circles, such as Chat or Settings. Each toast comes about 10 seconds after the change, lasts 8 seconds, and has **Open Circles** and a dismiss button. The provider sees none of these, because a toast never covers your own offer.

1. Quit and reopen Boundary on the member while the provider is sharing and online. No toast appears, and none in the following 30 seconds while the provider reconnects. Wait for those 30 seconds before the next step.
2. On the provider, turn off **Share with**, wait for "stopped sharing" on the member, and turn it back on. The member sees "shared" naming the provider, model and Circle, saying the model can be used now.
3. Press **Pause sharing**. The member sees that the provider paused the model. Press **Resume sharing**. The member sees that they can use it again.
4. Turn off Wi-Fi on the provider and leave it off for a minute. The member sees that the provider went offline. Turn Wi-Fi back on. The member sees that the provider is back online.
5. Turn Wi-Fi off and on again within about 5 seconds. If the connection comes back before 10 seconds pass, the member sees no toast.
6. Change two things on the provider within a few seconds, such as ticking another model and then pausing. The member sees one toast for that provider.
7. With a sheet open from Settings, press **Pause sharing** on the provider. The toast shows above the sheet. Press **Open Circles** in a later toast from the Chat screen: the app opens **Sharing** with that provider's panel, and the toast closes.
