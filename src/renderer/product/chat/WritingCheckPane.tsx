import React, { useMemo, useState } from 'react';
import type { Category } from '../../../shared/writingCheck/rules';
import { formatDayAndTime } from '../../../shared/messageTime';
import { cachedCheck, checkedBlocks } from './writingCheckView';
import { DetectorSection, useDetector } from './DetectorScore';
import './writingCheck.css';

/** A project file the pane checked (writing check spec, phase 4). */
export interface CheckedFile {
  projectId: string;
  relativePath: string;
  modifiedAt: string;
}

/** Text sent to the inspector's Check tab: a reply, a selection or a project file. */
export interface WritingCheckRequest {
  /** Increases with every Check press, so a new press reopens the tab. */
  seq: number;
  /** The message for Show in chat; empty for a file. */
  messageId: string;
  markdown: string;
  /** What was checked, for the pane's header: "Reply · Today 11:42", or a file's path. */
  source: string;
  file?: CheckedFile;
  /** Why the text couldn't be read, shown instead of a result. */
  error?: string;
}

const CATEGORY_LABELS: Record<Category, string> = {
  words: 'Words',
  shapes: 'Shapes',
  framing: 'Framing',
  rhythm: 'Rhythm',
  formatting: 'Formatting',
};

const CATEGORY_ORDER = Object.keys(CATEGORY_LABELS) as Category[];

function countLabel(count: number): string {
  if (count === 0) return 'No flags';
  return count === 1 ? '1 flag' : `${count} flags`;
}

function rateLabel(perHundredWords: number | null, words: number): string {
  if (perHundredWords == null) return `Too short for a rate · ${words} words`;
  const rate = Number(perHundredWords.toFixed(1));
  return `${rate} per 100 words · ${words} words`;
}

export const WritingCheckPane: React.FC<{
  check: WritingCheckRequest;
  onClose: () => void;
  onShowReply: (messageId: string) => void;
  onRecheckFile: (file: CheckedFile) => void;
}> = ({ check, onClose, onShowReply, onRecheckFile }) => {
  const result = useMemo(() => cachedCheck(check.markdown), [check.markdown]);
  return (
    <div className="wb-insp-pane wb-check">
      <div className="wb-insp-ident">
        <span>
          <span className="who-name">Writing check</span>
          <span className="who-meta">
            <span className={check.file ? 'wb-check-path mono' : undefined}>{check.source}</span>
            {check.file ? (
              <span className="wb-check-file-meta">
                {check.error ? null : (
                  <>
                    <span>{`modified ${formatDayAndTime(Date.parse(check.file.modifiedAt))}`}</span>
                    {' · '}
                  </>
                )}
                <button
                  type="button"
                  className="wb-check-link"
                  onClick={() => check.file && onRecheckFile(check.file)}
                >
                  Check again
                </button>
              </span>
            ) : (
              <>
                {' · '}
                <button
                  type="button"
                  className="wb-check-link"
                  onClick={() => onShowReply(check.messageId)}
                >
                  Show in chat
                </button>
              </>
            )}
          </span>
        </span>
        <button type="button" className="wb-check-close" aria-label="Close check" onClick={onClose}>
          ×
        </button>
      </div>

      {check.error ? (
        <p className="wb-insp-note wb-check-error" role="alert">
          {check.error}
        </p>
      ) : (
        <CheckResults key={check.seq} markdown={check.markdown} result={result} />
      )}
    </div>
  );
};

const CheckResults: React.FC<{
  markdown: string;
  result: ReturnType<typeof cachedCheck>;
}> = ({ markdown, result }) => {
  const detector = useDetector(markdown);
  const blocks = useMemo(
    () => checkedBlocks(markdown, result, detector.segments),
    [markdown, result, detector.segments]
  );
  const [hidden, setHidden] = useState<ReadonlySet<Category>>(new Set());
  const [focused, setFocused] = useState<number[] | null>(null);

  const counts = new Map<Category, number>();
  for (const flag of result.flags) counts.set(flag.category, (counts.get(flag.category) ?? 0) + 1);
  const shown = (index: number) => !hidden.has(result.flags[index].category);
  const toggle = (category: Category) =>
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  const focusedFlags = (focused ?? []).filter(shown).map((index) => result.flags[index]);

  return (
    <>
      <div className="wb-check-summary">
        <div className="wb-check-count" data-testid="check-count">
          {countLabel(result.flags.length)}
        </div>
        <div className="wb-check-rate">{rateLabel(result.perHundredWords, result.words)}</div>
      </div>
      <p className="wb-insp-note">
        Flags mark patterns common in model output. They don’t say who wrote the text: careful
        human writing trips some, and edited model text can pass. Code and quotes aren’t checked.
      </p>
      <DetectorSection detector={detector} markdown={markdown} />

      {counts.size > 0 ? (
        <>
          <div className="wb-check-filters" role="group" aria-label="Show categories">
            {CATEGORY_ORDER.filter((c) => counts.has(c)).map((category) => (
              <button
                key={category}
                type="button"
                className="wb-check-filter"
                aria-pressed={!hidden.has(category)}
                onClick={() => toggle(category)}
              >
                {CATEGORY_LABELS[category]} {counts.get(category)}
              </button>
            ))}
          </div>
          <div className="wb-check-detail" data-testid="check-detail" aria-live="polite">
            {focusedFlags.length === 0 ? (
              <span className="wb-check-hint">Point at or focus a highlight to see why it’s flagged.</span>
            ) : (
              focusedFlags.map((flag) => (
                <span key={`${flag.rule}:${flag.start}`} className="wb-check-reason">
                  <b>
                    {flag.title}
                    {flag.pattern !== undefined ? ` · pattern ${flag.pattern}` : ''}
                  </b>
                  <span>{flag.reason}</span>
                </span>
              ))
            )}
          </div>
        </>
      ) : null}

      <div className="wb-check-prose" data-guide-anchor="writing-check">
        {blocks.map((block, b) => (
          <p key={b} className={`is-${block.kind}`}>
            {block.runs.map((run, r) => {
              const flags = run.flags.filter(shown);
              if (flags.length === 0) {
                return run.detected ? (
                  <span key={r} className="is-detected">
                    {run.text}
                  </span>
                ) : (
                  <React.Fragment key={r}>{run.text}</React.Fragment>
                );
              }
              const active = focused !== null && flags.some((f) => focused.includes(f));
              const classes = [active ? 'is-active' : '', run.detected ? 'is-detected' : ''].filter(Boolean);
              return (
                <mark
                  key={r}
                  tabIndex={0}
                  className={classes.length ? classes.join(' ') : undefined}
                  title={flags.map((f) => result.flags[f].title).join(' · ')}
                  onMouseEnter={() => setFocused(flags)}
                  onFocus={() => setFocused(flags)}
                >
                  {run.text}
                </mark>
              );
            })}
          </p>
        ))}
      </div>
    </>
  );
};
