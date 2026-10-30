# 0016 · setup.sh fails on macOS's bash 3.2

**Serves:** first-run setup and stack upgrades on macOS.
**Status:** R1 and R2 done in v0.3.7, which Boundary pins

## Background

Boundary runs `scripts/setup.sh` with `bash` from a packaged app's PATH. Without Homebrew's bash on that PATH this is `/bin/bash` 3.2.57, where expanding an empty array with `set -u` on is an error.

`97df9a3` (first tagged in v0.3.5) added a loop over `buzz_profiles` to the `HERMES_BUZZ_ENABLED=0` branch of `scripts/sync-buzz-profile.sh`. With `HERMES_BUZZ_PROFILES` unset, which is the default, `read -a` leaves the array empty and the script exits with `buzz_profiles[@]: unbound variable`. Bash reports it at line 286, the `fi` that closes the branch; the expansion is on line 280. `setup.sh` then stops at line 937.

Checked by running the v0.3.6 `setup.sh` with Boundary's arguments under `/bin/bash` in a scratch copy with a stub `docker`: it fails this way with no `.env`. With the loop patched, or `HERMES_BUZZ_PROFILES=,` in `.env`, it runs on to the `source <(...)` at line 975. That line then fails with the error from `generate-n8n-credentials.js`, which Boundary already recovers from (`regenerateN8nCredentialsFromEnv`). The same empty-array loop is at line 223 for `HERMES_BUZZ_ENABLED=1` with no profiles. The `scripts/doctor.sh` loop at line 743 sits behind an empty check.

## R1 · Iterate an empty list safely (Blocking)

**Why:** every macOS install or upgrade without a newer bash on PATH fails at setup from v0.3.5 on. A stack user running `make ensure-local` under `/bin/bash` hits the same exit.

**Ask:** in `scripts/sync-buzz-profile.sh`, change both loops to `for name in ${buzz_profiles[@]+"${buzz_profiles[@]}"}; do`, or skip them when `profiles_csv` is empty.

**Acceptance:** `/bin/bash scripts/sync-buzz-profile.sh` exits 0 on macOS with `HERMES_BUZZ_PROFILES` unset, for both values of `HERMES_BUZZ_ENABLED`.

**Boundary fallback:** none shipped. A fallback that wrote `HERMES_BUZZ_PROFILES=,` to `.env` was built and dropped when v0.3.7 was tagged, so no install carries the comma.

> **Stack reply (done):** v0.3.7 changes both loops as asked, and skips the Buzz sync on a stack that has not configured Buzz. It also replaces the `source <(...)` in `setup.sh` with `eval`, and fixes `todo.sh`, which had not parsed under 3.2 since v0.3.3.

## R2 · Run the setup scripts under bash 3.2 in the stack's checks (Wanted)

**Why:** a developer machine with Homebrew's bash passes `#!/usr/bin/env bash` scripts that fail for users on the system shell.

**Ask:** a check that runs `setup.sh --non-interactive` under `/bin/bash` on macOS, or a lint for empty-array expansion and bash 4 syntax.

**Acceptance:** reverting R1 fails the check.

**Boundary fallback:** none.

> **Stack reply (done):** `make bash32-test` and a macOS CI job, both with a stub `docker`.
