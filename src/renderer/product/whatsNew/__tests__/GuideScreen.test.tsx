import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AnchorBoxes, Guide, Release } from '../../../../shared/types/releaseNotes';
import { GuideScreen } from '../GuideScreen';

const REACTIONS: Guide = {
  id: 'reactions',
  title: 'React to a Circle message',
  minutes: 1,
  steps: [
    {
      title: 'Hover the message',
      image: 'hover',
      callouts: [
        { anchor: 'msg', text: 'Hover any message in a Circle chat.' },
        { anchor: 'smile', text: 'The smiley opens the reaction picker.' },
      ],
    },
    { title: 'Pick a reaction', image: 'pick', callouts: [{ anchor: 'quick', text: 'Six quick reactions.' }] },
    { title: 'See who reacted', image: 'done', callouts: [{ anchor: 'mine', text: 'Yours is outlined.' }] },
  ],
};

vi.mock('../content', () => ({
  loadReleases: (): Release[] => [],
  loadGuide: (id: string): Guide | null =>
    id === 'reactions'
      ? REACTIONS
      : id === 'empty'
        ? { id: 'empty', title: 'Nothing here', minutes: 1, steps: [] }
        : null,
  imageUrl: (): string | null => '/assets/shot.png',
  anchorBoxes: (): AnchorBoxes => ({
    msg: { x: 0.2, y: 0.3, w: 0.5, h: 0.2 },
    smile: { x: 0.7, y: 0.22, w: 0.04, h: 0.03 },
    quick: { x: 0.3, y: 0.4, w: 0.3, h: 0.05 },
    mine: { x: 0.3, y: 0.5, w: 0.05, h: 0.03 },
  }),
}));

function show(guideId = 'reactions') {
  const onBack = vi.fn();
  render(<GuideScreen guideId={guideId} onBack={onBack} />);
  return { onBack };
}

describe('GuideScreen', () => {
  it('lists every step and opens the first', () => {
    show();
    expect(screen.getByText('Step 1 of 3')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Hover the message', level: 3 })).toBeTruthy();
  });

  it('draws one marker per callout', () => {
    show();
    expect(screen.getAllByTestId('guide-marker')).toHaveLength(2);
  });

  it('numbers the callouts alongside the screenshot', () => {
    show();
    expect(screen.getByText('Hover any message in a Circle chat.')).toBeTruthy();
    expect(screen.getByText('The smiley opens the reaction picker.')).toBeTruthy();
  });

  it('highlights the marker when its callout is hovered', () => {
    show();
    fireEvent.mouseEnter(screen.getByText('The smiley opens the reaction picker.').closest('li') as HTMLElement);
    const markers = screen.getAllByTestId('guide-marker');
    expect(markers.find((marker) => marker.textContent === '2')?.className).toContain('is-hot');
  });

  it('moves between steps', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Next step' }));
    expect(screen.getByText('Step 2 of 3')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByText('Step 1 of 3')).toBeTruthy();
  });

  it('jumps to a step from the list', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: /See who reacted/ }));
    expect(screen.getByText('Step 3 of 3')).toBeTruthy();
  });

  it('returns to the page from the last step', () => {
    const { onBack } = show();
    fireEvent.click(screen.getByRole('button', { name: /See who reacted/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onBack).toHaveBeenCalled();
  });

  it('returns to the page from the back link', () => {
    const { onBack } = show();
    fireEvent.click(screen.getByRole('button', { name: /What’s new/ }));
    expect(onBack).toHaveBeenCalled();
  });

  it('says so when the guide has no steps', () => {
    show('empty');
    expect(screen.getByText(/guide isn’t in this build/)).toBeTruthy();
  });

  it('says so when the guide is missing', () => {
    show('ghost');
    expect(screen.getByText(/guide isn’t in this build/)).toBeTruthy();
  });
});
