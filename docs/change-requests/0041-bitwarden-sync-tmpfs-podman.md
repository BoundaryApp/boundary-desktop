# 0041 · A `/run/bitwarden-sync` tmpfs that Podman accepts

**Serves:** the Bitwarden add-on on Boundary's bundled Podman.
**Status:** R1 released in v0.3.17 (08f973e), which Boundary pins; the overlay writes no broker entry on it · R2 answered by CR 0042 R2

## Background

Checked against the stack at v0.3.16 (1e50da5) and Podman v6.0.1, the engine Boundary bundles for Macs without Docker Desktop.

Since 07ffbee (first released in v0.3.14), `docker-compose.yml` gives `bitwarden-broker` this tmpfs (line 2418 in v0.3.16):

```yaml
tmpfs:
  - /tmp
  - /run/bitwarden-sync:mode=0700,uid=${HERMES_UID:-1000},gid=${HERMES_GID:-1000}
```

Docker accepts `uid=` and `gid=` on a service tmpfs. Podman does not: `processOptionsInternal` in Podman's `pkg/util/mount_opts.go` accepts `mode=`, `size=`, `tmpcopyup`, `notmpcopyup` and `U` for a tmpfs and sends anything else to its default case, which returns "unknown mount option". `docker compose up` on Podman then fails before the broker is created:

```
container create: unknown mount option "uid=501": invalid mount option
```

So on Podman, `addon.sh enable bitwarden` fails and the broker has never started since v0.3.14.

The broker creates its unlock socket itself: `_unix_server` in `compose/bitwarden-broker/broker/server.py` sets umask 0177 around the bind and then `chmod`s the socket to 0600. It runs as `HERMES_UID:HERMES_GID`, and no other service mounts `/run/bitwarden-sync`. The directory's owner and mode protect nothing that the socket's own mode doesn't already protect.

## R1 · Use a tmpfs form both engines accept (Wanted)

**Why:** Bitwarden can't start on Podman while the entry carries `uid=` or `gid=`.

**Ask:** give `bitwarden-broker` `- /run/bitwarden-sync:mode=1777` in place of the current entry. The directory is then writable by the broker's user on both engines, the sticky bit stops anyone else from removing the socket, and the socket stays 0600, owned by the broker's user. `mode=0700,U` also passes Podman's parser, but Docker rejects `U`, so it would move the failure to the other engine.

**Acceptance:** with `BITWARDEN_ENABLED=1`, `docker compose up -d bitwarden-broker` creates and starts the broker on Docker and on Podman 6; inside it, `stat -c '%a %U' /run/bitwarden-sync/sync.sock` shows `600` and the broker's user, and `python3 -m broker.unlock`, run with `docker compose exec` as that user, reaches the socket.

**Boundary fallback:** when the engine is Podman, Boundary adds its own compose file to every call. It reads `bitwarden-broker`'s tmpfs list from the stack's `docker-compose.yml`, drops `uid=` and `gid=` from each entry that has them and sets `mode=1777` on it, and gives the service the whole list with `!override`, because compose otherwise merges tmpfs lists and keeps the rejected entry. `/tmp` stays. On Docker there is no such file, so the stack's definition applies unchanged. The fallback writes nothing once the stack's entries have no `uid=` or `gid=`, and it goes away when a release with R1 is pinned.

> **Stack reply (19 Nov 2026):** accepted and on stack main at 08f973e, not in a tag; the next tag carries it. The entry is now `- /run/bitwarden-sync:mode=1777`, and the broker still creates `sync.sock` at 0600 as `HERMES_UID`. On Docker 29.9.3, as uid 501 on a read-only root, `mode=1777` gives a `1777 root:root` folder and a socket at `600` owned by 501, and `mode=0700,U` fails with `invalid tmpfs option "U"`. `scripts/test-bitwarden-signin-e2e.py` starts its broker with the new entry and passes on Docker. A new `scripts/test-compose-tmpfs-options.py` renders every profile and fails any service tmpfs option other than `rw`, `ro`, `exec`, `noexec`, `suid`, `nosuid`, `dev`, `nodev`, `noatime`, `size=` and `mode=`. Keep the Podman fallback until Boundary pins the tag carrying 08f973e; after that it writes nothing. Not run by the stack: anything on Podman, and a recreate of a live broker.

## R2 · The `bitwarden_signin` volume's owner on Podman (raised by the stack)

**Stack question:** `bitwarden-signin` creates `signin.sock` in the `bitwarden_signin` named volume, a local tmpfs with `o: "uid=${HERMES_UID},gid=${HERMES_GID},mode=0700,size=1m"`. The stack read that Podman chowns the volume's directory from `uid=`/`gid=` while the volume is new and empty, and asked whether the folder is still owned by `HERMES_UID` after both containers stop and the tmpfs is mounted again. It asked for `stat` output on Podman 6.0.1 before and after a stop and start, and `vault.sh status --json` after, and said it would change the volume if either check failed.

**Boundary answer:** it fails earlier than the stack expected, on the first start, and [CR 0042](0042-signin-seccomp-podman.md) R2 asks for the change. Podman records `uid=`/`gid=` as the volume's owner without a chown (`pkg/domain/infra/abi/parse/parse.go`) and mounts the tmpfs with the remaining options (`libpod/volume_internal_linux.go`), so it comes up owned by root at 0700 and the signer exits 2 with `PermissionError` on the socket. Mode alone doesn't fix it: Boundary's Podman machine runs SELinux enforcing, the tmpfs is labelled `tmpfs_t`, and binding a Unix socket there fails with `EACCES` even at 1777. Both were checked by hand on the bundled machine. On Podman, Boundary's overlay sets the volume's `o` to `mode=1777,size=1m,context=system_u:object_r:container_file_t:s0`.

`BOUNDARY_PODMAN_CHECK=1 BOUNDARY_PODMAN_CHECK_BITWARDEN=1 bun run test:podman` runs R1's acceptance and the stop-and-start steps against the pinned v0.3.16 with that overlay, and prints each output. It shows whether the socket comes back at 600, owned by the signer, and whether the signer is `down`. It doesn't test the stack's own volume options, which fail on the first start, as described above.

**Result (20 Nov 2026):** passed on bundled Podman 6.0.1 against v0.3.16 with Boundary's overlay, which gives the broker R1's `mode=1777` entry. In the broker, `sync.sock` was `600`, owned by the broker's uid, and `python3 -m broker.unlock --lock` on an unknown slug exited 3, so it reached the broker over the socket. In the signer, `signin.sock` was `600`, owned by the signer's uid, before and after `stop` and `up -d --no-deps` of both services. `vault.sh status --json` then reported a signer state other than `down`. Not run: R1 on Docker from Boundary's side, and the stack's own `bitwarden_signin` options, which fail on Podman for the reasons above.
