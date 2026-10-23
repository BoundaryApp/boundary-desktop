#!/usr/bin/env bash
# Smoke-test bundled Podman assets: write conf, init/start `boundary` machine, print DOCKER_HOST.
# Does not require Docker Desktop. macOS only.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ARCH="$(uname -m)"
case "${ARCH}" in
  arm64) FOLDER="darwin-arm64"; PROVIDER="libkrun" ;;
  x86_64) FOLDER="darwin-x64"; PROVIDER="applehv" ;;
  *) echo "Unsupported arch: ${ARCH}" >&2; exit 1 ;;
esac

RT="${ROOT}/resources/container-runtime/${FOLDER}"
PODMAN="${RT}/bin/podman"
COMPOSE="${RT}/bin/docker-compose"
STATE="${HOME}/.boundary-desktop-smoke/container-runtime"
CONF="${STATE}/containers.conf"

if [[ ! -x "${PODMAN}" ]]; then
  echo "Missing ${PODMAN}. Run ./scripts/fetch-container-runtime.sh first." >&2
  exit 1
fi
if [[ ! -x "${COMPOSE}" ]]; then
  echo "Missing ${COMPOSE}. Run ./scripts/fetch-container-runtime.sh first." >&2
  exit 1
fi
if [[ ! -x "${RT}/bin/gvproxy" ]]; then
  echo "Missing ${RT}/bin/gvproxy. Re-run ./scripts/fetch-container-runtime.sh." >&2
  exit 1
fi
if [[ "${FOLDER}" == "darwin-arm64" && ! -x "${RT}/bin/krunkit" ]]; then
  echo "Missing ${RT}/bin/krunkit. Re-run ./scripts/fetch-container-runtime.sh." >&2
  exit 1
fi
if [[ "${FOLDER}" == "darwin-arm64" && ! -f "${RT}/share/krunkit/KRUN_EFI.silent.fd" ]]; then
  echo "Missing ${RT}/share/krunkit/KRUN_EFI.silent.fd. Re-run ./scripts/fetch-container-runtime.sh." >&2
  exit 1
fi
if [[ "${FOLDER}" == "darwin-x64" && ! -x "${RT}/bin/vfkit" ]]; then
  echo "Missing ${RT}/bin/vfkit. Re-run ./scripts/fetch-container-runtime.sh." >&2
  exit 1
fi

mkdir -p "${STATE}"
cat > "${CONF}" <<EOF
# Smoke conf for Boundary bundled Podman
[engine]
helper_binaries_dir = ["${RT}/bin"]

[machine]
provider = "${PROVIDER}"
EOF

export CONTAINERS_CONF="${CONF}"
export PATH="${RT}/bin:${PATH}"

MACHINE="boundary"
echo "Using CONTAINERS_CONF=${CONF}"
echo "Podman: $(${PODMAN} version --format '{{.Client.Version}}' 2>/dev/null || echo unknown)"

STATUS="$(${PODMAN} machine list --format '{{.Name}}\t{{.Running}}' 2>/dev/null | awk -F'\t' -v m="${MACHINE}" '{
  name=$1
  sub(/\*+$/, "", name)
  if (name==m) { print $2; exit }
}')"
if [[ -z "${STATUS}" ]]; then
  echo "Initializing machine ${MACHINE} (may download OS image)…"
  INIT_ARGS=(machine init "${MACHINE}" --rootful --now)
  if [[ -f "${RT}/machine/machine-os.zst" ]]; then
    INIT_ARGS+=(--image "${RT}/machine/machine-os.zst")
  fi
  "${PODMAN}" "${INIT_ARGS[@]}"
elif [[ "${STATUS}" != "true" && "${STATUS}" != "True" ]]; then
  echo "Starting machine ${MACHINE}…"
  "${PODMAN}" machine start "${MACHINE}"
else
  echo "Machine ${MACHINE} already running"
fi

SOCK="$("${PODMAN}" machine inspect --format '{{(index . 0).ConnectionInfo.PodmanSocket.Path}}' "${MACHINE}" 2>/dev/null || true)"
if [[ -z "${SOCK}" ]]; then
  SOCK="$("${PODMAN}" machine inspect --format '{{.ConnectionInfo.PodmanSocket.Path}}' "${MACHINE}" 2>/dev/null || true)"
fi
if [[ -z "${SOCK}" ]]; then
  echo "Could not resolve Podman socket path" >&2
  exit 1
fi

export DOCKER_HOST="unix://${SOCK}"
echo "DOCKER_HOST=${DOCKER_HOST}"
"${PODMAN}" info --format 'RemoteSocket={{.Host.RemoteSocket.Path}}' || true
"${COMPOSE}" version --short || true
echo "Smoke OK. Use DOCKER_HOST above with docker-compose against the Boundary-managed sovereign-agent-stack project (or a local override)."
