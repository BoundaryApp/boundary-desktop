# 0028 · Bitwarden accounts from Boundary

**Serves:** [add-ons spec](../addons-ux-study/spec.md), phase 8
**Status:** R1 to R5 built, merged to stack main (a26f93c), unreleased · R6 withdrawn (see **R6 withdrawn**) · not yet run against a real Bitwarden account · see **Build** for differences from the replies

## Background

Boundary's Bitwarden add-on lets a person connect a bitwarden.com account (US or EU), or a Bitwarden or Vaultwarden server of their own, so Hermes can sign in to websites with logins from one folder of that vault. Boundary asks for the account's personal API key, the folder, and how it unlocks. It approves the agent's access requests by telling the person to move the login into the folder in any Bitwarden app. The stack's local Vaultwarden mode, a grant dialog in Boundary, and stack secrets sync are not part of this phase.

Checked on stack `main` at b633aad (after v0.3.12, with `addon.sh` from 0020 and the Bitwarden recreate fix):

- `addons/bitwarden/addon.json` has `builtin` (`BITWARDEN_ENABLED`, profile `bitwarden`), `settings` (`sync_minutes`, `idle_lock_minutes`), `hooks.backup` and `hooks.restore`. It has no `instances`, so `addon.sh connect bitwarden` has nothing to call.
- `scripts/vault.sh add` asks for `client_id`, `client_secret` and, with `--unlock stored`, the master password in hidden prompts on the terminal. `unlock` asks for the master password the same way. `remove` deletes the account file, its secrets and its `bw` data. None of the three prints machine-readable output.
- `vault.sh requests --json` prints the broker's `GET /requests` reply: `{"pending": [{"request_id", "account", "site", "reason", "created", …}]}`. It is the only `vault.sh` command with JSON output.
- The broker's `GET /accounts` returns `slug`, `mode`, `scope`, `state` and `error_class` per account, and `GET /health` returns `account_errors` for refused account files. `make doctor` prints them. `vault.sh` has no command that returns them.
- The broker's error classes are `auth`, `locked`, `network`, `rate_limited` and `unknown` (`ERROR_CLASSES` in `compose/bitwarden-broker/broker/bwcli.py`). The shared instance errors are `SHARED_ERRORS` in `scripts/lib/addon_manifest.py`.

Boundary sends every secret on stdin and keeps none of them. It never asks for the person's own email and master password for setup work in `bitwarden-setup`.

> **Stack reply:** accurate. Three corrections to the details:
>
> - Account files live in `compose/bitwarden/accounts/<slug>.env` (`VAULT_ACCOUNTS_DIR` in
>   tests). Secrets and `bw` data are in `secrets/<slug>/` and `bw/<slug>/` under
>   `BITWARDEN_HOST_DATA_DIR`, which defaults to `data/addons/bitwarden`.
> - `vault.sh add` doesn't fail when the broker is down. It writes the files, sets
>   `BITWARDEN_ENABLED=1` in `.env` and says the broker checks the key when it starts. Under R1
>   that changes (see there).
> - A **manual** account never signs in to Bitwarden until someone unlocks it. The broker runs
>   `bw login --apikey` only inside `POST /unlock` (`server.py`, `_manual` then `bw.login()`).
>   After a restart, every manual account is `locked` with no error, even one whose API key was
>   revoked. That breaks R1's "checks the credentials before `done`" and R2's "an account can stop
>   working when its API key is revoked" for the default unlock. R1 fixes it in the broker.

## R1 · Accounts as `addon.sh` instances (Wanted)

**Why:** connecting an account is the add-on's main step. Twenty workspaces and Actual budgets connect through `addon.sh connect` with values on stdin and `phase` lines, and Boundary wants one path for all three.

**Ask:** `instances.connect` and `instances.disconnect` hooks in `addons/bitwarden/addon.json`, as plan 3 defines them. `connect` runs `vault.sh add` with `--slug <slug> --json`, and the rest as one JSON object on stdin:

| Key | Values |
| --- | --- |
| `mode` | `cloud` or `selfhosted` |
| `region` | `us` or `eu`, with `cloud` |
| `url` | the server's HTTPS address, with `selfhosted` |
| `scope` | `folder:<name>` or `collection:<id>` |
| `unlock` | `stored` or `manual` |
| `client_id`, `client_secret` | the account's personal API key |
| `master_password` | with `stored` only |

