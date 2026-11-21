# 0040 · An agent can find its own SOUL.md

**Serves:** agent identity in chat (the agent inspector's SOUL.md).
**Status:** R1 released in stack v0.3.16 · R2 declined for now: the prompt already carries the text · Boundary masks other stack checkouts

## Background

Checked against the Hermes image Boundary 0.0.1-rc.17 runs and the stack's main at v0.3.15-66 (583ac90).

Hermes reads a profile's persona from `<HERMES_HOME>/SOUL.md` (`agent/prompt_builder.py`, `load_soul_md`) and puts its text into the system prompt as-is (`agent/system_prompt.py`, `_identity_parts`). Nothing in the prompt says where the file is. In the `hermes` container it is `/opt/data/SOUL.md` for the default profile and `/opt/data/profiles/<name>/SOUL.md` for a named one.

With `terminal.backend: ssh` and `ssh_host: hermes-worker` in `config.yaml` (the default profile and `api-server` both have it), the agent's terminal runs in `hermes-worker`. The file tools run there too: `tools/file_tools.py` builds `ShellFileOperations` on the terminal environment. `hermes-worker` mounts `projects`, `voice`, `memory` and `skills` (`compose/hermes/terminal-ssh.yml`), and has no `/opt/data`.

So when someone asks the agent to show or change its SOUL.md, it can't find the file. In a chat on that build, the agent said no SOUL.md existed, and after being given the path, it said `/opt/data` doesn't exist. In another chat the agent was asked to replace its SOUL.md. It searched the project index, found a different stack's `data/hermes/profiles/api-server/SOUL.md` in a coding root the worker mounts read-write, and overwrote that file. Boundary no longer indexes gitignored files in extra project sources, which closes that route. The agent still has no correct answer to give.

## R1 · Say where the persona lives and how it changes (Wanted)

**Why:** without it, the agent guesses. It either denies that the file exists or picks another file that has the same name.

**Ask:** when SOUL.md is loaded, the identity block also says, in a line or two, that this text comes from the profile's SOUL.md, that the agent's tools can't reach that file, and that the person changes it from their client. A config key that lets a client supply the wording would do, too.

**Acceptance:** in a chat with an SSH-terminal profile, "print your SOUL.md" gets an answer that names the profile's SOUL.md and points to the client, with no file search. "Replace your SOUL.md with this" gets the same answer and causes no write.

**Boundary fallback:** none. People can open the file from the agent inspector's **Open SOUL.md**.

**Released (stack v0.3.16):** `HERMES_ENVIRONMENT_HINT` on `hermes` says the identity text is the profile's `SOUL.md`, that the agent quotes it when asked and writes nothing when asked to change it, pointing to the client or to `data/hermes/profiles/<profile>/SOUL.md` on the host, and that `/opt/data` exists only in `hermes`. The terminal service also mounts an empty read-only folder over the stack's own `data/`, so a stack under a coding root no longer exposes `SOUL.md` files through the host path. The acceptance chat hasn't been run from Boundary.

## R2 · A read-only copy of the active profile's SOUL.md in the worker (Later)

**Why:** an agent asked to quote or review its own persona could then read the real file, not just the prompt text.

**Ask:** `hermes-worker` mounts each profile's `SOUL.md` read-only at a fixed path, for example `/opt/soul/<profile>/SOUL.md` (with a name for the default profile), and R1's line names the path for the agent's own profile. The worker never gets write access to it. Edits stay with the client and the file tools' protected-instruction gate.

**Acceptance:** from the worker, `cat /opt/soul/api-server/SOUL.md` prints the same bytes as `/opt/data/profiles/api-server/SOUL.md` in `hermes`, the default profile's copy matches `/opt/data/SOUL.md`, and a write to either fails.

**Boundary fallback:** none.

**Not done:** the stack declined R2 for now. The prompt already carries the text, a single-file bind goes stale when an editor saves by rename, and mounting each profile's folder would expose its `config.yaml`, `.env` and `state.db`. If quoting the file's bytes turns out to matter, the stack would add a synced mirror folder instead.

## Other stack checkouts under a coding root (Boundary's side)

The stack's mask covers only its own checkout. A different checkout inside a folder Boundary mounts, like the one whose `SOUL.md` was overwritten, still exposed its whole `data/` folder to the agent's file and terminal tools, read-write under a coding grant. Boundary hid only top-level `.env` files.

Boundary now looks for stack checkouts the way the stack's `make doctor` does, in every project folder, context root and coding grant, and mounts an empty read-only folder over each checkout's `data/` on every service that shows it ([ADR 0028](../adr/0028-coding-folders.md) §6).

The stack also asked which tool made the overwrite, and whether an approval prompt appeared. Hermes's protected-instruction gate always asks before `write_file` or `patch` touches a `SOUL.md` outside the Hermes home, so a write with no prompt points to the terminal tool, which that gate doesn't cover. That is not yet answered.
