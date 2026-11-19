import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { BitwardenConnectInput } from '../../../../shared/types/addons';
import {
  accountFromStatus,
  bitwardenOffered,
  bitwardenConnectInput,
  connectStdin,
  createBitwardenService,
  parseRequests,
  type BitwardenService,
} from '../bitwardenAddon';
import { createBitwardenFakeStack, type BitwardenFakeStack } from './bitwardenFake';

let stack: BitwardenFakeStack;
let service: BitwardenService;
let logs: { message: string; data: Record<string, unknown> }[];
let ensureFolders: Mock<() => Promise<void>>;

beforeEach(() => {
  stack = createBitwardenFakeStack();
  logs = [];
  ensureFolders = vi.fn<() => Promise<void>>(async () => undefined);
  service = createBitwardenService({
    ensureFolders,
    paths: () => ({ root: stack.root, dataRoot: stack.dataRoot }),
    run: (script, args, options) => stack.run(script, args, options),
    runJson: (script, args) => stack.runJson(script, args),
    exclusive: (work) => work(),
    log: (message, data) => logs.push({ message, data }),
  });
});

afterEach(() => stack.cleanup());

const SECRET = 'client-secret-Kx4-synthetic';
const CLIENT_ID = 'user.synthetic-0001';
const MASTER = 'master-Zq9-synthetic';

const home = (extra: Partial<BitwardenConnectInput> = {}): BitwardenConnectInput => ({
  slug: 'home',
  server: { kind: 'us' },
  scope: 'folder:Agent',
  unlock: 'manual',
  clientId: CLIENT_ID,
  clientSecret: SECRET,
  replace: false,
  ...extra,
});

/** Nothing secret in any argv or log line. */
function expectNoSecretOutsideStdin(): void {
  const outside = JSON.stringify([stack.calls.map((c) => c.args), logs]);
  for (const secret of [SECRET, CLIENT_ID, MASTER, 'right-master', 'wrong-master']) expect(outside).not.toContain(secret);
}

describe('enable folders', () => {
  it('creates the folders before addon.sh enable', async () => {
    const order: string[] = [];
    ensureFolders.mockImplementation(async () => {
      order.push('folders');
    });
    const before = stack.calls.length;
    await service.enable();
    expect(order).toEqual(['folders']);
    expect(ensureFolders).toHaveBeenCalledTimes(1);
    expect(stack.calls.slice(before).map((c) => `${c.script} ${c.args[0]}`)).toContain('addon.sh enable');
  });

  it('returns command_failed and never runs addon.sh when the folders can’t be made', async () => {
    ensureFolders.mockRejectedValue(new Error('/x/bw exists and is not a folder'));
    const result = await service.enable();
    expect(result).toMatchObject({ kind: 'error', error: 'command_failed', message: '/x/bw exists and is not a folder' });
    expect(stack.calls.filter((c) => c.script === 'addon.sh')).toEqual([]);
  });
});

