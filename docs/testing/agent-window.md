# Agent window

The agent button sits over every screen but Chat ([ADR 0052](../adr/0052-circles-destination-and-floating-agent.md), [agent window spec](../agent-window-ux-study/spec.md)). Until the floating window lands, pressing it opens Chat. On macOS with **Keep the agent button on the desktop** on, the button leaves the window for the desktop ([ADR 0058](../adr/0058-agent-button-outside-the-app-window.md)); the steps for that are under [On the desktop](#on-the-desktop).

## The button

These steps are for the in-window button: Windows, Linux, or macOS with **Settings → Chat → Keep the agent button on the desktop** off.

1. Open Circles, Inference, Services or Resources. The button is in the bottom right corner, with the built-in agent's mark. Hovering shows "Ask *name*" and ⌘J. Open Chat: the button is gone.
2. On a Circle channel, the composer's send button is clear of it.
3. Press the button, then go back and press ⌘J. Each opens Chat. ⌘J on Chat does nothing, and **File → Ask Your Agent** shows ⌘J.
4. Open a sheet, such as **Start or join a Circle → Start a Circle…**, or Settings from the rail. The sheet covers the button and the button takes no clicks.
5. Drag the button toward the left side. The four corners show as dashed slots, and a line marks the edge it will snap to. Let go: it snaps to that edge, 16 pixels in. A press that moves less than about 4 pixels opens Chat instead.
6. Resize the window, then quit and reopen Boundary. The button is in the same place along the same edge.
7. Right-click the button. **Bottom right**, **Bottom left**, **Top right** and **Top left** move it there. Escape closes the menu and returns focus to the button.
8. Start a reply with the built-in agent in Chat, then open Circles before it finishes. The button shows a pulsing dot while the reply runs, then a solid dot once it ends. Press the button: the dot goes. A reply that finishes while you're on Chat leaves no dot, and replies from other agents don't count.
9. With **Reduce motion** on in macOS Accessibility settings, the running dot doesn't pulse.

## On the desktop

macOS only. A build made for testing starts with **Settings → Chat → Keep the agent button on the desktop** on; a release build starts with it off. Check which you have before step 1.

### The switch and the window

1. In a test build, open **Settings → Chat**: **Keep the agent button on the desktop** is on. In a release build it is off. Turn it on if it isn't.
2. Close Boundary's window with the red button, then with ⌘W after reopening. Each time the window goes, the Dock icon stays, and a Dock click brings the window back on the screen it was on. Put the window in full screen and close it: it leaves full screen, then hides, and no black Space is left behind.
3. Start a long reply in Chat and close the window before it finishes. Open the panel: the reply keeps arriving. Click the Dock icon: Chat shows the full reply.
4. Turn the switch off. The button and panel go, the in-window button comes back on screens other than Chat, and closing the window now closes it as before.
5. Turn the switch on, hide the window, and quit with ⌘Q from the app menu while the panel is open. Boundary shows its quit screen and quits; the button and panel go first and don't come back over the quit screen.

### The button

6. The button sits at the bottom right of the main display, 16 pixels in, over whatever app is in front. Click into another app: that app stays in front, and hovering the button doesn't change that.
7. Put Safari or another app into full screen, and switch to another Space. The button shows on each.
8. Drag the button to the left edge and let go: it snaps there. Quit and reopen Boundary: it's in the same place.
9. With a second display, drag the button onto it, then unplug that display while Boundary runs. The button moves to the bottom right of the main display at once. Change the main display's resolution in System Settings: the button stays on screen.
10. Right-click the button: the four corners move it there, and **Hide button** hides it. **Window → Show Agent Button** brings it back, and so does **Settings → Chat → Show the agent button**.
11. Start a reply with the built-in agent and close the panel. The button's mark pulses while it runs, and a dot appears when it ends. Open the panel on the **Agent** tab: the dot goes. Open it on **Circles**: the dot stays.
12. Have someone post in a Circle. The button shows the unread count, with the @ mark when you're mentioned.

### The panel

13. Click the button. The panel opens toward the middle of the screen, 384 by 520 pixels or the size you last left it, with the agent's mark and name, **Agent** and **Circles**, ⤢ and ×. The cursor is in the message box.
14. On **Agent**: the line reads "Only you and *name* see this. It stays on this Mac." and the box reads "Ask *name* · only you see this". There is no project chip.
15. The **Chat** picker lists your chats with the agent, newest first, each with its project. Pick another, then **New chat**: a new chat starts in the same project.
16. Send a message in the panel and open the same chat in Chat: it's there, and the reverse. Type a draft in the panel and press ⤢: Boundary's window comes forward on that chat with the draft in the box, and the panel closes.
17. Click into another app with the panel open: the panel stays. Escape, ×, the button and ⌘J (with Boundary in front) each close it. A running reply keeps running.
18. In the panel, click a link in one of the agent's replies: the link prompt opens in the panel, and **Open** opens your browser. Copy a reply from its **More** menu and paste it in another app. On **Circles**, start editing one of your messages and press Escape: the edit ends and the panel stays. Open a message's delete sheet and press Escape: the sheet closes and the panel stays.
19. Drag a file from Finder and some text from Safari onto the panel: the cursor shows no drop, and nothing lands. Paste text into the box: it works.
20. Ask the agent for something that needs a folder it can't reach. The panel shows "This chat wants to work in a folder on your Mac" with **Answer in Boundary's window**, which opens the chat in the window. An approval or a credential prompt shows in the panel itself.
21. On **Circles**: every Circle in name order, bold with counts. Pick one: its last channel opens, with the coloured edge on the box and "Everyone in *Circle* gets a copy". The **Conversation** picker lists channels and direct messages.
22. Open the same channel on the Circles screen and type in either box: the other shows the same draft. Picking a channel in the panel doesn't change which Circle the Circles screen shows.
23. With the panel focused on a channel, have someone post there: no notification, and the channel isn't counted unread. Click into another app and have them post again: a notification arrives.
24. With Circles failing to connect (turn Wi-Fi off before launch), the **Circles** tab shows the same line the Circles screen does.

### Shortcuts and hidden work

25. With Boundary in front, ⌘J opens and closes the panel from every screen, Chat included. In the panel, ⌘N does nothing.
26. In **Settings → Chat → Shortcut from any app**, it reads **None**. **Record shortcut**, then press ⌘J: it's refused with a line about other apps. Press ⇧A: it's refused too. Record ⌃⌥B: it shows ⌃⌥B. Switch to another app and press ⌃⌥B: the panel opens and closes.
27. Record a shortcut another app holds, such as Spotlight's ⌘Space: a line says another app is using it, and the setting reads **None**. If a shortcut doesn't work after a relaunch, look for why (use the instance's name in place of `Boundary` for a build with another name):

```bash
grep -n "panel shortcut not held" ~/Library/Logs/Boundary/boundary-debug.log | tail -5
```

28. Turn the switch off: the shortcut stops working. Turn it on: it works again.
29. Open Circles with a running agent reply showing its pulsing marks, then close the window. In Activity Monitor's **Energy** tab, Boundary's impact drops to near idle within a few seconds, while the button's mark still pulses.

