# Shared model as the app default

Two Macs, for [ADR 0036](../adr/0036-shared-model-app-default.md). The provider shares a local model from the Circles screen; `dev:local-stack` works there. The consumer must be a managed install, with OpenRouter and any local server disconnected.

1. On the consumer, in Settings, Inference: the warning says no provider is connected, and the provider's model is listed under App default. With the provider not Trusted the row is disabled and says to trust them in Circles.
2. In Circles, turn on Trusted. Back in Settings, pick the model. The warning goes, the assistant restarts and Fallbacks appears.
3. In a new chat the chip reads the member's name and model. Send a message; the reply comes from the provider's Mac. Filter `circles-diagnostics.log` by `router.request`: its `served` field shows the `peer:` entry.
4. Pause sharing on the provider, then send. The chat says the member isn't sharing the model and the message wasn't sent. Nothing mentions OpenRouter. Resume, and it sends.
5. Quit Boundary on the provider, then send. The chat says the model is offline. Reopen it, wait for the member to show as online, and it sends.
6. Turn off Trusted, then send. The chat says to turn it on. Settings shows the row as chosen, with the reason. Turn it back on.
7. Connect OpenRouter on the consumer. The default stays the shared model. Add OpenRouter as a fallback, pause sharing and send: OpenRouter answers.
8. Quit and relaunch the consumer with sharing paused. It reaches the workbench, not a stuck start-up screen.
9. Pick OpenRouter as the app default. The chip follows, and the shared model can be picked again.
10. Fresh install on the consumer: at the Model step choose **Use a model from my Circle**, enter a name and an invite while an admin is online, turn on Trusted and press **Use as default**. Setup continues and the first chat sends.