describe('connect', () => {
  it('turns Bitwarden on first, then connects with the key on stdin and the name alone in argv', async () => {
    const result = await service.connect(home());
    expect(result).toEqual({ ok: true, message: 'home is signed in and stays locked until you unlock it.' });
    expect(stack.calls.filter((c) => c.script === 'addon.sh').map((c) => c.args.slice(0, 2).join(' '))).toEqual([
      'enable bitwarden',
      'connect bitwarden',
    ]);
    const connect = stack.calls.find((c) => c.args[0] === 'connect')!;
    expect(connect.args).toEqual(['connect', 'bitwarden', '--instance', 'home', '--json']);
    expect(connect.input).toEqual({
      mode: 'cloud',
      region: 'us',
      scope: 'folder:Agent',
      unlock: 'manual',
      client_id: CLIENT_ID,
      client_secret: SECRET,
    });
    expect(stack.stored()).toEqual(['home']);
    // The row comes from status, read again after connect (decision 27).
    expect(service.overview().accounts).toEqual([
      {
        slug: 'home',
        mode: 'cloud',
        scope: 'folder:Agent',
        unlock: 'manual',
        state: 'locked',
        error: null,
        retryAfter: null,
        file: null,
        canDisconnect: true,
      },
    ]);
    expectNoSecretOutsideStdin();
  });

  it('sends a self-hosted URL, a collection and a master password for Keep me unlocked', async () => {
    stack.setEnabled(true);
    const result = await service.connect(
      home({ server: { kind: 'selfhosted', url: 'https://vault.example.com' }, scope: 'collection:abc-123', unlock: 'stored', masterPassword: MASTER })
    );
    expect(result.ok).toBe(true);
    expect(stack.calls.find((c) => c.args[0] === 'connect')!.input).toEqual({
      mode: 'selfhosted',
      url: 'https://vault.example.com',
      scope: 'collection:abc-123',
      unlock: 'stored',
      client_id: CLIENT_ID,
      client_secret: SECRET,
      master_password: MASTER,
    });
    expect(service.overview().accounts[0]?.state).toBe('unlocked');
    expectNoSecretOutsideStdin();
  });

  it('never sends a master password with Ask me each time', () => {
    expect(connectStdin(home({ masterPassword: MASTER }))).not.toHaveProperty('master_password');
  });

  it.each([
    ['login_refused', undefined],
    ['server_unreachable', undefined],
    ['timeout', undefined],
    ['broker_down', undefined],
    ['command_failed', undefined],
  ])('reports %s by name and writes nothing', async (error) => {
    stack.setEnabled(true);
    stack.signIn = { error };
    if (error === 'broker_down') {
      stack.signIn = null;
      stack.brokerUp = false;
    }
    const result = await service.connect(home());
    expect(result).toMatchObject({ ok: false, error });
    expect(stack.stored()).toEqual([]);
    expect(stack.accounts.size).toBe(0);
    expectNoSecretOutsideStdin();
  });

  it('passes rate_limited’s wait on to the sheet', async () => {
    stack.setEnabled(true);
    stack.signIn = { error: 'rate_limited', retryAfter: 30 };
    expect(await service.connect(home())).toMatchObject({ ok: false, error: 'rate_limited', retryAfter: 30 });
    stack.signIn = { error: 'rate_limited' };
    const unknown = await service.connect(home());
    expect(unknown).toMatchObject({ ok: false, error: 'rate_limited' });
    expect(unknown).not.toHaveProperty('retryAfter');
  });

  it('reports exists, and replaces an account with connect --force, without a disconnect', async () => {
    stack.setEnabled(true);
    await service.connect(home());
    expect(await service.connect(home())).toMatchObject({ ok: false, error: 'exists' });
    const replaced = await service.connect(home({ replace: true }));
    expect(replaced.ok).toBe(true);
    const addonCalls = stack.calls.filter((c) => c.script === 'addon.sh');
    expect(addonCalls.map((c) => c.args[0])).not.toContain('disconnect');
    expect(addonCalls.at(-1)?.args).toEqual(['connect', 'bitwarden', '--instance', 'home', '--json', '--force']);
  });

  it('keeps the old account when a replacing key is refused', async () => {
    stack.setEnabled(true);
    await service.connect(home());
    stack.signIn = { error: 'login_refused' };
    expect(await service.connect(home({ replace: true }))).toMatchObject({ ok: false, error: 'login_refused' });
    expect(service.overview().accounts.map((a) => [a.slug, a.state])).toEqual([['home', 'locked']]);
    expect(service.overview().accounts[0]?.canDisconnect).toBe(true);
  });

  it('says which manual accounts the broker restart locked, and shows them locked', async () => {
    stack.setEnabled(true);
    await service.connect(home());
    expect(await service.unlock('home', 'right-master')).toEqual({ ok: true });
    expect(service.overview().accounts[0]?.state).toBe('unlocked');
    const result = await service.connect(home({ slug: 'work' }));
    expect(result).toMatchObject({ ok: true, message: expect.stringContaining('The broker restart locked home') });
    expect(service.overview().accounts.find((a) => a.slug === 'home')?.state).toBe('locked');
  });

  it('reports an exit with no done line as command_failed with how it ended', async () => {
    stack.setEnabled(true);
    const crashed = createBitwardenService({
      paths: () => ({ root: stack.root, dataRoot: stack.dataRoot }),
      ensureFolders: async () => undefined,
      run: async () => ({ kind: 'exited', code: 3, logTail: ['Traceback: boom'], lines: [] }),
      runJson: (script, args) => stack.runJson(script, args),
      exclusive: (work) => work(),
      log: () => undefined,
    });
    expect(await crashed.connect(home())).toEqual({
      ok: false,
      error: 'command_failed',
      message: 'the script exited with code 3 and no result: Traceback: boom',
    });
  });
});

