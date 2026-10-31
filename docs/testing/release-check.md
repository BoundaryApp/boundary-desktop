# Release check

Run these flows in the app before each release and before each move of the pinned agent stack version. They cover what only the assembled app shows. The stack contract suite (`bun run test:stack`) checks the stack side separately: config keys, gateway methods and events, and HTTP endpoints.

Before a release, run Boundary against the pinned stack it downloads (`bun run dev`). Before moving the pin, run it against a [sovereign-agent-stack](https://github.com/kaxline/sovereign-agent-stack) checkout at the candidate version with `bun run dev:local-stack`, as the [README](../../README.md#developing-against-your-own-stack-checkout) describes. You need at least two agents besides the built-in one for the channel flow.

When a step fails, note the flow, the step, what you saw and the time. The time is enough to find the matching lines in Boundary's debug log.

## 1. A first chat

1. In the left rail, under **Direct messages**, click **+** (**Message an agent**). In the sheet, click **Message** next to one of your agents, or **Chat** for the built-in one.
2. Send a prompt that takes a while and uses a tool, such as "Search the web for today's top three tech headlines and summarise them."
   - The status next to the **Tools** switch reads "Preparing…" (then "Preparing · 5s" as seconds pass), then the tool's name with its turn number, then "Generating…" or a token count, then "Done".
   - The agent's row in the rail shows a pulsing dot with the tooltip "*Agent* is working".
3. While it runs, click another chat in the rail, wait about 10 seconds, then click back.
   - The reply keeps streaming, or the transcript shows "*Agent* is still working · *elapsed*" until it does.
4. Wait for the reply to finish.
   - The reply has the agent's display name above it. Your message is right-aligned with no label.

Fails if: the turn never leaves "Preparing…", or ends with "No reply after 3 minutes" while the agent is visibly working.

## Failed chats

Hermes stores a chat on its first accepted message, so Boundary keeps a chat whose send failed in its own store (`failedChats` in the agent records file).

1. Stop the stack with `docker compose stop hermes` in the stack checkout. Start a new chat and send "Failed chat one". The message and the error show, and the chat is in the rail titled with the message.
2. Start another chat and send "Failed chat two". Both chats are in the rail, and each opens on its own message and error.
3. Quit Boundary and open it again. Both chats are still listed and open the same way, with Retry on the error line.
4. Start the stack again. In "Failed chat one", click **Retry**. The reply comes in the same chat, the rail shows no extra chat, and the error stays above the reply after reopening the chat.
5. In "Failed chat two", open the title menu and click **Delete chat…**, then confirm. It leaves the rail and doesn't return after a relaunch.

Fails if: a failed chat leaves the rail, a Retry starts a separate chat, or the error is gone after a reopen.

## 2. A channel hand-off

1. In the rail, under **Channels**, click **+** (**New channel**). Enter `test-room` as the **Name**. Under **Initial members**, leave exactly two agents selected (the built-in agent starts selected), then click **Create channel**.
2. Post "Hello room, no need to reply." without an @.
   - Nobody answers.
3. Post "@*first* what's 2+2? Then hand off to @*second* to double it.", using the two members' handles.
   - The first agent answers under its own name and mark, then the second answers in a separate section under its name.
   - The first agent's reply addresses the second by its handle.
4. Post "@*second* which channel is this, and who are its members?"
   - It names `#test-room` and both members.
5. Click another chat, then click back to the channel.
   - No message in the transcript starts with "[Boundary channel".

Fails if: the second agent never answers after the hand-off, or a "[Boundary channel" line shows in the transcript (the channel header was sent as message text instead of as context).

## 3. An approval

Hermes's default approval mode is `smart`: a guardian model reviews each flagged command and runs the low-risk ones without asking, so a harmless test command never reaches you. Before this flow, add a rule that sends the test command to you. The stack keeps the default profile's Hermes config in `data/hermes/config.yaml`; for the stack Boundary downloads, the stack folder is `assistant-stack/project` in Boundary's app data folder. Add under the top-level `approvals:` key, creating it if it isn't there:

```yaml
approvals:
  smart_policy: "Always ESCALATE any command that mentions boundary-approval-test."
```

Hermes rereads `config.yaml` when the file changes, so no restart is needed. Remove the line when you've finished this flow.

1. In a chat with the built-in agent, ask: "Run `rm -rf /tmp/boundary-approval-test` in the terminal."
   - A card appears with **Approval needed**, **Run ↵**, **Reject** and **More**. The status next to **Tools** reads "Waiting for approval".
2. Click **Reject**.
   - The card goes away and the agent reports that the command was refused.
3. Ask again (step 1), then click **Run ↵** on the new card.
   - The command runs and the turn completes.

Fails if: with the rule in place, no card appears and the agent reports the command ran, or the card shows "The connection to the assistant stack dropped, so that answer was not sent…" while the stack is up.

## 4. Stop agent and turning access back on

1. Open **Settings** → **Computer access** and click **Stop agent**. There is no confirmation.
   - A banner reads "Agent stopped. Hermes can’t show notifications, open links, use your files or clipboard…", with **Turn access back on**.
   - Hermes restarts because its tokens are replaced. Chats can be unavailable for up to a minute.
2. Open a chat.
   - A note reads "Computer access is stopped. Turn it back on in Settings → Computer access." with **Open Computer access**.
3. Ask the agent to show a desktop notification ("Show me a desktop notification saying hi").
   - It reports that it can't.
4. Quit and relaunch Boundary.
   - **Settings** → **Computer access** still shows the stopped banner, and the chat note still says computer access is stopped.
5. Click **Turn access back on**.
   - The banner goes. The chat note changes to "Connecting Hermes to Boundary's tools…" and then disappears.
6. Repeat step 3.
   - The notification appears.

Fails if: the chat note in step 2 reads "Boundary's tools aren't running" instead, or step 5 shows an error starting "Access is back on, but…".

## 5. Adding a folder

1. Open a project chat. In the right inspector's **Project** tab, under **Folders**, click **Add…**. Click **Choose folder…**, pick a scratch folder under your home folder, select **Use as reference** and click **Add as reference**.
   - "Connecting folder…" shows in the composer briefly, then the folder's row appears with a **Read-only** pill.
2. Ask the agent to list the folder's files.
   - It lists them.
3. Add a second scratch folder, select **Code in it**, click **Continue**, then **Give coding access**.
   - A "Connecting the coding agent" banner works through its checklist, and the row's pill reads **Connecting** before it settles on **Coding**. Chats keep working meanwhile.
   - Against a stack checkout (`dev:local-stack`), **Code in it** is unavailable and the sheet names the stack command to run instead. Skip to step 5.
4. While step 3 is still connecting, add a third scratch folder as reference.
   - Both folders end up listed.
5. Add a folder that your container engine doesn't share with its VM, such as one under `/opt`, as reference.
   - An error appears (for a file-sharing refusal it starts "Could not share"), and the folder isn't listed under **Folders**. After a relaunch it is still absent.
6. Click **Remove** on the reference folder from step 1.
   - The row goes, and once the folders are remounted the agent can no longer list that folder's files.

Fails if: a folder that failed to mount stays in the list, or the agent can still read a removed folder.