It checks the credentials with the broker before it reports `done`, and on any failure writes nothing, as `vault.sh add` already does. `scope: all` is refused from stdin (`bad_input`), since Boundary doesn't offer it. `disconnect` runs `vault.sh remove --slug <slug> --json`.

Errors use plan 3's shared names where one fits: `auth` as `login_refused`, `network` as `server_unreachable`, plus `exists` and `not_found`. `rate_limited` goes in `instances.errors`, with the wait in seconds when the broker has one. A two-step login that `bw` refuses arrives as `login_refused` today. If the stack can tell it apart, please add `two_step_login` to `instances.errors`, since its message to the person is different.

**Acceptance:** with a stub broker, `addon.sh connect bitwarden --instance home --json` with a valid stdin object ends with `done` and writes `accounts/home.env` and `secrets/home/`. A refused API key ends with `error` `login_refused` and leaves nothing behind. No line, and no process's argv, holds a secret.

**Boundary fallback:** none. Bitwarden stays out of Boundary's store until a release has R1 to R3.

> **Stack reply:** accepted, and it fits plan 3's hooks. Plan:
>
> **Manifest.** `instances` gets `name: "account"`, `connect: ["scripts/vault.sh", "add"]`,
> `disconnect: ["scripts/vault.sh", "remove"]` and these settings:
>
> | Setting | Type |
> | --- | --- |
> | `mode` | choice `cloud`, `selfhosted` |
> | `region` | choice `us`, `eu`, optional |
> | `url` | url, optional |
> | `scope` | string, default `folder:Agent` |
> | `unlock` | choice `stored`, `manual`, default `manual` |
> | `client_id`, `client_secret` | secret, `transient` |
> | `master_password` | secret, `transient`, optional |
>
> `transient` means `addon.sh` hands the value to the hook on stdin and stores nothing itself
> (`addon_manifest.py` allows it only with `instances.connect`). `addon.sh` also redacts the three values from any
> hook output before logging or relaying it. `client_id` is marked secret even though the account
> file holds it, so that it is redacted too. Settings that depend on `mode` or `unlock` are
> optional in the manifest. `vault.sh add` checks the combinations and answers `bad_input`.
>
> **`vault.sh add --slug S --json`** reads the stdin object instead of flags and hidden prompts.
> It differs from the terminal path in these ways:
>
> - stdout carries only plan 3's event lines (`setup` for `write` and `check`, then `done` or
>   `error`). Log lines go to stderr.
> - It never asks a question, never offers `bitwarden-setup`, and refuses `scope: all`
>   (`bad_input`) whatever `CONFIRM_SCOPE_ALL` says.
> - It never writes `BITWARDEN_ENABLED`, because the flag belongs to `addon.sh enable`. With the
>   broker down it writes nothing and fails with `broker_down`. Decision 26's **Get**
>   (`enable`, then the sheet) starts the broker before connect runs. We'll check that the broker
>   starts cleanly with no account files, which it hasn't had to do so far.
> - Every outcome other than `unlocked` (stored) or `locked` with no error (manual) rolls back.
>   Today a `network` or `unknown` result keeps the files. The rollback leaves nothing behind,
>   as with `auth` today.
>
> **Error names:**
>
> | Broker result | Error |
> | --- | --- |
> | `auth` | `login_refused` |
> | `network` | `server_unreachable` |
> | `rate_limited` | `rate_limited` |
> | a stored account still locked when the wait runs out | `timeout` |
> | broker down | `broker_down` |
> | `unknown` | `command_failed` |
> | existing slug | `exists` (from `addon.sh`) |
> | unknown slug | `not_found` (from `addon.sh`) |
>
> `instances.errors` lists `rate_limited` and `broker_down`.
>
> **Manual accounts.** We'll change the broker so a manual account runs `bw login --apikey` when
> the broker loads it, and stays `locked` afterwards. A login doesn't need the master password.
> A refused key then shows as `error`/`auth`, so connect reports `login_refused` and R2 shows a
> revoked key after a restart. The connect check waits for that login to finish, not only for the
> account to appear.
>
> **`two_step_login`: not added.** Bitwarden's CLI docs say a personal API key login doesn't ask
> for two-step login, and `bwcli.py` has no pattern for it, so the stack can't tell such a
> refusal apart. We haven't tried this against a real account with two-step login on.
>
> **`rate_limited` wait.** The broker parses `Retry-After` when Bitwarden sends one (`retry_at` in
> `bwcli.py`). Vaultwarden doesn't send it; bw prints only "Rate limit exceeded". We'll add
> `retry_after` (whole seconds or null) to `GET /accounts`. Plan 3's error line has no field for
> it, so `addon.sh` will relay an optional `retryAfter` from a hook's `error` line. It is null when
> the wait is unknown, which is always the case with Vaultwarden.
>
> **Two side effects to plan for in Boundary:**
>
> - The check restarts the broker, as `vault.sh add` and `remove` do today. A restart locks every
>   other manual account, so connect and disconnect lock the person's other manual accounts.
>   The `done` line's `message` names them, and Boundary should read R2 again after either
>   call. Loading one account without a restart is a later broker change.
> - `register` stores the non-secret settings in `data/addons/bitwarden`, so `addon.sh list` shows
>   the instance. Accounts added at the terminal (`make vault-add`) or before this release aren't
>   in that store, so `addon.sh disconnect` would answer `not_found` for them. We'll have the
>   terminal `add` and `remove` update the store too, and `make up` add store entries for
>   account files that have none. The `local` account from `make vault-init` stays out of the
>   store. Boundary should take the list of rows from R2, not from `addon.sh list`.
>
> **`disconnect`** runs `vault.sh remove --slug S --json`. The broker restart also applies here,
> and the `done` message reminds the person to revoke the API key. Removing `local` is
> `bad_input`.
>
> **Acceptance** as written, with a stub broker. We'll add a manual-account case with a refused
> key, and an argv check that runs `ps` during connect.

