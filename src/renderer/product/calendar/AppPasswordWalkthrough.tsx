import React, { useEffect, useRef, useState } from 'react';
import { APP_NAME } from '../../../shared/buildIdentity';
import { APP_PASSWORD_SLIDES } from './appPasswordSlides';
import { APP_SPECIFIC, APP_SPECIFIC_FORMAT_WARNING } from './appSpecificPassword';
import { Button } from '../../components/ui/button';

export interface AppPasswordWalkthroughProps {
  initialPassword?: string;
  onDone: (password: string) => void;
  onClose: () => void;
  /** Shows a way out for people who would rather use the calendars on this Mac. */
  onUseMac?: () => void;
  /** The id the sheet's dialog points at for its name; the slide heading carries it while the walkthrough shows. */
  titleId?: string;
}

const APPLE_ACCOUNT_URL = 'https://account.apple.com/';

/** Five slides that lead to an iCloud app-specific password. Escape closes; Done returns the paste. */
export function AppPasswordWalkthrough({ initialPassword = '', onDone, onClose, onUseMac, titleId }: AppPasswordWalkthroughProps) {
  const [index, setIndex] = useState(0);
  const [password, setPassword] = useState(initialPassword);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const last = APP_PASSWORD_SLIDES.length - 1;
  const slide = APP_PASSWORD_SLIDES[index];

  useEffect(() => {
    headingRef.current?.focus();
  }, [index]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // Consumed like the other popovers: the Sheet around us ignores a prevented Escape.
        event.preventDefault();
        onClose();
        return;
      }
      // Arrow keys move the caret inside the password field.
      if ((event.target as HTMLElement | null)?.tagName === 'INPUT') return;
      if (event.key === 'ArrowRight') setIndex((i) => Math.min(i + 1, last));
      else if (event.key === 'ArrowLeft') setIndex((i) => Math.max(i - 1, 0));
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, last]);

  const trimmed = password.trim();
  const badFormat = trimmed.length > 0 && !APP_SPECIFIC.test(trimmed);

  return (
    <section className="wb-cal-walk" aria-label={`Make an app-specific password for ${APP_NAME}`}>
      {onUseMac && (
        <Button variant="secondary" block type="button" className="wb-cal-walk-mac" onClick={onUseMac}>
          Rather not make a password? Use Calendars on this Mac
        </Button>
      )}
      {slide.picture}
      <h3 id={titleId} ref={headingRef} tabIndex={-1} className="wb-cal-walk-title">
        {slide.title}
      </h3>
      <p className="wb-cal-walk-body">{slide.body}</p>

      {slide.id === 'open' && (
        <Button variant="primary" block type="button" onClick={() => void window.electronAPI.urls.openUrl(APPLE_ACCOUNT_URL)}>
          Open account.apple.com
        </Button>
      )}

      {slide.id === 'paste' && (
        <div className="wb-cal-walk-field">
          <label htmlFor="wb-cal-walk-password">App-specific password</label>
          <input
            id="wb-cal-walk-password"
            className="wb-input"
            value={password}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setPassword(event.target.value)}
          />
          {badFormat && (
            <p className="wb-cal-walk-warn" role="alert">
              {APP_SPECIFIC_FORMAT_WARNING}
            </p>
          )}
        </div>
      )}

      <div className="wb-cal-walk-nav">
        <div className="wb-cal-walk-dots" aria-hidden="true">
          {APP_PASSWORD_SLIDES.map((s, i) => (
            <span key={s.id} className="wb-cal-walk-dot" data-active={i === index} />
          ))}
        </div>
        <span className="wb-cal-walk-count">
          Step {index + 1} of {APP_PASSWORD_SLIDES.length}
        </span>
        <Button variant="secondary" block type="button" disabled={index === 0} onClick={() => setIndex(index - 1)}>
          Back
        </Button>
        {index < last ? (
          <Button variant="primary" block type="button" onClick={() => setIndex(index + 1)}>
            Next
          </Button>
        ) : (
          <Button variant="primary" block type="button" onClick={() => onDone(trimmed)}>
            Done
          </Button>
        )}
      </div>
    </section>
  );
}
