# Bundled Podman fidelity gate (macOS)

Manual checklist before calling ContainerRuntime Phase 1 done. Run on a Mac **without** Docker Desktop installed (or with Docker quit and its socket unavailable).

## Visible verification (signed .dmg)

After installing a signed build on a clean Mac:

1. **Setup → Capability** — while loading, expect provision progress messages. On success, the Container runtime row shows **Using Boundary’s bundled container engine (Podman).** (or Docker when Desktop is present). A green banner may show **Provisioned Boundary container engine.**
2. **Settings → Diagnostics → Container engine** — Engine / Kind / Origin / Compose / Machine (`boundary`) / assets. Use **Re-check** after quitting Docker to confirm fallback, and **Copy JSON** for a shareable snapshot.
3. **Debug log (signed .dmg)** — `~/Library/Logs/Boundary/boundary-debug.log`. The capability failure screen and Diagnostics tab can copy it. Paste the file here when setup fails.

## Prerequisites

```bash
# From boundary-desktop/
./scripts/fetch-container-runtime.sh
# Confirm assets exist:
ls resources/container-runtime/darwin-arm64/bin/podman
ls resources/container-runtime/darwin-arm64/bin/docker-compose
ls resources/container-runtime/darwin-arm64/bin/krunkit
ls resources/container-runtime/darwin-arm64/lib/libkrun.dylib
ls resources/container-runtime/darwin-arm64/share/krunkit/KRUN_EFI.silent.fd
```

Optional scripted smoke (provisions the `boundary` machine and prints `podman info`):

```bash
./scripts/smoke-bundled-podman.sh
```

### Fresh-install / no-Docker dev loop

Wipe local Boundary state (userData, logs, prefs) and optionally the `boundary` Podman machine, then launch with Docker Desktop skipped so bundled Podman is used:

```bash
# Wipe + start (removes boundary machine by default)
bun run dev:fresh

# Wipe only (requires confirmation)
./scripts/reset-boundary-dev-state.sh --yes
./scripts/reset-boundary-dev-state.sh --yes --keep-machine   # faster; keep VM

# Then start manually with the same emulate flag:
BOUNDARY_EMULATE_NO_DOCKER=1 bun run dev
```

`BOUNDARY_EMULATE_NO_DOCKER=1` forces the resolver to skip system Docker (same path as a Mac without Docker Desktop).

## Checklist

1. **Resolver prefers Docker when present**
   - Start Docker Desktop; launch Boundary.
   - Capability “Container runtime” detail should mention Docker.
   - Confirm no `podman machine list` entry named `boundary` was created (or Settings Diagnostics shows `origin: system`).

2. **Fallback provisions bundled Podman**
   - Quit Docker Desktop (or rename `docker` off PATH in a clean VM).
   - Capability assess should show progress (downloading/starting engine).
   - After success, detail should mention Boundary’s bundled engine.
   - Settings → Diagnostics shows Engine **Boundary’s bundled Podman**, Origin **bundled**, Machine **boundary** running.
   - `podman machine list` (via bundled binary + `CONTAINERS_CONF`) shows `boundary` running.

3. **Assistant stack (Boundary-managed, core + rag + automation + coding)**
   - Boundary downloads a pinned archive of [sovereign-agent-stack](https://github.com/kaxline/sovereign-agent-stack) into `userData/assistant-stack/project`, runs that repo’s `./scripts/setup.sh --rag --automation --coding --non-interactive`, then brings up Compose project **`boundary-assistant`** with [`resources/assistant/docker-compose.boundary.yml`](../resources/assistant/docker-compose.boundary.yml) (stomps `container_name`, remounts `BOUNDARY_ASSISTANT_DATA` → `project/data`, optional port offset when defaults are busy). Profiles: **`core`**, **`rag`**, **`automation`**, **`coding`** (not ollama/calendar/signal).
   - Product path does **not** use a sibling `../assistant` checkout by default. For single-stack local iteration: `bun run dev:local-stack` (sets `BOUNDARY_LOCAL_STACK=1` + `BOUNDARY_ASSISTANT_ROOT` to `../assistant`). Attaches when Hermes `:8643` is already healthy; skips compose down on quit; blocks `reset:dev-state` / `assistant-stack:reset-install` / Hermes `--reset`. Override-only without the script: `BOUNDARY_ASSISTANT_ROOT` (skips auto `setup.sh`). Point compose at Boundary’s engine if using bundled Podman:
     ```bash
     export DOCKER_HOST=unix://…   # from smoke / machine inspect
     export PATH="/path/to/resources/container-runtime/darwin-arm64/bin:$PATH"
     ```
   - In the app: complete Setup → LLM → **Start the assistant stack**. Expect containers such as `boundary-hermes` / `boundary-hermes-webui` / `boundary-lightrag` / `boundary-n8n` / `boundary-opencode` (not the bare developer names).
   - Ready gate: Hermes API `http://127.0.0.1:8643/health` (or offset API port, e.g. `18643`, if a developer stack already holds the defaults). Secondary UIs may still be starting.
   - After setup, the **product home** is in-app chat (Workbench). App chrome reaches **Services** (browser cards for Hermes WebUI, SearXNG, LightRAG, Neo4j, GPT Researcher, n8n, OpenCode) and **Settings**. Chat uses a main-process Hermes bridge (dashboard JSON-RPC when available, HTTP `/v1/chat/completions` fallback). Host-folder Projects, instrument telemetry, and tool-approval cards remain later phases.
   - Quit Boundary: `compose -p boundary-assistant … down --timeout 10 --volumes --remove-orphans` with those four profiles (removes anonymous/named project volumes; host bind mounts under Boundary `userData` are preserved). A manual developer stack (`../assistant` default project) is left running.

   **Developing assistant + desktop together (dual-stack)**  
   Keep your advanced stack on default ports (`make up` from a local [sovereign-agent-stack](https://github.com/kaxline/sovereign-agent-stack) / `../assistant` checkout). Boundary detects busy ports and uses `+10000` (e.g. WebUI `18787`, LightRAG `19621`). Shared LM Studio is fine if you avoid overlapping active requests. To re-simulate first launch in the app, use IPC `assistant-stack:reset-install` (wipes `userData/assistant-stack/project`).

   **Manual fallback (debug only)**  
   From a local sovereign-agent-stack checkout without Boundary’s overlay:
   ```bash
   docker-compose -f docker-compose.yml --profile core --profile rag --profile automation --profile coding up -d
   ```
   That uses global `container_name: hermes` and `./data` — do not confuse it with Boundary’s managed project.

4. **Bind mounts / UID**
   - Boundary data lives under `~/Library/Application Support/Boundary/assistant-stack/project/data` (or the app’s `userData`). Write a file there from the host and from inside `boundary-hermes`.
   - If permission errors appear, ensure compose uses the machine’s **rootful** Docker-compatible socket (`ConnectionInfo.PodmanSocket`), not a rootless user socket. Boundary inits the `boundary` machine with `--rootful` and converts an existing rootless machine via `podman machine set --rootful`.

5. **Isolation**
   - User’s existing `podman-machine-default` (if any) is untouched.
   - Retry after a failed provision clears cache and can succeed once assets/network are fixed.
   - Boundary’s compose project name and overlay isolate it from a sibling developer stack.

## Out of scope here

- Windows/WSL (Phase 1b)
- Preloaded machine images / GHCR builds
- Stopping the machine on app quit