describe('bitwardenConnectInput', () => {
  const valid = {
    slug: 'home',
    server: { kind: 'eu' },
    scope: 'folder:Agent',
    unlock: 'manual',
    clientId: CLIENT_ID,
    clientSecret: SECRET,
    replace: false,
  };

  it('accepts a complete input', () => {
    expect(bitwardenConnectInput(valid)).toEqual({ ...valid, server: { kind: 'eu' } });
  });

  it.each([
    ['missing input', undefined],
    ['the name local', { ...valid, slug: 'local' }],
    ['a name starting with a digit', { ...valid, slug: '1home' }],
    ['a name over 31 characters', { ...valid, slug: `a${'b'.repeat(31)}` }],
    ['scope all', { ...valid, scope: 'all' }],
    ['a folder with a quote', { ...valid, scope: 'folder:Ag"ent' }],
    ['a self-hosted server without a URL', { ...valid, server: { kind: 'selfhosted' } }],
    ['a self-hosted server over http', { ...valid, server: { kind: 'selfhosted', url: 'http://vault.example.com' } }],
    ['Keep me unlocked without a master password', { ...valid, unlock: 'stored' }],
    ['an empty client_secret', { ...valid, clientSecret: '' }],
    ['a key with a line break', { ...valid, clientSecret: 'a\nb' }],
    ['no replace flag', { ...valid, replace: undefined }],
  ])('refuses %s before anything runs', (_name, input) => {
    expect(() => bitwardenConnectInput(input)).toThrow();
  });

  it('drops a trailing slash from a self-hosted address, as vault.sh does', () => {
    expect(bitwardenConnectInput({ ...valid, server: { kind: 'selfhosted', url: 'https://vault.example.com/' } }).server).toEqual({
      kind: 'selfhosted',
      url: 'https://vault.example.com',
    });
  });
});

describe('unlock and lock', () => {
  beforeEach(async () => {
    stack.setEnabled(true);
    await service.connect(home());
  });

  it('a wrong master password leaves the account locked; the right one unlocks it', async () => {
    expect(await service.unlock('home', 'wrong-master')).toMatchObject({ ok: false, error: 'login_refused' });
    expect(service.overview().accounts[0]?.state).toBe('locked');
    expect(await service.unlock('home', 'right-master')).toEqual({ ok: true });
    expect(service.overview().accounts[0]?.state).toBe('unlocked');
    const unlock = stack.calls.filter((c) => c.args[0] === 'unlock');
    expect(unlock.map((c) => c.args)).toEqual([
      ['unlock', '--slug', 'home', '--json'],
      ['unlock', '--slug', 'home', '--json'],
    ]);
    expect(unlock[0]!.input).toEqual({ master_password: 'wrong-master' });
    expectNoSecretOutsideStdin();
  });

  it('locks a manual account, and reports bad_input for a stored one and not_found for none', async () => {
    await service.unlock('home', 'right-master');
    expect(await service.lock('home')).toEqual({ ok: true });
    expect(service.overview().accounts[0]?.state).toBe('locked');
    await service.connect(home({ slug: 'work', unlock: 'stored', masterPassword: MASTER }));
    expect(await service.lock('work')).toMatchObject({ ok: false, error: 'bad_input' });
    expect(await service.unlock('gone', 'x')).toMatchObject({ ok: false, error: 'not_found' });
  });

  it('reports broker_down while the broker is down', async () => {
    stack.brokerUp = false;
    expect(await service.unlock('home', 'right-master')).toMatchObject({ ok: false, error: 'broker_down' });
  });
});

