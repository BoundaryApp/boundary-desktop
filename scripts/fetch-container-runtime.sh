#!/usr/bin/env bash
# Download and stage macOS Podman + Compose + machine helpers for Electron packaging.
# Binaries are gitignored under resources/container-runtime/.
#
# The podman-remote zip is CLI-only. gvproxy / krunkit / vfkit come from the same
# GitHub releases Podman's macOS .pkg uses (see contrib/pkginstaller/Makefile).
# krunkit-podman-unsigned.tgz is extracted as-is (bin/ lib/ share/) so firmware
# resolves at <root>/share/krunkit/KRUN_EFI.silent.fd.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${ROOT}/resources/container-runtime"
TMP="${TMPDIR:-/tmp}/boundary-container-runtime-$$"
mkdir -p "${TMP}"
trap 'rm -rf "${TMP}"' EXIT

# Apple Silicon: Podman 6 (libkrun default). Intel: last remote zip with amd64.
PODMAN_ARM_VERSION="${PODMAN_ARM_VERSION:-6.0.1}"
PODMAN_X64_VERSION="${PODMAN_X64_VERSION:-5.5.2}"
COMPOSE_VERSION="${COMPOSE_VERSION:-2.38.2}"
# Pinned to Podman v6.0.1 installer helper versions.
GVPROXY_VERSION="${GVPROXY_VERSION:-v0.8.9}"
KRUNKIT_VERSION="${KRUNKIT_VERSION:-1.3.2}"
VFKIT_VERSION="${VFKIT_VERSION:-0.6.4}"

download() {
  local url="$1" dest="$2"
  echo "Fetching ${url}"
  curl -fsSL -o "${dest}" "${url}"
}

clear_quarantine() {
  local target="$1"
  if command -v xattr >/dev/null 2>&1; then
    xattr -cr "${target}" >/dev/null 2>&1 || true
  fi
}

# Replace dest even when it is mode 555/444 (BSD cp cannot overwrite non-writable files).
stage_file() {
  local src="$1" dest="$2" mode="${3:-755}"
  mkdir -p "$(dirname "${dest}")"
  rm -f "${dest}"
  cp "${src}" "${dest}"
  chmod "${mode}" "${dest}"
}

ensure_helper_downloads() {
  if [[ -f "${TMP}/gvproxy-darwin" ]]; then
    return
  fi
  download \
    "https://github.com/containers/gvisor-tap-vsock/releases/download/${GVPROXY_VERSION}/gvproxy-darwin" \
    "${TMP}/gvproxy-darwin"
  download \
    "https://github.com/crc-org/vfkit/releases/download/v${VFKIT_VERSION}/vfkit-unsigned" \
    "${TMP}/vfkit-unsigned"
  download \
    "https://github.com/containers/krunkit/releases/download/v${KRUNKIT_VERSION}/krunkit-podman-unsigned-${KRUNKIT_VERSION}.tgz" \
    "${TMP}/krunkit.tgz"
}

# Extract Podman's krunkit tarball (bin/krunkit, lib/*.dylib, share/krunkit/*.fd)
# and place gvproxy / vfkit next to podman in bin/.
stage_helpers() {
  local dest="$1"
  ensure_helper_downloads

  tar -xzf "${TMP}/krunkit.tgz" -C "${dest}"
  if [[ -f "${dest}/bin/krunkit" ]]; then
    chmod 755 "${dest}/bin/krunkit"
  fi
  if [[ -d "${dest}/lib" ]]; then
    chmod -R u+w "${dest}/lib"
    find "${dest}/lib" -type f \( -name '*.dylib' -o -name '*.so' \) -exec chmod 644 {} +
  fi

  stage_file "${TMP}/gvproxy-darwin" "${dest}/bin/gvproxy" 755
  stage_file "${TMP}/vfkit-unsigned" "${dest}/bin/vfkit" 755
}

