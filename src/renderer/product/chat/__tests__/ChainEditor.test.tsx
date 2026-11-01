import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CirclesState } from '../../../../shared/types/circles';
import type { InferenceChainEntry } from '../../../../shared/types/inferenceChain';
import {
  ChainEditor,
  SharedModelChoices,
  chainCandidates,
  describeChainEntry,
  sharedModelChoices,
  type ChainContext,
} from '../ChainEditor';

const CIRCLE = 'c'.repeat(64);
const BO = 'b'.repeat(64);
const ME = 'a'.repeat(64);

function circles(overrides: Partial<CirclesState> = {}, offer: Partial<CirclesState['snapshot']['circles'][0]['offers'][0]> = {}): CirclesState {
  return {
    status: 'running',
    displayName: 'Ada',
    providers: { [BO]: { private: false, trusted: true } },
    snapshot: {
      identity: ME,
      circles: [
        {
          key: CIRCLE,
          name: 'Workshop',
          myRole: 'member',
          writable: true,
          members: [],
          invites: [],
          offers: [
            {
              identity: BO,
              name: 'Bo',
              isMine: false,
              models: [{ id: 'qwen3-8b', tools: true }, { id: 'gemma', tools: false }],
              available: true,
              away: false,
              online: true,
              ...offer,
            },
            { identity: ME, name: 'Ada', isMine: true, models: [{ id: 'mine', tools: false }], available: true, away: false, online: true },
          ],
        },
      ],
    },
    ...overrides,
  };
}

const slots: ChainContext['slots'] = {
  local: { configured: true, modelId: 'qwen3:14b' } as ChainContext['slots']['local'],
  openrouter: { configured: true, modelId: 'anthropic/claude-sonnet-4' } as ChainContext['slots']['openrouter'],
};

const shared = (modelId = 'qwen3-8b'): InferenceChainEntry => ({ slot: 'peer', modelId, peer: { circleId: CIRCLE, providerId: BO } });

afterEach(() => cleanup());