describe('disconnect', () => {
  it('removes the account and its store entry, and passes on the reminder to revoke the key', async () => {
    await service.connect(home());
    const result = await service.disconnect('home');
    expect(result).toMatchObject({ ok: true, message: expect.stringContaining('revoke it there') });
    expect(stack.stored()).toEqual([]);
    expect(service.overview().accounts).toEqual([]);
  });

  it('ends with done when the account file is already gone, so a second press clears the row', async () => {
    await service.connect(home());
    stack.accounts.delete('home');
    expect(await service.disconnect('home')).toMatchObject({ ok: true });
    expect(stack.stored()).toEqual([]);
  });

  it('reports not_found for an account the store has no entry for', async () => {
    stack.setEnabled(true);
    stack.addTerminalAccount('old', {});
    expect(await service.disconnect('old')).toMatchObject({ ok: false, error: 'not_found' });
  });
});

describe('refresh', () => {
  it('lists terminal accounts without Disconnect, refused files, and offline with broker_down while it’s off', async () => {
    stack.setEnabled(true);
    stack.addTerminalAccount('old', {});
    stack.addTerminalAccount('local', { mode: 'local' });
    stack.refused.push({ file: 'broken.json', error: 'bad_file' });
    const listed = await service.refresh();
    expect(listed.accounts.map((a) => [a.slug, a.state, a.error, a.canDisconnect])).toEqual([
      ['local', 'locked', null, false],
      ['old', 'locked', null, false],
      ['broken', 'refused', 'bad_file', false],
    ]);
    expect(listed.accounts[2]?.file).toBe('broken.json');
    stack.brokerUp = false;
    const down = await service.refresh();
    expect(down.accounts.filter((a) => a.state !== 'refused').every((a) => a.state === 'offline' && a.error === 'broker_down')).toBe(true);
    expect(down.requestsError).toBe('broker_down');
  });

  it('lists an account connected before v0.3.14 as refused with missing_client_id, and a bad file name with no slug', async () => {
    stack.setEnabled(true);
    stack.addPreUpdateAccount('home');
    stack.refused.push({ file: 'Bad Name.json', error: 'bad_slug' });
    const listed = await service.refresh();
    expect(listed.accounts.map((a) => [a.slug, a.file, a.state, a.error, a.canDisconnect])).toEqual([
      ['home', 'home.json', 'refused', 'missing_client_id', true],
      [null, 'Bad Name.json', 'refused', 'bad_slug', false],
    ]);
    // missing_client_id comes from the running broker; with it down the account is offline like the rest.
    stack.brokerUp = false;
    expect((await service.refresh()).accounts[0]).toMatchObject({ slug: 'home', state: 'offline', error: 'broker_down' });
    expect(logs.find((l) => l.message === 'status')?.data.states).toEqual(['refused/missing_client_id', 'refused/bad_slug']);
  });

  it('mends a refused missing_client_id account with connect --force, and keeps it refused when the key fails', async () => {
    stack.setEnabled(true);
    stack.addPreUpdateAccount('home');
    stack.signIn = { error: 'login_refused' };
    expect(await service.connect(home({ replace: true }))).toMatchObject({ ok: false, error: 'login_refused' });
    expect(service.overview().accounts[0]).toMatchObject({ slug: 'home', state: 'refused', error: 'missing_client_id' });
    expect(await service.connect(home({ replace: true }))).toMatchObject({ ok: true });
    expect(stack.calls.filter((c) => c.script === 'addon.sh').map((c) => c.args)).toEqual([
      ['connect', 'bitwarden', '--instance', 'home', '--json', '--force'],
      ['connect', 'bitwarden', '--instance', 'home', '--json', '--force'],
    ]);
    expect(service.overview().accounts[0]).toMatchObject({ slug: 'home', state: 'locked', error: null, canDisconnect: true });
    expectNoSecretOutsideStdin();
  });

  it('reads the pending requests', async () => {
    stack.setEnabled(true);
    stack.pending.push({ request_id: 'a1b2', account: 'home', site: 'example.com', reason: 'to download the bill', created: 1_800_000_000 });
    const listed = await service.refresh();
    expect(listed.requests).toEqual([
      { requestId: 'a1b2', account: 'home', site: 'example.com', reason: 'to download the bill', created: 1_800_000_000 },
    ]);
    // Metadata only: no site or reason reaches the log.
    expect(JSON.stringify(logs)).not.toMatch(/example\.com|download the bill/);
  });

  it('tells listeners each new overview', async () => {
    const seen: number[] = [];
    service.onChange((o) => seen.push(o.accounts.length));
    await service.connect(home());
    expect(seen.at(-1)).toBe(1);
  });
});

