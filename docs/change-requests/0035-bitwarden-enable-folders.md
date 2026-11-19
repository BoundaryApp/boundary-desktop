# 0035 · `addon.sh enable bitwarden` creates the broker's folders

**Serves:** Bitwarden in Boundary ([add-ons spec](../addons-ux-study/spec.md), phase 8).
**Status:** Open

## Background

At v0.3.14 (4b726a5), `addon.sh enable bitwarden` sets `BITWARDEN_ENABLED=1` and `cmd_enable` calls `start_services`, which runs `docker compose up -d --wait`. It never runs `vault.sh pre-up`, and `pre-up` can't stand in: `cmd_pre_up` returns early unless `env_get BITWARDEN_ENABLED` is on, and `env_get` reads only `.env`, where the flag is still off when `enable` starts.

`bitwarden-broker` bind-mounts four folders: `instances` under `<data root>/addons/bitwarden` (`vault.sh`'s `store_dir`), and `secrets`, `bw` and `broker` under `BITWARDEN_HOST_DATA_DIR` (`data_dir`). On Podman a missing bind source fails `up`, so the first `enable` on a fresh install fails.

## R1 · Create the folders in `enable` (Blocking for Podman installs)

**Why:** the first Get on a Podman install ends with the broker not started.

**Ask:** `addon.sh enable bitwarden` runs the add-on's pre-start folder step before `docker compose up`. Alternatively, `addon-dirs.sh` also creates `bw/`, `broker/` and `secrets/` under `BITWARDEN_HOST_DATA_DIR`. `secrets` needs mode 0711 and the others 0700, as `pre-up` creates them.

**Acceptance:** on a stack with no `data/addons/bitwarden` folder and `BITWARDEN_ENABLED` unset, `addon.sh enable bitwarden --json` ends with `done` on Podman and the broker runs.

**Boundary fallback:** `bitwardenFolders.ts` creates the same four folders, with the same modes, before it calls `addon.sh enable bitwarden`. It follows `data_dir` for `BITWARDEN_HOST_DATA_DIR` (environment, then `.env`, then `./data/addons/bitwarden`; a leading `~` expands and a relative path resolves against the stack root). It goes away when R1 lands.
