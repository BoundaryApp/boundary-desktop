# 0007 · Profile bootstrap: create a gateway profile whose folder exists without config.yaml

**Serves:** first-run assistant start-up (no spec).
**Status:** Open

## Background

The `hermes` service mounts `./data/hermes` at `/opt/data` and `./data/hermes/memories` over `/opt/data/profiles/api-server/memories` and `/opt/data/profiles/browser/memories`. On a fresh install those mount points don't exist, so the first container that starts from the `hermes` service (Boundary's one-shot `hermes setup --non-interactive --reset`) creates `profiles/api-server/` and `profiles/browser/` holding only an empty `memories/`.

`bootstrap-api-profile.sh` decides whether to create a profile from `hermes profile list`. The stub folders make the list report both profiles, so `hermes profile create --clone` is skipped, and the following `set_yaml_list` on the missing `config.yaml` exits 1. Checked against `v0.3.4`.

## R1 · Create the profile when config.yaml is missing (Wanted)

**Why:** Boundary deletes the stub folders from the host before `docker compose up`. On a first install with Docker Desktop that delete was refused with `EACCES` on `profiles/browser/memories` straight after the setup container exited, and start-up failed. The same folder could be removed moments later. Deleting folders the stack's own mounts create is a race Boundary can't fully win.

**Ask:** in `bootstrap-api-profile.sh`, treat a profile as missing when `${PROFILE_DIR}/config.yaml` doesn't exist, even if `hermes profile list` reports it. Clone into the existing folder, or move the stub aside first, without dropping the `memories` mount.

**Acceptance:** from an empty `data/hermes`, running `docker compose run --rm --no-deps --entrypoint hermes hermes setup --non-interactive --reset` and then `docker compose up -d hermes` leaves `profiles/api-server/config.yaml` and `profiles/browser/config.yaml` in place with no host-side cleanup in between.

**Boundary fallback:** `removeIncompleteHermesProfiles` (`src/main/services/assistant/assistantPaths.ts`) deletes stub profile folders before setup and before `up`, retries a refused delete, and logs instead of failing start-up when the folder still can't be removed. The function and both calls in `AssistantStackService.ts` go once R1 is in the pinned tag.
