# 0031 · Email add-on status per account, and named errors from the mailbox listing

**Serves:** Email in Boundary ([add-ons spec](../addons-ux-study/spec.md), phase 9).
**Status:** Open

## Background

Boundary drives the `email` add-on (`addons/email/addon.json`, v0.3.13) through `scripts/addon.sh`. Two things it shows the person have no command behind them.

- **State per account.** `mail_status` reports counts per account and `failed_accounts`, but only to Hermes: `email-mcp` sits on the internal `email` network and publishes no port. What Boundary can read is `email-indexer`'s log. Each pass prints one JSON line from `mail-index.py run --every` with totals (`in_scope`, `added`, `updated`, `removed`, `unreadable`) and `failed`, a map from account id to 4 or 5, and an account the renderer leaves out prints `email-indexer: <slug>: <reason>`. The line has no counts per account and no time; Boundary takes the time from `docker compose logs --timestamps`, and only the last 200 lines.
- **Why a listing failed.** `addon.sh run email mailboxes --instance <slug>` exits 4 for every failure of `docker compose run`. `mail-index.py`'s `guarded` exits 4 for `AuthFailed` and 5 for `ImapError`, but `addon.sh` folds both into 4, so Boundary tells a refused login from an unreachable server by matching the `mail-index:` line's wording (`the server rejected the user name or password`, `can't connect to`).

## R1 · `run email status` (Wanted)

**Why:** a row that says the password stopped working is the main thing the person needs from the Email page, and today it comes from parsing a log the stack never promised.

**Ask:** a manifest command, run in `email-mcp` or `email-indexer` with the index mounted read-only, that prints one JSON object: `last_indexed` (ISO time or null), `messages` (total), `accounts` as a map from account id to `{"messages": n, "failed": null | 4 | 5}`, and `skipped` as a map from account id to the renderer's reason. No subjects, senders, mailbox names or addresses.

**Acceptance:** after a pass where one account's password was refused, `run email status` names that account with `failed: 4` and gives the other account's message count; before the first pass it prints `last_indexed: null` with exit 0.

**Boundary fallback:** the pass line and skip lines from `docker compose logs --timestamps --tail 200 email-indexer`, totals only.

## R2 · Named errors from `run email mailboxes` (Wanted)

**Why:** the sheet's message for a refused app password depends on the wording of an exception.

**Ask:** `run email mailboxes` prints one JSON object on failure, `{"error": "login_refused" | "server_unreachable" | "bad_config", "message": "..."}`, on stdout or as the last stderr line, and keeps exit 4. The message names the account, never the password.

**Acceptance:** against GreenMail, a wrong password gives `login_refused`, a closed port `server_unreachable`, and `security: "plain"` on a public host `bad_config`.

**Boundary fallback:** matching the `mail-index:` line as described above, and the line itself for anything else.
