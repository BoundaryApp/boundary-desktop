# 0025 · Twenty: keys for one person, and adding a workspace that can't answer yet

**Serves:** [ADR 0048](../adr/0048-sharing-a-service-with-a-circle.md) and the [shared services spec](../shared-services-ux-study/spec.md): a member shares their Twenty with a Circle, and each person they grant gets their own keys.
**Status:** Open

## Background

ADR 0048 gives each person a provider shares Twenty with their own API keys, held on the provider's Mac, so Twenty records their changes under their name and one person's access can be revoked alone. Checked against v0.3.11, the tag Boundary pins, and Twenty's source at `twenty/v2.55.0`:

- `twenty_admin.py`'s `mint_key` calls `createApiKey` with a name, `KEY_EXPIRY` and a role id, then `generateApiKeyToken`. `revoke_keys_named` revokes every unrevoked key with a given name. `ensure_roles` finds the two roles by label (`Hermes read-only`, `Hermes read-write`) or creates them. All three need the owner's session, which `sign_in` gets from the owner login in the stack's `.env`.
- `crm.sh` exposes none of this on its own. `crm init --rotate` mints and revokes only the stack's two keys.
- `crm.sh add` sends an MCP `initialize` to `<url>/mcp` with each key and refuses to write the workspace file unless it answers 200.

## R1 · Mint and revoke keys for one person (Wanted)

**Why:** Boundary mints a key per person and level when a provider grants access, and revokes it when the grant ends. Doing that through the stack keeps the role labels and the owner sign-in in one place.

**Ask:** `crm.sh key create --name NAME --access read|write` signs in as the local owner, mints a key with that name for the matching role, and prints one JSON line to stdout: `{"id": "<key id>", "token": "<token>"}`, with progress and errors on stderr. `crm.sh key revoke --id ID` revokes that key and prints nothing on success. Both refuse when the local instance isn't running.

**Acceptance:** a token from `key create --access read` answers `tools/list` at `/mcp` and is refused a `create_one_company` call. After `key revoke` with its id, the same token is refused at `/mcp`. A record created with a `write` token shows the key's name as its creator.

**Boundary fallback:** Boundary's main process makes the same GraphQL calls through `/metadata`, as it does for the sign-in link (0023 R4's fallback), finding the roles by the labels above. Removed once the pinned tag has R1.

## R2 · Add a workspace without checking it first (Wanted)

**Why:** a member who turns on a shared Twenty while its provider's Mac is offline has nothing to answer the check, so `crm.sh add` refuses, although the address and tokens are right.

**Ask:** `crm.sh add --no-check` writes the workspace file without the MCP `initialize` calls, and says so on stdout.

**Acceptance:** `crm.sh add --slug s --url http://127.0.0.1:9 --no-check` with both key variables set writes `s.env` and exits 0.

**Boundary fallback:** Boundary writes the workspace file itself, in the format `cmd_add` writes, when the provider is offline. Removed once the pinned tag has R2.

> **Boundary note (12 Nov 2026):** the check can't pass from this Mac even when the provider is
> online. `crm.sh connect` and `add` run `curl` on the host against the URL they're given, and a
> shared workspace's URL is `http://host.docker.internal:<port>`, which containers resolve and the
> Mac doesn't (stack v0.3.14, `scripts/crm.sh` `mcp_status` and `catalog_check`). Boundary now
> always writes the instance file and keys itself, in `apply_instance`'s layout, and checks them
> with `test:stack` against `addon_manifest.py instances-plan`. R2 as asked would still help:
> with `--no-check`, Boundary could go through `addon.sh connect twenty` and its validation
> instead of writing the store. Alternatively, a check that runs from a container, or that maps
> `host.docker.internal` to `127.0.0.1` for the host-side `curl`, would let the check pass.
