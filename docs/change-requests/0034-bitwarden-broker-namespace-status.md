# 0034 · `vault.sh status --json` reports a broker outside hermes's namespace

**Serves:** Bitwarden in Boundary ([add-ons spec](../addons-ux-study/spec.md), phase 8).
**Status:** Open

## Background

At v0.3.14 (4b726a5), `bitwarden-broker` runs with `network_mode: service:hermes`. When `hermes` is recreated, the broker keeps running in the removed container's network namespace until `vault.sh follow-hermes` recreates it. The agent's Bitwarden tools in `hermes` can't reach it meanwhile.

`vault.sh status --json` can't show this. It reports `broker_down` only when the broker container isn't running (`broker_running`, `require_broker_json`; docs/bitwarden.md), and it reaches the broker through `docker compose exec`, which works from any namespace. So a broker in a removed `hermes`'s namespace reads as healthy and the command exits 0.

`doctor.sh` does detect it (lines 1295–1306): it reads the running broker's id with `compose_with_profile bitwarden ps --status running -q bitwarden-broker` and the running `hermes`'s with `docker compose ps --status running -q hermes`, and reports a problem when the broker's `docker inspect -f '{{.HostConfig.NetworkMode}}'` isn't `container:<hermes id>`.

## R1 · Report the namespace mismatch in `status --json`

**Why:** Boundary repairs a stale broker by running `follow-hermes` when the status says so. Without a status field it has to repeat `doctor.sh`'s three container reads itself, which ties it to compose's id format and to Docker's and Podman's `inspect` output.

**Ask:** `vault.sh status --json` reports when the running broker isn't in the running `hermes`'s network namespace, using `doctor.sh`'s check. Either each account line carries `error: "broker_stale"` (state `offline`), or the command prints one extra object such as `{"broker": "stale"}`. A dedicated subcommand (`vault.sh broker-check --json`) would also do. When `hermes` isn't running, it reports that rather than a mismatch.

**Acceptance:** after `docker compose up -d --no-deps --force-recreate hermes` with Bitwarden enabled, `vault.sh status --json` reports the mismatch and exits 0; after `vault.sh follow-hermes`, it no longer does.

**Boundary fallback:** `readBrokerNamespace` (bitwardenBrokerNamespace.ts) runs the same three reads with the environment the stack's scripts get, on each Bitwarden status refresh while Bitwarden is enabled, except within a minute of the last repair, and runs `follow-hermes` on a mismatch, at most once a minute. A failed read or a container that isn't running counts as no mismatch. It goes away when R1 lands.
