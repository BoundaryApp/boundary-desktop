# Writing check: living spec

| | |
| --- | --- |
| Status | Proposed |
| Visuals | [01-reply-check.html](01-reply-check.html) (reply check: action row, Check tab, no-flags and short states) |
| Started | 11 Nov 2026 |
| Builds on | [Message actions spec](../message-actions-ux-study/spec.md), [add-ons spec](../addons-ux-study/spec.md) |
| Upstream | [CR 0030](../change-requests/0030-text-detector-addon.md) (detector add-on, phase 5 only) |

## Progress

| Phase | Status | Depends on |
| --- | --- | --- |
| 1 Rule engine | Built 11 Nov 2026 | — |
| 2 Check a reply | Built 11 Nov 2026; in-app check pending | 1 |
| 3 Check a selection | Built 11 Nov 2026; in-app check pending | 2 |
| 4 Check a project file | Built 11 Nov 2026; in-app check pending | 2 |
| 5 Detector score from an add-on | Built 12 Nov 2026; shows once Boundary's pin is v0.3.14 and the add-on is on | 2, stack v0.3.14 |

## Goal

A user can select text, press **Check** on a reply, or pick a project file, and see which passages read as machine-written and why, in under a second, with no model, no network and no extra memory.

## Decisions

1. **Flags, not a verdict.** The built-in check is a set of rules that point at features common in model output: overused words, stock sentence shapes, framing phrases, even sentence rhythm and list-heavy formatting. It reports each hit with the reason and a count of flags per 100 words. It never shows a percentage or says "AI-written", because rules measure style, not where text came from. Careful human writing in a formal register trips some rules, and a model told to avoid them passes.
2. **No model.** Most people running a local model give it all the memory they have. A second detector model (Binoculars needs two 7B-class models) costs too much for a side feature, and the open-source zero-shot detectors trail the commercial ones on current models and paraphrased text anyway.
3. **Anything that needs an API key is an add-on.** Commercial detectors (Pangram, GPTZero) need an account and send the text off the Mac. They arrive through the add-on store ([CR 0030](../change-requests/0030-text-detector-addon.md)), and the add-on holds the key. Boundary never stores a detector key.
4. **A user action on the host.** Like Copy and Quote, the check runs in Boundary for the person at the keyboard. It isn't an agent tool and needs nothing from the stack until phase 5.
5. **Nothing is kept.** Results live in memory for the open window, cached by a hash of the text and the rule set version. Logs carry word count, flag counts per rule and duration, never the text or the matched spans.
6. **No new markdown dependency.** A small line scanner finds fenced code, inline code, headings, list items and block quotes. That is enough to skip code and quotes and to run the formatting rules. The rest of the rules work on plain text with offsets back to the source.

## Non-goals

- A probability that text is AI-written from the built-in check.
- Rewriting text to clear the flags. The reasons are there for the user, or for a follow-up prompt they write themselves.
- Circle chats and channels, until the reply check has been used for a while.
- Checking the composer draft before sending.
- Scoring with the model already loaded in Ollama or LM Studio. That needs log-probabilities for input tokens, which hasn't been confirmed for either. It gets its own spike if it comes back.

---

## Phase 1 · Rule engine

Pure TypeScript in `src/shared/writingCheck/`, with no Electron or DOM imports, so main and renderer can both run it.

**Work**

