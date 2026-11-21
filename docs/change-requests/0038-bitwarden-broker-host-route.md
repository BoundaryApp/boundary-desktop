# 0038 · The Bitwarden broker reaches Boundary's browser relay on the host

**Serves:** Bitwarden fills and sign-in handovers in Boundary's browser ([ADR 0065](../adr/0065-relay-credential-client.md)).
**Status:** R1 and R2 released in stack v0.3.16 (5189288) · Boundary's `boundary.url` needs no change · not yet run against a live broker

## Background

On stack main at f48d62c (unreleased, 0.3.16), `bitwarden-broker` has `networks: [credentials, browser]`, and both networks are `internal: true`. It has no `extra_hosts`. Its provider table names Boundary's relay `boundary`, read from `/secrets/boundary.url`, which Boundary writes as `ws://host.docker.internal:<port>/devtools/browser/credentials`; the relay listens on the Mac's loopback.

A container on internal networks only can't reach that address. Checked on Docker Desktop with the broker image (`assistant-bitwarden-broker:local`) on a throwaway `--internal` network, connecting to a port on the Mac's loopback:

- without `extra_hosts`, `host.docker.internal` doesn't resolve (`gaierror`);
- with `--add-host=host.docker.internal:host-gateway` it resolves to 192.168.65.254, and the connect fails with `Network is unreachable`.

So every fill or handover naming `boundary` returns `cdp_unavailable` whatever Boundary writes. Bundled Podman hasn't been tried; an internal network there has no gateway either.

## R1 · A route from the broker to the host for the `boundary` provider

**Why:** Boundary's relay is the only browser where a fill can happen for a Boundary user, and it runs on the host, not in a container.

**Ask:** give the broker a route to `host.docker.internal`, for example a third, non-internal network with `extra_hosts: ["host.docker.internal:host-gateway"]`, as `hermes` has. If a general egress route is too wide for the broker, a small forwarder on the `browser` network that only connects to the host's relay port would also do; then say which host and port Boundary should write into `boundary.url`.

**Acceptance:** with the add-on on and Boundary running, from inside the broker, `python3 -c "import socket; socket.create_connection(('host.docker.internal', <relay port>), 3)"` connects, on Docker Desktop and on Podman; and a `browser_vault` fill naming `boundary` in a Boundary chat fills the field.

**Boundary fallback:** none. Boundary writes the two files and serves the credential client either way (ADR 0065); fills in Boundary's browser fail with `cdp_unavailable` until R1 lands.

**Built (stack 5189288):** the broker joins `vault` and a new network, `bitwarden-egress`, which is not internal and which only the broker joins, with `extra_hosts: ["host.docker.internal:host-gateway"]`. The provider entry gains `hosts`: the `boundary` entry allows `host.docker.internal` and `host.containers.internal`, and `Provider.endpoint()` treats a `boundary.url` naming any other host as missing (`cdp_unavailable`). Boundary writes `host.docker.internal`, so `credentialClientUrl` stays as it is. The acceptance check hasn't been run yet on either engine.

## R2 · Say who else may read `secrets/`

**Why:** `boundary.token` lets its holder run script in and set cookies for pages in the user's own Chrome. At f48d62c `bitwarden-setup` mounts the same folder read-write; it is a one-shot tool the user runs, so this is fine today.

**Ask:** keep the folder out of other services' mounts, or tell Boundary where else to write the token if that changes.

**Acceptance:** `docs/contracts/credentials.md` lists the services that mount the add-on's `secrets` folder.

**Built (stack 5189288):** `docs/contracts/credentials.md` names two: `bitwarden-broker` read-only and `bitwarden-setup` read-write. `hermes` mounts only `broker-api/`. `scripts/test-bitwarden-compose-config.py` fails if any other service mounts `secrets/`, and the stack announces a change to that list in its changelog before it ships.
