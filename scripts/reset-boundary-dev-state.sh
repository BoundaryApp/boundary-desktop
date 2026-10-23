#!/usr/bin/env bash
# Reset local Boundary Desktop state so the next launch behaves like a fresh install.
# macOS-oriented (Application Support / Logs / Preferences). Does not touch Docker Desktop.
#
# Usage:
#   ./scripts/reset-boundary-dev-state.sh --yes
#   ./scripts/reset-boundary-dev-state.sh --yes --keep-machine
#   BOUNDARY_RESET_CONFIRM=1 ./scripts/reset-boundary-dev-state.sh
#
# Package scripts:
#   bun run reset:dev-state -- --yes
#   bun run dev:fresh          # wipe (incl. boundary machine) then dev with no-Docker emulate
#   bun run dev:local-stack    # sibling ../assistant; resets blocked while env is set
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIRM="${BOUNDARY_RESET_CONFIRM:-0}"
KEEP_MACHINE=0
YES=0

usage() {
  cat <<'EOF'
Reset Boundary Desktop local state for fresh-install testing.

Options:
  --yes              Required unless BOUNDARY_RESET_CONFIRM=1
  --keep-machine     Do not stop/remove the Podman machine named "boundary"
  --machine          Force remove the boundary machine (default)
  -h, --help         Show this help

Environment:
  BOUNDARY_RESET_CONFIRM=1   Same as --yes

Blocked when BOUNDARY_LOCAL_STACK=1 or BOUNDARY_ASSISTANT_ROOT is set
(dev:local-stack mode) so a sibling ../assistant checkout cannot be wiped.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes|-y) YES=1 ;;
    --keep-machine) KEEP_MACHINE=1 ;;
    --machine) KEEP_MACHINE=0 ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

if [[ "${CONFIRM}" == "1" ]]; then
  YES=1
fi

if [[ "${YES}" != "1" ]]; then
  echo "Refusing to wipe without --yes (or BOUNDARY_RESET_CONFIRM=1)." >&2
  echo "This deletes ~/Library/Application Support/Boundary and related logs/prefs." >&2
  exit 1
fi

# Never wipe while pointed at a live local sovereign-agent-stack checkout.
if [[ "${BOUNDARY_LOCAL_STACK:-}" == "1" ]] || [[ -n "${BOUNDARY_ASSISTANT_ROOT:-}" ]]; then
  echo "Refusing to reset: local assistant stack mode is active." >&2
  echo "  BOUNDARY_LOCAL_STACK=${BOUNDARY_LOCAL_STACK:-unset}" >&2
  echo "  BOUNDARY_ASSISTANT_ROOT=${BOUNDARY_ASSISTANT_ROOT:-unset}" >&2
  echo "Unset those (and do not use bun run dev:local-stack) before reset:dev-state / dev:fresh." >&2
  exit 1
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This reset script currently supports macOS only." >&2
  exit 1
fi

# Refuse if a Boundary / forge process looks active (best-effort).
if pgrep -fl 'electron-forge start|Electron\.app.*boundary|Boundary\.app' >/dev/null 2>&1; then
  echo "Boundary or electron-forge appears to be running. Quit it first, then re-run." >&2
  pgrep -fl 'electron-forge start|Electron\.app.*boundary|Boundary\.app' 2>/dev/null || true
  exit 1
fi

SUPPORT="${HOME}/Library/Application Support/Boundary"
LOGS="${HOME}/Library/Logs/Boundary"
PREFS="${HOME}/Library/Preferences/com.boundary.desktop.plist"
CACHE_A="${HOME}/Library/Caches/Boundary"
CACHE_B="${HOME}/Library/Caches/com.boundary.desktop"

ARCH="$(uname -m)"
case "${ARCH}" in
  arm64) FOLDER="darwin-arm64"; PROVIDER="libkrun" ;;
  x86_64) FOLDER="darwin-x64"; PROVIDER="applehv" ;;
  *) FOLDER=""; PROVIDER="" ;;
esac

remove_boundary_machine() {
  if [[ -z "${FOLDER}" ]]; then
    echo "Skipping Podman machine removal (unsupported arch: ${ARCH})."
    return 0
  fi
  local RT PODMAN CONF_DIR CONF
  RT="${ROOT}/resources/container-runtime/${FOLDER}"
  PODMAN="${RT}/bin/podman"
  if [[ ! -x "${PODMAN}" ]]; then
    echo "Bundled podman not found at ${PODMAN}; skipping machine removal."
    echo "Run ./scripts/fetch-container-runtime.sh if you need machine reset."
    return 0
  fi

  # Prefer existing Boundary conf; otherwise a temp conf so machine list/rm still works
  # after (or without) userData.
  local TMP_CONF_DIR=""
  if [[ -f "${SUPPORT}/container-runtime/containers.conf" ]]; then
    export CONTAINERS_CONF="${SUPPORT}/container-runtime/containers.conf"
  else
    TMP_CONF_DIR="$(mktemp -d "${TMPDIR:-/tmp}/boundary-reset-conf.XXXXXX")"
    CONF="${TMP_CONF_DIR}/containers.conf"
    cat > "${CONF}" <<EOF
# Temporary conf for reset-boundary-dev-state.sh
[engine]
helper_binaries_dir = ["${RT}/bin"]

[machine]
provider = "${PROVIDER}"
EOF
    export CONTAINERS_CONF="${CONF}"
  fi

  export PATH="${RT}/bin:${PATH}"
  echo "Stopping/removing Podman machine 'boundary' (if present)…"
  "${PODMAN}" machine stop boundary >/dev/null 2>&1 || true
  if "${PODMAN}" machine rm -f boundary >/dev/null 2>&1; then
    echo "Removed machine: boundary"
  else
    echo "No boundary machine to remove (or already gone)."
  fi
  if [[ -n "${TMP_CONF_DIR}" ]]; then
    rm -rf "${TMP_CONF_DIR}"
  fi
}

echo "Resetting Boundary Desktop local state…"

if [[ "${KEEP_MACHINE}" -eq 0 ]]; then
  remove_boundary_machine
else
  echo "Keeping Podman machine 'boundary' (--keep-machine)."
fi

removed=0
for path in "${SUPPORT}" "${LOGS}" "${CACHE_A}" "${CACHE_B}"; do
  if [[ -e "${path}" ]]; then
    rm -rf "${path}"
    echo "Removed: ${path}"
    removed=1
  fi
done
if [[ -f "${PREFS}" ]]; then
  rm -f "${PREFS}"
  echo "Removed: ${PREFS}"
  removed=1
fi

if [[ "${removed}" -eq 0 ]]; then
  echo "Nothing to remove (already clean)."
else
  echo "Done. Next launch will provision like a fresh install."
fi

echo
echo "Suggested:"
echo "  BOUNDARY_EMULATE_NO_DOCKER=1 bun run dev"
echo "  # or: bun run dev:fresh"
