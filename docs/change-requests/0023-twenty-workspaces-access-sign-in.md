# 0023 · Twenty: access changes, local workspaces while off, approvals, sign-in and onboarding

**Serves:** phase 4 of the [add-ons spec](../addons-ux-study/spec.md) (Twenty access, approvals and sign-in), mocked in [`phase4.html`](../addons-ux-study/phase4.html).
**Status:** Open

## Background

Boundary's Twenty page lists every workspace in `compose/twenty/workspaces/`: the local one from `crm init` and any hosted ones from `crm.sh add`. Each row has an access switch, **Open Twenty** for the local workspace, and **Connect**, **Disconnect**, **Turn off** and **Remove**. Checked against v0.3.10, the tag Boundary pins:

- `crm.sh add` and `crm.sh remove` do what the page needs, and are unchanged in v0.3.11. Boundary runs `add` with `TWENTY_KEY_RW`, `TWENTY_KEY_RO` and `TWENTY_ACCESS` in the environment, so nothing is asked.
- `twenty_admin.py`'s `write_workspace_file` writes `TWENTY_URL`, `TWENTY_WORKSPACE_URL`, `TWENTY_WORKSPACE_ID` and the two keys, and no `TWENTY_ACCESS`. `crm init --rotate` rewrites the whole file.
- `bootstrap-api-profile.sh` registers every `*.env` in the workspaces folder while `TWENTY_MCP_ENABLED=1`, whether or not the local instance is running.
- Hermes v0.22.7 asks before an MCP call only on a `trust: untrusted` server, and only for a tool without `readOnlyHint=true` (`tools/mcp_tool_handlers.py`, `_trust_gate_check`). It doesn't read the call's arguments. The prompt goes through the gateway approval queue that Boundary already answers.
- Twenty's web app signs a browser in from `/verify?loginToken=…` (`VerifyLoginTokenEffect.tsx`), and `LOGIN_TOKEN_EXPIRES_IN` defaults to 15 minutes. Twenty tracks onboarding as `PROFILE_CREATION`, `SYNC_EMAIL`, `INVITE_TEAM`, `BOOK_CALL` and `COMPLETED`, and `crm init` completes none of them. These three come from Twenty's `main` branch, since its newest GitHub tag is v2.9.0; they need confirming in the pinned `twentycrm/twenty:v2.55.0` image.

## R1 · Change a workspace's access, and keep it across `init` (Wanted)

**Why:** the page lets the user switch a workspace between **Look things up** and **Make changes** after setup. Boundary holds no keys, so it can't re-run `crm.sh add --force`, and `crm init --rotate` would drop an access line Boundary wrote.

**Ask:** `crm.sh access --slug S read|write` sets `TWENTY_ACCESS` in that workspace file and refuses `read` when the file has no `TWENTY_KEY_RO` (or `write` without `TWENTY_KEY_RW`). `crm init` keeps an existing `TWENTY_ACCESS` when it rewrites a file.

**Acceptance:** `crm.sh access --slug main read`, then `crm init --rotate`, leaves `TWENTY_ACCESS=read` in `main.env`, and the next bootstrap gives the default profile `TWENTY_MAIN_KEY` set to the read-only key.

**Boundary fallback:** Boundary rewrites only the `TWENTY_ACCESS` line in the workspace file, and writes it again after any `crm init`. Removed once the pinned tag has R1.

## R2 · Don't register local workspaces while the local instance is off (Wanted)

**Why:** a user moving to a hosted Twenty turns off the local one and keeps the hosted workspace. `TWENTY_MCP_ENABLED` stays 1, so the bootstrap still registers `crm-main` against a `twenty-server` that isn't running.

**Ask:** pass `TWENTY_LOCAL_ENABLED` to both bootstrap services. While it's 0, skip workspace files whose `TWENTY_URL` is `http://twenty-server:3000` and drop their entries and keys, as `reconcile_twenty_workspaces` does for removed files.

**Acceptance:** with `main.env` and `work.env` present, `TWENTY_MCP_ENABLED=1` and `TWENTY_LOCAL_ENABLED=0`, both profiles hold `crm-work` and no `crm-main`. Setting `TWENTY_LOCAL_ENABLED=1` brings `crm-main` back.

**Boundary fallback:** Turn off renames `main.env` to `main.env.off`, which the bootstrap's `*.env` glob skips. Turn on and install rename it back, and Remove deletes it. Removed once the pinned tag has R2.

## R3 · Ask before Twenty writes, not before lookups (Wanted)

**Why:** the spec's third access setting, **Make changes after asking you**, needs Hermes to ask before a record change and let lookups through. Every Twenty record call goes through `execute_tool`, so `trust: untrusted` on a `crm-*` server would ask before every lookup as well.

**Ask:** a workspace-file setting, for example `TWENTY_APPROVAL=writes`, that makes Hermes ask before `execute_tool` calls whose inner tool changes data (`create_*`, `update_*`, `delete_*`, and any other write in Twenty's tool catalog) and lets the rest through. Two routes we can see: a small gate in the stack in front of Twenty's `/mcp` that splits record tools into read and write tools with `readOnlyHint` set, registered as `trust: untrusted`, or argument-aware trust rules in Hermes upstream. The stack knows which fits better.

**Acceptance:** with the setting on, a `find_many_people` call runs without a prompt and a `create_one_company` call raises a gateway approval. Unattended runs keep the read-only key, so they never prompt.

**Boundary fallback:** the page offers two settings, **Look things up** and **Make changes**, until the pinned tag has R3.

## R4 · A sign-in link for the local workspace (Wanted)

**Why:** **Open Twenty** should open the CRM signed in, with no sign-in page, because the user never chose the owner's password.

**Ask:** `crm.sh login-link [--slug S]` signs in as the local owner, takes the workspace's `loginToken` from `signIn`'s `availableWorkspacesForSignIn`, and prints one line, `<TWENTY_WORKSPACE_URL>verify?loginToken=<token>`, to stdout, with progress and errors on stderr. It refuses workspaces whose `TWENTY_URL` isn't the local instance.

**Acceptance:** opening the printed URL in a browser with no Twenty session lands in the workspace signed in as the owner. The URL stops working after `LOGIN_TOKEN_EXPIRES_IN`.

**Boundary fallback:** Boundary's main process makes the same two calls: `signIn` with the owner's password from the stack's `.env` (or `TWENTY_PASSWORD_FILE`), then builds the URL from the workspace file. Removed once the pinned tag has R4.

## R5 · Finish Twenty's onboarding in `crm init` (Wanted)

**Why:** after R4 the first open should show the CRM. Without this it probably shows Twenty's welcome steps for a profile the user didn't create.

**Ask:** `crm init` accepts the owner's first and last name (for example `TWENTY_OWNER_FIRST_NAME` and `TWENTY_OWNER_LAST_NAME`, defaulting to `Owner`), sets them on the owner's workspace member, and completes or skips the profile, email sync, team invite and book-a-call steps, so the owner's onboarding status is `COMPLETED`. Boundary passes the Mac account's full name.

**Acceptance:** after `crm init` with the two names set, signing in through R4's link shows the workspace's records, and the owner's name reads as given.

**Boundary fallback:** none. Twenty shows its welcome steps on the first open until the pinned tag has R5.