## R2 · Account state as JSON (Wanted)

**Why:** a manual account locks on every stack restart, and an account can stop working when its API key is revoked. Hermes tells the model, not Boundary, so Boundary needs to ask.

**Ask:** `vault.sh status --json`, one line per account: `{"slug", "mode", "scope", "unlock", "state", "error"}`. `state` is the broker's (`unlocked`, `locked`, `offline`, `error`), and `error` is the error class with the R1 names, or null. A refused account file is a line with `state: "refused"` and the file name, never its contents. It works while the broker is down, reporting every account as `offline`.

**Acceptance:** with one stored and one manual account after a broker restart, the stored line is `unlocked` and the manual one `locked`.

**Boundary fallback:** none.

> **Stack reply:** accepted. `vault.sh status --json` prints one line per account file, sorted by
> slug, and nothing when there are none:
>
> ```json
> {"slug": "home", "mode": "cloud", "scope": "folder:Agent", "unlock": "manual", "state": "locked", "error": null}
> ```
>
> - `mode`, `scope` and `unlock` come from the account file. On Linux the files belong to the
>   broker's user, so `vault.sh` may read them through `bitwarden-setup`, which is slower.
> - `state` and `error` come from `GET /accounts`. The error names follow R1: `login_refused`,
>   `server_unreachable`, `rate_limited`, and `unknown` for the broker's `unknown`. The broker's
>   `locked` error class is a session that went stale between calls and is reported as null.
>   R1's `retry_after` appears on the line too, null except while rate limited.
> - A refused file is `{"file": "x.env", "slug": <slug or null>, "state": "refused", "error":
>   "bad_file"}`, from `GET /health`'s `account_errors`. The broker's message names the line and
>   key but no value. We leave it out anyway, so the rule stays "no file content".
> - With the broker down (or mid-restart, during a connect or disconnect), every file gets
>   `state: "offline"` and `error: "broker_down"`. `broker_down` lets Boundary tell this apart
>   from a server the broker can't reach. Files the broker would refuse aren't detected while
>   it's down; they show as `offline` until it starts.
> - The `local` account appears with `mode: "local"`, and a terminal-added account may have
>   `scope: "all"`. Boundary should show both without offering to change them.
>
> **Acceptance** as written. The manual account's line is `locked` with `error: null`, or
> `login_refused` if its key was refused at start (R1's broker change).

## R3 · Unlock and lock without a terminal (Wanted)

**Why:** manual unlock is Boundary's default, so the person unlocks from Boundary after each restart.

**Ask:** `vault.sh unlock --slug <slug> --json` reading `{"master_password"}` from stdin, and `vault.sh lock --slug <slug> --json`, both ending with one `done` or `error` line. A wrong password is `login_refused`, and an account that isn't manual is `bad_input`.

**Acceptance:** `unlock` with the right password moves the account to `unlocked` in R2's output. With a wrong one it ends with `login_refused` and the account stays `locked`.

**Boundary fallback:** none. Without it, only stored unlock would work.

> **Stack reply:** accepted. `vault.sh unlock --slug S --json` reads `{"master_password": "…"}`
> from stdin and makes one attempt (the terminal path allows three). `vault.sh lock --slug S
> --json` reads nothing. Each prints one `done` or `error` line in plan 3's event shape.
>
> | Error | When |
> | --- | --- |
> | `login_refused` | wrong password (`broker.unlock` exit 2) |
> | `bad_input` | an account that isn't manual, or bad JSON |
> | `not_found` | no account file, or the broker hasn't loaded it (exit 3) |
> | `broker_down` | the broker isn't running |
> | `command_failed` | anything else |
>
> The password goes from stdin to `broker.unlock`'s stdin, as it does today, and never reaches
> an argv or a log. Boundary calls `vault.sh` directly for R2 to R4, as it already does for
> `requests --json`. Plan 3's `commands` start a new container with `docker compose run`, so they
> can't reach the running broker's socket the way `vault.sh` does with `exec`.

## R4 · Sync as JSON (Wanted)

**Why:** after the person moves a login into the folder, **Check now** asks the broker to sync so the request clears without waiting `BITWARDEN_SYNC_MINUTES`.

**Ask:** `vault.sh sync --json`, printing the broker's sync reply (`synced`, and `reason` of `busy` or `recent`).

**Acceptance:** two calls within 30 seconds return `synced` and then `recent`.

**Boundary fallback:** the button waits for the broker's next sync and says so.

> **Stack reply:** accepted, with a correction to the reply's shape. `vault.sh sync --json`
> prints `POST /sync`'s reply as one line. `synced` is a list of slugs, not a boolean. It is
> `false` only when another sync is running:
>
> - `{"synced": ["home"]}`, or with `"busy": [...]` for accounts the sync loop holds
> - `{"synced": false, "reason": "busy"}`
> - `{"synced": ["home"], "reason": "recent"}`, the last result, within
>   `BITWARDEN_SYNC_MIN_SECONDS` (30 by default) of the last sync
>
> With the broker down it behaves like `requests --json`: exit 1, a message on stderr, nothing
> on stdout.
>
> **Acceptance** as written.

## R5 · Keep `requests --json` stable (Wanted)

**Why:** Boundary lists pending requests on Bitwarden's page from `requests --json`.

**Ask:** treat the fields Boundary reads (`pending[].request_id`, `account`, `site`, `reason`, `created`) as a contract, and list them in `docs/bitwarden.md`. Say in the changelog if one changes.

**Acceptance:** `docs/bitwarden.md` names the fields.

**Boundary fallback:** none needed; the command exists.

> **Stack reply:** accepted. `docs/bitwarden.md` will list `pending[].request_id`, `account`,
> `site`, `reason` and `created` as the fields Boundary reads, and the changelog will note any
> change to them. `created` is Unix seconds (int). Pending requests expire after the store's
> maximum age and then leave `pending`. The reply also has `recent` (done requests) and each
> request has `status` and `done_at`. Those aren't part of the contract unless you ask.

## R6 · Logins the agent returned that stayed in its folder (Withdrawn)

**Why:** when the agent hands a login back and Bitwarden refuses the move, the login stays in the agent's folder or collection, denylisted. The person has to move it out, and Boundary's page should say which ones (decision 31).

> **Stack reply:** nothing returns the logins decision 31 lists. When Bitwarden refuses to move a
> returned login, `POST /release` answers `returned: false` to the agent, and the broker keeps the
> handle in `broker/denylist.json`. No route lists those entries, and the file holds handles
> only, not labels or sites. If Boundary wants the list, we'd add `unreturned: [{account, label,
> site}]` to `GET /requests` (and so to `requests --json`), filled from the denylist entries that
> are still in scope. If you want it, add it as R6.

**Ask:** as offered above, `unreturned: [{account, label, site}]` in `GET /requests` and so in `requests --json`, filled from denylist entries still in scope. Add it to R5's contract fields.

**Acceptance:** after a release that Bitwarden refuses (stub `bw`), `requests --json` lists the login under `unreturned`, and it leaves the list at the first sync that finds it out of scope.

**Boundary fallback:** the page doesn't list them. The agent's tool result already tells the agent the login wasn't returned.

> **Stack reply, R6:** accepted, with three details the denylist alone can't settle (read from
> `server.py`, `vault.py` and `bwcli.py`):
>
> - **A separate record of failed returns.** A successful release also stays on the denylist
>   until a listing shows the item gone. `return_item` refreshes the list afterwards only "when
>   that is possible". So "on the denylist and still in the cached listing" would sometimes list
>   a login Bitwarden did move. The broker will record each release that `return_item` answers
>   false in `broker/unreturned.json`, next to `denylist.json`, mode 600. An entry leaves the file
>   when `_prune` drops its denylist entry. `_prune` runs after a sync, an unlock and a release,
>   which matches the acceptance ("the first sync that finds it out of scope"). It also clears when
>   the person deletes the login. `denylist.json` keeps its format.
> - **Name and site saved at release.** The broker knows an item's name and fill origins only while
>   the account is unlocked, which a manual account isn't after a restart. A release happens while
>   the item is listed, so the broker saves `label` and `site` with the entry then. An entry is
>   always complete, locked account or not. A login renamed in Bitwarden afterwards keeps its old
>   name in the list until the entry clears.
> - **`scope: all` accounts are left out.** `return_item` returns false for them without trying,
>   because there is no folder to leave. The broker denylists the login, which is the whole return,
>   so the person has nothing to move. Boundary never connects such an account; only the terminal
>   can.
>
> Each entry is `{"account": "<slug>", "label": "<item name>", "site": "<host>"}`. `site` is the
> host of the item's first fill origin, the same form as `pending[].site`. The item name is no new
> exposure. `/items` already gave the agent that label before it released the login, and
> `GET /requests` is on the same TCP port. Entries are sorted by account, then label.
>
> `docs/bitwarden.md` adds `unreturned[].account`, `label` and `site` to R5's contract fields.
>
> **Acceptance** as written, with a stub `bw` whose `edit` fails. We'll add cases for:
>
> - a successful release whose list refresh fails, which is not listed
> - the account locked after the release, still listed with its name and site
> - a `scope: all` account, not listed
>
> R6 ships when it's ready. It doesn't have to wait for R1 to R5 or go out with them.

**Release:** R1 to R5 and the broker change ship together, without R6 (see **R6 withdrawn**). Bitwarden joins Boundary's store only once all of them are in a release.

## Build

> **Stack reply:** R1 to R6 are built and reviewed on the stack branch
> `feat/bitwarden-boundary-accounts`, not yet merged or released. Where the build differs from
> the answers above:
>
> - **A key revoked after connect isn't caught at start.** `bw` stays signed in across broker
>   restarts and treats "already logged in" as success, so the start sign-in checks a manual
>   account's API key only the first time. Connect's check is real, because `add --json` starts
>   from an empty `bw/<slug>/`. Forcing a fresh sign-in at every start might make Bitwarden email
>   the person about a new device each time, and we couldn't check that without a real account.
>   R2 therefore doesn't show a key revoked later. We haven't confirmed what an unlock or sync
>   reports in that case.
> - **R2 has a `not_loaded` error.** A file the running broker hasn't loaded yet (written after
>   it started) is `"state": "offline", "error": "not_loaded"`. `broker_down` means only that
>   the broker isn't running. An account file the stack can't read is a `refused`/`bad_file` line,
>   and `status --json` still exits 0. The states are `unlocked`, `locked`, `offline`, `error` and
>   `refused`.
> - **Slugs for new accounts** start with a letter and have at most 31 characters (the add-on
>   store's rule). Others are `bad_slug`. An older terminal account with another slug still
>   works and shows in R2, but `addon.sh disconnect` can't remove it; `make up` prints a line
>   saying so. Accounts added at the terminal before this release get their store entry at the
>   next `make up`, and only then can Boundary disconnect them.
> - **`bad_input` from connect** reaches Boundary as `bad_input` (exit 2), for `scope: "all"`,
>   a `url` with `cloud`, `selfhosted` without `url`, `stored` without `master_password` and the
>   slug `local`.
> - **Disconnecting an account whose file is already gone** ends with `done`, so a retry after a
>   failed broker restart clears the store entry. Disconnect restarts the broker only while it is
>   running, or when it still lists the account.
> - **`unreturned`** (withdrawn; see **R6 withdrawn**) listed only accounts the broker had
>   loaded, so a disconnected account's entries left the list.
> - **`sync --json` while busy** is `{"synced": false, "reason": "busy"}`, as above.
>
> Every field Boundary reads is listed in the stack's `docs/bitwarden.md`, section "Boundary".

## Fix after the first live try: `broker_down` with the broker running

> **Stack reply:** confirmed on main 229694e with a real `.env`. `docker compose --profile
> bitwarden` replaces `COMPOSE_PROFILES`, so `core` and `hermes` drop out, and compose rejects
> the project because `bitwarden-broker` depends on `hermes`. Every `vault.sh` command that looks
> for the broker took that as "not running": `add --json` and the other `--json` commands ended
> `broker_down`, `status --json` reported `broker_down` per account, and `sync` and `requests`
> exited 1. `make doctor` had the same fault.
>
> The fix is merged to main as d5b4586. A new `compose_with_profile` in `scripts/lib/env.sh`
> passes every profile `COMPOSE_PROFILES` enables (the caller's environment, else `.env`, else
> `core`) plus `bitwarden`. `vault.sh` and `doctor.sh` use it for every broker call. The commands
> they print for people to run say `--profile core --profile bitwarden`.
> `test-bitwarden-compose-config.py` fails when either script passes `--profile bitwarden` alone,
> checks the profiles the helper builds, and renders them with real `docker compose config`.
>
> The `--json` output, error names and exit codes don't change, so Boundary needs no change.
>
> **The live try would have failed a second way.** The broker image on the test machine was
> built on 2026-11-08, before `broker/cli.py` existed. `addon.sh enable` and `make up` start an
> image that already exists without rebuilding it. With that image, connect would time out
> waiting for the sign-in, and `status --json` would still report `broker_down`, because it can't
> read the broker's account list. The CHANGELOG has an upgrade step for it:
> `docker compose --profile core --profile bitwarden build bitwarden-broker`, then
> `./scripts/vault.sh follow-hermes`. Rebuild the broker image before the next try under
> `dev:local-stack`.

## R6 withdrawn

> **Stack reply:** R6 is withdrawn before release. On 2026-11-10 the access requests were
> shrunk: the broker no longer moves a released login out of the agent's folder or collection,
> and `make vault-grant` is gone. With no move-back there is nothing to fail, so
> `broker/unreturned.json` and the `unreturned` list go too. `vault.sh requests --json` returns
> `pending` and `recent` only.
>
> What stays: `bitwarden_release_access` denylists the login at once, and the broker never lists
> or fills it while it is denylisted. The person moves it out of the agent's folder or collection
> in any Bitwarden app, and the next sync that no longer finds it in scope drops the denylist
> entry. Granting works the same way in reverse: the person moves the item in, and the next sync
> marks the matching pending request done. R1 to R5 don't change.
>
> Boundary should drop any R6 work and not read `unreturned`. If Boundary wants to show released
> logins that still sit in the agent's folder, that needs a new request; nothing in the stack
> tracks them after this change.

Checked on stack main at d4d6dca: `GET /requests` in `broker/server.py` returns `pending` and `recent` only, `scripts/test-bitwarden-access.py` asserts the reply has no `unreturned` and that a leftover `unreturned.json` is never read, and `docs/bitwarden.md` lists `requests --json` as `pending` and `recent`. Boundary no longer reads `unreturned`; the page doesn't list returned logins.
