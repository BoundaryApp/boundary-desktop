# Writing voices: living spec

| | |
| --- | --- |
| Status | Proposed |
| Visuals | [prototype.html](prototype.html) (click-through) |
| Started | 11 Nov 2026 |
| Builds on | [ADR 0056](../adr/0056-writing-voices.md), [ADR 0010](../adr/0010-durable-attribution-and-room-lifecycle.md) §4, [change request 0010](../change-requests/0010-room-context.md), [Settings spec](../settings-ux-study/spec.md), [Project create spec](../project-create-ux-study/spec.md) |

## Progress

| Phase | Status | Depends on |
| --- | --- | --- |
| 1. Voice records, Settings → Writing voices, create sheet with the sample check | Built | None |
| 2. Calibration, voice card, recalibrate and delete | Built | 1 |
| 3. Agent settings: Chat replies and Drafts, skills folder for personalities | Built | 2 |
| 4. Composer: `/` menu, voice chip, keeping a voice for the chat | Built | 3 |
| 5. Voices in channels | Built | 4 |

## Goal

Someone with a folder of their own writing turns it into a writing voice without leaving Boundary, and then always knows which voice an agent will use for the next reply and why.

## Flows

**Creating a voice.** **Settings → Writing voices** lists voices as cards, with **New voice…** at the top. The create sheet has a name field and a drop zone with **Choose files…** and **Paste text**. As files are added, a check runs on the Mac and fills a bar under the list: pieces, total words, and how many pieces reach 500 words. The bar is green from five such pieces. Files that are mostly headers and lists get a note, because calibration counts each fragment as a sentence and the voice comes out clipped. Files of other types are listed as not added, with the types the sheet takes. The sheet names the model that will calibrate. **Create voice** closes the sheet and the new card shows **Calibrating** with steps: copying samples, measuring, reading, writing the style guide.

**The voice card.** A ready card shows the voice's name, the pieces and words it was built from, the date it was calibrated, the first paragraph of its `STYLE.md`, and its **Never does** list. **Edit** turns the list into fields to add, change and remove lines; saving writes `STYLE.md`. **Open STYLE.md** opens the whole file in the Mac's editor. **Samples** lists the files, with **Add files…** and remove; any change shows **Samples changed** and **Recalibrate**. The card's menu has **Rename**, **Show in Finder** and **Delete…**.

**Setting an agent's voices.** The agent create and edit sheets get a **Writing voice** group below **Role**, with two pickers: **Chat replies** and **Drafts**. A line under each says what it covers: "How it talks to you here" and "Posts, emails and documents it writes for you". Each lists **No voice**, the ready voices, **New voice…** and **Manage voices…**. A voice still calibrating is listed but can't be picked. The inspector's Agent tab shows both settings under **Role**; for the built-in agent the pickers are there, since it has no edit sheet.

**Picking a voice for a message.** Typing `/` at the start of the composer opens a menu above it, grouped like the @ menu. Its first group is **Writing voices**, each row with the voice's name and a one-line description, and the agent's current voice marked. Typing filters by name. **Enter** picks a voice for this message: a chip at the start of the message reads **✎ Newsletter**, and the text after it is the message. **Tab** keeps the voice for this chat: the chip goes to the composer footer beside the project and inference chips. Backspace at the start of the message removes a message chip. The footer chip opens a small menu: other voices, **Use the agent's voice**, and **Manage voices…**.

**Seeing which voice was used.** A reply written in a voice shows "In Newsletter voice" in its details, beside the model. Keeping, changing or clearing a chat's voice adds a transcript line, as switching models does: "Writing in Newsletter from here".

**Sending while the agent works.** A message with a voice chip opens the busy-send menu like any other. **Queue** and **Send now** work as before.

**Deleting a voice.** **Delete…** lists the agents and chats that use the voice and says their settings go back to **No voice** and the folder goes to the Trash.

## Decisions

1. **Settings holds the library; the composer and agent sheet hold the pickers.** A voice is set up once and used constantly, so the place you use it is where it shows up, and **Manage voices…** links back.
2. **Two settings per agent, one pick per message.** Agents can talk in one voice and draft in another. A message's pick covers the whole reply, drafts included, because someone choosing a voice for a message expects one answer.
3. **The order is message, chat, agent.** A message chip wins over a kept voice, which wins over the agent's settings. The footer chip, the reply details and the transcript lines always show the result, so nobody has to work out the order.
4. **`/` opens a command menu, not a voices menu.** Hermes has its own slash commands, and other commands will want this key. Voices are the first group; typing a voice's name finds it from the top.
5. **The sample check runs before anything is copied.** The most common failure, a corpus of notes and reference docs, shows on the sheet instead of after a calibration run.
6. **The voice card shows `STYLE.md`'s description and Never does list, not calibration's chat reply.** They are the parts that most change the output, and the card reads them from the file Boundary checks.
7. **"Writing voice" wherever speech could be meant.** Settings, sheet titles and the menu group say **Writing voices**; chips and pickers show just the voice's name.

## Non-goals

- Voices shared with a Circle. A voice is the Mac owner's.
- Word, PDF or Google Docs samples. The skill reads text files; converting others is later work.
- Text-to-speech or anything about how an agent sounds aloud.
- Choosing a voice per message for drafts only. Message picks cover the whole reply (decision 2).
- Editing every section of `STYLE.md` in Boundary. **Open STYLE.md** covers the rest.

## Risks and open questions

- **Calibration on small local models.** The stack's guide warns that style matching is hard for them. If calibrations on the default local model come out flat, the sheet could offer a larger model for this one run.
- **Calibration sessions.** Boundary files them under the voice and hides them from All chats. If a calibration goes wrong, people may want to see what happened; a **Show calibration chat** link on a failed card would cover it.
- **A one-message voice stays in history.** Turn context is replayed on later turns, so a long `STYLE.md` sent on several one-off messages grows every later prompt. Watch prompt sizes in the context meter once phase 4 ships; a compact form of `STYLE.md` for turn context is the fix if it matters.
- **Drafts voice on a model that ignores skills.** A weak model may skip `write-in-voice`. The reply details can only say which voice was asked for, not whether the skill ran; a metadata log line for skill use would answer it.

## Acceptance criteria

- [x] **Settings → Writing voices** lists voices with their status, and **New voice…** opens the create sheet.
- [x] The create sheet counts pieces, words and 500-word pieces, notes list-heavy files, refuses other file types, and names the calibrating model, before anything is copied.
- [x] A voice is **Ready** only when `STYLE.md` exists and its exemplars resolve; a failed calibration shows **Try again** and keeps the samples.
- [x] Changing samples shows **Samples changed** and **Recalibrate**.
- [x] Editing **Never does** on the card writes `STYLE.md`.
- [x] Agent create and edit sheets and the built-in agent's inspector tab set **Chat replies** and **Drafts** separately.
- [x] A personality Boundary created can run `write-in-voice`.
- [x] `/` opens the command menu with **Writing voices** first; **Enter** adds a message chip and **Tab** keeps the voice for the chat.
- [x] Each reply in a voice says which in its details, and keeping, changing or clearing a chat's voice adds a transcript line.
- [x] A message with a chip sent mid-reply is submitted only after the running turn ends.
- [x] Deleting a voice names what uses it, resets those settings and moves the folder to the Trash.
- [x] Logs carry voice ids, counts and timings, never sample text, `STYLE.md` content or file names.
