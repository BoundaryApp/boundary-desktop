# Host Compose inventory

Observe-only host Compose listing lives on the product **Resources** destination ([ADR 0012](adr/0012-resources-compose-inventory.md)).

## Product

- Screen: `src/renderer/product/ResourcesScreen.tsx` — list under the 0011 stacked bars.
- IPC: `resources:get-compose-inventory` and `resources:subscribe-compose-inventory` (read-only).
- Living spec: [`resources-ux-study/04-compose-inventory.html`](resources-ux-study/04-compose-inventory.html).

Fields: project name, status, services, ports. No start, stop, or restart. Services still starts Boundary’s stack.

## Listing source

Main [`src/main/services/dockerService.ts`](../src/main/services/dockerService.ts) groups labeled Compose containers (`com.docker.compose.project`, service, working dir).

## Honesty states

- Engine down: Docker / Podman is not reachable.
- Empty host: engine is up and no labeled Compose projects are present.
