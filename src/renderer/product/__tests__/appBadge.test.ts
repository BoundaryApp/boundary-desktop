import { describe, expect, it, vi } from 'vitest';
import { appBadgeFor } from '../appBadge';

describe('appBadgeFor', () => {
  it('sends the count alone off Windows', () => {
    const draw = vi.fn(() => 'data:image/png;base64,AAAA');
    expect(appBadgeFor(4, false, draw)).toEqual({ count: 4 });
    expect(draw).not.toHaveBeenCalled();
  });

  it('adds the drawn overlay on Windows', () => {
    const draw = vi.fn(() => 'data:image/png;base64,AAAA');
    expect(appBadgeFor(12, true, draw)).toEqual({ count: 12, overlay: 'data:image/png;base64,AAAA' });
    expect(draw).toHaveBeenCalledWith(12);
  });

  it('draws nothing on Windows at 0, and sends the count when drawing fails', () => {
    const draw = vi.fn(() => null);
    expect(appBadgeFor(0, true, draw)).toEqual({ count: 0 });
    expect(draw).not.toHaveBeenCalled();
    expect(appBadgeFor(2, true, draw)).toEqual({ count: 2 });
  });
});
