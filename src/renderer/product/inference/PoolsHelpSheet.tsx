import React from 'react';
import type { TrustLevel } from '../../../shared/types/confidential';
import { Button } from '../../components/ui/button';
import { Sheet } from '../../components/ui/sheet';
import { CONFIDENTIAL_COPY } from './confidentialCopy';
import { LevelBadge } from './LevelBadge';

const LEVELS: TrustLevel[] = ['A', 'B', 'C'];

/** What pools do, in plain words (ADR 0047 decision 10). Opened from the card and Pool settings. */
export const PoolsHelpSheet: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
  const copy = CONFIDENTIAL_COPY.help;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      titleId="pools-help-title"
      backdropClassName="wb-conf-backdrop"
      title={copy.title}
      actions={<Button onClick={onClose}>Done</Button>}
    >
      {copy.sections.map((section, index) => (
        <section key={section.heading ?? index}>
          {section.heading ? <h3>{section.heading}</h3> : null}
          {section.levels ? (
            <ul className="wb-conf-rows">
              {LEVELS.map((level) => (
                <li key={level} className="wb-conf-row">
                  <LevelBadge level={level} />
                  <span className="wb-inf-row-text">
                    <b>{CONFIDENTIAL_COPY.levels[level].name}</b>
                    <span>{CONFIDENTIAL_COPY.levels[level].text}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {section.paragraphs.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
        </section>
      ))}
    </Sheet>
  );
};
