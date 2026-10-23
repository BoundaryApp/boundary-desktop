# Room lifecycle plan (ADR 0010)

ADR 0010 was drafted on 2026-09-23 and part-built in a stash that never landed. Main moved 166
commits past the stash's base, including ADRs 0023 (chat types), 0024 (chats belong to projects)
and the session-id repair, so the stash was a reference, not a patch. This plan brings the ADR and
the work current.

## Where each decision stands on main

| § | Decision | Main today | Stash code | Effort |
| --- | --- | --- | --- | --- |
| 1 | Per-message who-lines | Durable after reload (`annotateMessagesWithSpeakers`, `toThreadMessage`, `useReplySpeaker`). A live room wake still streams every agent into one bubble under the last speaker's name. | Adapter yields `agentSlug`; its `streamPrefix` removal makes the live bubble worse | Small–medium |
| 2 | Remove member | **Shipped** in `a47f54c` (Room tab Remove, `removeHermesChannelMember`) | Same function | None |
| 3 | Channel rename + delete | Not built | `renameHermesChannel`, `deleteHermesChannel`, both sheets, IPC | Medium |
| 4 | Agent edit, no delete | Not built; roster and Agent tab are read-only | `updateHermesAgent` (local store only), sheet `mode='edit'` | Small–medium |
| 5 | `@` not-in-channel adds and inserts | Not built; the row opens the Add-to-channel sheet | Add, then insert on success | Small |
| 6 | Draft card | Owner gate shipped. The raw `agent-draft` fence still shows; a failed Create from the card sets an error nobody sees | `stripAgentDraftFence`, open sheet on error | Small |

## What later ADRs change

- **Terms.** "Assistant" is now Hermes, the built-in agent. Recent is All chats, and
  "leftover" and *Keep as DM* are gone (0023 §4–5). A channel's session with no room falls to
  an ordinary Hermes chat.
- **Delete.** A room can link several session ids (`listSessionsForChannel`), so delete clears
  `channelId` on all of them. It copies the room's `projectId` onto the session so 0024 filing
  holds. Landing is still never All chats, but 0024 adds project pages as a candidate.
- **Rename.** The rail keeps a `#`-titled session's own title, so rename has to retitle the
  Hermes session too. That needs a `session.title` wrapper in `hermesGatewaySession.ts`.
  `reconcileChannelSessions` matches sessions titled `#slug` and must keep working.
- **Agent edit.** The built-in's name comes from its record and the user can't rename it
  (0023 §8, chat-types spec non-goals). `Hermes` stays a reserved handle. The role lives in
  the Hermes profile's soul, so an edit calls `profiles.configure`, not just the local store.
- **Duplicate handles are allowed** (0023 consequences: the @ menu tells them apart by mark
  and role). The only rejected handle is the built-in's.
- **UI homes.** Rename and Delete belong in the title's chat menu (0024 §5). Edit belongs on
  the Agent tab as well as the roster.

## Drop from the stash

Remove member (shipped), the `127.0.0.1:7859` debug logging, `remintGatewaySession` and the
adapter's delayed session resolve (replaced by `3d81df7`), rail snapshot deduping (replaced by
`keepIfEqual` and `chatScreenCache`), the `AssistantMessage`/`AssistantWho` restructure
(main's message row has moved on), the `streamPrefix` removal on its own, and the stash CSS.

## Order

1. **Re-decide the ADR.** Re-date it, set it to Proposed, fix terms and links (parent 0008;
   related 0009, 0014, 0023, 0024), record §2 as shipped, and settle the open questions below.
   Then add it to the ADR index, 0002/0008 children, and the chat-ux-study READMEs.
2. **§6 draft polish.** Strip the fence before rendering; open the create sheet on error.
3. **§5 `@`-add-and-insert.** `handleChangeMember` returns whether the add worked; insert via
   the composer store.
4. **§1 live who-lines.** Tag streamed turns with `agentSlug`, and give each woken agent its
   own bubble while streaming.
5. **§3 rename.** Gateway `session.title` wrapper, `renameHermesChannel` with
   `uniqueChannelSlug(base, exceptId)`, rename sheet from the title menu.
6. **§3 delete.** Rewritten delete semantics, delete sheet with new copy, landing per the ADR.
7. **§4 agent edit.** Guards for the built-in and reserved handle, `profiles.configure` for the
   role, edit mode on the create sheet, Edit on the roster and Agent tab.

Each step is its own commit with tests; in-app checks go to a checklist at the end.

## Decided (2026-10-10)

- After deleting a channel, land in the room's project (its newest chat, else its page);
  with no project, use the usual landing.
- Deleting a channel drops its Mentions cards.
- The built-in agent isn't editable.
- Live who-lines: one bubble per woken agent while streaming.

## In-app checks

Run these once the branch is merged into `main` (or the worktree is copied into the project
folder). Each step adds its checks here.

**Step 1: draft card (§6)**
1. In a chat, ask Hermes to propose a new agent as an `agent-draft` block. The reply shows the
   card and the prose around it, with no raw block.
2. On a card, use the handle `Hermes` and click **Create agent**. The New agent sheet opens,
   filled in from the card, with the error.

**Step 2: `@` someone not in the room (§5)**
3. In a channel, type `@` and pick an agent marked "Not in channel". They join the room's
   members (Room tab), and `@Name ` is in the composer.

**Step 3: live who-lines (§1)**
4. In a channel with Hermes and one personality, send `@Ana check the pricing and ask @Hermes
   to confirm` (use your agent's name). While it streams there are two sections, each with
   its own name and mark, and no `**Hermes:**` line in the text.
5. Leave the chat and come back. It looks the same, now as two separate messages.

**Step 4: channel rename (§3)**
6. In a channel, open the title menu (the `#slug` in the header) and choose **Rename
   channel…**. Change the name; the slug follows it unless you edit the slug yourself.
7. After **Rename**, the header and the rail show the new `#slug` straight away, and the
   members and transcript are unchanged.
8. Rename a second channel to the first one's name. Its slug gets `-2`.
9. Quit and relaunch. The room keeps its new name, and Hermes WebUI lists the session under
   the new `#slug`.

**Step 5: channel delete (§3)**
10. In a channel filed under a project, open the title menu and choose **Delete channel…**.
    The sheet names the project the transcript will be filed in and warns that posts since
    the last @ won't be in it.
11. After **Delete channel**, you land on that project's newest other chat (or its project
    page if it has none), never on All chats. The room is gone from the rail, and its
    Mentions cards are gone.
12. The old transcript is listed as a Hermes chat titled `#slug` in that project, and opens
    with the conversation intact.
13. Delete a channel under No project. You land on your newest Hermes chat (or an empty
    Hermes composer if there are none).
14. Quit and relaunch. The deleted room doesn't come back, and the app doesn't try to open it.

**Step 6: agent edit (§4)**
15. Open **All agents…**. Each personality has **Edit**; Hermes doesn't. The Agent tab of a
    personality's DM has **Edit** too.
16. Edit a personality's name, handle and role and **Save**. The roster, the DM's header and
    the Agent tab show the new name and role; `@` in a channel finds the new handle.
17. On the Agent tab, the Soul excerpt shows the new role, and **Open SOUL.md** shows the
    new `# Name` line and role with the rest of the file unchanged. Ask the agent in its DM
    what its role is; it answers with the new one.
18. Edit SOUL.md by hand (change its first line), then change the role in Boundary. Saving
    says SOUL.md kept your edits, and the file is unchanged.
19. Try to rename a personality to `Hermes`. The sheet shows the error and nothing changes.