describe('shared models as the app default (ADR 0036)', () => {
  it('lists members’ models, not the user’s own, and keeps a chosen one whose offer went', () => {
    const labels = (current: InferenceChainEntry | null, state = circles()) =>
      sharedModelChoices(current, { slots, circles: state }).map((view) => view.label);
    expect(labels(null)).toEqual(["Bo's qwen3-8b", "Bo's gemma"]);
    expect(labels(shared())).toEqual(["Bo's qwen3-8b", "Bo's gemma"]);
    expect(labels(shared(), circles({ snapshot: { identity: ME, circles: [] } }))).toEqual(["A member's qwen3-8b"]);
  });

  it('says what stops chats, since no entry comes after it', () => {
    const detail = (state: CirclesState, entry = shared()) => describeChainEntry(entry, { slots, circles: state }, 'first').detail;
    expect(detail(circles({ providers: {} }))).toMatch(/Trust Bo in Circles to use it/);
    expect(detail(circles({}, { available: false }))).toMatch(/Chats can’t send until that changes/);
    expect(detail(circles({}, { online: false }))).toMatch(/Offline now, so chats can’t send/);
    expect(detail(circles(), shared('gemma'))).toMatch(/Doesn’t support tool calls/);
  });

  it('only lets the user pick a model that can serve', () => {
    const onPick = vi.fn();
    render(<SharedModelChoices current={null} ctx={{ slots, circles: circles({ providers: {} }) }} onPick={onPick} />);
    fireEvent.click(screen.getByRole('button', { name: /Bo's qwen3-8b/ }));
    expect(onPick).not.toHaveBeenCalled();
    cleanup();
    render(<SharedModelChoices current={null} ctx={{ slots, circles: circles() }} onPick={onPick} />);
    fireEvent.click(screen.getByRole('button', { name: /Bo's qwen3-8b/ }));
    expect(onPick).toHaveBeenCalledWith(shared());
  });

  it('still lets the user pick an offline provider’s model, for when they’re back', () => {
    render(<SharedModelChoices current={null} ctx={{ slots, circles: circles({}, { online: false }) }} onPick={vi.fn()} />);
    expect((screen.getByRole('button', { name: /Bo's qwen3-8b/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('doesn’t offer the first entry again as a fallback', () => {
    const labels = chainCandidates(shared(), [], { slots, circles: circles() }).map((view) => view.label);
    expect(labels).not.toContain("Bo's qwen3-8b");
    expect(labels).toContain("Bo's gemma");
  });
});

describe('describeChainEntry', () => {
  it('says why a shared model is skipped, in the order main checks', () => {
    const cases: Array<[CirclesState, InferenceChainEntry, RegExp]> = [
      [circles({ status: 'starting' }), shared(), /Circles aren’t connected/],
      [circles({ snapshot: { identity: ME, circles: [] } }), shared(), /no longer in that Circle/],
      [circles({}, { available: false }), shared(), /Bo isn’t sharing it now/],
      [circles(), shared('gone'), /No longer shared/],
      [circles({ providers: {} }), shared(), /until you trust Bo in Circles/],
    ];
    for (const [state, entry, reason] of cases) {
      const view = describeChainEntry(entry, { slots, circles: state });
      expect({ detail: view.detail, skipped: view.skipped }).toEqual({ detail: expect.stringMatching(reason), skipped: true });
    }
  });

  it('serves a trusted provider’s model, saying when they are offline and whether it is private', () => {
    expect(describeChainEntry(shared(), { slots, circles: circles() })).toMatchObject({
      label: "Bo's qwen3-8b",
      skipped: false,
      detail: 'Shared in Workshop. Not for private projects.',
    });
    const offline = describeChainEntry(shared(), {
      slots,
      circles: circles({ providers: { [BO]: { private: true, trusted: true } } }, { online: false }),
    });
    expect(offline).toMatchObject({
      skipped: true,
      offline: true,
      detail: expect.stringMatching(/Offline now\. Skipped\..*Can serve private projects/),
    });
  });

  it('marks a disconnected provider skipped', () => {
    expect(describeChainEntry({ slot: 'openrouter' }, { slots: { local: slots.local }, circles: circles() })).toMatchObject({
      skipped: true,
      detail: 'Not connected. Skipped.',
    });
  });
});

describe('chainCandidates', () => {
  it('offers the other provider and others’ shared models not already in the chain', () => {
    const labels = chainCandidates({ slot: 'local' }, [shared()], { slots, circles: circles() }).map((view) => view.label);
    expect(labels).toEqual(['OpenRouter · claude-sonnet-4', "Bo's gemma"]);
  });
});

describe('a candidate that can’t serve yet', () => {
  const untrusted = { slots, circles: circles({ providers: {} }) };

  it('says so, in words that don’t read as an active fallback', () => {
    const [view] = chainCandidates({ slot: 'local' }, [], untrusted).filter((item) => item.entry.slot === 'peer');
    expect(view).toMatchObject({ skipped: true, detail: 'Shared in Workshop. Can’t be used until you trust Bo in Circles.' });
    expect(view.detail).not.toMatch(/Skipped/);
    const offline = { slots, circles: circles({}, { online: false }) };
    expect(chainCandidates({ slot: 'local' }, [], offline).find((item) => item.entry.slot === 'peer')?.detail).toMatch(
      /Offline now, so it can’t be used yet/
    );
  });

  it('can still be added, dimmed, and then reads as skipped', () => {
    const onChange = vi.fn();
    render(<ChainEditor primary={{ slot: 'local' }} fallbacks={[]} ctx={untrusted} emptyNote="none" onChange={onChange} />);
    const add = screen.getByRole('button', { name: /^Add Bo's gemma\. .*Can’t be used until you trust Bo/ });
    expect(add.className).toContain('is-skipped');
    fireEvent.click(add);
    expect(onChange).toHaveBeenCalledWith([shared('gemma')]);
    cleanup();
    render(<ChainEditor primary={{ slot: 'local' }} fallbacks={[shared('gemma')]} ctx={untrusted} emptyNote="none" onChange={onChange} />);
    expect(screen.getByRole('list', { name: 'Fallbacks' }).textContent).toMatch(/Skipped until you trust Bo/);
  });
});

describe('the link to Circles', () => {
  const left = { slots, circles: circles({ snapshot: { identity: ME, circles: [] } }) };

  it('shows on a fallback that can’t serve, and opens the fix', () => {
    const opened = vi.fn();
    window.addEventListener('boundary:open-circles', opened);
    render(<ChainEditor primary={{ slot: 'local' }} fallbacks={[shared()]} ctx={{ slots, circles: circles({ providers: {} }) }} emptyNote="none" onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open in Circles' }));
    expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({ person: BO });
    window.removeEventListener('boundary:open-circles', opened);
  });

  it('is absent on a fallback that can serve, and on one from a Circle the user left', () => {
    render(<ChainEditor primary={{ slot: 'local' }} fallbacks={[shared()]} ctx={{ slots, circles: circles() }} emptyNote="none" onChange={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Open in Circles' })).toBeNull();
    cleanup();
    render(<ChainEditor primary={{ slot: 'local' }} fallbacks={[shared()]} ctx={left} emptyNote="none" onChange={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Open in Circles' })).toBeNull();
    expect(screen.getByRole('list', { name: 'Fallbacks' }).textContent).toMatch(/no longer in that Circle.*Choose another model/);
  });
});

describe('ChainEditor', () => {
  it('reorders, removes and adds entries', () => {
    const onChange = vi.fn();
    const fallbacks = [{ slot: 'openrouter' as const }, shared()];
    render(
      <ChainEditor primary={{ slot: 'local' }} fallbacks={fallbacks} ctx={{ slots, circles: circles() }} emptyNote="none" onChange={onChange} />
    );
    const list = screen.getByRole('list', { name: 'Fallbacks' });
    expect(within(list).getAllByRole('listitem').map((row) => row.textContent?.slice(0, 1))).toEqual(['2', '3']);
    expect((within(list).getByRole('button', { name: 'Move OpenRouter · claude-sonnet-4 up' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(within(list).getByRole('button', { name: "Move Bo's qwen3-8b up" }));
    expect(onChange).toHaveBeenLastCalledWith([shared(), { slot: 'openrouter' }]);
    fireEvent.click(within(list).getByRole('button', { name: 'Remove OpenRouter · claude-sonnet-4' }));
    expect(onChange).toHaveBeenLastCalledWith([shared()]);
    fireEvent.click(screen.getByRole('button', { name: "Add Bo's gemma" }));
    expect(onChange).toHaveBeenLastCalledWith([...fallbacks, shared('gemma')]);
  });
});
