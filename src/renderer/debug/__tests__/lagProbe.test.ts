import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const report = vi.fn();
const mark = vi.fn();

async function load(enabled: boolean) {
  window.boundaryLagProbe = {
    config: vi.fn().mockResolvedValue({ enabled, tracing: enabled, logDir: '/tmp/lag' }),
    report,
    mark,
  };
  const probe = await import('../lagProbe');
  await probe.installLagProbe();
  return probe;
}

describe('renderer lag probe', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    report.mockReset();
    mark.mockReset();
    delete window.boundaryLagProbe;
  });

  it('reports slow React commits and counts fast ones silently', async () => {
    const probe = await load(true);
    report.mockClear();
    probe.onReactRender('thread:composer', 'update', 4, 4, 0, 0);
    expect(report).not.toHaveBeenCalled();
    probe.onReactRender('thread:messages', 'update', 40, 40, 0, 0);
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'react-commit', id: 'thread:messages', ms: 40 })
    );
  });

  it('logs state changes without asking for a recording', async () => {
    const probe = await load(true);
    report.mockClear();
    probe.probeLog('chat-rail-state', { railChats: 0 });
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'chat-rail-state', railChats: 0 })
    );
    expect(report.mock.calls[0][0]).not.toHaveProperty('severe');
  });

  it('marks from the keyboard shortcut', async () => {
    await load(true);
    document.dispatchEvent(
      new KeyboardEvent('keydown', { code: 'KeyL', metaKey: true, altKey: true, shiftKey: true })
    );
    expect(mark).toHaveBeenCalledWith('⌘⌥⇧L');
  });

  it('does nothing when main says the probe is off', async () => {
    const probe = await load(false);
    probe.onReactRender('thread:messages', 'update', 400, 400, 0, 0);
    probe.mark('x');
    expect(report).not.toHaveBeenCalled();
    expect(mark).not.toHaveBeenCalled();
  });
});
