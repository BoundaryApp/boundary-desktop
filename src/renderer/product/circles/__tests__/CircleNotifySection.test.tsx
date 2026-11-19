import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CircleMemberView } from '../../../../shared/types/circles';
import { circleMember, circleSnapshot } from '../../../__tests__/circleFixtures';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import { CircleNotifySection } from '../CircleNotifySection';

const notifyPrefs = vi.fn();
const setNotifyPrefs = vi.fn();
stubElectronAPI({
  circles: {
    notifyPrefs: (...args: unknown[]) => notifyPrefs(...args),
    setNotifyPrefs: (...args: unknown[]) => setNotifyPrefs(...args),
  },
});

function people(count: number): CircleMemberView[] {
  return Array.from({ length: count }, (_, index) =>
    circleMember({ identity: index.toString(16).padStart(64, '0'), name: `Person ${index}`, isMe: index === 0 }),
  );
}

/** Main's answer: the level resolves from the people count the way `resolveNotifyLevel` does. */
function answer(count: number, prefs = { level: 'default', channelMentions: true }) {
  const resolved = prefs.level === 'default' ? (count <= 6 ? 'all' : 'mentions') : prefs.level;
  return { prefs, resolved, people: count, global: { enabled: true, showText: true } };
}

beforeEach(() => {
  notifyPrefs.mockReset();
  // Main stores what it is sent and answers the next read with it.
  setNotifyPrefs.mockReset().mockImplementation(async (input: { prefs: { level: string; channelMentions: boolean } }) => {
    const last = (await notifyPrefs.mock.results.at(-1)?.value) as ReturnType<typeof answer>;
    notifyPrefs.mockResolvedValue(answer(last.people, input.prefs));
  });
});

describe('CircleNotifySection', () => {
  it('says all messages notify in a Circle of five people', async () => {
    notifyPrefs.mockResolvedValue(answer(5));
    render(<CircleNotifySection circle={circleSnapshot({ members: people(5) })} />);
    expect(await screen.findByText('Default: all messages, because this Circle has 5 people.')).toBeTruthy();
    expect(screen.queryByText(/Mentions need this Circle updated/)).toBeNull();
  });

  it('says mentions only in a Circle of nine, and that an admin has to update it', async () => {
    notifyPrefs.mockResolvedValue(answer(9));
    render(<CircleNotifySection circle={circleSnapshot({ members: people(9) })} />);
    expect(
      await screen.findByText(
        'Default: mentions only, because this Circle has 9 people. Mentions need this Circle updated by an admin.',
      ),
    ).toBeTruthy();
  });

  it('says an admin has to update the Circle when Mentions is picked below format 3', async () => {
    notifyPrefs.mockResolvedValue(answer(5, { level: 'mentions', channelMentions: true }));
    render(<CircleNotifySection circle={circleSnapshot({ members: people(5) })} />);
    expect(await screen.findByText('Mentions need this Circle updated by an admin.')).toBeTruthy();
    expect(screen.queryByText(/^Default:/)).toBeNull();
  });

  it('says nothing more about Mentions once the Circle is at format 3', async () => {
    notifyPrefs.mockResolvedValue(answer(9, { level: 'mentions', channelMentions: true }));
    render(<CircleNotifySection circle={circleSnapshot({ members: people(9), format: 3 })} />);
    await screen.findByRole('radio', { name: 'Mentions' });
    expect(screen.queryByText(/Mentions need this Circle updated/)).toBeNull();
  });

  it('shows no default line once a level is picked', async () => {
    notifyPrefs.mockResolvedValue(answer(5, { level: 'all', channelMentions: true }));
    render(<CircleNotifySection circle={circleSnapshot({ members: people(5) })} />);
    await screen.findByRole('radio', { name: 'All' });
    expect(screen.queryByText(/^Default:/)).toBeNull();
  });

  it('saves Mentions with the @channel setting kept', async () => {
    notifyPrefs.mockResolvedValue(answer(5));
    const circle = circleSnapshot({ members: people(5) });
    render(<CircleNotifySection circle={circle} />);
    fireEvent.click(await screen.findByRole('radio', { name: 'Mentions' }));
    expect(setNotifyPrefs).toHaveBeenCalledWith({ key: circle.key, prefs: { level: 'mentions', channelMentions: true } });
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Mentions' }).getAttribute('aria-checked')).toBe('true'));
  });

  it('saves @channel off with the level kept', async () => {
    notifyPrefs.mockResolvedValue(answer(5, { level: 'all', channelMentions: true }));
    const circle = circleSnapshot({ members: people(5) });
    render(<CircleNotifySection circle={circle} />);
    fireEvent.click(await screen.findByRole('switch', { name: '@channel notifies me' }));
    expect(setNotifyPrefs).toHaveBeenCalledWith({ key: circle.key, prefs: { level: 'all', channelMentions: false } });
    await waitFor(() => expect(screen.getByRole('switch', { name: '@channel notifies me' }).getAttribute('aria-checked')).toBe('false'));
  });

  it('asks again when the Circle or its member count changes', async () => {
    notifyPrefs.mockResolvedValue(answer(6));
    const circle = circleSnapshot({ members: people(6) });
    const { rerender } = render(<CircleNotifySection circle={circle} />);
    await screen.findByText(/all messages, because this Circle has 6 people/);
    notifyPrefs.mockResolvedValue(answer(7));
    rerender(<CircleNotifySection circle={{ ...circle, members: people(7) }} />);
    expect(await screen.findByText(/mentions only, because this Circle has 7 people/)).toBeTruthy();
    expect(notifyPrefs).toHaveBeenCalledTimes(2);
  });
});
