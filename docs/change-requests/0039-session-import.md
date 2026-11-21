# 0039 · Moving chat history between installs

**Serves:** Chat history in Boundary: an **Export history** and **Import history** action in Settings, for moving to another Mac, from a local stack to a managed install, or onto a remote stack host ([CR 0037](0037-remote-stack-host.md)).
**Status:** R1–R3 released in stack v0.3.16 as `scripts/sessions.sh` · R4 not done · R5 (a clashing title is renamed, reported as `renamed`) and R6 (`session_ids` in the manifest, `imported_ids` and `skipped_ids` on import lines) released in v0.3.17, which Boundary pins · R7 and R8 asked, Later · Boundary's export built, import not built

## Background

Read in the `nousresearch/hermes-agent:v0.23.1` image.

`hermes sessions export --format jsonl` writes one session per line from `SessionDB.export_all` (or `export_session` with `--session-id`). Redaction is off unless `--redact` is given. Nothing in the CLI reads that file back.

The store can already take it. `SessionDB.import_sessions` (`hermes_state_portability.py`) accepts the dicts `export_session` and `export_all` return. It skips ids that already exist, refuses an id that was deleted here, detaches a child whose parent is neither present nor in the payload, and resets gateway routing, handoff, rewind and `last_activity_*` so an imported row is history, not a live channel. One call takes at most 500 sessions, 10,000 messages per session and 50,000 messages in all (`_IMPORT_MAX_*` in `hermes_state.py`). Its callers today are `adopt_session_lineage_from` and the profile repair in `hermes_cli/sessions_repair_profiles.py`, which uses the separate `export_session_for_move` / `import_moved_session` pair.

Each profile keeps its own `state.db` under `profiles/<name>/`, beside the default profile's at the Hermes home. Boundary lists a profile's chats with `session.list` and its `profile` parameter, so a session imported into the right profile's database with its id intact shows up in Boundary's chat list without further work.

Today the only way to move history is to copy `state.db` files with the stack stopped. That replaces the target's history instead of adding to it, and it leaves out sessions in profiles the copy doesn't cover.

## R1 · A stack command that exports and imports sessions (Wanted)

**Why:** the import logic exists in Hermes but has no entry point, and Boundary should not open `state.db` or handle transcripts itself.

**Ask:** a stack script, for example `scripts/sessions.sh export --dest DIR --json` and `scripts/sessions.sh import --from DIR --json`, run against the stack's `hermes` service.

- `export` writes one jsonl file per profile, including the default profile, and a manifest naming each file's profile, session count and Hermes version. No redaction, since the file is a move and not a share. Compacted turns are included if the jsonl projection leaves them out by default.
- `import` reads each file into the matching profile's database through `import_sessions`, in batches under the `_IMPORT_MAX_*` limits. A parent and its children go in the same batch where the limits allow, so fewer children are detached.
- Both print JSON lines with counts and ids only: per profile, how many were imported, skipped, detached and refused, and a final line with the totals and exit code. No titles, previews or message text, so a client can show progress without seeing content.
- Running `import` twice with the same export imports nothing the second time.

Upstream, this would be `hermes sessions import`, the counterpart of `sessions export`. If you'd rather add it there and wrap it, that works for Boundary as long as the script's JSON output stays the same.

**Acceptance:** export from a stack with sessions in the default profile and one other profile; import into a fresh stack; `session.list` on each profile returns the same ids with the same message counts. A second import reports every session as skipped.

**Boundary fallback:** none. People can run `hermes sessions export --format md` for a readable archive, but nothing loads it back.

## R2 · Profiles the target doesn't have (Wanted)

**Why:** sessions belong to a profile, and two installs rarely have the same set. A local stack may have `software-engineer`; a fresh managed install has only the built-in profiles.

**Ask:** pick one behaviour and document it. Boundary's preference, in order: import into a profile of the same name when it exists; otherwise create the profile from the export's manifest if the stack can do that safely, or skip that profile's file and report it by name as `profile_missing`. Never fold another profile's sessions into the default profile without a flag that asks for it.

**Acceptance:** an export holding a profile the target lacks either creates it or reports `profile_missing` with its session count, and imports everything else.

**Boundary fallback:** none. Boundary would list skipped profiles from the JSON output and tell the person to create the agent first.

## R3 · Importing while the gateway runs (Wanted)

**Why:** Boundary keeps the stack running. Stopping `hermes` for an import means closing open chats and restarting MCP servers.

