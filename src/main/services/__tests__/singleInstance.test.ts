import { describe, expect, it, vi } from 'vitest';
import { claimSingleInstance } from '../../singleInstance';

function fakeApp(gotLock: boolean) {
  const handlers = new Map<string, () => void>();
  return {
    requestSingleInstanceLock: vi.fn(() => gotLock),
    exit: vi.fn(),
    on: vi.fn((event: string, handler: () => void) => {
      handlers.set(event, handler);
    }),
    emit: (event: string) => handlers.get(event)?.(),
  };
}

describe('claimSingleInstance', () => {
  it('shows the first instance when a second one starts', () => {
    const app = fakeApp(true);
    const onSecondInstance = vi.fn();
    expect(claimSingleInstance(app as never, onSecondInstance)).toBe(true);
    expect(app.exit).not.toHaveBeenCalled();
    app.emit('second-instance');
    expect(onSecondInstance).toHaveBeenCalledOnce();
  });

  it('exits the second instance without quitting (which would stop the stack)', () => {
    const app = fakeApp(false);
    expect(claimSingleInstance(app as never, vi.fn())).toBe(false);
    expect(app.exit).toHaveBeenCalledWith(0);
    expect(app.on).not.toHaveBeenCalled();
  });
});
