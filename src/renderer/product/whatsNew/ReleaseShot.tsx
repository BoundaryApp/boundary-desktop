import React from 'react';
import { anchorBoxes, imageUrl } from './content';

export interface ShotMarker {
  anchor: string;
  /** The number drawn on the marker and in the step's list. */
  n: number;
}

/** Under this much of the image in both directions, a marker sits beside its target, not on it. */
const SMALL = 0.12;
/** How far outside a small target's edge the marker sits, as a fraction of the image width. */
const BESIDE = 0.02;
/** Markers closer than this to one that is already placed shift along. */
const APART = 0.035;

/** Keeps a marker's centre inside the image, whatever the box it came from. */
const clamp = (value: number): number => Math.min(Math.max(value, BESIDE), 1 - BESIDE);

interface Placed {
  n: number;
  x: number;
  y: number;
}

/**
 * A bundled screenshot with a ring around the part a slide is about and numbered markers for a
 * guide step's callouts. Positions come from the boxes the screenshot was saved with, so they
 * follow the real layout instead of being typed in by hand (ADR 0059).
 */
export const ReleaseShot: React.FC<{
  /** A version, or `guides/<id>`. */
  owner: string;
  image?: string;
  /** An anchor to ring. */
  anchor?: string;
  markers?: ShotMarker[];
  /** The marker the reader is pointing at, drawn larger. */
  hot?: number | null;
  onHot?: (n: number | null) => void;
  alt?: string;
}> = ({ owner, image, anchor, markers = [], hot = null, onHot, alt = '' }) => {
  if (!image) return null;
  const url = imageUrl(owner, image);
  const boxes = anchorBoxes(owner, image);
  const ring = anchor ? boxes[anchor] : undefined;

  const placed: Placed[] = [];
  for (const marker of markers) {
    const box = boxes[marker.anchor];
    if (!box) continue;
    // A small target takes its marker beside it, so the marker doesn't cover it; a large one
    // takes it on its top-left corner. Either way the marker stays inside the image.
    const small = box.w < SMALL && box.h < SMALL;
    let x = small ? box.x - BESIDE : box.x;
    let y = small ? box.y + box.h / 2 : box.y;
    if (small && x < BESIDE) x = box.x + box.w + BESIDE;
    if (y < BESIDE) y = box.y + box.h / 2;
    while (placed.some((other) => Math.hypot(other.x - x, other.y - y) < APART)) x += APART;
    placed.push({ n: marker.n, x: clamp(x), y: clamp(y) });
  }

  return (
    <figure className="wn-shot">
      {url ? <img src={url} alt={alt} /> : <div className="wn-shot-blank" aria-hidden="true" />}
      {url && ring ? (
        <span
          className="wn-shot-ring"
          aria-hidden="true"
          style={{
            left: `${ring.x * 100}%`,
            top: `${ring.y * 100}%`,
            width: `${ring.w * 100}%`,
            height: `${ring.h * 100}%`,
          }}
        />
      ) : null}
      {url
        ? placed.map((marker) => (
            <span
              key={marker.n}
              className={`wn-shot-marker${hot === marker.n ? ' is-hot' : ''}`}
              data-testid="guide-marker"
              style={{ left: `${marker.x * 100}%`, top: `${marker.y * 100}%` }}
              onMouseEnter={() => onHot?.(marker.n)}
              onMouseLeave={() => onHot?.(null)}
            >
              {marker.n}
            </span>
          ))
        : null}
    </figure>
  );
};
