import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stubElectronAPI } from '../../../../__tests__/electronApiFake';
import type { CircleSnapshot } from '../../../../../shared/types/circles';
import { ShareToCircleSheet } from '../ShareToCircleSheet';

const circle: CircleSnapshot = {
  key: 'aa'.repeat(32),
  name: 'Book club',
  myRole: 'member',
  members: [],
  invites: [],
  offers: [],
  needsUpdate: false,
  writable: true,
  format: 2,
};

function renderSheet(onShared = vi.fn()) {
  render(
    <ShareToCircleSheet
      draft={{ text: 'Plan my week', role: 'user' }}
      circles={[circle]}
      channels={{}}
      onClose={() => undefined}
      onShared={onShared}
    />
  );
  return onShared;
}

const shareButton = () => screen.getByRole('button', { name: /^(Share|Sharing…)$/ });

describe('ShareToCircleSheet', () => {
  afterEach(cleanup);

  it('shows the error and can share again when the post call rejects', async () => {
    const chatPost = vi
      .fn()
      .mockRejectedValueOnce(new Error('Circles stopped'))
      .mockResolvedValueOnce({ success: true });
    stubElectronAPI({ circles: { chatPost } });
    const onShared = renderSheet();

    await act(async () => fireEvent.click(shareButton()));
    expect(screen.getByText('Circles stopped')).toBeTruthy();
    expect(shareButton().textContent).toBe('Share');
    expect(onShared).not.toHaveBeenCalled();

    await act(async () => fireEvent.click(shareButton()));
    expect(chatPost).toHaveBeenCalledTimes(2);
    expect(onShared).toHaveBeenCalledWith(expect.objectContaining({ circleKey: circle.key, channel: 'general' }));
  });

  it('shows main’s error when the post is refused', async () => {
    stubElectronAPI({ circles: { chatPost: vi.fn(async () => ({ success: false, error: 'Not a member.' })) } });
    const onShared = renderSheet();
    await act(async () => fireEvent.click(shareButton()));
    expect(screen.getByText('Not a member.')).toBeTruthy();
    expect(onShared).not.toHaveBeenCalled();
  });
});
