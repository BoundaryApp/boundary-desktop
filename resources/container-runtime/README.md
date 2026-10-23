# Container runtime assets (macOS)

Boundary packages a fallback Podman stack for machines without Docker Desktop.

Licences for everything shipped here are in [`../licenses/container-runtime/`](../licenses/container-runtime/README.md).

## Layout

Matches Podman’s macOS installer (`/opt/podman`): helpers in `bin/`, dylibs in `lib/`, krunkit EFI firmware in `share/`.

```
resources/container-runtime/
  darwin-arm64/
    bin/podman
    bin/docker-compose
    bin/gvproxy            # required (from gvisor-tap-vsock)
    bin/krunkit            # required on arm64 (libkrun)
    bin/vfkit              # required on x64; also staged on arm64
    lib/libkrun.dylib      # required on arm64 (plus epoxy / virgl / MoltenVK)
    share/krunkit/KRUN_EFI.silent.fd  # required on arm64
    machine/machine-os.zst # optional; omit to let `podman machine init` pull
  darwin-x64/
    …same layout (vfkit required; krunkit also staged)
```

Helpers are **not** inside `podman-remote-release-*.zip`. `scripts/fetch-container-runtime.sh` downloads them from the same GitHub releases Podman’s macOS installer uses, extracts the krunkit tarball as-is, and fails if they are missing.

## Fetch

```bash
./scripts/fetch-container-runtime.sh
```

Pins are in the script. Binaries are gitignored; run the script before packaging.

## Runtime resolution

See `src/main/services/containerRuntime/bundledPaths.ts`. Packaged apps resolve
under `process.resourcesPath/container-runtime/<platform-arch>/`.
