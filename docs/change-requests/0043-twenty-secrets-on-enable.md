# 0043 · `addon.sh enable twenty` generates Twenty's secrets when `.env` has none

**Serves:** the Twenty add-on's local instance, on stacks first set up before v0.3.10.
**Status:** R1 released in v0.3.17 (d0f17cc) as the manifest `generate` field, which Boundary pins · Boundary fallback stays for trees older than the pin; it writes nothing after `enable` · the run on a pre-0.3.10 `.env` is Boundary's

## Background

Checked against the stack at v0.3.16 (1e50da5).

`twenty-db` takes `POSTGRES_PASSWORD=${TWENTY_DB_PASSWORD:-}`, and `twenty-server` and `twenty-worker` take `TWENTY_ENCRYPTION_KEY` (or the `_FILE` form of each, CR 0020 R8). The only thing that writes either value is `scripts/setup.sh` (lines 840–845), which generates both for every install with `set_env_if_placeholder`. Those lines arrived in 9aa1335, first released in v0.3.10.

A stack whose `.env` was made before v0.3.10 has neither value, and nothing adds them later: upgrades keep `.env`, and `addon.sh enable twenty` with the `local` setting writes the two flags and starts the four services without checking the secrets. Postgres then refuses to initialise:

```
Error: Database is uninitialized and superuser password is not specified.
```

`twenty-db` restarts until compose gives up with `dependency failed to start: container twenty-db is unhealthy`, and `enable` fails at its start step. This happens on a developer checkout set up before 0.3.10 and on any Boundary-managed stack first set up on an older pin, since Boundary runs `setup.sh` only on a stack's first start.

## R1 · Generate the secrets in `enable` (Wanted)

**Why:** turning on the local instance should work on any stack that has the add-on, without re-running `setup.sh`.

**Ask:** before `addon.sh enable twenty` starts the services with the `local` setting on, write `TWENTY_ENCRYPTION_KEY` and `TWENTY_DB_PASSWORD` into `.env` when they are empty or a placeholder, with the same rules as `setup.sh`: skip a key whose `_FILE` form is set, and never replace a set value. A manifest field for generated secrets (the `backup.secrets` list already names both) would let other add-ons use the same step.

**Acceptance:** on an `.env` with neither key, `addon.sh enable twenty` with `local: true` starts all four services and `crm.sh init` finishes. On an `.env` with either key set, or its `_FILE` form set, the file is unchanged.

**Boundary fallback:** before Get and Start turn on this Mac's Twenty, Boundary writes the missing values into the stack's `.env` under the same rules: 32 random bytes in base64 for the encryption key and in hex for the password (`ensureTwentySecrets`, twentySecrets.ts, called from addonInstaller.ts). It writes nothing when both are set. It goes away when a release with R1 is pinned.

> **Stack reply (20 Nov 2026):** R1 accepted and on stack main at d0f17cc, not in a tag. Built as a manifest field: `"generate": [{"env": NAME, "encoding": "hex" | "base64", "bytes": 16-64}]`. `addon.sh enable` writes each entry to `.env` in its `flags` step, before any service starts, from `/dev/urandom`, only when the value is empty or starts with `change-me` or `change_me` and `<NAME>_FILE` is unset. A set value is never replaced. It prints `Set NAME` for each value it writes and never the value. `scripts/lib/addon_manifest.py` rejects an unknown encoding, a size outside 16 to 64, a repeated name and any other field. Twenty lists `TWENTY_ENCRYPTION_KEY` (32 bytes, base64) and `TWENTY_DB_PASSWORD` (32 bytes, hex); beyond the ask, Vikunja lists `VIKUNJA_SECRET` (32 bytes, hex), which stacks set up before `setup.sh` wrote it have empty, so Vikunja signs everyone out on each restart. The step runs on every `enable twenty`, with `local` on or off, so a hosted-only stack gets two unused values. A failed `enable` doesn't roll these writes back, so a retry reuses the secrets `twenty-db` may already hold. `scripts/test-twenty-addon-cli.sh` covers it against a stub docker. Not run by the stack: `enable twenty` with `local: true` on a real `.env` from before v0.3.10, through `twenty-db` init and `crm.sh init`.
>
> **Boundary response:** accepted. Checked at stack main 31184fc: `addons/twenty/addon.json` and `addons/vikunja/addon.json` carry the `generate` lists above, `generate_secrets` in `scripts/addon.sh` runs before the flags in `enable_env` and skips any value other than empty, `change-me*` and `change_me*`, and `_validate_generate` in `addon_manifest.py` checks the entries. `ensureTwentySecrets` uses the same encodings and rules, so the two can run together on a pin carrying d0f17cc, and it goes once that pin lands. The acceptance run on an old `.env` is Boundary's, after the pin moves.
