# Windows and Linux plan

| | |
| --- | --- |
| Status | Phased parity decided 13 Nov 2026 |
| Related | [Updates plan](updates-plan.md), [Bundled Podman fidelity](bundled-podman-fidelity.md) |
| Started | 13 Nov 2026 |

## Progress

| Phase | Status | Depends on |
| --- | --- | --- |
| 1 Linux builds against the distribution's Docker or Podman | In progress | — |
| 2 Windows builds against Docker Desktop | Not started | — |
| 3 Linux preview releases | Not started | 1 |
| 4 Bundled engine on Windows over WSL2, then Windows releases | Not started | 2, bind-mount spike |
| 5 Updates on Windows and Linux | Not started | 3 |

## Goal

Boundary on Windows and Linux does what it does on macOS: one install, then the agent stack runs without the user setting up a container engine. The platforms get there by different routes.

On macOS Boundary ships Podman with a krunkit VM. On Windows the equivalent is a Podman machine on WSL2. Turning WSL2 on needs administrator rights and can need a restart and BIOS virtualization, so first run has a step the Mac doesn't. On Linux containers run without a VM, but Podman depends on conmon, crun, netavark, pasta and `/etc/subuid` entries that distributions already package. Linux uses the distribution's Docker or Podman, and Boundary helps install it rather than shipping its own.

The first Windows users are expected to be non-technical, on their own machines rather than managed corporate ones. They won't install Docker Desktop themselves, so Windows isn't released until the bundled engine works. Until then Windows builds come from CI for testers only, and need Docker Desktop. Home users are normally administrators, so WSL2's administrator requirement is acceptable; the restart it can need is a first-run step to design.

## Phase 1: Linux

- `scripts/setup-dependencies.js` joins `PATH` with `path.delimiter`.
- Deb and Rpm packages carry `src/assets/icon.png`.
- System Docker detection tries, after the active Docker context: Docker Desktop at `~/.docker/desktop/docker.sock`, `/var/run/docker.sock`, rootless Docker at `$XDG_RUNTIME_DIR/docker.sock`, then Podman's API socket at `$XDG_RUNTIME_DIR/podman/podman.sock` and `/run/podman/podman.sock`. A Podman socket still needs a `docker` CLI with Compose on `PATH`. Rootless engines are untested with the stack's bind mounts, which run rootful on macOS.
- `BOUNDARY_SMOKE_EXIT=1` makes a packaged build exit 0 once the main window has loaded, and 1 if it fails to load or takes longer than the timeout. CI launches each package this way under `xvfb-run`.
- Test Build runs on `ubuntu-latest` as well as macOS.

Local check: `scripts/linux-build-check/run.sh` builds the deb and rpm in an Ubuntu 24.04 container on Docker Desktop and smoke-launches the package under Xvfb. It defaults to the host architecture; pass `amd64` to match the runner, or add `--check` to run `bun run check` in the container first.

## Phase 2: Windows

- `src/main/index.ts` returns after `app.quit()` when `electron-squirrel-startup` handles a Squirrel event, so install and update events don't run migrations.
- A `.ico` icon, and `setupIcon` on the Squirrel maker.
- Docker detection on Windows reads `Path` as well as `PATH`, looks in `C:\Program Files\Docker\Docker\resources\bin`, and skips the login-shell probe.
- Stack setup scripts need a shell. The candidate is running them inside the Podman machine's distribution once phase 4 lands; until then they need Git Bash or WSL.
- Host-path lists stop using `:` as a separator.
- Test Build on `windows-latest` starts with type check, package and smoke launch. The unit suite joins once tests stop hard-coding POSIX host paths.

Local check: a Windows 11 ARM VM in UTM or Parallels, which runs x64 builds under emulation.

## Phase 3: Linux preview releases

Build and Release's matrix gains `ubuntu-latest`, and the release notes call the Linux packages a preview. Updates stay off: `buildFeedBase()` already returns no feed off macOS.

## Phase 4: bundled engine on Windows

Windows joins Build and Release when this phase works end to end. Windows builds need a code-signing certificate by then, or SmartScreen warns on install.

Before committing to WSL2, a spike measures bind-mount speed and permissions for host folders under `/mnt/c`, which shared folders, coding mounts and project sources all use. Memory sizing (ADR 0055) needs a WSL2 equivalent through `.wslconfig`.

## Other macOS-only features

- Calendars use a Swift EventKit helper. They stay macOS-only until another source is chosen.
- `safeStorage` uses DPAPI on Windows. On Linux it uses libsecret or KWallet and falls back to an unencrypted mode when neither is running; Boundary should check `safeStorage.getSelectedStorageBackend()` and warn.
- Updates need MSIX on Windows and AppImage or the distribution's package manager on Linux ([updates plan](updates-plan.md)).