# krunkit-podman-unsigned ships LC_RPATH=/opt/homebrew/lib:/opt/podman/lib.
# Point krunkit at bundled lib/, and dylibs at their own directory.
fix_bundled_rpaths() {
  local dest="$1"
  local bin

  strip_stock_rpaths() {
    local target="$1"
    chmod u+w "${target}" 2>/dev/null || true
    install_name_tool -delete_rpath /opt/homebrew/lib "${target}" 2>/dev/null || true
    install_name_tool -delete_rpath /opt/podman/lib "${target}" 2>/dev/null || true
    install_name_tool -delete_rpath /usr/local/lib "${target}" 2>/dev/null || true
  }

  if [[ -f "${dest}/bin/krunkit" ]]; then
    strip_stock_rpaths "${dest}/bin/krunkit"
    if ! otool -l "${dest}/bin/krunkit" 2>/dev/null | grep -q 'path @loader_path/../lib'; then
      install_name_tool -add_rpath '@loader_path/../lib' "${dest}/bin/krunkit"
    fi
  fi

  shopt -s nullglob
  for bin in "${dest}/lib"/*.dylib; do
    [[ -f "${bin}" ]] || continue
    strip_stock_rpaths "${bin}"
    if ! otool -l "${bin}" 2>/dev/null | grep -q 'path @loader_path'; then
      install_name_tool -add_rpath '@loader_path' "${bin}"
    fi
  done
  shopt -u nullglob
}

require_helpers() {
  local dest="$1" arch="$2"
  local missing=0
  if [[ ! -x "${dest}/bin/gvproxy" ]]; then
    echo "Required helper missing: ${dest}/bin/gvproxy" >&2
    missing=1
  fi
  if [[ "${arch}" == "arm64" ]]; then
    if [[ ! -x "${dest}/bin/krunkit" ]]; then
      echo "Required helper missing: ${dest}/bin/krunkit (libkrun provider)" >&2
      missing=1
    fi
    if ! ls "${dest}/lib"/libkrun*.dylib >/dev/null 2>&1; then
      echo "Required helper missing: ${dest}/lib/libkrun*.dylib" >&2
      missing=1
    fi
    if [[ ! -f "${dest}/share/krunkit/KRUN_EFI.silent.fd" ]]; then
      echo "Required helper missing: ${dest}/share/krunkit/KRUN_EFI.silent.fd (krunkit firmware)" >&2
      missing=1
    fi
    if [[ -x "${dest}/bin/krunkit" ]] && ! otool -l "${dest}/bin/krunkit" 2>/dev/null | grep -q 'path @loader_path/../lib'; then
      echo "krunkit is missing @loader_path/../lib rpath; bundled libkrun.dylib will not load" >&2
      missing=1
    fi
  else
    if [[ ! -x "${dest}/bin/vfkit" ]]; then
      echo "Required helper missing: ${dest}/bin/vfkit (applehv provider)" >&2
      missing=1
    fi
  fi
  if [[ "${missing}" -ne 0 ]]; then
    exit 1
  fi
}

stage_darwin() {
  local arch="$1" podman_ver="$2" zip_arch="$3"
  local dest="${OUT}/darwin-${arch}"
  local zip="${TMP}/podman-${arch}.zip"
  local extract="${TMP}/podman-${arch}"
  local compose_bin="${TMP}/docker-compose-${arch}"

  rm -rf "${dest}"
  mkdir -p "${dest}/bin" "${dest}/lib" "${dest}/share" "${dest}/machine"
  download \
    "https://github.com/containers/podman/releases/download/v${podman_ver}/podman-remote-release-darwin_${zip_arch}.zip" \
    "${zip}"
  rm -rf "${extract}"
  mkdir -p "${extract}"
  unzip -q "${zip}" -d "${extract}"

  local podman_src
  podman_src="$(find "${extract}" -type f -name 'podman' | head -1)"
  if [[ -z "${podman_src}" ]]; then
    echo "podman binary not found in release zip" >&2
    exit 1
  fi

  stage_file "${podman_src}" "${dest}/bin/podman" 755
  stage_helpers "${dest}"
  fix_bundled_rpaths "${dest}"

  local compose_arch
  if [[ "${arch}" == "arm64" ]]; then
    compose_arch="darwin-aarch64"
  else
    compose_arch="darwin-x86_64"
  fi
  download \
    "https://github.com/docker/compose/releases/download/v${COMPOSE_VERSION}/docker-compose-${compose_arch}" \
    "${compose_bin}"
  stage_file "${compose_bin}" "${dest}/bin/docker-compose" 755

  # Optional machine image: leave empty so `podman machine init` pulls the matching tag.
  touch "${dest}/machine/.keep"

  clear_quarantine "${dest}"
  require_helpers "${dest}" "${arch}"

  echo "Staged ${dest}"
  ls -la "${dest}/bin" "${dest}/lib" "${dest}/share/krunkit" 2>/dev/null || ls -la "${dest}/bin" "${dest}/lib" || true
}

mkdir -p "${OUT}"
stage_darwin "arm64" "${PODMAN_ARM_VERSION}" "arm64"
stage_darwin "x64" "${PODMAN_X64_VERSION}" "amd64"

echo "Done. Package with electron-forge after this directory is populated."
