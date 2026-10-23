import { describe, expect, it, vi } from 'vitest';
import type { ApprovalOutcome } from '../approvals';
import { executeHostTool, type HostToolDeps } from '../hostTools';

const NOW = Date.parse('2026-10-08T12:00:00Z');

function deps(overrides: Partial<HostToolDeps> & { outcome?: ApprovalOutcome; grants?: string[] } = {}): HostToolDeps {
  const { outcome = 'allow', grants = [], ...rest } = overrides;
  const held = new Set(grants);
  return {
    hasGrant: vi.fn((capability: string, resource = '*') => held.has(`${capability}:${resource}`) || held.has(`${capability}:*`)),
    addGrant: vi.fn((capability: string, resource = '*') => {
      held.add(`${capability}:${resource}`);
    }),
    requestApproval: vi.fn(async () => outcome),
    showNotification: vi.fn(async () => 'shown' as const),
    openExternal: vi.fn(async () => undefined),
    readClipboard: vi.fn(() => 'copied text'),
    writeClipboard: vi.fn(),
    pickFiles: vi.fn(async () => ['/Users/me/data/report.csv']),
    chooseSavePath: vi.fn(async () => '/Users/me/Downloads/notes.md'),
    fileSize: vi.fn(async () => 12),
    readFile: vi.fn(async () => Buffer.from('a,b\n1,2\n')),
    writeFile: vi.fn(async () => undefined),
    now: () => NOW,
    audit: vi.fn(),
    ...rest,
  };
}

const textOf = (result: { content: Array<{ text: string }> }) => result.content[0].text;

describe('desktop_notification', () => {
  it('asks first, shows the notification on allow, and audits it', async () => {
    const d = deps();
    const result = await executeHostTool('desktop_notification', { title: ' Build done ', body: 'All green' }, d);
    expect(result.isError).toBeUndefined();
    expect(d.requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({ capability: 'notify', detail: 'Build done\nAll green', alwaysDescription: expect.any(String) })
    );
    expect(d.showNotification).toHaveBeenCalledWith('Build done', 'All green');
    expect(d.audit).toHaveBeenCalledWith({
      tool: 'desktop_notification',
      decision: 'allowed',
      args: { title: 'Build done', body: 'All green' },
      outcome: 'shown',
    });
  });

  it('skips the approval when a grant exists and stores one on "always"', async () => {
    const granted = deps({ grants: ['notify:*'] });
    await executeHostTool('desktop_notification', { title: 'Hi' }, granted);
    expect(granted.requestApproval).not.toHaveBeenCalled();
    expect(granted.audit).toHaveBeenCalledWith(expect.objectContaining({ decision: 'granted' }));

    const always = deps({ outcome: 'always' });
    await executeHostTool('desktop_notification', { title: 'Hi' }, always);
    expect(always.addGrant).toHaveBeenCalledWith('notify', '*');
  });

  it('does nothing on deny or timeout and tells Hermes not to retry', async () => {
    for (const outcome of ['deny', 'timeout'] as const) {
      const d = deps({ outcome });
      const result = await executeHostTool('desktop_notification', { title: 'Hi' }, d);
      expect(result.isError).toBe(true);
      expect(d.showNotification).not.toHaveBeenCalled();
      expect(d.audit).toHaveBeenCalledWith(expect.objectContaining({ decision: outcome === 'deny' ? 'denied' : 'timeout' }));
    }
  });

  it('rejects bad arguments before asking, and says so when the system does not confirm', async () => {
    for (const args of [{}, { title: '' }, { title: 'x'.repeat(121) }, { title: 'x', body: 5 }, { title: 'x', extra: 1 }]) {
      const d = deps();
      expect((await executeHostTool('desktop_notification', args, d)).isError).toBe(true);
      expect(d.requestApproval).not.toHaveBeenCalled();
    }
    const d = deps({ showNotification: vi.fn(async () => 'unconfirmed' as const) });
    expect(textOf(await executeHostTool('desktop_notification', { title: 'Hi' }, d))).toMatch(/didn't confirm/);
  });
});

describe('open_url', () => {
  it('opens an http(s) link after approval, with "always" scoped to the site', async () => {
    const d = deps({ outcome: 'always' });
    const result = await executeHostTool('open_url', { url: 'https://Example.com/a?b=1' }, d);
    expect(textOf(result)).toMatch(/Opened https:\/\/example.com\/a\?b=1/);
    expect(d.requestApproval).toHaveBeenCalledWith(expect.objectContaining({ detail: 'https://example.com/a?b=1' }));
    expect(d.addGrant).toHaveBeenCalledWith('open_url', 'example.com');
    expect(d.openExternal).toHaveBeenCalledWith('https://example.com/a?b=1');

    const again = deps({ grants: ['open_url:example.com'] });
    await executeHostTool('open_url', { url: 'https://example.com/other' }, again);
    expect(again.requestApproval).not.toHaveBeenCalled();
    await executeHostTool('open_url', { url: 'https://another.example/' }, again);
    expect(again.requestApproval).toHaveBeenCalledTimes(1);
  });

  it('refuses other schemes and junk without asking', async () => {
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'x-apple.systempreferences:', 'not a url', '']) {
      const d = deps();
      expect((await executeHostTool('open_url', { url }, d)).isError, url).toBe(true);
      expect(d.requestApproval).not.toHaveBeenCalled();
      expect(d.openExternal).not.toHaveBeenCalled();
    }
  });
});

