# 0026 · Actual Budget: budgets per person, the credential that signs in, and read-only runs

**Serves:** Actual Budget in the stack (the `budget` and `budget-local` profiles), which Boundary doesn't turn on yet, and later [ADR 0048](../adr/0048-sharing-a-service-with-a-circle.md) when a budget is shared with a Circle.
**Status:** R1, R2, R4 and R5 merged on the stack's `main` for 0.3.13 · `budget.sh` is the Actual hooks for `addon.sh` (CR 0020) · ended-session fix merged, unreleased · R3 accepted for later, Boundary asks to move it to Wanted (round 8) · round 7 (three follow-ups from Boundary's build) accepted, planned, not built; Boundary keeps its fallbacks until a release has them

## Background

The stack is moving from one budget signed in with Actual's server password to several budgets, each tied to a person, with `budget-<slug>` MCP entries on that person's Hermes profile signed in with the person's own credential. The stack asked four questions: who runs `actual-server` and the OpenID provider, how a person's credential reaches the stack, whether attribution matters, and what unattended runs get. This request answers them and asks for the interface Boundary would call.

Checked in the `actualbudget/actual-server:26.11.0` image the stack pins, read in a container with no network, and in `compose/actual-mcp` at v0.3.11:

- **No API keys in 26.11.0.** The server's code has no API key table, migration or route; its `Bearer` headers are all for bank sync. A sign-in creates a session (`sessions`: `token`, `expires_at`, `user_id`, `auth_method`), which a client sends as `x-actual-token`. `expires_at` is `-1` (never) unless `token_expiration` sets minutes; it can also follow the OpenID provider's expiry. The vendored MCP server already takes `ACTUAL_SESSION_TOKEN` in place of `ACTUAL_PASSWORD`.
- **Password login is one user.** `loginWithPassword` always signs in as the user with an empty `user_name`, so every password client is the same person.
- **Access is per budget, all or nothing.** `user_access` holds `(user_id, file_id)` with no permission column, so a user given a budget can do everything in it. Read-only has to come from the read-only MCP server, as it does today.
- **Changes carry no author.** Synced changes are stored in `messages_binary` as `timestamp`, `is_encrypted` and `content`, with no user. Whichever credential Hermes uses, Actual doesn't record who made an edit.
- **Disabling a user ends their sessions.** `getSession` only returns sessions of users with `enabled = 1`.
- **The MCP server keeps sessions.** `/mcp` uses `StreamableHTTPServerTransport` with a `sessionIdGenerator`, so a client carries `Mcp-Session-Id` across calls.

If the budget API keys you describe are in a newer Actual, please name the version and what a key covers, since the answers below assume 26.11.0.

> **Stack reply:** accurate, and it corrects us. There are no API keys in the pinned 26.11.0
> image. Our earlier note took them from Actual's current docs without checking the image we pin.
> The credential is a session token, which the vendored MCP server already accepts as
> `ACTUAL_SESSION_TOKEN`. It wins over `ACTUAL_PASSWORD` when both are set
> (`integrations/actual/connection.ts`).
>
> We accept the two consequences you point out. Actual records no author, so per-person
> credentials only decide which budgets a person can open. And password login is always the same
> user, so on the local single-user server every profile is the same identity. We'll build this
> as "connect budget X to profile Y". A remote multi-user server is the one case where the
> credentials differ per person.
>
> **`Mcp-Session-Id` lifetime**, from reading `src/index.ts`: a session lasts until the client
> closes it (`DELETE /mcp`) or the server process restarts. There is no idle expiry. A restart
> loses every session, so a client has to treat an unknown session as a reason to send a new
> `initialize`.

## Answers

**1. Who runs the server and the OpenID provider.** The local `actual-server` runs on the user's Mac through `budget-local`, single-user with the server password, as in v0.3.12. Boundary won't run or set up an OpenID provider. Multi-user mode is labelled preview and experimental, the first OpenID sign-in becomes the permanent owner, and every person needs an account with the provider, which is too much for a default install. A household that runs its own multi-user Actual server connects to it as a remote URL, which the stack already supports.

> **Stack reply:** agreed. The stack won't add an OpenID provider. `budget-local` stays
> single-user with the server password. A household's own multi-user server connects as a remote
> URL.

**2. How a person's credential reaches the stack.** Boundary asks for it in a sheet, keeps it encrypted with `safeStorage`, and calls a stack command with it in the environment (R1). Boundary names the Hermes profile in that call, so the stack doesn't need its own map of people to profiles. On 26.11.0 the credential is a session token.

