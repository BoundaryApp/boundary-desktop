import React, { useState } from 'react';
import { loadGuide } from './content';
import { ReleaseShot } from './ReleaseShot';
import { Button } from '../../components/ui/button';
import './whatsNew.css';

/**
 * A feature walkthrough: one step at a time, each a screenshot with numbered markers on the
 * parts the step talks about (ADR 0059). Hovering a marker or its line highlights the pair.
 */
export const GuideScreen: React.FC<{ guideId: string; onBack: () => void }> = ({ guideId, onBack }) => {
  const guide = loadGuide(guideId);
  const [at, setAt] = useState(0);
  const [hot, setHot] = useState<number | null>(null);

  if (!guide || guide.steps.length === 0) {
    return (
      <div className="wn-guide">
        <p className="wn-empty">That guide isn’t in this build.</p>
      </div>
    );
  }

  const step = guide.steps[Math.min(at, guide.steps.length - 1)];
  const last = at === guide.steps.length - 1;
  const markers = step.callouts.map((callout, index) => ({ anchor: callout.anchor, n: index + 1 }));

  return (
    <div className="wn-guide">
      <aside>
        <button type="button" className="wn-guide-back" onClick={onBack}>
          ← What’s new
        </button>
        <h2>{guide.title}</h2>
        <p className="wn-guide-meta">
          {guide.steps.length} step{guide.steps.length === 1 ? '' : 's'} · {guide.minutes} min
        </p>
        <div className="wn-guide-steps">
          {guide.steps.map((item, index) => (
            <button
              key={item.title}
              type="button"
              aria-current={index === at ? 'step' : undefined}
              className={index < at ? 'is-done' : undefined}
              onClick={() => {
                setAt(index);
                setHot(null);
              }}
            >
              <span className="wn-step-n">{index < at ? '✓' : index + 1}</span>
              {item.title}
            </button>
          ))}
        </div>
      </aside>

      <div className="wn-guide-step">
        <div className="wn-guide-col">
          <p className="wn-guide-kicker">
            Step {at + 1} of {guide.steps.length}
          </p>
          <h3>{step.title}</h3>
          <ReleaseShot
            owner={`guides/${guide.id}`}
            image={step.image}
            markers={markers}
            hot={hot}
            onHot={setHot}
            alt={`${guide.title}: ${step.title}`}
          />
          <ol className="wn-callouts">
            {step.callouts.map((callout, index) => (
              <li
                key={callout.anchor}
                className={hot === index + 1 ? 'is-hot' : undefined}
                onMouseEnter={() => setHot(index + 1)}
                onMouseLeave={() => setHot(null)}
              >
                <span className="wn-callout-n">{index + 1}</span>
                <span>{callout.text}</span>
              </li>
            ))}
          </ol>
          <div className="wn-guide-nav">
            <Button
              variant="quiet"
              type="button"
              disabled={at === 0}
              onClick={() => {
                setAt(at - 1);
                setHot(null);
              }}
            >
              Back
            </Button>
            <Button
              variant="primary"
              block
              type="button"
              onClick={() => {
                if (last) onBack();
                else {
                  setAt(at + 1);
                  setHot(null);
                }
              }}
            >
              {last ? 'Done' : 'Next step'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};
