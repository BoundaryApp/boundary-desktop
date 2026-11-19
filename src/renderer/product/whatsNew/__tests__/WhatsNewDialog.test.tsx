import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnchorBoxes, Guide, Release, ReleaseSlide } from '../../../../shared/types/releaseNotes';
import { WhatsNewDialog } from '../WhatsNewDialog';

const images = vi.hoisted(() => ({ url: '/assets/shot.png' as string | null }));
vi.mock('../content', () => ({
  loadReleases: (): Release[] => [],
  loadGuide: (): Guide | null => null,
  imageUrl: (): string | null => images.url,
  anchorBoxes: (): AnchorBoxes => ({ msg: { x: 0.1, y: 0.2, w: 0.3, h: 0.1 } }),
}));

const slide = (title: string, extra: Partial<ReleaseSlide> = {}): ReleaseSlide => ({
  title,
  body: 'What it does.',
  image: 'one',
  ...extra,
});

const release = (slides: ReleaseSlide[], version = '0.0.1-rc.11'): Release => ({
  version,
  date: 'Nov 13',
  slides,
  guides: [],
});

const THREE = release([
  slide('React to Circle messages', { guide: 'reactions', anchor: 'msg' }),
  slide('Queue a follow-up'),
  slide('Todo lists add-on'),
]);

function show(over: Partial<React.ComponentProps<typeof WhatsNewDialog>> = {}) {
  const props = {
    release: THREE,
    missed: [] as Release[],
    onOpenPage: vi.fn(),
    onOpenGuide: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
  render(<WhatsNewDialog {...props} />);
  return props;
}

beforeEach(() => {
  images.url = '/assets/shot.png';
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('WhatsNewDialog', () => {
  it('names the version it is showing', () => {
    show();
    expect(screen.getByText(/rc\.11/)).toBeTruthy();
  });

  it('shows the first slide and pages forward', () => {
    show();
    expect(screen.getByRole('heading', { name: 'React to Circle messages' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('heading', { name: 'Queue a follow-up' })).toBeTruthy();
  });

  it('pages back', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('heading', { name: 'React to Circle messages' })).toBeTruthy();
  });

  it('shows Done rather than Next on a single-slide release', () => {
    show({ release: release([slide('One thing')]) });
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
  });

  it('renders a dot per slide, up to six', () => {
    show({ release: release(Array.from({ length: 6 }, (_, i) => slide(`Feature ${i}`))) });
    expect(screen.getAllByRole('button', { name: /^Slide / })).toHaveLength(6);
  });

  it('jumps to a slide from its dot', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Slide 3' }));
    expect(screen.getByRole('heading', { name: 'Todo lists add-on' })).toBeTruthy();
  });

  it('pages with the arrow keys', () => {
    show();
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(screen.getByRole('heading', { name: 'Queue a follow-up' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(screen.getByRole('heading', { name: 'React to Circle messages' })).toBeTruthy();
  });

  it('closes when it is done', () => {
    const props = show({ release: release([slide('One thing')]) });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(props.onClose).toHaveBeenCalledWith('done');
  });

  it('closes on Escape', () => {
    const props = show();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(props.onClose).toHaveBeenCalledWith('done');
  });

  it('turns popups off in one click', () => {
    const props = show();
    fireEvent.click(screen.getByRole('button', { name: 'Don’t show again' }));
    expect(props.onClose).toHaveBeenCalledWith('opt-out');
  });

  it('shows the missed-releases chip only when some were missed', () => {
    show();
    expect(screen.queryByRole('button', { name: /earlier release/ })).toBeNull();
  });

  it('counts the missed releases in the chip', () => {
    show({ missed: [release([], '0.0.1-rc.10'), release([], '0.0.1-rc.9')] });
    expect(screen.getByRole('button', { name: /2 earlier releases you haven’t seen/ })).toBeTruthy();
  });

  it('opens the page at the newest missed release', () => {
    const props = show({ missed: [release([], '0.0.1-rc.10'), release([], '0.0.1-rc.9')] });
    fireEvent.click(screen.getByRole('button', { name: /earlier releases/ }));
    expect(props.onOpenPage).toHaveBeenCalledWith('0.0.1-rc.10');
  });

  it('opens a slide’s guide', () => {
    const props = show();
    fireEvent.click(screen.getByRole('button', { name: /Open the guide/ }));
    expect(props.onOpenGuide).toHaveBeenCalledWith('reactions');
  });

  it('offers no guide link on a slide without one', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.queryByRole('button', { name: /Open the guide/ })).toBeNull();
  });

  it('keeps the slide text when the image is missing', () => {
    images.url = null;
    show();
    expect(screen.getByRole('heading', { name: 'React to Circle messages' })).toBeTruthy();
    expect(screen.getByText('What it does.')).toBeTruthy();
  });

  it('takes focus when it opens by itself', () => {
    show();
    expect(document.activeElement?.textContent).toBe('Next');
  });

  it('names itself for screen readers', () => {
    show();
    expect(screen.getByRole('dialog').getAttribute('aria-labelledby')).toBe('whats-new-title');
  });
});