1. `extractProse(markdown)` returns plain text, a map from plain-text offsets back to source offsets, and the block structure the formatting rules need. Fenced and inline code, block quotes, URLs and HTML are left out of the prose.
2. A rule is `{ id, pattern?, category, title, reason, find(blocks) → Span[] }`. Categories: **Words**, **Sentence shapes**, **Framing**, **Rhythm**, **Formatting**.
3. The rules follow the numbered patterns of the `humanizer` skill bundled with Hermes Agent (a port of blader/humanizer, MIT, based on Wikipedia's "Signs of AI writing"). A flag carries the pattern number, so a flag and a humanizer pass use the same names. 31 rules:
   - **Words:** inflated significance (1), promotional tone (4), vague attribution (5), model vocabulary and stock phrases (7), "serves as" for "is" (8), filler phrases (23), stacked hedges (24), false depth (27). "Landscape" counts only after an abstract modifier ("digital landscape").
   - **Sentence shapes:** trailing "-ing" commentary (3), "not X, but Y" contrasts and tacked-on "no X" (9), groups of three at one or more per 40 words of a paragraph (10), false ranges (12), more than one dash per 100 words (14), runs of three or more sentences of three words or fewer (31), a short question answered at once (32).
   - **Framing:** formulaic challenges (6), chatbot phrasing and openers (20, 22), knowledge-cutoff disclaimers (21), summaries and upbeat endings (25), announcing instead of saying (28), adverb openers (33), unasked reassurance (34).
   - **Rhythm:** sentence lengths varying less than 25% across a paragraph of five or more sentences.
   - **Formatting:** heavy bold (15), a bold label and colon on most items of a list (16), Title Case headings (17), emoji on headings and bullets (18), a warm-up line under a heading (29).

   Left out because a rule can't tell them from ordinary writing: notability claims (2), synonym cycling (11), passive voice (13), curly quotes (19, which macOS and Word add to human text), hyphenated pairs (26) and forced metaphors (30).
4. `checkText(markdown) → { ruleSetVersion, words, flags: Flag[], perHundredWords }`. Under 50 words, it returns the flags but marks the density as too short to compare.
5. Two fixture sets under `src/shared/writingCheck/__tests__/fixtures/`, written for the tests and never copied from real chats: `plain/` avoids the patterns and stands in for careful human prose, and `assistant/` is in a chat assistant's default voice. They check the rules against each other, not against real human writing; calibrating thresholds needs a corpus of human text, which phase 1 doesn't have.

**AC**

- [x] 1.1 Each rule has a test with a passage that trips it and a near miss that doesn't.
- [x] 1.2 Code blocks, inline code and quoted text never produce a flag.
- [x] 1.3 Every flag's span maps back to the exact source characters.
- [x] 1.4 The plain fixtures average fewer flags per 100 words than the assistant fixtures, and the test prints both numbers.
- [x] 1.5 Each rule makes one pass over the text, with no backtracking-prone patterns, and a 5,000-word fixture is in the suite.

## Phase 2 · Check a reply

**Work**

1. **Check writing** in the assistant action row ([MessageActions.tsx](../../src/renderer/product/chat/MessageActions.tsx)), after Copy. Hidden while the reply streams, like the rest of the row.
2. The result opens as a **Check** tab in the right inspector, after the conversation's own tabs. The tab exists only while there is a result for the open chat; each press brings it forward, and **×** closes it. Opening another chat hides it, and coming back shows it again until another reply is checked.
3. The pane shows what was checked ("Reply · Today 11:42"), the flag count and the rate per 100 words, a fixed note on what the check measures and what it can't, a filter per category, and the reply's prose with each flagged span highlighted. Pointing at or focusing a highlight shows its title, humanizer pattern number and reason above the prose.
4. **Show in chat** scrolls the transcript to the reply and marks it for a moment.

**AC**

- [x] 2.1 One click on **Check** opens the panel with results for that reply.
- [x] 2.2 Pressing **Check** again on an unchanged reply reuses the cached result.
- [x] 2.3 A mounted-runtime test covers the button, the panel and the empty result ("No flags").
- [ ] 2.4 Light and dark themes both match the mock.

## Phase 3 · Check a selection

**Work**

1. Add **Check** to the selection popover (`SelectionQuote`), after Quote and Copy.
2. Extend the popover to the user's own messages and to selections across messages. Quote stays on a selection inside one reply.
3. The panel shows the selection's text, not the whole reply. Only text inside messages is checked: across messages, each message's selected part becomes one paragraph, without speaker names, times or buttons. The header says "Selection from a reply", "Selection from your message" or "Selection across 2 messages", and **Show in chat** goes to the first selected message.

**AC**

- [x] 3.1 Selecting part of a reply or a prompt and pressing **Check** shows flags for that text only.
- [x] 3.2 A selection across two messages checks the selected text as one passage.

## Phase 4 · Check a project file

**Work**

1. **Check** beside each file in the **Wrote** list under a reply (`ReplyFiles`), for `.md`, `.markdown` and `.txt`.
2. **Check a file…** in the Project tab's ⋯ menu opens a file dialog in the project's host folder, limited to the same types.
3. Main reads the file through the project's host path and refuses, with a reason shown in the pane: a path outside the project folder, a symlink that resolves outside it, another type, a missing file, a file over 1 MB, or one that isn't text (contains a NUL byte). It sends the text to the renderer for the check.
4. The pane names the file by its project path, says when it was modified, and offers **Check again**, which reads it again. The **Check** tab shows in every view once there is a result, since a file can be checked from a project page.
5. Each read logs one line to the debug log, `area: "writing-check"`, with the outcome, extension, size and duration: never the path or the text.

**AC**

- [x] 4.1 A file outside the project folder, a symlink out of it, or an unsupported type gets a clear refusal and no read.
- [x] 4.2 The panel names the file and its modified time, and **Check again** re-reads it.

## Phase 5 · Detector score from an add-on

Built on [CR 0030](../change-requests/0030-text-detector-addon.md) R1–R2 and [CR 0027](../change-requests/0027-addon-store-metadata.md) R4, both in stack v0.3.14. Installing the add-on and setting its key happen in the stack (`addon.sh enable detector`); Boundary's add-on store doesn't offer it yet.

**Work**

1. When the detector add-on is on, the panel gains **Get detector score** under the note. "On" means the stack has `addons/detector/addon.json`, the token file exists, and `GET /health` answers with a provider. Before the first call to a provider the pane shows the manifest's `store.dataLeaves` with **Send to Pangram** (or GPTZero) and **Cancel**; agreeing is remembered per provider in main.
2. Main reads `DETECTOR_PORT` from the stack's `.env` (default 8790) and the token from `<data root>/addons/detector/secrets/http_token` on each check, reading it again once after a 401 since the stack can rotate it. It calls `POST http://127.0.0.1:<port>/check` with `Authorization: Bearer <token>`. The token never reaches the renderer. Text under 50 words gets the add-on's `too_short` without a provider call; the pane can say so before calling.
3. The score shows under the note as "Pangram: AI · score 0.82", with the model and the time it was checked, and a line saying it's that provider's own score, not comparable with other detectors. No benchmark figures. Segments that scored 0.5 or more get a dotted underline, a second layer under the flag highlights; GPTZero's are best effort and may skip sentences.
4. The add-on's errors show in the panel with its own message, plus "Try again in N s" from `retryAfter`, and **Try again**. Boundary adds `unavailable` when nothing answers on the port, and its own message for a refused token or an unreadable answer.
5. Each check logs one debug-log line, `area: "writing-check"`, message `detector check`, with the outcome, HTTP status, provider, segment count, character count and duration: never the text or token. A status probe that finds the add-on missing logs why (`no_token`, `health_<status>`, `no_answer`).

**AC**

- [x] 5.1 Without the add-on, nothing about detector scores appears.
- [x] 5.2 A fake add-on, built to match the endpoint CR 0030 delivers, covers success, each error and a timeout.
- [ ] 5.3 The live check is `detectorAddon.stack.test.ts`: `/health`, a `too_short` refusal and a wrong token, which cost nothing and send nothing off the Mac. A run with a real provider key is a manual flow.
