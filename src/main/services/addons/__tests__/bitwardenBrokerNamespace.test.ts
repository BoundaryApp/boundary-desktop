import { describe, expect, it, vi } from 'vitest';
import { readBrokerNamespace } from '../bitwardenBrokerNamespace';

// doctor.sh at stack tag v0.3.14 (4b726a5, lines 1295–1306): the broker's id from
// `compose_with_profile bitwarden ps --status running -q bitwarden-broker`, hermes's from
// `docker compose ps --status running -q hermes`, and the broker's
// `docker inspect -f '{{.HostConfig.NetworkMode}}'` must be `container:<hermes id>`.

const BROKER = 'b'.repeat(64);
const HERMES = 'a'.repeat(64);
const OLD_HERMES = 'c'.repeat(64);

function deps(over: { broker?: string; hermes?: string; mode?: string; fail?: 'compose' | 'inspect' } = {}) {
  const compose = vi.fn(async (args: string[]) => {
    if (over.fail === 'compose') throw Object.assign(new Error('compose failed'), { name: 'ComposeError' });
    return args.at(-1) === 'bitwarden-broker' ? (over.broker ?? `${BROKER}\n`) : (over.hermes ?? `${HERMES}\n`);
  });
  const cli = vi.fn(async () => {
    if (over.fail === 'inspect') throw new TypeError('inspect failed');
    return over.mode ?? `container:${HERMES}\n`;
  });
  return { compose, cli };
}

describe('readBrokerNamespace', () => {
  it('reads both running ids and the broker’s network mode as doctor.sh does', async () => {
    const d = deps();
    expect(await readBrokerNamespace(d)).toEqual({ ok: true, matches: true });
    expect(d.compose.mock.calls).toEqual([
      [['ps', '--status', 'running', '-q', 'bitwarden-broker']],
      [['ps', '--status', 'running', '-q', 'hermes']],
    ]);
    expect(d.cli.mock.calls).toEqual([[['inspect', '-f', '{{.HostConfig.NetworkMode}}', BROKER]]]);
  });

  it('reports a mismatch when the broker sits in a replaced hermes’s namespace', async () => {
    expect(await readBrokerNamespace(deps({ mode: `container:${OLD_HERMES}` }))).toEqual({ ok: true, matches: false });
  });

  it('matches a short id against a full one', async () => {
    expect(await readBrokerNamespace(deps({ mode: `container:${HERMES.slice(0, 12)}` }))).toEqual({ ok: true, matches: true });
  });

  it('gives no evidence when the broker or hermes isn’t running', async () => {
    const noBroker = deps({ broker: '\n' });
    expect(await readBrokerNamespace(noBroker)).toEqual({ ok: false, reason: 'no_broker' });
    expect(noBroker.cli).not.toHaveBeenCalled();
    expect(await readBrokerNamespace(deps({ hermes: '' }))).toEqual({ ok: false, reason: 'no_hermes' });
  });

  it('gives no evidence when the network mode isn’t another container’s', async () => {
    expect(await readBrokerNamespace(deps({ mode: 'bridge\n' }))).toEqual({ ok: false, reason: 'unexpected_mode' });
    expect(await readBrokerNamespace(deps({ mode: '' }))).toEqual({ ok: false, reason: 'unexpected_mode' });
  });

  it('gives no evidence, with the error’s name only, when a read fails', async () => {
    expect(await readBrokerNamespace(deps({ fail: 'compose' }))).toEqual({ ok: false, reason: 'read_failed', error: 'ComposeError' });
    expect(await readBrokerNamespace(deps({ fail: 'inspect' }))).toEqual({ ok: false, reason: 'read_failed', error: 'TypeError' });
  });
});
