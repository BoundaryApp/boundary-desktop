# 0070. Moving chat history between installs

- Date: 2026-11-20
- Status: Proposed
- Related: [0010](0010-durable-attribution-and-room-lifecycle.md), [0023](0023-chat-types-and-hermes-home.md), [0024](0024-chats-belong-to-projects.md), [0046](0046-cancel-or-undo-long-running-actions.md), [0056](0056-writing-voices.md), [0062](0062-the-stack-runs-on-a-stack-host.md), [0067](0067-removing-a-project.md), [CR 0039](../change-requests/0039-session-import.md)

## Context

People move to a new Mac, from a local agent stack to the managed install, or onto a remote stack host, and lose their chats on the way. The only way to carry them today is to copy `state.db` files with the stack stopped, which replaces the target's history and misses profiles the copy doesn't cover.

Stack v0.3.16, which Boundary pins, ships `scripts/sessions.sh` (CR 0039 R1–R3). Checked in the script, `scripts/lib/sessions_move.py` and the `nousresearch/hermes-agent:v0.23.1` image:

- `export --dest DIR --json` writes one `<profile>.jsonl` per Hermes profile (`default` for the Hermes home), mode 0600 in a 0700 folder, and `manifest.json` (`"format":"assistant-sessions/1"`) with each profile's session and message counts, the stack version and the Hermes image. `DIR` must be new or empty. Nothing is redacted.
- `import --from DIR --json` loads each file into the profile of the same name through `SessionDB.import_sessions`, with session ids unchanged, while the gateway runs. Each profile gets one line with `imported`, `skipped`, `detached`, `refused`, `too_large`, `invalid` and `failed` counts, plus `refused_ids`, `too_large_ids`, `invalid_ids` and `failed_ids`. A profile the target lacks gets `"status":"profile_missing"` and its session count, and none of its sessions are imported. A second import of the same export skips everything. `failed` above 0 exits 1, and running the import again retries those sessions.
- Lines carry counts and session ids, never titles or message text.
- Both commands run on the stack host: the script reads and writes `DIR` there and pipes the files into the `hermes` container.

Two gaps in the stack matter here. A title the target already holds makes `import_sessions` raise `IntegrityError` and roll back its whole batch, and a rerun fails the same way (CR 0039 R5, reproduced on a synthetic store). The import output also doesn't list the ids it imported or skipped, and the manifest has counts only, so Boundary can't name every session the target now holds (R6).

Hermes holds the transcripts. Boundary holds the rest of what a chat is, keyed by session id, in the per-stack agent store (`hermesAgentStore.ts`, one file per stack identity):

- `sessionMeta`: the owning agent, room, project, branch origin, inference override and kept writing voice;
- `sessionSpeakers`, `sessionAliases` and `standingDmByAgent`;
- inference, writing voice and project marks; reply endings, `noReplies`, and the voices replies and prompts were written in;
- `channels` and `channelPosts`. A room's posts are the user's own lines and exist only in Boundary, so they are chat content;
- `agents`: each agent's name, handle, role and writing voices. The agent's persona is the profile's `SOUL.md` on the stack.

Projects live in a per-Mac store (`hermes-projects`) and point at folders on that Mac. Writing voices live in a per-stack store (`writingVoicesStoreName`).

## Decision

1. **Settings gets a Chat history panel** with **Export history…** and **Import history…**. Both run in the main process; the renderer sees progress and counts only.

2. **An export is one folder holding the stack's files and Boundary's.** Boundary asks for a parent folder and creates `Boundary history <date>` inside it, so the stack's empty-folder rule always holds. It runs `sessions.sh export --dest <that folder> --json` through the stack host's `runScript`, the way add-on scripts run (`runAddonScript`), then writes `boundary.json` beside the stack's files, mode 0600. The panel says the folder holds whole chats, unencrypted, and should be kept like a backup.