> **Stack reply:** agreed. One gap: 26.11.0 has no screen that shows a session token. On a
> password server, `connect` can take `ACTUAL_PASSWORD`, sign in itself, and store the session it
> gets back, so the sheet only asks for the password. On a remote OpenID server, the person has
> to sign in in a browser and copy the token from the web app's local storage. That works but is
> awkward. If Boundary already shows that server in a web view, reading the token there would
> spare the user the step.
>
> To check: whether changing the server password ends sessions created by an earlier password
> sign-in. If it doesn't, a stored session outlives a password change, and we'll say so in the
> docs.

> **Boundary reply:** the password-only sheet works for us. Boundary doesn't show Actual in a web view, so for a remote OpenID server the copy step stays until it does. Please put the answer to the password-change check in R1's error list (see our follow-up there).

**3. Attribution.** It would matter, and it's why Boundary gives each person their own Twenty keys. Actual doesn't record an author on 26.11.0, so per-person credentials only separate who can open which budget. A single account is fine to start with. Per-person credentials are worth it for a remote multi-user server, where Actual decides which budgets each person sees.

> **Stack reply:** understood. Actual stores no author on changes, so we won't claim attribution
> anywhere.

**4. Unattended runs.** Read-only access to the person's budgets, as today, through the read-only MCP server (R2). This matches Twenty, where unattended runs get the read key.

> **Stack reply:** agreed, through the read-only MCP server. See R2 for what this changes in the
> stack.

## R1 · Connect a budget to one profile with a command (Wanted)

**Why:** Boundary connects budgets from its UI, as it does Twenty workspaces, and needs one command that checks the credential, writes the entry and reloads Hermes, with output it can read.

**Ask:** `scripts/addon.sh connect actual --json` (or `budget.sh add` until `addon.sh` exists) with these in the environment:

| Key | Required | Meaning |
| --- | --- | --- |
| `ACTUAL_SLUG` | yes | Hermes sees `budget-<slug>` |
| `ACTUAL_PROFILE` | no, default `default` | The Hermes profile that gets the entries |
| `ACTUAL_SERVER_URL` | yes | `http://actual-server:5006` for the local server, or a remote `https://` URL |
| `ACTUAL_BUDGET_SYNC_ID` | yes | The budget's Sync ID |
| `ACTUAL_PASSWORD` or `ACTUAL_SESSION_TOKEN` | one of the two | The token wins when both are set, as in `connection.ts` |
| `ACTUAL_BUDGET_ENCRYPTION_PASSWORD` | no | For an end-to-end encrypted budget |

It checks that the credential opens that budget before writing anything, keeps the values out of argv and out of its output, and prints JSON lines as `addon.sh enable` does, ending in `done` or `error`. `disconnect actual <slug> --json` removes the entries and the stored values. Neither touches the budget on the server.

**Acceptance:** with a valid token, `connect` ends with `done` and the profile's next turn lists `budget-<slug>` tools. With a token for a user without access to that budget, it ends with `error` and writes nothing. No line of output contains the token or password.

**Boundary fallback:** none. Boundary doesn't offer budgets per person until this exists; the single budget from `ACTUAL_BUDGET_FILE` stays as it is.

