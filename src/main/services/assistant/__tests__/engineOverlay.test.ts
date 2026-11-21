import { describe, expect, it } from 'vitest';
import { load } from 'js-yaml';
import {
  buildEngineOverlayYaml,
  isSeccompProfileFile,
  podmanTmpfsEntry,
  podmanTmpfsOptions,
  podmanVolumeOptions,
  readServiceList,
  readVolumeMountOptions,
  readServiceTmpfs,
} from '../engineOverlay';
import { V0316_COMPOSE } from './engineOverlayFixture';


type OverlayService = { tmpfs?: string[]; security_opt?: string[]; cap_add?: string[] };

/** The overlay's top-level volumes. */
function overlayVolumes(yaml: string): Record<string, { driver_opts: { o: string } }> | undefined {
  return (load(yaml.replaceAll('!override', '')) as { volumes?: Record<string, { driver_opts: { o: string } }> }).volumes;
}

/** The overlay's services, with the `!override` tags read as plain lists. */
function overlayServices(yaml: string): Record<string, OverlayService> {
  return (load(yaml.replaceAll('!override', '')) as { services: Record<string, OverlayService> }).services;
}

const SECCOMP_FILE = 'seccomp=./compose/bitwarden-signin/seccomp.json';

describe('readServiceTmpfs', () => {
  it('reads the broker list past comments and leaves other services alone', () => {
    expect(readServiceTmpfs(V0316_COMPOSE, 'bitwarden-broker')).toEqual([
      '/tmp',
      '/run/bitwarden-sync:mode=0700,uid=${HERMES_UID:-1000},gid=${HERMES_GID:-1000}',
    ]);
  });

  it('is null without the service or its list', () => {
    expect(readServiceTmpfs('services:\n  hermes:\n    image: x\n', 'bitwarden-broker')).toBeNull();
    expect(readServiceTmpfs('services:\n  bitwarden-broker:\n    image: x\n  hermes:\n    tmpfs:\n      - /tmp\n', 'bitwarden-broker')).toBeNull();
  });
});

describe('readServiceList', () => {
  it('reads security_opt past comments between entries', () => {
    expect(readServiceList(V0316_COMPOSE, 'web-browser', 'security_opt')).toEqual([
      'no-new-privileges:true',
      SECCOMP_FILE,
    ]);
    expect(readServiceList(V0316_COMPOSE, 'bitwarden-signin', 'security_opt')).toEqual([
      'no-new-privileges:true',
      SECCOMP_FILE,
    ]);
  });

  it('is null for the flow form', () => {
    expect(readServiceList('services:\n  hermes:\n    security_opt: ["no-new-privileges:true"]\n', 'hermes', 'security_opt')).toBeNull();
  });
});

describe('isSeccompProfileFile', () => {
  it('is true for a profile file, in either separator form', () => {
    expect(isSeccompProfileFile(SECCOMP_FILE)).toBe(true);
    expect(isSeccompProfileFile('seccomp:/etc/profile.json')).toBe(true);
  });

  it('is false for the other options and the values Podman takes', () => {
    expect(isSeccompProfileFile('no-new-privileges:true')).toBe(false);
    expect(isSeccompProfileFile('seccomp=unconfined')).toBe(false);
    expect(isSeccompProfileFile('seccomp=builtin')).toBe(false);
    expect(isSeccompProfileFile('label=disable')).toBe(false);
  });
});

describe('podmanTmpfsEntry', () => {
  it('drops uid and gid and opens the directory with the sticky bit', () => {
    expect(podmanTmpfsEntry('/run/bitwarden-sync:mode=0700,uid=${HERMES_UID:-1000},gid=${HERMES_GID:-1000}')).toBe(
      '/run/bitwarden-sync:mode=1777'
    );
    expect(podmanTmpfsEntry('/run/x:uid=1000,size=1m')).toBe('/run/x:mode=1777,size=1m');
  });

  it('leaves entries Podman takes unchanged', () => {
    expect(podmanTmpfsEntry('/tmp')).toBe('/tmp');
    expect(podmanTmpfsEntry('/run/x:mode=0700,size=1m')).toBe('/run/x:mode=0700,size=1m');
  });
});

describe('readVolumeMountOptions', () => {
  it("reads the signer volume's o option", () => {
    expect(readVolumeMountOptions(V0316_COMPOSE, 'bitwarden_signin')).toBe(
      'uid=${HERMES_UID:-1000},gid=${HERMES_GID:-1000},mode=0700,size=1m'
    );
  });

  it('is null without the volume or its option', () => {
    expect(readVolumeMountOptions(V0316_COMPOSE, 'web_browser_profile')).toBeNull();
    expect(readVolumeMountOptions('services:\n  bitwarden_signin:\n', 'bitwarden_signin')).toBeNull();
  });
});

describe('podmanTmpfsOptions', () => {
  it('drops uid and gid and sets mode 1777, keeping size', () => {
    expect(podmanTmpfsOptions('uid=${HERMES_UID:-1000},gid=${HERMES_GID:-1000},mode=0700,size=1m')).toBe('mode=1777,size=1m');
    expect(podmanTmpfsOptions('mode=0700,size=1m')).toBe('mode=0700,size=1m');
  });
});

