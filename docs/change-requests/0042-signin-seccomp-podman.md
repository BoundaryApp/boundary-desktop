# 0042 · `bitwarden-signin` on Podman: a seccomp setup and a socket volume Podman accepts

**Serves:** the Bitwarden add-on's sign-in service on Boundary's bundled Podman.
**Status:** R2 released in v0.3.17 (`mode=1777,size=1m`) apart from `context=`, which Boundary's overlay still adds · R1 deferred to a stack Podman override (its Podman and Linux milestone) · Boundary fallback stays

## Background

Checked against the stack at v0.3.16 (1e50da5) and at 08f973e, Podman v6.0.1 (the engine Boundary bundles for Macs without Docker Desktop), containers/common v0.68.1 (Podman 6.0.1's default seccomp profile) and docker-compose v2.38.2 (the compose Boundary bundles).

`docker-compose.yml` gives `bitwarden-signin` (line 2512 in v0.3.16) and `web-browser` (line 2342) this option:

```yaml
security_opt:
  - no-new-privileges:true
  - seccomp=./compose/bitwarden-signin/seccomp.json
```

Compose reads the file and sends its JSON inline as `seccomp=<json>` (`parseSecurityOpts` in compose's `pkg/compose/create.go`), which is what Docker's API expects. Podman's compat API passes `HostConfig.SecurityOpt` through unchanged; `pkg/specgenutil/specgen.go` stores the value after `seccomp=` as `SeccompProfilePath`, and `getSeccompConfig` in `pkg/specgen/generate/config_linux_seccomp.go` opens it with `os.ReadFile`. Container create then fails:

```
container create: opening seccomp profile failed: open {"comment":"Docker's default seccomp profile for the bitwarden-signin service: ...
```

So on Podman, `addon.sh enable bitwarden` creates the broker but not the signer, and `web-browser` can't be created either. No compose form gets a file path to Podman, because compose inlines every value except `unconfined` and `builtin`. The image label `io.containers.seccomp.profile` doesn't help: Podman reads it only under seccomp policy `image`, and the compat API never sets a policy.

Podman's default profile (containers/common `pkg/seccomp/seccomp.json`) is not enough on its own. It allows `clone`, `clone3` and `unshare` with any flags, but allows `chroot` only when `CAP_SYS_CHROOT` is in the container's bounding set, which `cap_drop: [ALL]` removes. Chromium's namespace sandbox calls `chroot` inside the user namespace it creates, so the signer would report `sandbox_unavailable` and refuse sign-in sessions.

## R1 · A seccomp setup both engines accept (Wanted)

**Why:** the signer can't be created on Podman while its `security_opt` carries a profile file, and the signer is what signs in to every Bitwarden item not marked `agent-in-page-fill`.

**Ask:** ship a setup for `bitwarden-signin` and `web-browser` under which Chromium's sandbox starts on Docker and on Podman 6, and say which security properties it keeps on each. Two routes Boundary found, neither tried by the stack:

- A Podman override file in the stack (for example `compose/engine-podman.yml`), which `scripts/up.sh` and `addon.sh` add when the engine is Podman, giving these services a `security_opt` Podman takes. Boundary would add the same file instead of writing its own.
- On Podman, Podman's default profile plus `cap_add: [SYS_CHROOT]`. That keeps a syscall filter. Podman puts added capabilities in the effective and permitted sets of a non-root user (`pkg/specgen/generate/security_linux.go`), so the service's user could call `chroot` in the container too. On Docker this doesn't work: Docker's default profile allows `clone` with namespace flags and `unshare` only with `CAP_SYS_ADMIN`.

**Acceptance:** with `BITWARDEN_ENABLED=1`, `docker compose up -d bitwarden-signin` creates and starts the signer on Docker and on Podman 6, and its `/health` reports a status other than `sandbox_unavailable` on both. The same holds for `web-browser` with its profile on: Chromium opens its CDP port.

**Boundary fallback:** when the engine is Podman, Boundary adds its own compose file to every call. For `bitwarden-signin` and `web-browser`, it reads the `security_opt` list from the stack's `docker-compose.yml`, drops each `seccomp=` that names a file, gives the service the rest of the list with `!override`, and adds `cap_add: [SYS_CHROOT]`. That is the second route above: the container runs under Podman's default profile, and with `cap_drop: [ALL]` it holds `CAP_SYS_CHROOT` and nothing else (`MergeCapabilities` in containers/common). `no-new-privileges`, the read-only root and the non-root user stay. On Docker there is no such file. The fallback writes nothing once the stack's lists name no profile file, and it goes away when a release with R1 is pinned. Boundary's compose profiles don't include `web-browser` today, so only the signer runs under it.

## R2 · A socket volume the signer can write to on Podman (Wanted)

**Why:** with R1's fallback in place, the signer starts on Podman 6 and exits 2 at once: `cannot listen on /run/bitwarden-signin/signin.sock (PermissionError)`. The `bitwarden_signin` volume (line 2755 in v0.3.16) is a local tmpfs with `o: "uid=${HERMES_UID:-1000},gid=${HERMES_GID:-1000},mode=0700,size=1m"`. For a local volume, Podman takes `uid=` and `gid=` out of `o` and records them as the volume's owner without a chown (`pkg/domain/infra/abi/parse/parse.go`), then mounts the tmpfs with the remaining options (`mount` in `libpod/volume_internal_linux.go`). The tmpfs comes up owned by root at mode 0700, and `HERMES_UID` can't create the socket. Docker passes `o` to `mount` whole, so it works there. Mode alone doesn't fix it on Podman: the machine runs SELinux enforcing, and the volume's tmpfs is labelled `tmpfs_t`, where a container process can create a file but binding a Unix socket fails with `EACCES` (checked by hand on Boundary's machine, Fedora CoreOS).

**Ask:** give the volume options both engines apply the same way, and a label a container can create sockets under where SELinux is on. With `o: "mode=1777,size=1m,context=system_u:object_r:container_file_t:s0"` on Podman, the signer's user binds the socket and a second container with the volume mounted read-only connects to it (checked by hand). `context=` is refused by kernels without SELinux, so it can't go in the shared definition as is; a tmpfs mount on the service (`tmpfs:`), which Podman labels for the container, may be the simpler route if the broker can reach the socket another way. For the mode, `mode=1777` works on both engines: the signer creates `signin.sock` itself under umask 0177 and `chmod`s it to 0600 (`_unix_server` in `signer/server.py`), only the signer and `bitwarden-broker` mount the volume, and the sticky bit keeps another user from removing the socket. It is the same reasoning as CR 0041 R1.

**Acceptance:** `addon.sh enable bitwarden` on Podman 6 starts the signer, and `/health` over the socket answers from the broker. On Docker the same holds, and `stat -c '%a %U' /run/bitwarden-signin/signin.sock` shows `600` and the signer's user on both.

**Boundary fallback:** on Podman, the same compose file sets the volume's `driver_opts.o` to the stack's options with `uid=`/`gid=` dropped, `mode=1777` and `context=system_u:object_r:container_file_t:s0` (compose merges `driver_opts` by key, so `type` and `device` stay). Since the stack declined `context=`, the volume part stays after R2 ships: it adds the label to the stack's `mode=1777,size=1m` and writes nothing only once the stack's `o` names a context. A volume created with the old options stays: compose sees the changed definition and asks whether to recreate it, and with no terminal it keeps the old one. So before Get Bitwarden and before each stack start with Bitwarden on, Boundary reads the volume's `o` from Podman and, when it differs from the one the compose file sets, removes the volume with `podman volume rm --force`, which also removes the broker and signer containers; compose then creates all three again. This goes away with the rest of the fallback.

## Stack reply (20 Nov 2026)

The stack replied with a plan; nothing is built. It confirmed the Background at its main 31184fc.

> **R2, the mode:** accepted. The volume's `o` becomes `mode=1777,size=1m`, without `uid=` and `gid=`, on the same reasoning as CR 0041 R1: only the signer and the broker (read-only) mount it, and the signer creates `signin.sock` under umask 0177 and `chmod`s it to 0600. On Docker that gives a root-owned 1777 tmpfs with a 0600 socket owned by the signer's user, and it also removes the case where a changed `HERMES_UID` leaves the old owner on a volume compose didn't recreate. `scripts/test-compose-tmpfs-options.py` will check the `driver_opts.o` of every `type: tmpfs` named volume under the same option list. An existing volume keeps its old options until removed; on Docker it still works, and on Podman Boundary's read-and-remove step is still needed for a volume created before the change.
>
> **R2, `context=`:** declined for `docker-compose.yml`, because a kernel without SELinux refuses the option and `up` would fail on every host without it. Boundary keeps it in its Podman override. The stack will decide whether its own Podman override can carry the label, since a Podman host isn't always SELinux-enforcing.
>
> **R1:** deferred. The stack will add `compose/engine-podman.yml`, which `scripts/up.sh` and `scripts/addon.sh` add to every compose call when the engine is Podman (neither detects the engine today). For `bitwarden-signin` and `web-browser` it replaces `security_opt` with `no-new-privileges:true` alone, leaving Podman's default seccomp profile, and adds `cap_add: [SYS_CHROOT]`: Boundary's second route. On Docker nothing changes. Compared with Docker, on Podman the syscall filter is wider (`clone`, `clone3` and `unshare` with any flags, so any process in the container can create user namespaces) and the service's user holds `CAP_SYS_CHROOT` in its effective and permitted sets. `cap_drop: [ALL]` apart from that capability, `no-new-privileges`, the read-only root and the non-root user stay on both. The tradeoff will be written in the override file and `docs/extending.md`. The override ships with lifting `install.sh`'s Podman refusal and a Podman run of R1's and R2's acceptance, in the same milestone. Nothing in the reply has been run on Podman by the stack.

**Boundary response:** accepted, including the `context=` decline. Checked at stack main 31184fc: both services still carry `seccomp=./compose/bitwarden-signin/seccomp.json`, the volume's `o` is unchanged, `compose/engine-podman.yml` doesn't exist and `install.sh` still fails Podman with `unsupported_host`. Boundary's overlay (`engineOverlay.ts`) already takes the route the stack chose for R1. `podmanVolumeOptions` used to add `context=` only while the stack's `o` had `uid=` or `gid=`, so on `mode=1777,size=1m` it would have written nothing and the signer would have hit `EACCES` again under SELinux. It now adds `context=` whenever the options name none, and the read-and-remove step treats a volume made from the stack's unlabelled R2 options as stale. When the stack's Podman override ships, Boundary adds that file instead of writing its own `security_opt`, keeps its `context=` unless the stack's override carries it, and keeps the read-and-remove step for volumes created before. `BOUNDARY_PODMAN_CHECK=1 BOUNDARY_PODMAN_CHECK_BITWARDEN=1 bun run test:podman` is Boundary's run of the acceptance on its bundled Podman, and its output can go back to the stack for the milestone's Podman run.
