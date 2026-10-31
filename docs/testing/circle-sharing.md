# Sharing controls on the Circles screen

Two Macs. The provider has a local model connected and is in a Circle with the member; the member trusts the provider and has the shared model as their default.

1. On the provider, with nothing shared, open Circles. **Share your models** says to choose a model, and each Circle's **You** row has its own **Share with** switch, off.
2. Tick a model and turn on **Share with** for the Circle. The panel turns green and names the Circle. The member sees the model within a few seconds.
3. Press **Pause sharing**. The panel and the **You** row both say "Paused: members can't use your models", and the **You** dot turns amber. The member's dot for that offer turns amber and their next send says the provider isn't sharing.
4. Press **Resume sharing**. The warnings go and the member can send.
5. Turn on **Away mode**. The switch says the Mac stays awake, the **You** row shows **Away mode**, and the Mac doesn't sleep on its idle timer.
6. Pause with away mode on. The switch says the Mac can sleep while paused. Resume.
7. Quit the provider's model server. Within about 3 seconds the panel says the server isn't responding and offers **Open Settings**. Restart the server.
8. In Settings, Inference, the Local card has one status line and **Open Circles**, with no sharing controls. It goes to the Circles screen, and the line follows pause and resume.
9. Turn off **Share with**. The member stops seeing the offer, and the model stays ticked.
10. On an install with no local model server, or one that isn't responding, in a Circle and sharing nothing, the Circles screen has no **Share your models** panel and no **Share with** switch.
11. On an install in no Circle, Settings' line says to create or join a Circle, and **Open Circles** shows the create and join forms.

## Alerts when a shared model changes

The member stays on a screen other than Circles, such as Chat or Settings. Each toast comes about 10 seconds after the change, lasts 8 seconds, and has **Open Circles** and a dismiss button. The provider sees none of these, because a toast never covers your own offer.

1. Quit and reopen Boundary on the member while the provider is sharing and online. No toast appears, and none in the following 30 seconds while the provider reconnects. Wait for those 30 seconds before the next step.
2. On the provider, turn off **Share with**, wait for "stopped sharing" on the member, and turn it back on. The member sees "shared" naming the provider, model and Circle, saying the model can be used now.
3. Press **Pause sharing**. The member sees that the provider paused the model. Press **Resume sharing**. The member sees that they can use it again.
4. Turn off Wi-Fi on the provider and leave it off for a minute. The member sees that the provider went offline. Turn Wi-Fi back on. The member sees that the provider is back online.
5. Turn Wi-Fi off and on again within about 5 seconds. If the connection comes back before 10 seconds pass, the member sees no toast.
6. Change two things on the provider within a few seconds, such as ticking another model and then pausing. The member sees one toast for that provider.
7. With a sheet open from Settings, press **Pause sharing** on the provider. The toast shows above the sheet. Press **Open Circles** in a later toast from the Chat screen: the app goes to the Circles screen and the toast closes.
