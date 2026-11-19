#!/usr/bin/env bash
# Builds Boundary's Linux packages in a container and launches the packaged app once with
# BOUNDARY_SMOKE_EXIT=1, the same check CI runs on ubuntu-latest.
#
#   scripts/linux-build-check/run.sh            # host architecture (arm64 on Apple Silicon)
#   scripts/linux-build-check/run.sh amd64      # x64, as on the runner; slower under emulation
#   scripts/linux-build-check/run.sh arm64 --check   # also runs `bun run check` first
#
# The repository is copied into the container without node_modules, so dependencies install
# for Linux. Packages land in out/linux-check/<arch>/.
set -euo pipefail

ARCH="${1:-$(docker info --format '{{.Architecture}}' | sed 's/aarch64/arm64/;s/x86_64/amd64/')}"
RUN_CHECK="${2:-}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IMAGE="boundary-linux-build-check:${ARCH}"
OUT="${ROOT}/out/linux-check/${ARCH}"
mkdir -p "${OUT}"

docker build --platform "linux/${ARCH}" -t "${IMAGE}" "${ROOT}/scripts/linux-build-check"

docker run --rm --platform "linux/${ARCH}" \
  -v "${ROOT}:/src:ro" -v "${OUT}:/out" \
  -e RUN_CHECK="${RUN_CHECK}" \
  "${IMAGE}" bash -euo pipefail -c '
    rsync -a --exclude node_modules --exclude out --exclude .vite --exclude ".claude/worktrees" /src/ /work/
    node scripts/setup-dependencies.js
    if [ "${RUN_CHECK}" = "--check" ]; then
      NODE_OPTIONS=--max-old-space-size=4096 bun run check
    fi
    NODE_ENV=production bun run dist:linux
    exe=$(find out -maxdepth 2 -type f -name Boundary -perm -u+x | head -n 1)
    [ -n "${exe}" ] || { echo "No packaged executable under out/" >&2; ls -la out; exit 1; }
    echo "Smoke launch: ${exe}"
    # Docker'\''s default seccomp profile blocks the namespaces Chromium'\''s sandbox uses; CI keeps it.
    BOUNDARY_SMOKE_EXIT=1 xvfb-run -a "${exe}" --no-sandbox
    cp -r out/make /out/
    echo "Packages:"; find /out/make -type f \( -name "*.deb" -o -name "*.rpm" \) -exec ls -la {} \;
  '
