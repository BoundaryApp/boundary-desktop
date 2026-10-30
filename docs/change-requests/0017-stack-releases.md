# 0017 · Stack releases Boundary can install unattended

**Serves:** [updates plan](../updates-plan.md) (phases 3, 4 and 6).
**Status:** Open

## Background

Boundary installs the stack from a GitHub source zip of a pinned commit, checks it against a SHA-256 compiled into the app, and swaps it in on launch with a data backup taken first. The updates plan moves the pin into a channel file Boundary signs, so a tested stack release can reach users without a Boundary release. Updates then run on users' Macs with nobody reading the CHANGELOG's upgrade steps. Each item below replaces something a person does by hand today, or something Boundary hard-codes and would have to guess.

## R1 · An immutable release archive per tag (Wanted)

**Why:** Boundary pins the SHA-256 of `https://github.com/kaxline/sovereign-agent-stack/archive/<ref>.zip`. GitHub generates that file on request and recommends release assets when a stable checksum matters, so a change on GitHub's side would break every install.

**Ask:** each tag gets a GitHub Release with the tree as a release asset (`sovereign-agent-stack-vX.Y.Z.tar.gz`) and its `.sha256`, built by CI from the tag.

**Acceptance:** downloading the asset twice, a week apart, gives the same hash, and the hash matches the published `.sha256`.

**Boundary fallback:** Boundary's release workflow downloads the source zip once, checks it, and re-publishes it as an asset of a Boundary release. The channel file points there.

## R2 · Machine-readable release metadata (Wanted)

**Why:** the CHANGELOG's Upgrade steps, Required keys and Host requirements sections are written for a person. Boundary hard-codes the matching facts: `PRESERVED_PROJECT_PATHS` (which must match `.gitignore`), the data directories that migrate one way, and the profiles to start.

**Ask:** a `release.json` at the root of the tree, written as part of tagging:

```json
{
  "version": "v0.3.5",
  "kind": "patch",
  "upgradeFrom": ">=v0.3.0",
  "preserve": ["data", ".env", "compose/hermes/api-server.env", "…"],
  "oneWayData": ["hermes", "n8n", "rag_storage", "neo4j", "db"],
  "requiredEnv": ["NEW_KEY"],
  "hostRequirements": { "dockerCompose": ">=2.30", "memoryMiB": 12288 }
}
```

**Acceptance:** CI fails a tag whose `release.json` is missing, invalid, or whose `version` does not match the tag; `preserve` is checked against `.gitignore`.

**Boundary fallback:** the lists stay hard-coded in Boundary, and a maintainer copies changes from the CHANGELOG into the channel file entry.

## R3 · The stack's version at runtime (Wanted)

**Why:** Boundary cannot tell which stack it is talking to. Local stack mode attaches to any running stack, and after an update Boundary needs to confirm the new version is the one that answered the health check.

**Ask:** `gateway.capabilities` returns `stack_version` (the tag, or `git describe` output for an untagged checkout) and `hermes_version`. A `VERSION` file at the root of the tree holds the same tag.

**Acceptance:** with v0.3.5 running, `gateway.capabilities` reports `stack_version: "v0.3.5"`; on a checkout nine commits past it, it reports the `git describe` string.

**Boundary fallback:** Boundary trusts its own record of the version it installed, and treats an attached local stack as unknown.

## R4 · Upstream images pinned by digest (Wanted)

**Why:** `.env.example` pins tags such as `HERMES_AGENT_IMAGE_TAG=v0.22.5`. A tag can be moved, so two users on the same stack release can run different images, and a rollback can come back to a different image than it left.

**Ask:** pins in `.env.example` and the compose defaults use `name:tag@sha256:<digest>`. A tool such as Renovate keeps the digests current.

**Acceptance:** `docker compose config` for every profile set shows a digest on every image that is not built locally.

**Boundary fallback:** none needed; Boundary records the digests it pulled during staging and can detect a moved tag, but cannot prevent it.

## R5 · Prebuilt, signed images for the locally built services (Later)

**Why:** `up --build` builds llm-proxy, the OpenCode images, caldav-mcp and the Hermes worker on the user's Mac on first start and on every update. Builds are the slowest and least predictable part of an update, and their output differs by machine.

**Ask:** a release workflow that builds these images for `linux/arm64` and `linux/amd64`, pushes them to GHCR by digest, and signs them with cosign keyless signing from that workflow. Compose keeps `build:` for development and uses the published image by default.

**Acceptance:** `cosign verify --certificate-identity-regexp '^https://github.com/kaxline/sovereign-agent-stack/.github/workflows/release.yml@refs/tags/v' --certificate-oidc-issuer https://token.actions.githubusercontent.com <image@digest>` passes for each image of a release.

**Boundary fallback:** Boundary keeps building locally, during staging once R6 lands.

## R6 · A tag variable for locally built images (Wanted)

**Why:** locally built images are tagged `${IMAGE_PREFIX}-<service>:local`. Boundary wants to build the next release's images while the current stack runs, and keep the previous release's images for a rollback. Both need a tag per release.

**Ask:** `${IMAGE_PREFIX}-<service>:${LOCAL_IMAGE_TAG:-local}` for every image with a `build:` section.

**Acceptance:** with `LOCAL_IMAGE_TAG=v0.3.5`, `compose build` produces `boundary-assistant-llm-proxy:v0.3.5` and leaves `:local` alone.

**Boundary fallback:** Boundary builds at apply time on launch, as today, and a rollback rebuilds.

## R7 · A consistent backup of the shared Postgres cluster (Wanted)

**Why:** Boundary's pre-update backup does not include `data/db`. Boundary plans to clone the cluster directory with the containers stopped, and needs the stack to say whether that is safe for its Postgres image and shutdown settings.

**Ask:** confirm that a file copy of `data/db` after `compose down` (default stop timeout) is a consistent backup, or provide `scripts/db-dump.sh` that writes a `pg_dumpall` file Boundary can run before stopping the stack.

**Acceptance:** restoring the copy or dump into a fresh `data/db` starts Postgres without recovery warnings, and every service that uses it starts.

**Boundary fallback:** Boundary clones `data/db` with the containers stopped, and a failed restore tells the user to restore by hand from the kept copy.

## R8 · Non-interactive upgrade steps (Wanted)

**Why:** some upgrades have steps beyond `setup.sh` and `up`, such as `make hermes-upgrade`. Boundary cannot run a step that is only described in the CHANGELOG.

**Ask:** `scripts/upgrade.sh --from vX.Y.Z --non-interactive` runs every step needed between two versions, and is a no-op when none is needed. `setup.sh` already runs this way.

**Acceptance:** upgrading a v0.3.0 install to the latest tag with `setup.sh --non-interactive`, `upgrade.sh --from v0.3.0 --non-interactive` and `compose up` matches a fresh install of the latest tag, apart from user data.

**Boundary fallback:** releases with manual steps are not added to the channel file, or Boundary carries the step for that one release.
