# 0056. Writing voices

- Date: 2026-11-11
- Status: Proposed · amended at phase 3 (§7: the Drafts line goes in session context)
- Related: [0010](0010-durable-attribution-and-room-lifecycle.md) §4 (editing a personality), [0024](0024-chats-belong-to-projects.md), [0031](0031-checks-on-the-stack-contract-and-drift.md) (stack contract), [change request 0010](../change-requests/0010-room-context.md) (session and turn context)

## Context

People want an agent to write the way they do, or the way their company does, from samples of that writing. The agent stack already ships a Hermes skill for it, `write-in-voice`. A voice there is a folder under the stack's user-data root, `voice/<name>/`, mounted at `/opt/voice`:

- `samples/` holds the person's writing. The skill reads `.md`, `.markdown`, `.txt`, `.rst` and `.text`.
- `STYLE.md` is written by *calibration*: the skill runs `scripts/corpus-stats.py` over the samples, reads them, picks two to four exemplars and fills a template that ends with a **Never does** list. People are meant to edit it.
- `drafts/` holds saved drafts.

Asked to write in a voice, the skill reads `STYLE.md` and the exemplars, drafts, runs Hermes's bundled `humanizer` skill over the draft, and checks it against **Never does**. It refuses to set the agent's conversational tone; the stack keeps that for `SOUL.md`.

None of this is visible in Boundary. A person has to know the folder, type "calibrate the my-voice writing voice" into a chat, and name the voice in every request. Three things in the pinned stack (v0.3.13, Hermes v0.22.7) shape what Boundary can build on it:

- **Skills reach only the built-in agent.** The stack's bootstrap sets `skills.external_dirs: /opt/skills` on the default profile. Boundary creates personalities with `profiles.create` and `clone_from: null`, which in Hermes's `tui_gateway/methods_profiles.py` makes a fresh profile with Hermes's bundled skills and no copied config, so a personality can't see `write-in-voice`.
- **Session context is cheap; turn context is not.** The stack's `client_context` overlay (change request 0010) takes `context` on `session.create` and `session.resume`, appends it to the agent's ephemeral system prompt and never stores it. `context` on `prompt.submit` is added to that turn's input and replayed with the stored turn on every later turn. Turn context is refused while a turn is running (`4082`), so it can't be queued or steered, and both are refused on isolated compute-host turns (`4083`). Each is at most 16,000 characters.
- **"Voice" already means speech in Hermes.** `prompt.submit` has a `voice_context` field for spoken voice mode.

## Decision

1. **A writing voice is a saved item in Boundary, backed by the stack's folder.** Boundary keeps a record per voice (id, name, folder, status, calibration date, a hash of the sample list) and leaves `samples/`, `STYLE.md` and `drafts/` where the skill expects them, so the skill and the files keep working outside Boundary. The interface says **writing voice** wherever speech could be meant, and code uses `writingVoice` names, never `voice` alone.
2. **Voices are managed under Settings → Writing voices.** The composer menu and the agent sheet's pickers link there with **Manage voices…**. A voice is set up rarely and used often, so it gets no place in the icon rail.
3. **Creating a voice checks the samples before anything is copied.** The create sheet takes files (native file dialog or drop) and pasted text, saved as `.md`. Boundary counts pieces and words and the share of lines that are headers or list items, on the Mac, and compares them with the stack's guidance: five or more pieces of 500 words or more, mostly prose. Boundary does this itself rather than parsing `corpus-stats.py`'s output, which is text for people. Files of other types are refused with the types it takes.
4. **Calibration runs on the built-in agent in the background.** **Create voice** copies the files into `voice/<id>/samples/` and starts a turn on the default profile, which has the skill, asking it to calibrate that voice. Boundary marks the voice **Ready** only when `STYLE.md` exists and every exemplar path in its frontmatter resolves, the skill's own check, never on the agent's say-so. A turn that ends otherwise leaves the voice **Not calibrated** with **Try again**; the samples stay. Adding or removing samples marks the voice **Samples changed** until it is recalibrated.
5. **An agent has two voice settings: Chat replies and Drafts.** Each is a voice or **No voice**, set in the agent's create and edit sheets and shown on the inspector's Agent tab. The built-in agent sets them on its inspector tab. *Chat replies* is how the agent talks in the conversation. *Drafts* is the posts, emails and documents it writes for the person to use elsewhere.
6. **A voice picked in the composer covers the whole reply, drafts included.** `/` opens a command menu whose first group is **Writing voices**; typing filters it. Picking a voice puts a chip at the start of the message that applies to that message. **Tab** on the highlighted row, or the chip's pin, keeps it for the chat instead: the chip moves to the composer footer beside the project and inference chips. For each reply the voice comes from, in order, the message's chip, the chat's kept voice, then the agent's own settings.
7. **Where each voice reaches Hermes.**
   - The agent's *Chat replies* voice and a chat's kept voice go in session context, as the voice's `STYLE.md` without frontmatter, under one line saying to write every reply in it. Changing either sends `session.resume` with the new context before the next turn.
   - A message's chip goes in that turn's context, with the line saying to write the whole reply, including any draft in it, in this voice. Turn context is replayed later, so the line names the message it applies to.
   - The *Drafts* voice is a line in the same session context naming the voice for `write-in-voice` when the agent writes something for the person to use elsewhere. Session context reaches the model as part of the system prompt on every turn, works the same for the built-in agent and personalities, and never rewrites a file the person edits; the cost is that it applies only in Boundary's chats, not in the WebUI or Signal. When a message's chip or a kept voice applies, Boundary's line says that voice replaces it. (Amended at phase 3 from "the agent's standing instructions".)
   - In a channel, voices go in turn context next to the room header, since the room's session is shared.
   - Without `client_context`, or on an isolated compute-host turn, the same text goes above the message, as channels already do.
8. **A message with a voice chip is never sent into a running turn.** Turn context can't be queued or steered in Hermes. **Queue** and **Send now** in the busy-send menu both submit once the running turn has ended, so they work unchanged. **Add to this run**, planned for the run-control spec's phase 3, isn't offered for a message with a chip.
9. **Personalities get the stack's skills folder.** Boundary's new-profile setup writes `skills.external_dirs: [/opt/skills]` on personalities it creates, and adds it to existing ones on the next stack start, so a *Drafts* voice works on every agent.
10. **Deleting a voice asks first and moves its folder to the Trash.** The dialog names the agents and chats that use it; their settings go back to **No voice**.
11. **Logs carry metadata only:** voice ids, sample counts, word counts, calibration timings and outcomes. Never sample text, `STYLE.md` content or file names.

## Consequences

- One `STYLE.md` serves both settings, so editing **Never does** on a voice changes chat replies and drafts at once.
- A voice in session context costs its `STYLE.md` on every turn but adds nothing to the stored history. A voice on a single message is stored with that turn and replayed after, which is why chips are for one message and keeping a voice moves it to session context.
- A `STYLE.md` over 16,000 characters can't be sent. The voice card shows its size and refuses to apply a voice over the limit, asking the person to shorten it.
- Calibration quality depends on the default model. The create sheet names the model that will calibrate.
- Calibration turns are Hermes sessions like any other; Boundary files them under the voice and leaves them out of All chats.
- Boundary starts depending on the `voice/` mount in `hermes-worker`, `/opt/voice` in `HERMES_WRITE_SAFE_ROOT`, the `write-in-voice` skill and its `STYLE.md` frontmatter, and `skills.external_dirs`. Each gets a row in `docs/stack-contract.md` when it is built.
- The flows, mocks and phases are in the [writing voices study](../writing-voices-ux-study/spec.md).
