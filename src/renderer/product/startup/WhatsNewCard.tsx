import React from 'react';
import type { Release } from '../../../shared/types/releaseNotes';
import { ReleaseShot } from '../whatsNew/ReleaseShot';
import { openWhatsNew } from '../whatsNew/WhatsNewLayer';

const shortVersion = (version: string) => version.replace(/^\d+\.\d+\.\d+-/, '');

/**
 * What the version being started brought, in the start-up screen's story slot (ADR 0059). It
 * fills a wait rather than interrupting, so it shows even when the popup is turned off.
 */
export const WhatsNewCard: React.FC<{
  release: Release;
  index: number;
  onPick: (index: number) => void;
  onPause: (paused: boolean) => void;
}> = ({ release, index, onPick, onPause }) => {
  const slide = release.slides[index];
  if (!slide) return null;

  return (
    <section
      className="su-whats-new"
      aria-roledescription="carousel"
      aria-label="New in this version"
      onMouseEnter={() => onPause(true)}
      onMouseLeave={() => onPause(false)}
      onFocus={() => onPause(true)}
      onBlur={() => onPause(false)}
    >
      <header>
        New in this version <span className="su-wn-version">{shortVersion(release.version)}</span>
      </header>
      <div className="su-wn-body" key={slide.title}>
        <ReleaseShot owner={release.version} image={slide.image} anchor={slide.anchor} />
        <div>
          <h2>{slide.title}</h2>
          <p>{slide.body}</p>
        </div>
      </div>
      <footer>
        <div className="su-wn-dots">
          {release.slides.map((item, at) => (
            <button
              key={item.title}
              type="button"
              aria-label={`Show ${item.title}`}
              aria-current={at === index || undefined}
              onClick={() => onPick(at)}
            />
          ))}
        </div>
        <button type="button" className="su-wn-more" onClick={() => openWhatsNew(index)}>
          Read more
        </button>
      </footer>
    </section>
  );
};
