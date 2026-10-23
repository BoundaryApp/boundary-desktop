# Container runtime licences

The macOS app ships these files under `Resources/container-runtime/`, fetched by
`scripts/fetch-container-runtime.sh`. Versions are the script's defaults. None of them are
modified.

| Shipped file | Project | Version | Licence | Text |
| --- | --- | --- | --- | --- |
| `bin/podman` | [Podman](https://github.com/containers/podman) (remote client) | 6.0.1 (arm64), 5.5.2 (x64) | Apache-2.0 | [podman.LICENSE](podman.LICENSE) |
| `bin/docker-compose` | [Docker Compose](https://github.com/docker/compose) | 2.38.2 | Apache-2.0 | [docker-compose.LICENSE](docker-compose.LICENSE), [docker-compose.NOTICE](docker-compose.NOTICE) |
| `bin/gvproxy` | [gvisor-tap-vsock](https://github.com/containers/gvisor-tap-vsock) | 0.8.9 | Apache-2.0 | [gvproxy.LICENSE](gvproxy.LICENSE) |
| `bin/vfkit` | [vfkit](https://github.com/crc-org/vfkit) | 0.6.4 | Apache-2.0 | [vfkit.LICENSE](vfkit.LICENSE) |
| `bin/krunkit` | [krunkit](https://github.com/containers/krunkit) | 1.3.2 | Apache-2.0 | [krunkit.LICENSE](krunkit.LICENSE) |
| `lib/libkrun.dylib` | [libkrun](https://github.com/containers/libkrun) | from the krunkit 1.3.2 release | Apache-2.0 | [libkrun.LICENSE](libkrun.LICENSE) |
| `lib/libMoltenVK.dylib` | [MoltenVK](https://github.com/KhronosGroup/MoltenVK) | from the krunkit 1.3.2 release | Apache-2.0 | [MoltenVK.LICENSE](MoltenVK.LICENSE) |
| `lib/libepoxy.0.dylib` | [libepoxy](https://github.com/anholt/libepoxy) | from the krunkit 1.3.2 release | MIT | [libepoxy.COPYING](libepoxy.COPYING) |
| `lib/libvirglrenderer.1.dylib` | [virglrenderer](https://gitlab.freedesktop.org/virgl/virglrenderer) | from the krunkit 1.3.2 release | MIT | [virglrenderer.COPYING](virglrenderer.COPYING) |
| `share/krunkit/KRUN_EFI.silent.fd` | EFI firmware built from [TianoCore EDK2](https://github.com/tianocore/edk2) | from the krunkit 1.3.2 release | BSD-2-Clause-Patent | [edk2.License.txt](edk2.License.txt) |

When a version in the fetch script changes, check that the project's licence hasn't, and update
this table.