describe('repairing a broker that\'s stopped or left in an old hermes namespace', () => {
  let clock: number;
  let follows: number;

  const create = (over: Partial<Parameters<typeof createBitwardenService>[0]> = {}): BitwardenService =>
    createBitwardenService({
      paths: () => ({ root: stack.root, dataRoot: stack.dataRoot }),
      run: (script, args, options) => stack.run(script, args, options),
      runJson: (script, args) => stack.runJson(script, args),
      exclusive: (work) => work(),
      ensureFolders: async () => undefined,
      log: (message, data) => logs.push({ message, data }),
      now: () => clock,
      followHermes: async () => {
        follows += 1;
        await stack.run('vault.sh', ['follow-hermes']);
      },
      checkBrokerNamespace: () => stack.brokerNamespace(),
      ...over,
    });

  beforeEach(() => {
    vi.useFakeTimers();
    clock = 1_000_000;
    follows = 0;
    service = create();
  });

  afterEach(() => vi.useRealTimers());

  const accounts = (): void => {
    stack.setEnabled(true);
    stack.addTerminalAccount('home', {});
    stack.addTerminalAccount('work', {});
  };

  /** The broker runs in a removed hermes's namespace: status reads normally. */
  const staleBroker = (): void => {
    accounts();
    stack.brokerStale = true;
  };

  /** The broker container isn't running: status reads broker_down per account. */
  const stoppedBroker = (): void => {
    accounts();
    stack.brokerUp = false;
  };

  it('repairs a broker in an old hermes namespace, which status reads as healthy', async () => {
    staleBroker();
    const before = await create({ followHermes: undefined }).refresh();
    expect(before.accounts.map((a) => [a.slug, a.state, a.error])).toEqual([
      ['home', 'locked', null],
      ['work', 'locked', null],
    ]);
    await service.refresh();
    expect(follows).toBe(1);
    expect(stack.brokerStale).toBe(false);
    expect(logs.find((l) => l.message === 'repair')?.data).toEqual({ reason: 'namespace', ms: 0 });
  });

  it('repairs a stopped broker once, then shows the accounts', async () => {
    stoppedBroker();
    const overview = await service.refresh();
    expect(follows).toBe(1);
    expect(stack.calls.filter((c) => c.args[0] === 'follow-hermes')).toHaveLength(1);
    expect(overview.statusError).toBeNull();
    expect(overview.accounts.map((a) => [a.slug, a.state, a.error])).toEqual([
      ['home', 'locked', null],
      ['work', 'locked', null],
    ]);
    expect(overview.requestsError).toBeNull();
  });

  it('repairs when the status read fails with broker_down and lists no accounts', async () => {
    stack.setEnabled(true);
    stack.brokerUp = false;
    const real = stack.runJson.bind(stack);
    let failing = true;
    service = create({
      runJson: async (script, args) => (failing && args[0] === 'status' ? { code: 1, objects: [], logTail: ['not running'] } : real(script, args)),
      followHermes: async () => {
        follows += 1;
        failing = false;
      },
    });
    const overview = await service.refresh();
    expect(follows).toBe(1);
    expect(overview.statusError).toBeNull();
  });

  it('doesn\'t repair again within a minute, and doesn\'t read the namespace meanwhile', async () => {
    staleBroker();
    await service.refresh();
    expect(follows).toBe(1);
    const reads = stack.namespaceReads;
    stack.brokerStale = true;
    clock += 59_999;
    await service.refresh();
    expect(follows).toBe(1);
    expect(stack.namespaceReads).toBe(reads);
    stack.brokerUp = false;
    await service.refresh();
    expect(follows).toBe(1);
    clock += 1;
    await service.refresh();
    expect(follows).toBe(2);
  });

  it('doesn\'t repair or read the namespace while Bitwarden is off', async () => {
    stack.addTerminalAccount('home', {});
    stack.brokerStale = true;
    await service.refresh();
    expect(follows).toBe(0);
    expect(stack.namespaceReads).toBe(0);
  });

  it('doesn\'t repair a broker in hermes\'s namespace, or when one account answers', async () => {
    accounts();
    await service.refresh();
    expect(service.overview().accounts.map((a) => a.error)).toEqual([null, null]);
    expect(stack.namespaceReads).toBe(1);
    expect(follows).toBe(0);

    // An account that answers with its own error keeps the broker from reading as down.
    stack.accounts.get('home')!.error = 'rate_limited';
    stack.accounts.get('work')!.error = 'rate_limited';
    await service.refresh();
    expect(follows).toBe(0);
  });

  it('takes a namespace read that gives no evidence as no mismatch, and logs its reason only', async () => {
    accounts();
    service = create({ checkBrokerNamespace: async () => ({ ok: false, reason: 'read_failed', error: 'Error' }) });
    await service.refresh();
    expect(follows).toBe(0);
    expect(logs.find((l) => l.message === 'broker namespace')?.data).toEqual({ result: 'unknown', reason: 'read_failed', error: 'Error' });

    service = create({ checkBrokerNamespace: async () => Promise.reject(new RangeError('boom')) });
    await service.refresh();
    expect(follows).toBe(0);
    expect(logs.filter((l) => l.message === 'broker namespace').at(-1)?.data).toEqual({ result: 'unknown', reason: 'read_failed', error: 'RangeError' });
  });

  it('repairs when a refused file shows beside accounts that read broker_down', async () => {
    stoppedBroker();
    stack.refused.push({ file: 'broken.json', error: 'bad_file' }, { file: 'Bad Name.json', error: 'bad_slug' });
    const overview = await service.refresh();
    expect(follows).toBe(1);
    expect(overview.accounts.map((a) => [a.slug, a.state, a.error])).toEqual([
      ['home', 'locked', null],
      ['work', 'locked', null],
      ['broken', 'refused', 'bad_file'],
      [null, 'refused', 'bad_slug'],
    ]);
  });

  it('doesn\'t repair when only refused files are listed and the namespace matches', async () => {
    stack.setEnabled(true);
    stack.refused.push({ file: 'broken.json', error: 'bad_file' });
    await service.refresh();
    expect(follows).toBe(0);
  });

  it('the follower\'s own refresh never repairs or reads the namespace', async () => {
    stoppedBroker();
    await service.refresh({ repair: false });
    expect(follows).toBe(0);
    expect(service.overview().accounts.every((a) => a.error === 'broker_down')).toBe(true);
    stack.brokerUp = true;
    stack.brokerStale = true;
    await service.refresh({ repair: false });
    expect(follows).toBe(0);
    expect(stack.namespaceReads).toBe(0);
  });

  it('logs the repair with metadata only', async () => {
    stoppedBroker();
    await service.refresh();
    const line = logs.find((l) => l.message === 'repair');
    expect(line?.data).toEqual({ reason: 'broker_down', ms: 0 });
  });

  describe('repairIfStranded, for checks nobody asked for', () => {
    it('repairs a broker in an old hermes namespace without reading status', async () => {
      staleBroker();
      await service.repairIfStranded('poll');
      expect(follows).toBe(1);
      expect(stack.calls.filter((c) => c.args[0] === 'status')).toHaveLength(0);
      expect(logs.find((l) => l.message === 'repair')?.data).toEqual({ reason: 'namespace', trigger: 'poll', ms: 0 });
    });

    it('shares refresh\'s once-a-minute limit both ways', async () => {
      staleBroker();
      await service.refresh();
      expect(follows).toBe(1);
      stack.brokerStale = true;
      const reads = stack.namespaceReads;
      clock += 59_999;
      await service.repairIfStranded('focus');
      expect(follows).toBe(1);
      expect(stack.namespaceReads).toBe(reads);
      clock += 1;
      await service.repairIfStranded('focus');
      expect(follows).toBe(2);
      stack.brokerStale = true;
      await service.refresh();
      expect(follows).toBe(2);
    });

    it('doesn\'t repair a broker in hermes\'s namespace, or while Bitwarden is off', async () => {
      accounts();
      await service.repairIfStranded('poll');
      expect(follows).toBe(0);
      expect(stack.namespaceReads).toBe(1);
      stack.setEnabled(false);
      stack.brokerStale = true;
      await service.repairIfStranded('poll');
      expect(stack.namespaceReads).toBe(1);
      expect(follows).toBe(0);
    });

    it('doesn\'t repair a stopped broker: only the page\'s refresh can tell it\'s meant to run', async () => {
      stoppedBroker();
      await service.repairIfStranded('poll');
      expect(follows).toBe(0);
    });

    it('logs a read with no evidence once per reason, not on every poll', async () => {
      let check: Awaited<ReturnType<NonNullable<Parameters<typeof create>[0]['checkBrokerNamespace']>>> = { ok: false, reason: 'no_hermes' };
      accounts();
      service = create({ checkBrokerNamespace: async () => check });
      const unknowns = () => logs.filter((l) => l.message === 'broker namespace').map((l) => l.data);
      await service.repairIfStranded('poll');
      await service.repairIfStranded('poll');
      expect(unknowns()).toEqual([{ result: 'unknown', reason: 'no_hermes', trigger: 'poll' }]);
      check = { ok: true, matches: true };
      await service.repairIfStranded('poll');
      check = { ok: false, reason: 'no_hermes' };
      await service.repairIfStranded('focus');
      expect(unknowns()).toHaveLength(2);
      expect(follows).toBe(0);
    });

    it('logs a follow-hermes that rejects by error name and doesn\'t reject', async () => {
      staleBroker();
      service = create({ followHermes: () => Promise.reject(new TypeError('secret')) });
      await expect(service.repairIfStranded('poll')).resolves.toBeUndefined();
      expect(logs.find((l) => l.message === 'repair failed')?.data).toEqual({ reason: 'namespace', trigger: 'poll', error: 'TypeError' });
      expect(JSON.stringify(logs)).not.toContain('secret');
    });
  });
});

