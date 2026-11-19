import React, { useEffect, useRef, useState } from 'react';
import type { Release } from '../../../shared/types/releaseNotes';
import { Sheet } from '../../components/ui/sheet';
import { ReleaseShot } from './ReleaseShot';
import { Button } from '../../components/ui/button';

const TITLE_ID = 'whats-new-title';

/** Why the slideshow closed: `opt-out` also turns future popups off. */
export type CloseReason = 'done' | 'opt-out';

/**
 * A release's features, one slide each (ADR 0059). One click closes it; one click closes it and
 * stops future releases opening by themselves.
 */
export const WhatsNewDialog: React.FC<{
  release: Release;
  /** Releases skipped before this one, newest first. */
  missed: Release[];
  startAt?: number;
  onOpenPage: (version: string) => void;
  onOpenGuide: (id: string) => void;
  onClose: (reason: CloseReason) => void;
}> = ({ release, missed, startAt = 0, onOpenPage, onOpenGuide, onClose }) => {
  const count = release.slides.length;
  const [at, setAt] = useState(Math.min(startAt, Math.max(count - 1, 0)));
  // It opens by itself, so nothing has moved focus near it: a keyboard reader would otherwise
  // tab in from the top of the page behind it.
  const nextRef = useRef<HTMLButtonElement>(null);
  useEffect(() => nextRef.current?.focus(), []);
  const slide = release.slides[at];
  const last = at === count - 1;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === 'ArrowRight') setAt((index) => Math.min(index + 1, count - 1));
      if (event.key === 'ArrowLeft') setAt((index) => Math.max(index - 1, 0));
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [count]);

  if (!slide) return null;

  const version = release.version.replace(/^\d+\.\d+\.\d+-/, '');

  return (
    <Sheet
      open
      onClose={() => onClose('done')}
      titleId={TITLE_ID}
      className="wn-dialog"
      actions={
        <>
          <Button variant="quiet" type="button" onClick={() => onClose('opt-out')}>
            Don’t show again
          </Button>
          <div className="wn-dots" role="group" aria-label="Slides">
            {release.slides.map((item, index) => (
              <button
                key={item.title}
                type="button"
                aria-label={`Slide ${index + 1}`}
                aria-current={index === at}
                onClick={() => setAt(index)}
              />
            ))}
          </div>
          <div className="wn-actions-right">
            {at > 0 ? (
              <Button variant="quiet" type="button" onClick={() => setAt(at - 1)}>
                Back
              </Button>
            ) : null}
            <Button
              variant="primary"
              block
              ref={nextRef}
              type="button"
              onClick={() => (last ? onClose('done') : setAt(at + 1))}
            >
              {last ? 'Done' : 'Next'}
            </Button>
          </div>
        </>
      }
      actionsClassName="wn-actions"
    >
      <header className="wn-head">
        <p className="wn-kicker" id={TITLE_ID}>
          <strong>What’s new</strong> in {version}
        </p>
        {missed.length > 0 ? (
          <button type="button" className="wn-chip" onClick={() => onOpenPage(missed[0].version)}>
            <span className="wn-pip" aria-hidden="true" />
            {missed.length} earlier release{missed.length > 1 ? 's' : ''} you haven’t seen
          </button>
        ) : null}
        <button type="button" className="wn-close" aria-label="Close" onClick={() => onClose('done')}>
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </header>

      <ReleaseShot owner={release.version} image={slide.image} anchor={slide.anchor} />
      <h3 className="wn-slide-title">{slide.title}</h3>
      <p className="wn-slide-body">{slide.body}</p>
      {slide.guide ? (
        <p className="wn-slide-more">
          <button type="button" className="wn-link" onClick={() => onOpenGuide(slide.guide as string)}>
            Open the guide →
          </button>
        </p>
      ) : null}
    </Sheet>
  );
};