**Ask:** say whether `import_sessions` through `_execute_write` is safe beside a live gateway on the same `state.db`, or whether the script must stop and start `hermes` the way `backup.sh --stop` does. If it can run live, say whether the gateway's session list needs a refresh to show new rows.

**Acceptance:** the doc for the command says which, and a live import (if allowed) lists the new sessions in `session.list` without a restart.

**Boundary fallback:** if a stop is needed, Boundary shows that the agent will restart before it runs the import.

## R4 · Files messages point at (Later)

**Why:** a message can refer to an image, attachment or paste stored beside `state.db` (`attachments/`, `images/`, `pastes/`). Moving the rows without the files leaves broken references.

**Ask:** say which folders a moved session needs, and either carry them in the export or name what is left behind in the manifest.

**Acceptance:** a session with an image attachment shows the image after import, or the import output counts the missing files.

**Boundary fallback:** none.

## Released

Stack v0.3.16 ships `scripts/sessions.sh export --dest DIR` and `import --from DIR`, with `--profile NAME` and `--json` (its CHANGELOG, "Host scripts", and `docs/sessions.md`). Checked against the asks in the script's header and docs at the tag:

- R1: export writes `<profile>.jsonl` per profile, `default` for the Hermes home, mode 0600 in a 0700 folder, and `manifest.json` with each file's session and message counts, the stack version and the Hermes image. Lines come from `export_all(include_inactive=True)`, so compacted turns are kept, and nothing is redacted. Import goes through `import_sessions` in batches under Hermes' caps, parents before children, and reports per profile `imported`, `skipped`, `detached`, `refused`, `too_large`, `invalid` and `failed` with ids only. A second import skips every session. The acceptance run (two stacks, `session.list` on each profile) hasn't been done from Boundary.
- R2: a profile the target lacks is skipped with `"status":"profile_missing"` and its session count, never folded into another profile.
- R3: import runs beside a live gateway; each batch is one write transaction through `_execute_write`, and `session.list` shows the rows without a restart.
- R4 is not done: files under the Hermes home's `cache/` and spilled tool results stay behind. The stack's docs say so, but neither the manifest nor the import output names or counts them.

The stack's reply corrected the Background on these points, each confirmed in the v0.23.1 image:

- `hermes sessions import` already exists upstream (`hermes_cli/foreign_sessions.py`, `--from claude|codex`), so it isn't free for the counterpart of `sessions export`. The script calls `SessionDB` from a module run inside the `hermes` container instead.
- One `import_sessions` call writes nothing when any entry is invalid or was deleted on the target; it doesn't refuse per session. The script checks ids before batching.
- Besides the count caps, Hermes caps an import at 5 MB per session and 25 MB per call (`_IMPORT_MAX_SESSION_BYTES`, `_IMPORT_MAX_TOTAL_BYTES`). A session over 10,000 message rows or 5 MB is reported as `too_large` and can't be imported.
- `include_inactive=True` is the right export flag, not `include_compacted`: the `export_session` docstring says `include_compacted` would make archived turns live context again on import.
- Parents don't need to share a batch with their children: `_attach_import_parents` looks the parent up in the store.

Also checked at the tag: `bad_input` exits 2, `command_failed` 4, and `hermes_not_running` 1 (`jl_exit_code`), as the reply says. The script's header comment says 4 for `hermes_not_running`. An import with `failed` above 0 also exits 1; its last line is a `done` line rather than an `error` line. The export doesn't carry `session_model_usage` rows, so per-model usage for an imported session starts empty.

## R5 · Imports fail on a title the target already has (Wanted, bug)

**Why:** `sessions` has a unique index on `title` (`idx_sessions_title_unique` in `hermes_state_schema.py`), and `_import_session_row` inserts the exported title unchanged. A title the target already holds raises `sqlite3.IntegrityError` inside `_execute_write`, which rolls back the whole call. `sessions_move.py` then marks every session in that batch, up to 500, as `failed`, and a second run fails the same way. Two installs belonging to one person can easily hold the same title, for example a recurring scheduled chat. Hermes's other import paths already handle this: `import_foreign_history` and `import_moved_session` append ` (<last 12 characters of the id>)` to a clashing title.

Reproduced in a throwaway `nousresearch/hermes-agent:v0.23.1` container on a synthetic store: import session `a1` titled "Weekly plan"; then import `b2` titled "Weekly plan" and `c3` titled "Other" in one call. The second call raises `IntegrityError: UNIQUE constraint failed: sessions.title`, and the store holds only `a1`.

