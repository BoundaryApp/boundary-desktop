import React, { useEffect, useRef } from 'react';
import type { Release } from '../../../shared/types/releaseNotes';
import { loadGuide } from './content';
import { ReleaseShot } from './ReleaseShot';
import { useWhatsNew } from './state';
import './whatsNew.css';

const shortVersion = (version: string) => version.replace(/^\d+\.\d+\.\d+-/, '');

/** A guide to open, as a card. */
const GuideCard: React.FC<{ id: string; onOpen: (id: string) => void }> = ({ id, onOpen }) => {
  const guide = loadGuide(id);
  if (!guide) return null;
  return (
    <button type="button" className="wn-guide-card" onClick={() => onOpen(id)}>
      <span className="wn-guide-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="16" height="16">
          <path d="M5 4h10l4 4v12H5z" />
          <path d="M9 12h6M9 16h4" />
        </svg>
      </span>
      <span className="wn-guide-text">
        <strong>{guide.title}</strong>
        <span>
          {guide.steps.length} step{guide.steps.length === 1 ? '' : 's'} · {guide.minutes} min
        </span>
      </span>
    </button>
  );
};

const ReleaseSection: React.FC<{
  release: Release;
  unseen: boolean;
  onOpenGuide: (id: string) => void;
  onRead: (version: string) => void;
  scrollTo: boolean;
}> = ({ release, unseen, onOpenGuide, onRead, scrollTo }) => {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    if (scrollTo) ref.current?.scrollIntoView({ block: 'start' });
  }, [scrollTo]);

  useEffect(() => {
    if (!unseen || !ref.current) return;
    // Reading a release's section on this page is what counts as having seen it.
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onRead(release.version);
      },
      { threshold: 0.25 }
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [onRead, release.version, unseen]);

  const linked = new Set(release.slides.flatMap((slide) => (slide.guide ? [slide.guide] : [])));
  const extras = release.guides.filter((id) => !linked.has(id));

  return (
    <section className="wn-release" id={`wn-${release.version}`} ref={ref}>
      <header>
        <h2>{release.version}</h2>
        <span className="wn-date">{release.date}</span>
        {unseen ? <span className="wn-badge">New to you</span> : null}
      </header>
      {release.slides.map((slide) => (
        <article className="wn-feature" key={slide.title}>
          <ReleaseShot owner={release.version} image={slide.image} anchor={slide.anchor} />
          <h3>{slide.title}</h3>
          <p>{slide.body}</p>
          {slide.guide ? (
            <p className="wn-slide-more">
              <button type="button" className="wn-link" onClick={() => onOpenGuide(slide.guide as string)}>
                Open the guide →
              </button>
            </p>
          ) : null}
        </article>
      ))}
      {extras.length > 0 ? (
        <div className="wn-guides">
          <h4>More guides</h4>
          <div className="wn-guide-list">
            {extras.map((id) => (
              <GuideCard key={id} id={id} onOpen={onOpenGuide} />
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
};

/** Every release's notes, newest first, with the guides they offer (ADR 0059). */
export const WhatsNewScreen: React.FC<{
  /** A version to open the page at. */
  scrollTo?: string;
  onOpenGuide: (id: string) => void;
}> = ({ scrollTo, onOpenGuide }) => {
  const state = useWhatsNew();
  const releases = state?.releases ?? [];
  const unread = (version: string) => state?.unread(version) ?? false;

  return (
    <div className="wn-page">
      <div className="wn-page-col">
        <div className="wn-page-head">
          <div>
            <h1>What’s new</h1>
            <p className="wn-sub">Every release, newest first.</p>
          </div>
          {state ? (
            <label className="wn-switch">
              Show new releases on launch
              <button
                type="button"
                role="switch"
                aria-checked={state.popups}
                aria-label="Show new releases on launch"
                onClick={() => state.setPopups(!state.popups)}
              />
            </label>
          ) : null}
        </div>
        {releases.length === 0 ? (
          <p className="wn-empty">No release notes yet.</p>
        ) : (
          releases.map((release) => (
            <ReleaseSection
              key={release.version}
              release={release}
              unseen={unread(release.version)}
              onOpenGuide={onOpenGuide}
              onRead={(version) => state?.markSeen(version)}
              scrollTo={scrollTo === release.version}
            />
          ))
        )}
      </div>
      {releases.length > 0 ? (
        <nav className="wn-index" aria-label="Releases">
          <h5>Releases</h5>
          {releases.map((release) => (
            <button
              key={release.version}
              type="button"
              onClick={() =>
                document.getElementById(`wn-${release.version}`)?.scrollIntoView({ block: 'start' })
              }
            >
              {unread(release.version) ? <span className="wn-pip" aria-hidden="true" /> : null}
              {shortVersion(release.version)}
            </button>
          ))}
        </nav>
      ) : null}
    </div>
  );
};
