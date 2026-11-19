import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AnchorBoxes, Guide, Release } from '../../../../shared/types/releaseNotes';
import { ReleaseShot } from '../ReleaseShot';

const boxes = vi.hoisted(() => ({ value: {} as AnchorBoxes }));
vi.mock('../content', () => ({
  loadReleases: (): Release[] => [],
  loadGuide: (): Guide | null => null,
  imageUrl: (): string | null => '/assets/shot.png',
  anchorBoxes: (): AnchorBoxes => boxes.value,
}));

const percent = (value: string | undefined) => Number((value ?? '').replace('%', ''));
const markerAt = (n: number) => {
  const marker = screen.getAllByTestId('guide-marker').find((item) => item.textContent === String(n));
  return { x: percent(marker?.style.left), y: percent(marker?.style.top) };
};

describe('ReleaseShot marker placement', () => {
  it('puts a marker beside a small target', () => {
    boxes.value = { smile: { x: 0.7, y: 0.2, w: 0.03, h: 0.03 } };
    render(<ReleaseShot owner="v" image="one" markers={[{ anchor: 'smile', n: 1 }]} />);
    expect(markerAt(1).x).toBeLessThan(70);
    expect(markerAt(1).y).toBeCloseTo(21.5, 0);
  });

  it('puts a marker on the corner of a large target', () => {
    boxes.value = { panel: { x: 0.3, y: 0.3, w: 0.5, h: 0.4 } };
    render(<ReleaseShot owner="v" image="one" markers={[{ anchor: 'panel', n: 1 }]} />);
    expect(markerAt(1).x).toBeCloseTo(30, 0);
    expect(markerAt(1).y).toBeCloseTo(30, 0);
  });

  it('keeps a marker on a wide target at the left edge beside its own corner', () => {
    boxes.value = { banner: { x: 0, y: 0.4, w: 0.9, h: 0.1 } };
    render(<ReleaseShot owner="v" image="one" markers={[{ anchor: 'banner', n: 1 }]} />);
    expect(markerAt(1).x).toBeLessThan(10);
  });

  it('keeps every marker inside the image', () => {
    boxes.value = {
      a: { x: 0.95, y: 0.5, w: 0.02, h: 0.02 },
      b: { x: 0.96, y: 0.5, w: 0.02, h: 0.02 },
      c: { x: 0.97, y: 0.5, w: 0.02, h: 0.02 },
      d: { x: 0.98, y: 0.5, w: 0.02, h: 0.02 },
    };
    render(
      <ReleaseShot
        owner="v"
        image="one"
        markers={[
          { anchor: 'a', n: 1 },
          { anchor: 'b', n: 2 },
          { anchor: 'c', n: 3 },
          { anchor: 'd', n: 4 },
        ]}
      />
    );
    for (const n of [1, 2, 3, 4]) {
      expect(markerAt(n).x).toBeGreaterThanOrEqual(0);
      expect(markerAt(n).x).toBeLessThanOrEqual(100);
    }
  });
});