describe('sync', () => {
  beforeEach(async () => {
    stack.setEnabled(true);
    await service.connect(home({ unlock: 'stored', masterPassword: MASTER }));
    stack.pending.push({ request_id: 'a1b2', account: 'home', site: 'example.com', reason: '', created: 1 });
    await service.refresh();
  });

  it('clears a request once the login is in the folder, and the next press within 30 s gets that result', async () => {
    stack.granted.add('example.com');
    expect(await service.sync()).toEqual({ ok: true, synced: ['home'], recent: false });
    expect(service.overview().requests).toEqual([]);
    expect(await service.sync()).toEqual({ ok: true, synced: ['home'], recent: true });
  });

  it('reports busy while another sync runs, and broker_down when it’s off', async () => {
    stack.syncBusy = true;
    expect(await service.sync()).toMatchObject({ ok: false, error: 'busy' });
    stack.brokerUp = false;
    expect(await service.sync()).toMatchObject({ ok: false, error: 'broker_down' });
  });
});

describe('parsing', () => {
  it('reads an unknown state as unknown, and a rate limit’s wait', () => {
    expect(accountFromStatus({ slug: 'a', state: 'weird' }, new Set()).state).toBe('unknown');
    expect(accountFromStatus({ slug: 'a', state: 'error', error: 'rate_limited', retry_after: 12 }, new Set(['a']))).toMatchObject({
      retryAfter: 12,
      canDisconnect: true,
    });
  });

  it('leaves out request entries without an id or account', () => {
    expect(parseRequests({ pending: [{ site: 'x' }, null, 'no'] })).toEqual([]);
  });

  it('finds Bitwarden only in a stack with vault.sh, addon.sh and accounts as instances', () => {
    const files: Record<string, string> = {
      '/s/scripts/addon.sh': '',
      '/s/scripts/vault.sh': '',
      '/s/addons/bitwarden/addon.json': JSON.stringify({ instances: { connect: {}, disconnect: {} } }),
    };
    expect(bitwardenOffered('/s', (p) => files[p] ?? null)).toBe(true);
    files['/s/addons/bitwarden/addon.json'] = JSON.stringify({ builtin: {} });
    expect(bitwardenOffered('/s', (p) => files[p] ?? null)).toBe(false);
  });
});
