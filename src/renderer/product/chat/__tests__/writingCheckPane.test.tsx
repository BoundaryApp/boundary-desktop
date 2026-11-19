import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import type { ProjectSourcesRailProps } from '../ProjectSourcesRail';
import { RightInspector } from '../RightInspector';
import type { WritingCheckRequest } from '../WritingCheckPane';

stubElectronAPI({ agents: { getSoul: vi.fn(async () => ({ success: false })), revealSoul: vi.fn() } });

const projectTab: Omit<ProjectSourcesRailProps, 'role'> = {
  project: null,
  inspect: null,
  connecting: false,
  rpcAvailable: true,
  onChangeFolder: (): void => undefined,
  onChooseFolder: (): void => undefined,
  onRevealHub: (): void => undefined,
  onRevealSource: (): void => undefined,
  onRefreshIndex: (): void => undefined,
  onAddFolder: (): void => undefined,
  onRemoveSource: (): void => undefined,
};

const FLAGGED = [
  'Great question! Remote work has become a pivotal part of the business landscape.',
  '',
  "It's not just about working from home, it's about how we collaborate. I hope this helps!",
].join('\n');

const PLAIN = [
  'The build passed on Tuesday after we pinned the compiler to the version the release used.',
  'Two tests still fail on the older Mac, both in the date parser, and Dan thinks the time zone',
  'database on that machine is out of date. I will update it tomorrow and run them again.',
  'If they pass, we can tag the release on Thursday morning and send notes to the three teams',
  'waiting on it.',
].join(' ');

function inspector(check: WritingCheckRequest | null, handlers: Partial<Record<'onCloseCheck' | 'onShowCheckedReply', () => void>> = {}) {
  return (
    <RightInspector
      centerMode="conversation"
      kind="hermes"
      activeChannel={null}
      activeAgent={null}
      agents={[]}
      threadId="t1"
      projectTab={projectTab}
      onMakeChannel={() => undefined}
      onAddToChannel={() => undefined}
      writingCheck={check}
      onCloseCheck={handlers.onCloseCheck ?? (() => undefined)}
      onShowCheckedReply={handlers.onShowCheckedReply ?? (() => undefined)}
    />
  );
}

const request = (markdown: string, seq = 1): WritingCheckRequest => ({
  seq,
  messageId: 'm1',
  markdown,
  source: 'Reply · Today 11:42',
});

const marks = () => document.querySelectorAll('.wb-check-prose mark');

describe('Writing check in the inspector', () => {
  afterEach(cleanup);

  it('has no Check tab until a reply is checked, then opens on it', () => {
    const { rerender } = render(inspector(null));
    expect(screen.queryByRole('button', { name: 'Check' })).toBeNull();
    rerender(inspector(request(FLAGGED)));
    expect(screen.getByRole('button', { name: 'Check' }).className).toContain('is-on');
    expect(screen.getByText('Writing check')).toBeTruthy();
    expect(screen.getByText('Reply · Today 11:42')).toBeTruthy();
  });

  it('counts the flags, highlights them and explains the one in focus', async () => {
    render(inspector(request(FLAGGED)));
    const result = screen.getByTestId('check-count');
    expect(result.textContent).toMatch(/^\d+ flags$/);
    expect(screen.getByText(/Too short for a rate · \d+ words/)).toBeTruthy();
    expect(marks().length).toBeGreaterThan(3);

    const pivotal = [...marks()].find((m) => m.textContent === 'pivotal') as HTMLElement;
    await act(async () => fireEvent.focus(pivotal));
    const detail = screen.getByTestId('check-detail');
    expect(detail.textContent).toContain('Model vocabulary');
    expect(detail.textContent).toContain('pattern 7');
  });

  it('hides a category’s highlights when its filter is turned off', async () => {
    render(inspector(request(FLAGGED)));
    const filters = within(screen.getByRole('group', { name: 'Show categories' }));
    const framing = filters.getByRole('button', { name: /^Framing \d+$/ });
    const before = marks().length;
    await act(async () => fireEvent.click(framing));
    expect(framing.getAttribute('aria-pressed')).toBe('false');
    expect(marks().length).toBeLessThan(before);
    expect([...marks()].some((m) => m.textContent?.includes('I hope this helps'))).toBe(false);
  });

  it('says so when a reply has no flags, with a rate once it is long enough', () => {
    render(inspector(request(PLAIN)));
    expect(screen.getByTestId('check-count').textContent).toBe('No flags');
    expect(screen.getByText(/^0 per 100 words · \d+ words$/)).toBeTruthy();
    expect(marks().length).toBe(0);
  });

  it('closes, and shows the reply in the chat', async () => {
    const onCloseCheck = vi.fn();
    const onShowCheckedReply = vi.fn();
    render(inspector(request(FLAGGED), { onCloseCheck, onShowCheckedReply }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Show in chat' })));
    expect(onShowCheckedReply).toHaveBeenCalledWith('m1');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Close check' })));
    expect(onCloseCheck).toHaveBeenCalled();
  });

  it('returns to the Check tab when another reply is checked', async () => {
    const { rerender } = render(inspector(request(FLAGGED, 1)));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Project' })));
    expect(screen.getByRole('button', { name: 'Check' }).className).not.toContain('is-on');
    rerender(inspector(request(PLAIN, 2)));
    expect(screen.getByRole('button', { name: 'Check' }).className).toContain('is-on');
  });
});
