import type { RuntimeKind } from '../containerRuntime/types';

// Boundary's fallbacks for what bundled Podman (v6.0.1) refuses in the stack's compose file. Docker
// accepts all of it, so Docker gets no overlay. AssistantStackService writes the overlay before
// every compose call (`syncEngineOverlay`). Each fallback becomes a no-op once the stack ships a
// form both engines accept; remove it then.
//
// Change request 0041: a service-level tmpfs with `uid=` or `gid=` fails `up` with "unknown mount
// option" (pkg/util/mount_opts.go accepts only mode, size, tmpcopyup, notmpcopyup and U there).
// The stack gives bitwarden-broker `/run/bitwarden-sync:mode=0700,uid=…,gid=…` from v0.3.14 to
// v0.3.16; v0.3.17 has `mode=1777`, so this fallback writes nothing on the current pin.
//
// Change request 0042 R2: for a local tmpfs volume, Podman takes `uid=` and `gid=` out of `o`
// (pkg/domain/infra/abi/parse/parse.go) and mounts the tmpfs with the rest
// (libpod/volume_internal_linux.go), so it comes up owned by root. The stack's bitwarden_signin
// volume is `uid=…,gid=…,mode=0700,size=1m`, and the signer, running as HERMES_UID, can't create
// its socket there. On Podman it gets `mode=1777,size=1m`; the signer creates the socket 0600.
// The machine runs SELinux enforcing, and a tmpfs volume mounts as `tmpfs_t`, where a container
// can create files but not bind a socket, so the options also carry
// `context=system_u:object_r:container_file_t:s0`. Checked by hand on the bundled machine: with
// it, the signer's user binds there, and a second container with the volume read-only connects.
// RuntimeKind 'podman' is only ever the bundled machine (resolveContainerRuntime.ts).
//
// Change request 0042: compose reads a `seccomp=<file>` security option and sends the profile's
// JSON inline (docker/compose pkg/compose/create.go `parseSecurityOpts`). Podman's compat API
// keeps the value as `SeccompProfilePath` (pkg/specgenutil/specgen.go) and opens it as a file
// (pkg/specgen/generate/config_linux_seccomp.go), so container create fails with "opening seccomp
// profile failed". The stack gives bitwarden-signin and web-browser
// `seccomp=./compose/bitwarden-signin/seccomp.json` so Chromium's namespace sandbox can start with
// no capabilities. On Podman they drop that option and get Podman's default profile
// (containers/common v0.68.1), which already allows clone and unshare with namespace flags but
// allows chroot only with CAP_SYS_CHROOT in the bounding set, so they also get
// `cap_add: [SYS_CHROOT]`. With `cap_drop: [ALL]` that leaves CAP_SYS_CHROOT as the one
// capability (common/pkg/capabilities MergeCapabilities), effective for the non-root user too
// (pkg/specgen/generate/security_linux.go); no-new-privileges and the read-only root stay.

/** The engine overlay's file name, beside the pinned stack under userData. */
export const ENGINE_OVERLAY_FILENAME = 'docker-compose.engine.yml';

/** The services whose tmpfs lists get rewritten on Podman. */
const TMPFS_SERVICES = ['bitwarden-broker'] as const;

/** The named tmpfs volumes whose mount options get rewritten on Podman. */
const TMPFS_VOLUMES = ['bitwarden_signin'] as const;

/** The services whose security options get rewritten on Podman. */
const SECURITY_OPT_SERVICES = ['bitwarden-signin', 'web-browser'] as const;

/**
 * The block list under `key` in `service` of the stack's compose file, read as text: the file
 * uses compose tags and anchors a plain YAML load doesn't take. Only the block form (`key:` then
 * `- ` lines) is read, skipping comments; null when the service or its list isn't there in that
 * form.
 */