> **Stack reply (accepted, planned, not built):** `scripts/budget.sh connect --json` and
> `budget.sh disconnect <slug> --json`, with the keys in your table. `addon.sh connect actual`
> can wrap them once `addon.sh` exists; it isn't on main yet.
>
> - **Checks before writing:** the slug (lowercase letters, digits and `-`), that the profile
>   exists, and that the credential opens that budget. The check is the same `actual-admin.mjs`
>   check `budget.sh add` runs today, with its 45-second limit. Nothing is written if any check
>   fails.
> - **Storage:** one secret file per connected budget, mode 600 and gitignored, mounted read-only
>   into the two MCP containers. A password-free index lists slug, profile and server, and the
>   Hermes bootstrap registers from that index. Credentials never go in `.env`, the bootstraps,
>   argv or output.
> - **Running it:** each MCP container runs one MCP process per connected budget, routed by path
>   (`/<slug>/mcp`). Compose stays static. Every budget costs one process with the budget loaded
>   in each of the two containers. We'll measure how much memory that is.
> - **Output:** JSON lines ending in `{"event":"done",...}` or `{"event":"error","error":...}`.
>   The error values are `bad_slug`, `unknown_profile`, `login_refused`, `token_expired`,
>   `no_access` (the credential is valid but can't open that sync id), `encryption_password`,
>   `timeout`, `server_unreachable` and `exists`. `exists` means the slug is already connected,
>   and `--force` replaces it. `token_expired` covers a disabled user, since disabling ends their
>   sessions.
> - **Reload:** `connect` and `disconnect` recreate the MCP containers and run
>   `make hermes-reload`, so the profile's next turn lists `budget-<slug>` tools.
> - **The existing single budget:** an install with `ACTUAL_BUDGET_FILE` keeps its `budget` entry
>   with the same tool names. Connected budgets come in alongside it.
> - **`disconnect`:** removes the entries, the secret file and the cache. It doesn't touch the
>   budget on the server.
>
> One question back: when the named profile is `default`, should `browser` (Hermes WebUI) get the
> same entries, as it does today for the single budget? We'd default to yes.

> **Boundary reply:** yes, `browser` gets the same entries as `default`. Three follow-ups:
>
> - **Access per budget.** `ACTUAL_ACCESS` is one setting in `.env` today, while each Twenty workspace has its own `TWENTY_ACCESS`. Please have `connect` take `ACTUAL_ACCESS=read|write` per budget, stored in that budget's index row, and add a way to change it without reconnecting, as `crm.sh access` does. With `read`, the profile's chats get only `budget-<slug>-ro`. Boundary will preselect `read` for budgets, since this is financial data.
> - **A session that was ended.** Please say whether `token_expired` also covers a stored session ended later, by a password change or a disabled user, on both the password path and the token path, and whether the MCP server reports it at call time in a way Boundary can tell apart. Boundary then asks for the password or token again instead of showing a generic failure.
> - **Which command Boundary calls.** The `addon.sh` contract in your `docs/extending.md`, not yet on main, has `list`, `configure` (with `--instance <slug>`, values as JSON on stdin) and `enable`, but no `connect`, and `enable` prints no JSON lines. Boundary will build on `budget.sh connect` and `disconnect` as described here. If budgets later become `addon.sh` instances instead, please keep the same checks, error values and JSON lines, and say whether credentials then move from the environment to stdin.
> - **Reloading.** `connect`, `disconnect` and access changes end with `make hermes-reload` in your plan. Item 4 of Boundary's `addon.sh` reply in change request 0020 asks for a reload that runs the bootstraps without recreating Hermes or needing `make`; please apply the same here.

> **Stack reply, access per budget:** accepted. `connect` takes `ACTUAL_ACCESS=read|write` per budget, default `read`,
> stored in that budget's index row. `budget.sh access <slug> read|write --json` changes it
> without reconnecting, then reloads Hermes. It prints the same JSON lines, and `bad_access` for
> any other value, which writes nothing. With `read`, the profile and `browser` get only
> `budget-<slug>-ro`. With `write`, they also get `budget-<slug>`.
>
> The existing stack-wide `ACTUAL_ACCESS` in `.env` keeps its v0.3.12 meaning for the single
> budget only. Per-budget rows use the row's value. An unknown value in a row fails closed: that
> budget gets no entries, and `status` reports it (below).

> **Stack reply, a session that was ended:** we can't answer this yet without guessing, so the spike will. What we know
> from reading the vendored server: it signs in and downloads the budget once, on the first tool
> call, and later calls work on that loaded copy and sync it. We haven't seen what a sync does
> after the session behind it has ended. It may fail the call, or it may keep answering from the
> loaded copy without telling anyone. The second would be worse than an error, and the spike
> checks it on both the password and the token path. Until then, we commit to the following:
>
> - `connect` returns `token_expired` for an ended session, whichever way it ended. That covers
>   a password change (if 26.11.0 ends sessions on a password change, which the spike checks) and
>   a disabled user. If a password change doesn't end password sessions, we'll say so, because
>   the old stored session would then keep working.
> - New: `budget.sh status [--slug <slug>] --json` checks each connected budget's stored
>   credential afresh, outside the MCP process. It prints one line per budget with
>   `{"slug","profile","access","state"}`. `state` is `ok`, `token_expired`, `no_access`,
>   `encryption_password`, `server_unreachable`, `timeout` or `bad_access`. Boundary can call it
>   when a person opens budgets, or after a turn that mentions a budget failure, and ask again for
>   the password or token on `token_expired`. `make doctor` reports the same states.
> - At call time: if the spike shows the server keeps answering from the loaded copy, the
>   launcher will restart a budget's process when its sync fails with an ended session. Calls
>   then fail with a tool error naming `token_expired`. Hermes passes tool errors to the model,
>   not to Boundary, so `status` is the signal Boundary should rely on.

> **Stack reply, which command Boundary calls:** build on `budget.sh connect`, `disconnect`, `access` and `status`. They stay
> supported entry points with these keys, checks, error values and JSON lines, even if budgets
> later become `addon.sh` instances. In that case the `budget.sh` commands become thin wrappers.
> If `addon.sh configure` takes values as JSON on stdin, `connect` will accept that too, but it
> will keep reading the environment, so Boundary doesn't have to change. A credential is never
> taken from argv either way.

> **Stack reply, spike results for a session that was ended:**
>
> - **The unpatched server answers silently.** After the session behind a loaded budget ends,
>   by a deleted token or a password change, reads keep coming from the loaded copy. Writes
>   report success but don't reach the server. They're pushed later if a new session opens the
>   same cache, possibly under a different credential. We'll patch the vendored server so an
>   auth or access failure during sync (`token-expired`, `file-access-not-allowed`) fails the
>   call. The model then gets a tool error such as `Authentication failed: invalid or expired
>   session token`. `budget.sh status` stays the signal Boundary should use.
> - **A password change ends every earlier password session,** including the sessions `connect`
>   stores, so it shows up as `token_expired`. Turning on OpenID mode also deletes every existing
>   session.
> - **A disabled user's token** gets 401 `token-not-found`, the same answer as a bad token. Both
>   map to `token_expired`, and the stack can't tell them apart.
> - **A user without access** to a budget sees an empty budget list, and gets 403
>   `file-access-not-allowed` when opening it by sync id. `connect` and `status` report
>   `no_access`.
> - **`connect --force` and `disconnect` clear that budget's cache,** so writes stranded under an
>   ended session can't be pushed later under a new credential.
> - **Not tested:** expiry with `token_expiration` set to `openid-provider`.

> **Stack reply, resource cost:** each connected budget runs one process in each of the two MCP containers. With
> about 2,000 transactions, a process used about 90 MB idle and 115 MB after reads (PSS), so plan
> on roughly 180–230 MB per connected budget.

> **Stack reply, correction to the output and input:** `budget.sh connect` and `disconnect` become the Actual add-on's
> connect and disconnect hooks for `addon.sh` (CR 0020), and `budget.sh init` its init hook. You
> can call `addon.sh connect actual --instance <slug> --json`, or `budget.sh` directly as promised
> in round 2. Both print the same lines. This replaces the `event` lines from round 1 and the
> environment input from round 2.
>
> - **Key:** every line keys on `phase`, as in CR 0020's R3, never `event`.
> - **Last line:** always `{"phase":"done",...}` or
>   `{"phase":"error","error":"<name>","message":"<one sentence>",...}`, and nothing follows it.
>   `message` never holds a secret. A `done` line from `connect` carries `account` and `mcp`:
>   the MCP server names to wait for in `mcp.servers.status`. That's `budget-<slug>-ro`, plus
>   `budget-<slug>` for a `write` budget.
> - **Error names:** the shared ones every add-on uses are `bad_slug`, `exists`, `not_found`,
>   `login_refused`, `token_expired`, `no_access`, `timeout` and `server_unreachable`. Actual adds
>   `bad_access`, `unknown_profile` and `encryption_password`, and lists them in its manifest's
>   `instances.errors`, so `addon.sh` passes them through. Treat a name you don't know as a
>   generic failure. `addon.sh` adds its own: `bad_input`, `missing_settings`,
>   `command_failed`, `compose_failed` and `busy`.
> - **Exit codes:** key on the `error` name, not the exit code. Through `addon.sh`, a hook's error
>   exits 4. `addon.sh`'s own errors exit 2 (`bad_input`, and `not_found` on `disconnect`),
>   3 (`missing_settings`), 4 (`command_failed`) or 1 (`compose_failed`, `busy`).
> - **Input:** `connect` takes `--slug <slug> --json` on the command line and the rest of your
>   table's keys as one JSON object on stdin, with numbers and bools as JSON types. Credentials
>   travel only on stdin. `addon.sh` passes your stdin object through unchanged and adds the same
>   flags. `disconnect` takes `--slug <slug> --json` and reads no stdin. The environment input
>   from round 2 stays for people running `budget.sh` in a terminal, but it isn't part of what
>   Boundary calls.
> - **Failure:** a failed `connect` writes nothing.
>
> The `addon.sh` side is planned for 0.3.13. If its shape changes before it ships, we'll send a
> note.

> **Stack reply, ended-session fix merged:** the patched MCP server now fails a call when a sync shows the
> budget can't be used any more, and shuts that budget's loaded copy down so nothing more is
> written to it. It matches the error code from Actual, never the message text. A network failure
> still keeps the old offline behaviour. The fix also covers the existing single budget in
> v0.3.12, and ships in the next 0.3.x patch.
>
> The tool error the model sees replaces the round-3 example. There is one message per cause:
>
> | Cause | Actual codes | Message starts |
> |---|---|---|
> | Sign-in | `token-expired`, `token-not-found`, `unauthorized`, `invalid-password` | `Actual sign-in failed (<code>). If it keeps failing, <hint>.` |
> | Access removed | `file-access-not-allowed` | `Access to this budget was removed (<code>); its owner or an admin has to restore it.` |
> | Deleted on the server | `file-not-found` | `This budget was deleted on the server (<code>); <hint> with another budget.` |
> | Changed on the server (reset, re-keyed) | `file-needs-upload`, `file-has-reset`, `file-has-new-key`, `file-key-mismatch`, `file-old-version` | `The budget changed on the server (<code>); <hint>.` |
>
> `<hint>` names the commands for the single budget today. Each connected budget's process will
> get a hint naming `budget.sh connect --force` for that slug. These messages reach the model, not
> Boundary, so `budget.sh status` stays the signal to rely on. The round-2 plan to restart a
> budget's process on an ended session is dropped: the next call after a failure starts a fresh
> sign-in instead.
>
> One gap remains: a write made in the few seconds between a successful sync and the background
> push can still be stranded if the session ends in that window. `connect --force` and
> `disconnect` clear the cache, so such a write is never pushed later under another credential.

> **Boundary reply:** Boundary will call `connect`, `disconnect`, `access` and `status` with the round-4 input and read the `phase` lines, keying on the `error` name. We read the slug flag as two layers: Boundary calls `addon.sh connect|disconnect actual --instance <slug> --json`, and `addon.sh` runs the hook as `budget.sh connect --slug <slug> --json`. `account` is only a field in the `done` line.

## R2 · Read-only for unattended runs, per budget (Wanted)

**Why:** a person's cron and api-server runs should look up their budgets without being able to change them, as today.

**Ask:** each connected budget gets a read-write entry for interactive chats and a read-only entry (the read-only MCP server's 18 read tools) for unattended runs, on the profile named in R1.

**Acceptance:** an unattended run on that profile can call `get-transactions` on `budget-<slug>` and has no `create-transaction` tool.

**Boundary fallback:** none needed; Boundary sets no tools for unattended runs.

> **Stack reply (accepted, planned, not built; one point to check):** today a profile gets one
> budget entry. Cron is fenced away from a read/write entry, so cron on the default profile has
> no budget, and read-only unattended access goes through the separate `api-server` profile. To
> give the person's own cron read-only access, each connected budget gets two entries on that
> profile: `budget-<slug>` (read/write) for chats and `budget-<slug>-ro` (the 18 read tools) for
> cron. The cron fence keeps only `-ro`.
>
> To check: whether Hermes can keep `-ro` out of interactive chats through its per-platform
> toolsets. If it can't, chats list the 18 read tools twice, which works but costs context.
> We'll report back before building.
>
> Question back: by "api-server runs", do you mean runs on the person's own profile, or the
> stack's shared `api-server` profile? The stack has one `api-server` profile, not one per
> person, so per-person budgets there would need a profile choice from you.

> **Boundary reply:** we mean the person's own profile's unattended runs, such as cron. The shared `api-server` profile keeps only the existing single budget. With access per budget (R1 follow-up), a `read` budget has only the `-ro` entry, so the double listing can happen only for `write` budgets.

> **Stack reply:** understood. Connected budgets register only on the named profile, plus
> `browser` when that profile is `default`. The shared `api-server` profile keeps only the
> single v0.3.12 budget. The person's cron gets `budget-<slug>-ro` and never `budget-<slug>`.

> **Stack reply, double listing:** Hermes can keep `budget-<slug>-ro` out of chats, but only if the stack takes
> over the profile's whole list of chat toolsets. Coding focus mode and cron jobs with their own
> toolset lists bypass that list. We're not doing it now, so on `write` budgets chats list the
> read tools twice. `read` budgets have only the `-ro` entry, so they aren't affected.

## R3 · The Actual MCP servers on the host, for sharing with a Circle (Later)

**Why:** ADR 0048 lets a member share a service with their Circle through a gateway in Boundary that runs on the Mac, outside the containers. For Actual it would forward a member's read grant to the read-only MCP server and a write grant to the read-write one. Today both listen only on the `budget` network.

**Ask:** optional ports on `127.0.0.1` for `actual-mcp-ro` and `actual-mcp-rw` (for example `ACTUAL_MCP_RO_PORT` and `ACTUAL_MCP_RW_PORT`, unset by default), and the `/mcp` routes and methods a client uses, including how long an `Mcp-Session-Id` lives.

**Acceptance:** with both ports set, `POST 127.0.0.1:<port>/mcp` with an `initialize` answers 200 with an `Mcp-Session-Id` from each, and nothing listens with the ports unset.

**Boundary fallback:** none. Actual isn't shareable until this lands.

> **Stack reply (accepted for later):** yes, with one condition. The ports are only opened with
> bearer auth on. `ACTUAL_MCP_RO_PORT` and `ACTUAL_MCP_RW_PORT`, unset by default, publish on
> `127.0.0.1`, and setting either one starts both servers with `--enable-bearer`. An open
> read/write endpoint on the Mac's loopback could be written by any process there. The stack
> generates one token per server into a mode-600 file and gives Boundary the path. Requests
> without `Authorization: Bearer <token>` get 401.
>
> Routes: `POST /<slug>/mcp` with `initialize` (answers 200 and sets `Mcp-Session-Id`), then
> `POST` with that header for calls, `GET` for the server-sent event stream, and `DELETE` to
> close the session. The single legacy budget stays on `/mcp`. Session lifetime is as described
> under Background.

> **Boundary reply:** agreed, bearer auth on. Boundary's gateway sets that server's token as the `Authorization` header on what it forwards, as it does with a member's Twenty key, and never passes it to members.

> **Stack reply:** agreed. One token per server, in a mode-600 file whose path the stack reports.
> Rotating it is a later item.

> **Stack reply, session lifetime measured:** an `Mcp-Session-Id` survived 6 minutes idle, ended on `DELETE`, and
> was unknown after a restart. A call with an unknown id gets HTTP 400 `Bad Request: No valid
> session ID provided`, not 404. The stack's proxy will turn that into 404 so clients know to
> send a new `initialize`. Your gateway should treat either response that way.

> **Boundary reply, round 8 (please move R3 from Later to Wanted):** Boundary is building the
> consumer side of ADR 0048 for Twenty now, and Actual is the next service people have asked to
> share. On the stack's `main` at v0.3.14-7 (a22506a), neither `actual-mcp-ro` nor `actual-mcp-rw`
> publishes a port, and neither runs with `--enable-bearer`. Everything agreed in rounds 1–3
> above still stands: `ACTUAL_MCP_RO_PORT` and `ACTUAL_MCP_RW_PORT`, unset by default, on
> `127.0.0.1`, bearer auth on whenever either is set, one token per server in a mode-600 file
> whose path the stack reports, `POST`/`GET`/`DELETE` on `/<slug>/mcp`, and 404 for an unknown
> `Mcp-Session-Id`. Four additions, found while planning the gateway against the current compose
> file:
>
> - **Which budgets the read-write server serves.** Since v0.3.14, `actual-mcp-rw` serves a
>   budget only when its `bind` gives some profile `rw`. A provider who reads a budget in their own
>   chats but shares it with **Make changes** would have no read-write route for it. Please either
>   serve a budget on `actual-mcp-rw` when a new instance setting (for example `share: "rw"`)
>   asks for it, without registering it on any profile, or say that Boundary must bind it `rw` on
>   the provider's profile to share writes. Boundary would rather not widen the provider's own
>   chats to share with someone else.
> - **Reporting the ports and token files.** Please have `addon.sh list actual --json` (or
>   `budget.sh status --json`) report, when the ports are set, each server's host port and token
>   file path, so Boundary doesn't read `.env` or guess a path under the data root.
> - **Turning it on after install.** Setting the ports means recreating both MCP containers.
>   Please make it an `addon.sh configure actual` setting (for example `{"host_ports": true}`)
>   that picks free ports and writes the tokens, followed by `enable`, as `local` works, so
>   Boundary doesn't edit `.env` itself.
> - **Rotating a token.** Rotation was left for later. Boundary only needs the token to change
>   when someone asks for it, with the new file in place before the servers restart. A command
>   that does that is enough, and it can stay Later.
>
> **Acceptance (added):** with `host_ports` on, `addon.sh list actual --json` names both ports and
> token files. `POST 127.0.0.1:<rw port>/<slug>/mcp` with an `initialize` and the rw token answers
> 200 for a budget whose `bind` is read-only on every profile but whose share setting is `rw`.
> Without the token, the answer is 401.
>
> **Boundary fallback:** none. Actual stays unshareable until this lands. The gateway's `share`
> entry for Actual (ADR 0048 §12) is written only after these answers.

## R4 · List the budgets on a server (Wanted)

**Why:** Boundary's connect sheet takes a server address and a password or token, then shows the budgets on that server to pick from, rather than asking for a Sync ID. `actual-admin.mjs list` already prints one `<sync id><TAB><name>` line per budget, but `budget.sh` shows that list only in its error text, when `init` or `add` finds more than one budget.

**Ask:** `budget.sh budgets --json`, taking the same server and credential keys as `connect` (`ACTUAL_SERVER_URL`, `ACTUAL_PASSWORD` or `ACTUAL_SESSION_TOKEN`), prints one JSON line per budget, `{"sync_id": "…", "name": "…", "encrypted": true|false}`, and ends with `done` or `error` using `connect`'s error values. It writes nothing.

**Acceptance:** against a server with two budgets, the output has two budget lines and `done`. With a wrong password it ends with `error` `login_refused` and no budget lines. No line contains the password or token.

**Boundary fallback:** the sheet asks for the Sync ID.

> **Stack reply, round 5 (accepted, planned, not built):** `budget.sh budgets --json`, in the R1 build.
>
> - **Input:** `--json` on the command line, and the server and credential keys from `connect`
>   as one JSON object on stdin. For the local server set up by R5, pass `{"server": "local"}`
>   with no credential; the stack uses the server password it stored.
> - **Output:** one line per budget, `{"phase":"budget","sync_id":"…","name":"…","encrypted":true|false}`,
>   then `done`. The `phase` key is there so the lines parse like every other line. `encrypted`
>   comes from the encryption key id the server's budget list carries for each budget (seen in
>   26.11.0's `/sync/list-user-files`). Deleted budgets and budgets the credential can't open are
>   left out, since the server doesn't list them for that user.
> - **Errors:** `connect`'s names. A wrong password ends with `login_refused` and prints no
>   budget lines; an ended session ends with `token_expired`.
> - **Writes nothing:** it signs in and reads the list over HTTP, without loading any budget, so
>   it creates no cache.
> - **How you call it:** directly, as with `access` and `status`. `addon.sh run` runs a command in
>   a one-shot container, and `budgets` is a host script like `connect`.

## R5 · Set up a local server without the single budget (Wanted)

**Why:** Boundary's local install wants `actual-server` set up with a first budget, connected as a `budget-<slug>` row like any other. `budget.sh init` writes the v0.3.12 single budget, which registers the plain `budget` entry beside the rows. `budget.sh remove` clears it, but also sets `ACTUAL_MCP_ENABLED=0`, which drops the rows too.

**Ask:** an `init` mode that sets the server password, creates or adopts the first budget, and either connects it as a row (taking `ACTUAL_SLUG`, `ACTUAL_PROFILE` and `ACTUAL_ACCESS`) or prints what `connect` needs, without writing the single budget. JSON lines as `connect` prints them.

**Acceptance:** on a fresh `budget-local` profile, the new mode ends with `done`, the profile's next turn lists `budget-<slug>` tools, and no `budget` entry and no `ACTUAL_BUDGET_FILE` exist.

**Boundary fallback:** none. Boundary doesn't offer a local Actual install until this exists.

> **Stack reply, round 5 (accepted, planned, not built):** `budget.sh init --server-only`, which becomes the
> Actual manifest's `hooks.init`, so `addon.sh enable actual` runs it once after `actual-server`
> is healthy. It sets up the server and stops there. Connecting the first budget is a normal
> `connect`.
>
> - **What it does:** sets a generated server password on a fresh `actual-server` and stores it
>   in `data/addons/actual/secrets/`, mode 600. If the server has no budget, it creates one named
>   `Budget`. It never writes `compose/actual/budget.env` or `ACTUAL_BUDGET_FILE`, so no plain
>   `budget` entry appears.
> - **Its `done` line:** carries `sync_id` and `name` when the server has exactly one budget
>   afterwards, created or adopted. With several, it carries neither, and you list them with R4.
>   It never prints the password.
> - **Then:** `addon.sh connect actual --instance <slug> --json` with
>   `{"server": "local", "sync_id": "…", "profile": "budget-local", "access": "write"}` on stdin.
>   `connect` uses the stored password for the local server, and its `done` line names
>   `budget-<slug>` and `budget-<slug>-ro` for you to wait on. That pair meets the acceptance: the
>   profile's next turn lists `budget-<slug>` tools, with no `budget` entry and no
>   `ACTUAL_BUDGET_FILE`.
> - **An existing local server:** if `make budget-init` set it up, `--server-only` adopts the
>   password from `budget.env` and leaves that file alone. If the server has a password the stack
>   doesn't know, it ends with `login_refused`, and nothing is written.
> - **Starting the server:** the manifest gets a `local` setting that owns `ACTUAL_LOCAL_ENABLED`,
>   so `enable` starts `actual-server` before `init` runs. Set it with `addon.sh configure actual`
>   before `enable`.
> - **The flag problem:** `budget.sh remove` will remove the single budget only, and turns
>   `ACTUAL_MCP_ENABLED` off only when no connected budgets remain. `make budget-init` without
>   `--server-only` keeps its v0.3.12 behaviour for existing installs.

> **Boundary reply:** agreed on both. One correction to our own wording, which the example above follows: in R5's acceptance we wrote "a fresh `budget-local` profile", but `budget-local` is the compose profile. The `profile` key `connect` takes is the Hermes profile, and Boundary connects budgets on `default` (mirrored to `browser`), so the local example is `{"server": "local", "sync_id": "…", "profile": "default", "access": "read"}`. Boundary sends `read` unless the person chooses **Make changes**. Please confirm `connect` reads `profile` that way for the local server too.

> **Stack reply, round 6:** confirmed. `connect` reads `profile` as the Hermes profile for every server,
> the local one included. `budget-local` is the compose profile that runs `actual-server`, and it
> never goes in `connect`'s input. Our round-5 example was wrong; your call is right:
> `{"server": "local", "sync_id": "…", "profile": "default", "access": "read"}`. On `default`,
> the entries are mirrored to `browser`, as for any connected budget (R2). With `read`, the
> `done` line names only `budget-<slug>-ro`; with `write`, it also names `budget-<slug>`.

## Round 7 · Follow-ups from Boundary's build

Boundary built its side against the stack's `main` (merge 5b94263) and read `addon.sh`, `addon-events.sh`, `addon_cli.py`, `addon_store.py`, `budget.sh` and `addons/actual/addon.json` there. Everything Boundary calls matched rounds 4 to 6. Three things don't have a stack command yet; Boundary ships with the fallback named under each.

**R7a · Replace a connected budget.** Your round-1 reply said `--force` replaces an `exists` slug, and the spec's Sign in again relies on it, but neither `addon.sh connect` nor the hook takes it, and `addon.sh` answers `exists` for a known slug before the hook runs. Please accept `--force` on `addon.sh connect` (or a `replace: true` stdin key) that runs the hook's checks first and swaps the row and the stored session only when they pass.
*Boundary fallback:* `disconnect`, then `connect`. If the new sign-in fails, the row is gone; the sheet says so.

> **Stack reply (accepted, planned, not built):** confirmed. `addon.sh connect` answers `exists`
> before the hook runs (`scripts/addon.sh` `cmd_connect`), so the round-1 `--force` never reached
> `addon.sh`. We'll add `addon.sh connect actual --instance <slug> --force --json`:
>
> - The hook runs its checks first, with the same stdin as a new connect. If any check fails, the
>   row and its stored session are left exactly as they were, and the error is the hook's.
> - Only when the checks pass does the hook replace the stored session token (and the
>   encryption password, or remove it if the new input has none), and `addon.sh` then rewrites
>   `instances/<slug>.json` from the new input. Settings you leave out take their defaults, not
>   the old row's values.
> - The launcher sees the changed files and restarts that budget's server on an empty cache, as
>   on any reconnect, so nothing cached under the old session is pushed under the new one.
> - `--force` on a slug that doesn't exist behaves like a plain connect. `done` is the same as
>   a new connect's.

**R7b · The first budget from `enable`.** `init --server-only`'s `done` line carries `sync_id` and `name`, but `hook-result` passes on only `account`, `mcp` and `message`, so `enable actual --json` drops them. Please pass the init hook's `sync_id` and `name` through to `enable`'s `done` line.
*Boundary fallback:* after `enable`, `budget.sh budgets --json` with `{"server": "local"}`; one budget is connected, several leave the pick to the person.

> **Stack reply (accepted, planned, not built):** confirmed. `hook-result` in
> `scripts/lib/addon_cli.py` passes on only `account`, `mcp` and `message`. Rather than teach
> `addon.sh` Actual's field names, we'll let any init or connect hook put a `result` object in its
> `done` line, and `addon.sh` will copy it to its own `done` line as `result`, keeping only string,
> number and boolean values. `budget.sh init --server-only` will add
> `"result": {"sync_id": "…", "name": "…"}` when exactly one budget exists, keeping the
> top-level fields for direct callers. So read `done.result.sync_id` and `done.result.name` from
> `enable actual --json`; when `result` is absent, use your fallback.

**R7c · Turn off this Mac's server without dropping remote budgets.** With a remote budget connected, Boundary turns the local server off with `configure actual {"local": false}` and `enable`. The rows on `server: "local"` stay registered, so chats list tools that fail. Please have the bootstraps skip rows whose server is `local` while `ACTUAL_LOCAL_ENABLED` is off, and have `status` report them as a state of their own.
*Boundary fallback:* the rows stay; Boundary shows them as off and its own `server_off` state, and no dot.

> **Stack reply (accepted, planned, not built):** confirmed. The bootstrap registers every row
> whatever `ACTUAL_LOCAL_ENABLED` says (`scripts/lib/actual_rows.py`).
>
> - The bootstraps will skip rows whose `server` is `local` while `ACTUAL_LOCAL_ENABLED` is off,
>   and drop their entries, as they already do for rows on other profiles. Remote rows stay.
> - `budget.sh status` will report those rows as `server_off`, the name you already use, without
>   trying to sign in. `make doctor` shows the same state.
> - Turning the local server back on: `configure actual {"local": true}`, then
>   `enable actual --reinit --json`. The `--reinit` matters only if the add-on was first enabled
>   with `local` off, because the init hook then recorded itself as done without setting up a
>   server. The rows come back on the next bootstrap run, which `enable` does.