**Ask:** before batching, give a session whose title the target already holds (or that an earlier session in the same import took) the id-tail suffix Hermes uses, and count those as `renamed` with their ids. If a batch still raises, retry its sessions one at a time so one bad session can't fail the rest. Add the case to `scripts/test-sessions-sh.sh`.

**Acceptance:** importing a session whose title the target already has imports it under the suffixed title, reports it as `renamed`, and imports the rest of its batch.

**Boundary fallback:** none. Boundary would show those chats as failed, with a Retry that fails again.

## R6 · Which session ids the target now holds (Wanted)

**Why:** Boundary reapplies its own per-session state after an import, but only to sessions the target now holds. The reply says to apply it to every session except `refused_ids`, `too_large_ids`, `invalid_ids` and `failed_ids`. That needs the full list of ids in the export, which Boundary doesn't have: it must not read the `.jsonl` files, and the manifest carries counts only. A `profile_missing` line carries no ids at all. Boundary's own records don't stand in for the list either, since a session can exist in Hermes without a Boundary record, and the two exports are taken moments apart. `import_sessions` already returns `imported_ids` and `skipped_ids`; `sessions_move.py` drops them.

**Ask:** add `imported_ids` and `skipped_ids` to each import `profile` line, and add `session_ids` to each manifest profile entry, so a `profile_missing` profile's sessions can be named too.

**Acceptance:** for every profile in an import, `imported_ids`, `skipped_ids` and the four error lists together hold every id in that profile's manifest entry.

**Boundary fallback:** reapply state only to ids that are both in Boundary's records and absent from the error lists, and skip every session of a `profile_missing` profile. A session created between the two exports is left without its state.

## R7 · Sessions skipped with fewer messages than the export (Later)

**Why:** `skipped` compares ids only. When someone moves history back to an install that holds an older copy of a session, the older copy stays, and the turns added since are dropped without a word.

**Ask:** count a skipped session whose stored `message_count` is lower than the export's as `stale`, with its ids. Leave replacing it to a later flag.

**Acceptance:** importing an export whose session has more messages than the target's copy reports that id under `stale_ids`.

**Boundary fallback:** none. Boundary can't tell an unchanged session from a stale one.

## R8 · Sessions over the import caps (Later)

**Why:** a long chat with large tool results can pass 5 MB, and those are often the chats people most want to keep. `too_large` sessions can't move at all. `import_moved_session` (`hermes_state_profile_repair.py`) has no size caps, but it keeps gateway routing and other live state that `import_sessions` resets, so it isn't a drop-in route.

**Ask:** say whether a `too_large` session can be imported another way with `import_sessions`' resets applied, for example in chunks of messages inside one transaction. If not, say so in `docs/sessions.md`.

**Acceptance:** a synthetic 6 MB session either imports, or the docs say why it can't.

**Boundary fallback:** list the chats that didn't move, by count, and keep the export folder so they can be retried after a later stack release.

## Boundary's side

Boundary keeps much more than the project and channel by session id. The per-stack agent store (`hermesAgentStore.ts`) holds `sessionMeta` (agent, channel, project, branch, inference override, writing voice), `sessionSpeakers`, `sessionAliases`, `standingDmByAgent`, the inference, writing voice and project marks, reply endings, `noReplies` and the voices replies and prompts were written in. It also holds `channelPosts`, the user's own lines in rooms, which exist only in Boundary. Projects live in a separate store and point at folders that may not exist on the target Mac.

Boundary's export therefore writes its own file into the stack's export folder, with the same 0600 mode, since it holds chat content too. On import it reapplies that state to the ids the stack reports as present (R6, or its fallback). It never overwrites a record the target already has. A chat whose project folder is missing goes under No project. For a `profile_missing` profile, Boundary holds the agent's own record, so it can offer to create the agent and import that profile again. Boundary refreshes the chat list after an import rather than waiting for `sessions.changed`, which a direct write to the store probably doesn't send (not yet checked).

Boundary's stack pin is v0.3.16, so the commands are available now; the Settings actions wait on R5, since without it an import can fail in a way Retry can't fix. The design is [ADR 0070](../adr/0070-moving-chat-history-between-installs.md). A `test:stack` case will drive `sessions.sh export` and `import` between two synthetic homes, including a title clash once R5 lands, and the stack contract table gains a row for `sessions.sh` in the same change.
