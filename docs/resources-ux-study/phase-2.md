# Resources Phase 2

Phase 1 shipped the Accepted Resources rail destination: live four-bucket CPU / memory / disk bars, observe-only. This file is the follow-on list. It is not product code.

## 1. Compose inventory — shipped

Observe-only host Compose listing lives on Resources (ADR 0012, [`04-compose-inventory.html`](04-compose-inventory.html)). Start / stop stay off Resources. Services still starts Boundary’s stack. Main [`dockerService.ts`](../../src/main/services/dockerService.ts) remains the listing source.

## 2. GPU / VRAM

No host GPU probe exists today. Do not invent a VRAM row until there is a real measurement path (Metal counters, `nvidia-smi`, or runtime APIs from Ollama / LM Studio).

## 3. Harder disk — shipped

Cold cache returns null so CPU / RAM paint first. Recursive walks use a 90s TTL and a 15s budget. LLM disk sums `~/.ollama` plus well-known LM Studio model dirs. Windows walks the tree instead of `du`.

## 4. Engine VM overhead — footnote only

When `podman machine inspect boundary` reports reserved memory, Resources shows a caveat. That number includes container RAM, so it is not a fifth bar segment. Docker Desktop still has no clean number.

## 5. Windows listen-PID parity — shipped

`netstat -ano` maps the listen PID; `Get-CimInstance` samples WorkingSet and percent CPU. macOS / Linux still use `lsof` + `ps`.

## 6. Local-stack identity — shipped

Always match `com.docker.compose.project=boundary-assistant`. Local mode also matches working dirs under the assistant root and compose service labels. A foreign project named `hermes` is not stolen.