export function readServiceList(composeText: string, service: string, key: string): string[] | null {
  const lines = composeText.split('\n');
  const start = lines.findIndex((line) => line === `  ${service}:`);
  if (start < 0) return null;
  let i = start + 1;
  // The service ends at the next line indented two spaces or less.
  const inService = (line: string) => line.trim() === '' || line.trimStart().startsWith('#') || /^ {3,}\S/.test(line);
  const header = `    ${key}:`;
  while (i < lines.length && inService(lines[i]) && lines[i] !== header) i += 1;
  if (lines[i] !== header) return null;
  const entries: string[] = [];
  for (i += 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '' || /^ {6,}#/.test(line)) continue;
    const item = /^ {6}- (.+)$/.exec(line);
    if (!item) break;
    entries.push(unquote(item[1].replace(/\s+#.*$/, '').trim()));
  }
  return entries.length ? entries : null;
}

/** The `tmpfs` list of `service`; see `readServiceList`. */
export function readServiceTmpfs(composeText: string, service: string): string[] | null {
  return readServiceList(composeText, service, 'tmpfs');
}

function unquote(value: string): string {
  if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * One tmpfs entry as Podman takes it: `uid=` and `gid=` dropped, and with them the directory
 * opened to every user (mode 1777, sticky) so the service's own user can still create files in
 * it. Entries without either option come back unchanged.
 */
export function podmanTmpfsEntry(entry: string): string {
  const colon = entry.indexOf(':');
  if (colon < 0) return entry;
  return `${entry.slice(0, colon)}:${podmanTmpfsOptions(entry.slice(colon + 1))}`;
}

/** A tmpfs option list as Podman takes it; see `podmanTmpfsEntry`. */
export function podmanTmpfsOptions(optionList: string): string {
  const options = optionList.split(',');
  const owner = (option: string) => /^(uid|gid)=/.test(option);
  if (!options.some(owner)) return optionList;
  const kept = options.filter((option) => !owner(option) && !option.startsWith('mode='));
  return ['mode=1777', ...kept].join(',');
}

/** The SELinux label a container may create sockets under; see change request 0042 R2. */
const PODMAN_VOLUME_CONTEXT = 'context=system_u:object_r:container_file_t:s0';

/**
 * A tmpfs volume's `o` as the bundled Podman machine needs it: `podmanTmpfsOptions`, plus the
 * container file label unless the options already name a context. The stack accepted R2's mode
 * but declined `context=` for its shared compose file, since kernels without SELinux refuse it, so
 * the label is added to its `mode=1777,size=1m` too. Unchanged only once the options name a context.
 */
export function podmanVolumeOptions(optionList: string): string {
  const options = podmanTmpfsOptions(optionList);
  if (/(^|,)context=/.test(options)) return options;
  return `${options},${PODMAN_VOLUME_CONTEXT}`;
}

/**
 * The `o` driver option of a top-level named volume in the stack's compose file, read as text
 * like `readServiceList`; null when the volume or the option isn't there in block form.
 */
export function readVolumeMountOptions(composeText: string, volume: string): string | null {
  const lines = composeText.split('\n');
  const top = lines.indexOf('volumes:');
  if (top < 0) return null;
  let i = lines.indexOf(`  ${volume}:`, top + 1);
  if (i < 0) return null;
  for (i += 1; i < lines.length && (lines[i].trim() === '' || /^ {3,}/.test(lines[i])); i += 1) {
    const option = /^ {6}o: (.+)$/.exec(lines[i]);
    if (option) return unquote(option[1].replace(/\s+#.*$/, '').trim());
  }
  return null;
}

/**
 * Each named tmpfs volume whose `o` the Podman overlay replaces, with the `o` it writes. Empty
 * once the stack's options need no change. `removeStaleSignerVolume` compares a volume Podman
 * already holds against this.
 */
export function podmanVolumeOverrides(composeText: string): Map<string, string> {
  const overrides = new Map<string, string>();
  for (const volume of TMPFS_VOLUMES) {
    const options = readVolumeMountOptions(composeText, volume);
    if (options && podmanVolumeOptions(options) !== options) overrides.set(volume, podmanVolumeOptions(options));
  }
  return overrides;
}

/** True for a `seccomp=` option naming a profile file, which Podman can't take from compose. */
export function isSeccompProfileFile(option: string): boolean {
  const match = /^seccomp[=:](.*)$/.exec(option);
  return Boolean(match) && match![1] !== 'unconfined' && match![1] !== 'builtin';
}

/** The capability Podman's default seccomp profile needs before it allows `chroot`. */
const PODMAN_SANDBOX_CAP = 'SYS_CHROOT';

/** `key` of `service` again under `!override`, since compose otherwise merges the lists. */
function overrideList(key: string, entries: string[]): string {
  if (!entries.length) return `    ${key}: !override []\n`;
  return `    ${key}: !override\n${entries.map((entry) => `      - ${JSON.stringify(entry)}`).join('\n')}\n`;
}

/**
 * A service's `security_opt` without its seccomp profile file, plus the capability Podman's
 * default profile needs for Chromium's sandbox; null when no entry names a profile file.
 */
function podmanSeccompBlock(composeText: string, service: string): string | null {
  const entries = readServiceList(composeText, service, 'security_opt');
  if (!entries?.some(isSeccompProfileFile)) return null;
  const kept = entries.filter((entry) => !isSeccompProfileFile(entry));
  return `${overrideList('security_opt', kept)}    cap_add:\n      - ${JSON.stringify(PODMAN_SANDBOX_CAP)}\n`;
}

/** The rewritten list, or null when the stack has none or Podman takes every entry. */
function rewrittenList(
  composeText: string,
  service: string,
  key: string,
  rewrite: (entry: string) => string
): string | null {
  const entries = readServiceList(composeText, service, key);
  if (!entries) return null;
  const rewritten = entries.map(rewrite);
  if (rewritten.every((entry, i) => entry === entries[i])) return null;
  return overrideList(key, rewritten);
}

/**
 * The engine overlay for `kind`, or null when the engine needs none. On Podman, each listed
 * service whose stack list has an entry Podman rejects gets the whole list again, rewritten.
 */
export function buildEngineOverlayYaml(kind: RuntimeKind, composeText: string): string | null {
  if (kind !== 'podman') return null;
  const blocks = new Map<string, string[]>();
  const add = (service: string, block: string | null) => {
    if (block) blocks.set(service, [...(blocks.get(service) ?? []), block]);
  };
  for (const service of TMPFS_SERVICES) add(service, rewrittenList(composeText, service, 'tmpfs', podmanTmpfsEntry));
  for (const service of SECURITY_OPT_SERVICES) add(service, podmanSeccompBlock(composeText, service));
  const volumes = [...podmanVolumeOverrides(composeText)].map(
    ([volume, o]) => `  ${volume}:\n    driver_opts:\n      o: ${JSON.stringify(o)}\n`
  );
  if (!blocks.size && !volumes.length) return null;
  const services = [...blocks].map(([service, parts]) => `  ${service}:\n${parts.join('')}`);
  return `# Generated by Boundary for the Podman engine — do not edit by hand.
# Podman refuses uid= and gid= on a service tmpfs (change request 0041), drops them from a tmpfs
# volume's mount options so it comes up owned by root (and labelled so no socket can be made in
# it), and reads an inline seccomp profile as a
# file path (change request 0042). These entries replace the stack's; the Chromium services get
# Podman's default seccomp profile and CAP_SYS_CHROOT instead.
${services.length ? `services:\n${services.join('')}` : ''}${volumes.length ? `volumes:\n${volumes.join('')}` : ''}`;
}