describe('clipboard', () => {
  it('writes after approval and never puts the text in the audit', async () => {
    const d = deps();
    await executeHostTool('clipboard_write', { text: 'secret value' }, d);
    expect(d.writeClipboard).toHaveBeenCalledWith('secret value');
    expect(d.requestApproval).toHaveBeenCalledWith(expect.objectContaining({ detail: 'secret value' }));
    const audited = JSON.stringify((d.audit as ReturnType<typeof vi.fn>).mock.calls);
    expect(audited).not.toContain('secret value');
    expect(audited).toContain('"chars":12');
  });

  it('keeps clipboard text out of the audit even on invalid calls', async () => {
    const d = deps();
    await executeHostTool('clipboard_write', { text: 'secret value', extra: true }, d);
    expect(JSON.stringify((d.audit as ReturnType<typeof vi.fn>).mock.calls)).not.toContain('secret value');
  });

  it('asks on every read, with no "always", and returns the text', async () => {
    const d = deps({ grants: ['clipboard_read:*'] });
    const result = await executeHostTool('clipboard_read', {}, d);
    expect(d.requestApproval).toHaveBeenCalledWith(expect.objectContaining({ alwaysDescription: undefined }));
    expect(textOf(result)).toBe('copied text');
    expect(JSON.stringify((d.audit as ReturnType<typeof vi.fn>).mock.calls)).not.toContain('copied text');
  });

  it('reads nothing when declined', async () => {
    const d = deps({ outcome: 'deny' });
    expect((await executeHostTool('clipboard_read', {}, d)).isError).toBe(true);
    expect(d.readClipboard).not.toHaveBeenCalled();
  });
});

describe('files', () => {
  it('grants read_file for 24 hours on exactly the picked files', async () => {
    const d = deps();
    const result = await executeHostTool('pick_files', { purpose: 'the sales numbers', extensions: ['.CSV', 'bad ext!'] }, d);
    expect(d.pickFiles).toHaveBeenCalledWith({ message: 'Hermes asks: the sales numbers', multiple: false, extensions: ['csv'] });
    expect(d.addGrant).toHaveBeenCalledWith('read_file', '/Users/me/data/report.csv', new Date(NOW + 86_400_000).toISOString());
    const body = JSON.parse(textOf(result));
    expect(body.files[0]).toEqual({ path: '/Users/me/data/report.csv', name: 'report.csv', bytes: 12 });
    expect(body.how_to_read).toMatch(/not in your filesystem.*read_file/s);
  });

  it('reads a picked text file and refuses anything not picked', async () => {
    const d = deps({ grants: ['read_file:/Users/me/data/report.csv'] });
    expect(textOf(await executeHostTool('read_file', { path: '/Users/me/data/report.csv' }, d))).toBe('a,b\n1,2\n');
    expect(JSON.stringify((d.audit as ReturnType<typeof vi.fn>).mock.calls)).not.toContain('1,2');

    for (const filePath of ['/Users/me/.ssh/id_rsa', '/Users/me/data/../data/../.ssh/id_rsa', 'report.csv']) {
      const result = await executeHostTool('read_file', { path: filePath }, d);
      expect(result.isError, filePath).toBe(true);
    }
    expect(d.readFile).toHaveBeenCalledTimes(1);
  });

  it('refuses big and binary files', async () => {
    const big = deps({ grants: ['read_file:/f'], fileSize: vi.fn(async () => 2 * 1024 * 1024) });
    expect(textOf(await executeHostTool('read_file', { path: '/f' }, big))).toMatch(/up to/);
    const binary = deps({ grants: ['read_file:/f'], readFile: vi.fn(async () => Buffer.from([0x50, 0, 0x4b])) });
    expect(textOf(await executeHostTool('read_file', { path: '/f' }, binary))).toMatch(/not text/);
  });

  it('saves through the Save dialog every time and never audits contents', async () => {
    const d = deps();
    const result = await executeHostTool('write_file', { suggested_name: '../../etc/notes.md', content: 'private draft' }, d);
    expect(d.chooseSavePath).toHaveBeenCalledWith({ defaultName: 'notes.md' });
    expect(d.writeFile).toHaveBeenCalledWith('/Users/me/Downloads/notes.md', 'private draft');
    expect(textOf(result)).toMatch(/Saved to/);
    expect(JSON.stringify((d.audit as ReturnType<typeof vi.fn>).mock.calls)).not.toContain('private draft');

    const cancelled = deps({ chooseSavePath: vi.fn(async () => null) });
    expect(textOf(await executeHostTool('write_file', { suggested_name: 'a.txt', content: 'x' }, cancelled))).toMatch(/cancelled/);
    expect(cancelled.writeFile).not.toHaveBeenCalled();
  });

  it('reports a cancelled picker without granting anything', async () => {
    const d = deps({ pickFiles: vi.fn(async () => []) });
    expect(textOf(await executeHostTool('pick_files', { purpose: 'x' }, d))).toMatch(/didn't choose/);
    expect(d.addGrant).not.toHaveBeenCalled();
  });
});

it('refuses unknown tools', async () => {
  const d = deps();
  const result = await executeHostTool('run_shell', { cmd: 'ls' }, d);
  expect(result.isError).toBe(true);
  expect(d.requestApproval).not.toHaveBeenCalled();
});
