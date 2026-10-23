#!/usr/bin/env bash
# Run Boundary Desktop against a sibling sovereign-agent-stack checkout (../assistant).
# Attaches to an already-healthy Hermes on default ports when possible; never wipes
# the checkout (reset IPC / reset:dev-state are blocked while this mode is active).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ASSISTANT_CANDIDATE="${BOUNDARY_ASSISTANT_ROOT:-$ROOT/../assistant}"

if [[ ! -d "${ASSISTANT_CANDIDATE}" ]]; then
  echo "Local assistant stack not found at: ${ASSISTANT_CANDIDATE}" >&2
  echo "Clone sovereign-agent-stack as a sibling ../assistant, or set BOUNDARY_ASSISTANT_ROOT." >&2
  exit 1
fi

ASSISTANT="$(cd "${ASSISTANT_CANDIDATE}" && pwd)"
if [[ ! -f "${ASSISTANT}/docker-compose.yml" ]]; then
  echo "Expected docker-compose.yml under local assistant root: ${ASSISTANT}" >&2
  exit 1
fi

export BOUNDARY_LOCAL_STACK=1
export BOUNDARY_ASSISTANT_ROOT="${ASSISTANT}"
export DEBUG="${DEBUG:-boundary:*}"

echo "dev:local-stack → BOUNDARY_ASSISTANT_ROOT=${BOUNDARY_ASSISTANT_ROOT}"
echo "  Resets are blocked. Quit leaves the live stack running."
echo "  Prefer starting ../assistant first (make up); Boundary will attach if Hermes :8643 is healthy."

cd "${ROOT}"
FORGE="${ROOT}/node_modules/.bin/electron-forge"
if [[ ! -x "${FORGE}" ]]; then
  echo "electron-forge not found at ${FORGE}. Run npm install from the repo root." >&2
  exit 1
fi
exec "${FORGE}" start
