# 0062. The stack runs on a stack host, local or reached over SSH

- Date: 2026-11-14
- Status: Proposed
- Parent: [0031](0031-checks-on-the-stack-contract-and-drift.md)
- Related: [0027](0027-host-bridge.md) (host bridge), [0055](0055-container-engine-sized-to-what-is-on.md) (engine sizing), [Windows and Linux plan](../windows-linux-plan.md), [remote stack plan](../remote-stack-plan.md), [CR 0037](../change-requests/0037-remote-stack-host.md)

## Context

Boundary runs the agent stack on the same machine as the app. On macOS it starts its own Podman machine; on Windows the plan is a Podman machine on WSL2. Both need hardware virtualization. A Windows PC that is itself a virtual machine (a cloud PC, a VDI desktop) only has it when its host passes nested virtualization through, so on many of them neither Docker Desktop, Podman nor WSL2 can start, and Boundary can't run its stack at all.

Running the stack on another machine would cover that case and several more common ones:

- A laptop with 8 GB of memory can't spare what the stack needs (0055 measured 9–10 GB charged to the Mac for a 12 GiB machine).
- Scheduled jobs, email triage and agents shared with a Circle stop when the laptop sleeps. A stack on an always-on machine (a home server, a mini PC, a NAS) keeps running.
- Two of a person's devices could use one agent with one memory, instead of two that drift apart.

Pointing Docker at a remote daemon (a Docker context over SSH or TCP) is not enough. A survey of `src/main/services` on 2026-11-14 found that Boundary assumes the stack is local in five ways:

- **Files.** About 95 call sites in about 40 files read or write the stack's checkout and data root directly: `.env`, profile `.env` files, `config.yaml` reads, the agent registry, overlays, add-on folders, provisioning and upgrades. Some go through shared helpers (`stackEnv`, `hermesProvision.editProfileEnvs`); many use `fs` directly.
- **Commands.** Compose, CLI and `compose exec` calls go through `containerRuntime/runCli.ts`, and add-on scripts through `runScriptProcess`. About 15 call sites spawn processes directly, including `scripts/setup.sh`, `sync-profiles.sh`, `unzip`, `ssh-keygen` and `du`. Three services use dockerode directly, and `dockerodeOptionsFromApiEndpoint` treats an `ssh://` endpoint as a socket path.
- **Ports.** Boundary's compose overlay publishes the stack's ports on `127.0.0.1`. `resolveHermesStackEndpoints` builds most URLs, but about a dozen call sites build `127.0.0.1` URLs themselves, some from `.env` values rather than the stored ports.
- **Host folders.** Projects, context roots, coding roots, shared folders and the workspace reach containers as bind mounts of paths on this machine, often as identity binds (`/Users/x/p:/Users/x/p`).
- **Callbacks.** The host bridge, browser relay, inference router, Mac calendars and Circles service listeners listen on this machine's loopback, and containers reach them at `host.docker.internal`.

With a remote daemon, every one of these resolves on the wrong machine.

## Decision

1. **The stack runs on a stack host.** A stack host is the one way Boundary's main process reaches the stack. It offers:
   - **commands:** compose, the container CLI, `compose exec`, and the stack's scripts, with streaming output and cancellation;
   - **files:** read, write (atomic), list, make a folder, and remove, addressed by a location (`stack`, `data`, `userContent`) and a path relative to it, never by an absolute host path;
   - **endpoints:** a URL on this machine for each of the stack's published ports;
   - **capabilities:** what the host can do beyond these (§4).

   Code outside the host's implementation does not touch the stack's files, run its processes or build its URLs.
2. **The local host is the default, and stays as direct as today.** Its files are `fs` calls, its commands are the current runtime helpers, and its endpoints are `127.0.0.1` with the stored ports. Moving code behind the host changes no behaviour on a local install.
3. **A remote host is reached over SSH, and only SSH.** One SSH connection carries the commands and files (SFTP), and forwards each published port to a local port, so the stack's ports stay bound to the remote host's loopback. A Docker daemon exposed over TCP gives root on the remote host to anyone who reaches the port, needs certificates to manage, and still provides no file access or port forwarding, so Boundary doesn't offer it.
4. **Features check capabilities, not where the host is.** A capability names something only some hosts can do. The local host has them all. A remote host starts without these:
   - `hostFolders`: binding a folder on this machine into a container (projects from host folders, coding folders, shared folders, context roots);
   - `hostCallbacks`: containers calling a listener on this machine (host bridge, browser relay, inference router, Mac calendars, Circles service listeners);
   - `provision`: Boundary installing, upgrading and backing up the stack itself;
   - `engineControl`: starting, stopping and sizing the container engine (0055).

   A feature whose capability is missing says so where it appears and why, instead of failing when it runs. Later phases can add capabilities to the remote host (reverse tunnels for callbacks, for example) without changing the features.
5. **A remote stack is installed and upgraded by the stack, not by Boundary.** The stack provides a command that installs or upgrades it on a Linux or macOS host, and a status command that reports its version (CR 0037 R1–R2). When Boundary connects, it compares that version with its pin, and refuses to connect to a stack outside the range it supports, saying which side to update.
6. **Config the stack owns is changed through the stack's commands.** Where Boundary edits a file whose format the stack owns (`.env` flags, profile `.env` values, MCP server entries), the stack provides a command that makes the change (CR 0037 R3). Boundary keeps writing files it owns, such as its compose overlays. Until the commands ship, those edits go through the host's file operations, which works for both hosts.
7. **Users choose a remote host; Boundary doesn't decide from the machine.** Settings has a stack location: this computer (the default) or another computer over SSH. First run suggests the remote host when the local engine can't start because virtualization is missing. Boundary does not detect whether it runs in a virtual machine: a VM with nested virtualization runs the local engine, and `HypervisorPresent` is also true on ordinary PCs with Hyper-V or virtualization-based security on.
8. **One Boundary per remote stack at first.** Two clients writing the same stack's config at once is unsafe until the stack locks its config writes (CR 0037 R4). Until then, connecting to a stack that another client holds says which client holds it.

## Consequences

- The host interface makes the stack contract explicit in code. A lint rule can then flag `fs`, `child_process` and `127.0.0.1` used on stack paths outside the host's implementation, which also catches drift the current helpers allow.
- Phase 1 is a refactor with no behaviour change and is worth doing even if the remote host never ships: tests can fake one interface instead of the 20-odd modules they mock today (`AssistantStackService` in 23 test files, `resolveAssistantRoot` in 22).
- On a remote host, chats, memory, agent files and add-on data live on that host. Settings, Circles and the app's own state stay on each device. Backups of a remote stack are the stack's job (CR 0037 R1), since `provision` is off.
- A remote host can't see this machine's folders, so features built on host folders are unavailable there until a sync layer exists. Shared folders and coding folders are the visible losses.
- Each remote call crosses the network, so call sites that read a file many times in a loop (`projectSourcesModel`, `webSearchModeOverrides`) need batching or caching before the remote host is usable.
- The SSH connection is a new failure: it can drop mid-turn. The host reconnects and restores its port forwards, and the chat shows the stack as unreachable while it does.
- `test:stack` gains a remote variant that runs against a stack host reached over SSH.
