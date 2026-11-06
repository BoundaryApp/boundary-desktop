# 0021 · The SSH worker key is owned by uid 1000 whatever `HERMES_UID` is

**Serves:** the agent's terminal and file tools on every install (`terminal.backend: ssh`).
**Status:** Open

## Background

`compose/hermes/09-install-worker-key.sh` copies the read-only mount `/opt/hermes-ssh/id_ed25519` to `/var/lib/hermes-worker-key/id_ed25519`, then runs `chown "${HERMES_UID:-1000}:${HERMES_GID:-1000}"` and `chmod 600`. `terminal.ssh_key` points at that copy (`bootstrap-api-profile.sh`).

The script's shebang is `#!/bin/sh`. s6-overlay v3 (3.2.3.0 in `nousresearch/hermes-agent:v0.22.7`) runs cont-init scripts with an empty environment, and only scripts started through `/command/with-contenv` see the container's variables. So the script never sees `HERMES_UID` and always chowns the key to 1000:1000. The other scripts that read the environment (`005-remap-hermes-uid`, `007-profile-ownership`, `015-supervise-perms`, `019-pin-profile-gateways`, `02-reconcile-profiles`, `06-buzz-localhost-proxy`) already use `with-contenv`.

`005-remap-hermes-uid` and the image's stage2 hook do see `HERMES_UID` and remap the `hermes` user to it. Boundary sets `HERMES_UID` and `HERMES_GID` to the Mac user's ids, which is 501 for the first account on a Mac. The gateway then runs as uid 501, OpenSSH can't read a mode-600 key owned by 1000, and every SSH connection to `hermes-worker` fails. The agent reports that it has no permission for `/var/lib/hermes-worker-key/id_ed25519` and can't reach any filesystem. A stack started without `HERMES_UID` runs hermes as 1000 and doesn't show the fault.

Checked against v0.3.10, the tag Boundary pins. The script hasn't changed since v0.1.0. A throwaway `nousresearch/hermes-agent:v0.22.7` container started with `HERMES_UID=4242` and two extra cont-init scripts logged `[stage2] Changing hermes UID to 4242`. The `with-contenv` script printed `HERMES_UID=4242` and the `#!/bin/sh` script printed `HERMES_UID=unset`. Reported from rc.15 on a second Mac.

## R1 · Give the worker key to the remapped hermes user (Blocking)

**Why:** on any host whose uid isn't 1000, which includes nearly every Mac running Boundary, the agent can't run a shell command or write a file.

**Ask:** change the shebang of `compose/hermes/09-install-worker-key.sh` to `#!/command/with-contenv sh`. Chowning to `hermes:hermes` instead of the numeric ids would also work, since `005` has already remapped the user by the time `09` runs.

**Acceptance:** with `HERMES_UID=501 HERMES_GID=20` set for `docker compose up -d hermes`, `docker compose exec -T hermes ls -ln /var/lib/hermes-worker-key/` shows the key owned by `501 20`, and `docker compose exec -T -u hermes hermes ssh -i /var/lib/hermes-worker-key/id_ed25519 hermes-worker true` exits 0.

**Boundary fallback:** none built. If one is needed before the stack ships R1, Boundary can run `docker compose exec -T -u 0 hermes chown hermes:hermes /var/lib/hermes-worker-key/id_ed25519` after each `up` that creates or recreates the `hermes` container. OpenSSH reads the key on each connection, so the gateway needs no restart. That step goes once R1 is in the pinned tag.

## R2 · Check that cont-init scripts see the environment they read (Wanted)

**Why:** a cont-init script that reads a variable without `with-contenv` gets its default with no error. Wherever hermes runs as uid 1000, that default is also the right value, so the fault doesn't show.

**Ask:** a check that fails when a script mounted into `/etc/cont-init.d/` reads a variable the compose file sets and doesn't start with `#!/command/with-contenv`. Or run `scripts/test-terminal-backend-compose.py`'s ssh case with `HERMES_UID` set to something other than 1000. `11-warmup-uv-cache` reads `UV_CACHE_DIR` under `#!/bin/sh` too, and may be worth a look while there.

**Acceptance:** reverting R1 fails the check.

**Boundary fallback:** none.