3. **`boundary.json` carries Boundary's state for the exported sessions**, with `"format":"boundary-history/1"`, the app version and the source stack's kind:
   - every agent record, with the text of its profile's `SOUL.md`, read through `StackFiles`;
   - for each session id in the agent store, its profile name (the owning agent's slug, or `default` for the built-in agent and rooms) and its slices of the records listed in Context;
   - rooms and their posts;
   - the project records the exported sessions and rooms point at (id, name, kind, host path);
   - the writing voice records those sessions, replies and agents point at.

   It leaves out what belongs to one install: `lastOpened`, `mentionsSeenAt`, `failedChats` (sends Hermes never stored), `roomSoulsSent` and `roomVoicesSent` (a target sends them again once), and `orchestrator`.

4. **Boundary never opens the `.jsonl` files.** It reads `manifest.json` for counts and profile names, and its own `boundary.json`. Logs and the debug log carry counts, profile names and session ids, never titles, posts or voice text.

5. **Import starts with a review.** Boundary checks that the folder has a `manifest.json` in the `assistant-sessions/1` format and, when present, a `boundary.json` it can read. The review sheet lists each profile with its session count from the manifest and says which agents this install lacks. A folder without `boundary.json` (made with `sessions.sh` directly) still imports; its chats arrive without Boundary's filing and show as unfiled chats of their profile.

6. **Missing agents can be created first.** For each profile the target lacks whose agent is in `boundary.json`, the review offers to create it, on by default. Boundary creates it with the exported slug, not a fresh one, since import matches profiles by name; a slug already taken here means the agent exists, so nothing is created. It writes the exported `SOUL.md`. The agent's model and toolsets start at this install's defaults, and the sheet says so. An agent left uncreated is reported as not moved, and importing the same folder again after creating it picks up its chats.

7. **Then the stack imports.** Boundary runs `sessions.sh import --from <folder> --json`, shows each profile line as it arrives, and keeps the final line. Exit 1 with `failed` above 0 is a partial result, not an error. Other errors show the stack's named error.

8. **Then Boundary reapplies its state, without overwriting.** The sessions it applies to are those whose profile was imported, minus `refused_ids`, `too_large_ids`, `invalid_ids` and `failed_ids`. Once the stack adds R6's id lists, Boundary uses them instead. For each of those sessions:
   - a record the target already has for that id is kept, and the exported one dropped;
   - a project id this Mac knows is kept. Otherwise a project with the same kind and host path here is used. Otherwise the chat is filed under No project, and the result lists the project's name;
   - a writing voice id this stack lacks is added from `boundary.json`, unless a voice with the same name exists, which is used instead;
   - `standingDmByAgent` is set only when the target has none for that agent.

   Rooms are added when their id is new, with their posts; a member whose agent wasn't created is dropped from the room's members. Applying the same folder twice changes nothing the second time.

9. **The chat list refreshes when the import ends.** Boundary doesn't wait for `sessions.changed`, which a direct write to the store may not send (not yet checked). It refetches the chat list and tells every window to reload it.

10. **The result says what didn't move.** Counts of chats moved, already here, and not moved by reason: deleted on this install, too large to import, unreadable, failed, or belonging to an agent that wasn't created. Projects that weren't found are named. **Retry** runs steps 7–9 again when anything failed. The export folder is never changed or deleted by an import.

11. **One history action at a time, and it can be cancelled.** Export and import are held while the other runs. **Cancel** stops the script (ADR 0046). Each import batch is one transaction, so a cancelled import leaves whole sessions, and running it again skips them. A cancelled export leaves a partial folder, which Boundary deletes because it created it.

12. **Import waits on the stack's title fix (CR 0039 R5).** Until a stack release has it, **Import history…** is shown disabled with a line saying it needs a newer agent stack. Export ships first, so people can take a copy before they move.

13. **Remote stack hosts come later.** On a remote host the export folder would be on the other machine, and `StackFiles` has no way to copy a folder of that size between hosts. Both actions show disabled there with a line saying so, as ADR 0067 §8 does for removal. Moving history onto or off a remote host is a separate decision.

14. **The stack contract and tests.** The [stack contract](../stack-contract.md) gets a row for `sessions.sh` export and import and the JSON line shapes above. A `test:stack` case runs export and import between two synthetic Hermes homes, through Boundary's runner, and checks the profile lines and the reapplied records. Unit fakes use the line shapes confirmed above. A mounted-runtime test checks that imported chats show in the chat list without a restart.

## Consequences

- Chats move without stopping the stack, and an import adds to the target's history instead of replacing it.
- Some chats can't move: sessions over 5 MB or 10,000 messages (R8), and sessions deleted on the target. A target with an older copy of a session keeps that copy (R7). The result counts each, so nothing goes missing without a word.
- Images and audio under the Hermes home's `cache/` and spilled tool results stay behind (R4). A moved chat shows a broken reference where one was.
- A recreated agent has its persona but this install's model and toolsets. Per-model usage for an imported session starts empty, since the export doesn't carry it.
- The export folder holds whole chats, unencrypted, including room posts from Boundary. Boundary writes it with owner-only permissions and doesn't encrypt it.
- Moving between the local agent stack and the managed install on one Mac uses the same flow: each stack has its own agent store, and the project store is shared, so projects match by id.
- Boundary depends on `sessions.sh`'s line shapes and on its matching profiles by name. A change to either is a stack contract change.