describe('podmanVolumeOptions', () => {
  it('adds the container file label to rewritten options', () => {
    expect(podmanVolumeOptions('uid=1,gid=1,mode=0700,size=1m')).toBe(
      'mode=1777,size=1m,context=system_u:object_r:container_file_t:s0'
    );
  });

  it('adds the label to options without uid or gid, as CR 0042 R2 ships them', () => {
    expect(podmanVolumeOptions('mode=1777,size=1m')).toBe('mode=1777,size=1m,context=system_u:object_r:container_file_t:s0');
  });

  it('leaves options that already name a context alone', () => {
    expect(podmanVolumeOptions('mode=1777,context=system_u:object_r:x_t:s0')).toBe('mode=1777,context=system_u:object_r:x_t:s0');
    expect(podmanVolumeOptions('uid=1,context=system_u:object_r:x_t:s0')).toBe('mode=1777,context=system_u:object_r:x_t:s0');
  });
});

describe('buildEngineOverlayYaml', () => {
  it('gives Docker no overlay, so the stack definition stays as it is', () => {
    expect(buildEngineOverlayYaml('docker', V0316_COMPOSE)).toBeNull();
  });

  it('replaces the broker tmpfs list on Podman, keeping /tmp', () => {
    const yaml = buildEngineOverlayYaml('podman', V0316_COMPOSE);
    expect(yaml).not.toBeNull();
    expect(yaml).toContain('  bitwarden-broker:\n    tmpfs: !override\n');
    expect(overlayServices(yaml!)['bitwarden-broker']).toEqual({ tmpfs: ['/tmp', '/run/bitwarden-sync:mode=1777'] });
    expect(yaml).not.toContain('hermes:');
  });

  it("gives the signer and web-browser Podman's default profile and CAP_SYS_CHROOT, keeping no-new-privileges", () => {
    const yaml = buildEngineOverlayYaml('podman', V0316_COMPOSE)!;
    expect(yaml).toContain('  bitwarden-signin:\n    security_opt: !override\n');
    const services = overlayServices(yaml);
    for (const service of ['bitwarden-signin', 'web-browser']) {
      expect(services[service]).toEqual({ security_opt: ['no-new-privileges:true'], cap_add: ['SYS_CHROOT'] });
    }
    expect(yaml).not.toContain('seccomp=');
  });

  it("rewrites the signer volume's mount options on Podman", () => {
    expect(overlayVolumes(buildEngineOverlayYaml('podman', V0316_COMPOSE)!)).toEqual({
      bitwarden_signin: { driver_opts: { o: 'mode=1777,size=1m,context=system_u:object_r:container_file_t:s0' } },
    });
  });

  it('writes an empty security_opt when the profile file was the only entry', () => {
    const only = V0316_COMPOSE.replace(/( {2}bitwarden-signin:[\s\S]*?security_opt:\n) {6}- no-new-privileges:true\n/, '$1');
    const yaml = buildEngineOverlayYaml('podman', only)!;
    expect(yaml).toContain('  bitwarden-signin:\n    security_opt: !override []\n    cap_add:\n');
    expect(overlayServices(yaml)['bitwarden-signin']).toEqual({ security_opt: [], cap_add: ['SYS_CHROOT'] });
  });

  it('keeps the seccomp fallback once the stack fixes the tmpfs, and the reverse', () => {
    const tmpfsFixed = V0316_COMPOSE.replace(/mode=0700,uid=[^\n]*/, 'mode=1777');
    expect(Object.keys(overlayServices(buildEngineOverlayYaml('podman', tmpfsFixed)!))).toEqual([
      'bitwarden-signin',
      'web-browser',
    ]);
    const seccompFixed = V0316_COMPOSE.replaceAll(SECCOMP_FILE, 'seccomp=unconfined');
    expect(buildEngineOverlayYaml('podman', seccompFixed)).not.toContain('cap_add');
    expect(Object.keys(overlayServices(buildEngineOverlayYaml('podman', seccompFixed)!))).toEqual(['bitwarden-broker']);
  });

  it('keeps only the volume label once the stack ships CR 0041 R1, 0042 R1 and R2', () => {
    const fixed = V0316_COMPOSE.replace(/mode=0700,uid=[^\n]*/, 'mode=1777')
      .replaceAll(`      - ${SECCOMP_FILE}\n`, '')
      .replace(/o: "uid=[^"]*"/, 'o: "mode=1777,size=1m"');
    const yaml = buildEngineOverlayYaml('podman', fixed)!;
    expect(yaml).not.toContain('services:');
    expect(overlayVolumes(yaml)).toEqual({
      bitwarden_signin: { driver_opts: { o: 'mode=1777,size=1m,context=system_u:object_r:container_file_t:s0' } },
    });
  });

  it('gives Podman no overlay once the stack labels the volume too, or has none of the services', () => {
    const labelled = V0316_COMPOSE.replace(/mode=0700,uid=[^\n]*/, 'mode=1777')
      .replaceAll(`      - ${SECCOMP_FILE}\n`, '')
      .replace(/o: "uid=[^"]*"/, 'o: "mode=1777,size=1m,context=system_u:object_r:container_file_t:s0"');
    expect(buildEngineOverlayYaml('podman', labelled)).toBeNull();
    expect(buildEngineOverlayYaml('podman', 'services:\n  hermes:\n    image: x\n')).toBeNull();
  });
});
