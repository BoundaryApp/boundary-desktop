// The broker runs with `network_mode: service:hermes`. When hermes is recreated, the broker keeps
// running in the removed container's namespace: `vault.sh status --json` still reads normally
// (it reports broker_down only for a broker that isn't running), but hermes can't reach it.
// doctor.sh at stack tag v0.3.14 finds this by comparing the broker's
// HostConfig.NetworkMode with `container:<running hermes id>`; this is the same check, until
// the stack reports it itself (change request 0034).

/** No evidence either way: a container isn't running, the mode isn't another container's, or a read failed. */
export type BrokerNamespaceUnknown = 'no_broker' | 'no_hermes' | 'unexpected_mode' | 'read_failed' | 'inactive';

export type BrokerNamespaceCheck =
  | { ok: true; matches: boolean }
  | { ok: false; reason: BrokerNamespaceUnknown; error?: string };

export interface BrokerNamespaceDeps {
  /** Compose against the stack's project with the `bitwarden` profile; resolves with stdout. */
  compose(args: string[]): Promise<string>;
  /** The container CLI (`docker` or `podman`); resolves with stdout. */
  cli(args: string[]): Promise<string>;
}

const firstLine = (stdout: string): string => stdout.split('\n')[0]?.trim() ?? '';

/** The same container when one id is the other or a prefix of it (a short id is 12 characters). */
const sameId = (a: string, b: string): boolean => a.length >= 12 && b.length >= 12 && (a.startsWith(b) || b.startsWith(a));

/** Never rejects. Reads ids and the network mode only; nothing else from stdout leaves this function. */
export async function readBrokerNamespace(deps: BrokerNamespaceDeps): Promise<BrokerNamespaceCheck> {
  try {
    const broker = firstLine(await deps.compose(['ps', '--status', 'running', '-q', 'bitwarden-broker']));
    if (!broker) return { ok: false, reason: 'no_broker' };
    const hermes = firstLine(await deps.compose(['ps', '--status', 'running', '-q', 'hermes']));
    if (!hermes) return { ok: false, reason: 'no_hermes' };
    const mode = (await deps.cli(['inspect', '-f', '{{.HostConfig.NetworkMode}}', broker])).trim();
    if (!mode.startsWith('container:')) return { ok: false, reason: 'unexpected_mode' };
    return { ok: true, matches: sameId(mode.slice('container:'.length), hermes) };
  } catch (error) {
    return { ok: false, reason: 'read_failed', error: error instanceof Error ? error.name : typeof error };
  }
}
