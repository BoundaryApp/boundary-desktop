import React, { useEffect, useState } from 'react';
import { formatDayAndTime } from '../../../shared/messageTime';
import {
  DETECTOR_MIN_WORDS,
  DETECTOR_PROVIDER_NAMES,
  detectorWordCount,
  type DetectorScore as Score,
  type DetectorSegment,
  type DetectorStatus,
} from '../../../shared/types/writingCheck';
import { DETECTED_SCORE } from './writingCheckView';
import { Button } from '../../components/ui/button';

/**
 * The detector add-on's score in the Check pane (writing check spec, phase 5). Shown only when
 * the add-on answers; the first send to each provider waits for the user to agree, after saying
 * what leaves the Mac. The score is the provider's own number and is never shown without it.
 */

type Step =
  | { kind: 'idle' }
  | { kind: 'confirm' }
  | { kind: 'running' }
  | { kind: 'done'; score: Score }
  | { kind: 'error'; message: string };

export interface Detector {
  status: DetectorStatus;
  step: Step;
  segments: readonly DetectorSegment[];
  request: () => void;
  agree: () => void;
  cancel: () => void;
}

const NO_SEGMENTS: DetectorSegment[] = [];

export function useDetector(markdown: string): Detector {
  const [status, setStatus] = useState<DetectorStatus>({ available: false });
  const [step, setStep] = useState<Step>({ kind: 'idle' });

  useEffect(() => {
    let live = true;
    void window.electronAPI.writingCheck
      .detectorStatus()
      .then((next) => live && setStatus(next))
      .catch((): void => undefined);
    return () => {
      live = false;
    };
  }, []);

  const send = async () => {
    setStep({ kind: 'running' });
    const result = await window.electronAPI.writingCheck.checkWithDetector({ text: markdown });
    if ('score' in result) {
      setStep({ kind: 'done', score: result.score });
      return;
    }
    const wait = result.error.retryAfter ? ` Try again in ${result.error.retryAfter} s.` : '';
    setStep({ kind: 'error', message: `${result.error.message}${wait}` });
  };

  return {
    status,
    step,
    segments: step.kind === 'done' ? step.score.segments : NO_SEGMENTS,
    request: () => {
      if (!status.available) return;
      if (status.consented) void send();
      else setStep({ kind: 'confirm' });
    },
    agree: () => {
      if (!status.available) return;
      setStatus({ ...status, consented: true });
      void window.electronAPI.writingCheck.agreeToDetector({ provider: status.provider });
      void send();
    },
    cancel: () => setStep({ kind: 'idle' }),
  };
}

export const DetectorSection: React.FC<{ detector: Detector; markdown: string }> = ({
  detector,
  markdown,
}) => {
  const { status, step } = detector;
  if (!status.available) return null;
  const name = DETECTOR_PROVIDER_NAMES[status.provider];
  const tooShort = detectorWordCount(markdown) < DETECTOR_MIN_WORDS;

  if (step.kind === 'confirm') {
    return (
      <div className="wb-check-detector" role="group" aria-label="Send to a detector">
        <p className="wb-check-detector-leaves">{status.dataLeaves}</p>
        <div className="wb-insp-actions">
          <Button variant="secondary" size="sm" type="button" onClick={detector.agree}>
            Send to {name}
          </Button>
          <Button variant="secondary" size="sm" type="button" onClick={detector.cancel}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  if (step.kind === 'done') {
    const { score } = step;
    const meta = [score.model ? `model ${score.model}` : null, `checked ${formatDayAndTime(Date.parse(score.checkedAt))}`]
      .filter(Boolean)
      .join(' · ');
    return (
      <div className="wb-check-detector" data-testid="detector-result">
        <div className="wb-check-detector-score">
          {DETECTOR_PROVIDER_NAMES[score.provider]}
          {score.label ? `: ${score.label}` : ''} · score {score.score.toFixed(2)}
        </div>
        <div className="wb-check-rate">{meta}</div>
        <p className="wb-insp-note">
          {DETECTOR_PROVIDER_NAMES[score.provider]}’s own score, not comparable with other detectors.
          {score.segments.some((s) => s.score >= DETECTED_SCORE)
            ? ` Dotted underlines mark passages it scored ${DETECTED_SCORE} or higher.`
            : ''}
        </p>
      </div>
    );
  }

  return (
    <div className="wb-check-detector">
      {step.kind === 'error' ? (
        <p className="wb-insp-note wb-check-error" role="alert">
          {step.message}
        </p>
      ) : null}
      <div className="wb-insp-actions">
        <Button
          variant="secondary"
          size="sm"
          type="button"
          disabled={tooShort || step.kind === 'running'}
          onClick={detector.request}
        >
          {step.kind === 'error' ? 'Try again' : 'Get detector score'}
        </Button>
      </div>
      <p className="wb-insp-note">
        {step.kind === 'running'
          ? `Asking ${name}…`
          : tooShort
            ? `${name} needs ${DETECTOR_MIN_WORDS} words or more.`
            : `Sends this text to ${name} under your account.`}
      </p>
    </div>
  );
};
