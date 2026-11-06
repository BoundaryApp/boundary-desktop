import React, { useState } from 'react';
import type { InferenceChainEntry, InferenceStack, InferenceStackEntry } from '../../../shared/types/inferenceChain';
import type { CirclesState } from '../../../shared/types/circles';
import type { LlmSlotStatus } from '../../../shared/types/onboarding';
import { Sheet } from '../../components/ui/sheet';
import { ProviderClaims } from '../circles/PersonPanel';
import { describeChainEntry, entryKey, type ChainContext, type ChainEntryView } from './entries';
import { entryState, moveEntry, skipReason, type DryRunStep } from './stack';
import './inference.css';

/**
 * One model stack drawn as numbered rungs on a spine (settings spec decision 3), at any level:
 * the app's Chat stack in Inference, a project's stack in its inspector, a chat's own from the
 * composer chip. Each level passes its list, how its entries are described, and how it saves.
 */

export function formatContext(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}K` : String(tokens);
}

/** Who stands behind an entry, for "Trust Maya" and the skip reasons. */
function providerName(entry: InferenceChainEntry, circles: CirclesState): string {
  if (entry.slot === 'local') return 'Your local model';
  if (entry.slot === 'openrouter') return 'OpenRouter';
  const identity = entry.peer?.providerId;
  for (const circle of circles.snapshot.circles) {
    const named =
      circle.offers.find((offer) => offer.identity === identity)?.name ??
      circle.members.find((member) => member.identity === identity)?.name;
    if (named) return named;
  }
  return 'This member';
}

export interface Rung {
  entry: InferenceChainEntry;
  view: ChainEntryView;
  state: InferenceStackEntry | null;
  slot: LlmSlotStatus | undefined;
  reason: string | null;
}

/** Each entry with its label, its state from `described`, and why it's skipped now. */
export function buildRungs(entries: InferenceChainEntry[], ctx: ChainContext, described: InferenceStack | null): Rung[] {
  return entries.map((entry, index) => {
    const view = describeChainEntry(entry, ctx, index === 0 ? 'first' : 'fallback');
    const state = entryState(described, entry);
    const slot = entry.slot === 'peer' ? undefined : ctx.slots[entry.slot];
    return { entry, view, state, slot, reason: skipReason(state, slot, providerName(entry, ctx.circles)) };
  });
}

/** The inline fix for a skipped entry, when the user can make it here (settings spec decision 9). */
function rungFix(
  rung: Rung,
  circles: CirclesState,
  showSources: () => void
): { label: string; run: () => void } | null {
  const { entry, state, slot } = rung;
  if (state?.stale === 'provider-untrusted' && entry.peer) {
    const identity = entry.peer.providerId;
    const settings = circles.providers[identity] ?? { private: false, trusted: false };
    return {
      label: `Trust ${providerName(entry, circles)}`,
      run: () => void window.electronAPI.circles.setProviderSettings({ identity, ...settings, trusted: true }),
    };
  }
  if (entry.slot !== 'peer' && slot?.health === 'unauthorized') {
    return { label: 'Sign in again', run: showSources };
  }
  return null;
}

const OUTCOME_CLASS: Record<DryRunStep['outcome'], string> = {
  answers: ' is-answers',
  skipped: ' is-passed',
  private: ' is-unreached',
  unreached: ' is-unreached',
};

function stepLine(step: DryRunStep): string {
  if (step.outcome === 'answers') return 'Answers now';
  if (step.outcome === 'skipped') return step.reason;
  if (step.outcome === 'private') return 'A private project stops before this';
  return 'If the one above fails';
}

export interface StackListProps {
  /** The stored order, which moves act on. */
  list: InferenceChainEntry[];
  /** The rungs as drawn, first to last; Inference draws an app switch's target first. */
  rungs: Rung[];
  circles: CirclesState;
  described: InferenceStack | null;
  /** A save or switch is running: nothing moves. */
  locked: boolean;
  selected: string | null;
  onSelect: (key: string) => void;
  onChange: (next: InferenceChainEntry[]) => void;
  onAdd: () => void;
  /** False while adding can't help, such as when the list's first entry can't be saved. */
  canAdd?: boolean;
  /** Where connecting and signing in happen for this level. */
  showSources: () => void;
  /** Why the level can't save a list, or null; a move that would make one is disabled. */
  refuses?: (next: InferenceChainEntry[]) => string | null;
  /** Draw where a private project's request stops. Off for a level the lock doesn't reach. */
  privacyLine?: boolean;
  steps?: DryRunStep[];
  /** Drawn under a rung, such as an app switch's progress. */
  afterRung?: (index: number) => React.ReactNode;
}

export const StackList: React.FC<StackListProps> = ({
  list,
  rungs,
  circles,
  described,
  locked,
  selected,
  onSelect,
  onChange,
  onAdd,
  canAdd = true,
  showSources,
  refuses = () => null,
  privacyLine = true,
  steps,
  afterRung,
}) => {
  const lastPrivate = rungs.reduce((at, rung, index) => (rung.state && !rung.state.privateCut ? index : at), -1);
  const showCut = (index: number) => privacyLine && index === lastPrivate && index < rungs.length - 1;
  const canMove = (index: number, delta: -1 | 1) => {
    const next = moveEntry(list, index, delta);
    return next !== list && refuses(next) === null;
  };
  return (
    <div className="wb-inf-stack">
      <div className="wb-inf-spine" aria-hidden="true" />
      {privacyLine && described?.noPrivate ? (
        <div className="wb-inf-pline is-top">No private model. Private projects can’t send.</div>
      ) : null}
      <ol aria-label="Model stack, first to last">
        {rungs.map((rung, index) => {
          const key = entryKey(rung.entry);
          const step = steps?.[index];
          const fix = rungFix(rung, circles, showSources);
          return (
            <li key={key}>
              <div className={`wb-inf-rung${selected === key ? ' is-selected' : ''}${step ? OUTCOME_CLASS[step.outcome] : ''}`}>
                <button type="button" className="wb-inf-open" onClick={() => onSelect(key)}>
                  <span className="wb-inf-num">{index + 1}</span>
                  <span className="wb-inf-row-text">
                    <b>{rung.view.label}</b>
                    <span>{step ? stepLine(step) : rung.view.detail}</span>
                  </span>
                </button>
                {fix ? (
                  <button type="button" className="wb-btn-ghost wb-inf-fix" onClick={fix.run}>
                    {fix.label}
                  </button>
                ) : (
                  <span className={`wb-inf-status${rung.reason ? ' is-warn' : ' is-ok'}`}>{rung.reason ?? 'Ready'}</span>
                )}
                <span className="wb-inf-acts">
                  <button
                    type="button"
                    className="wb-inf-ico"
                    aria-label={`Move ${rung.view.label} up`}
                    disabled={locked || !canMove(index, -1)}
                    onClick={() => onChange(moveEntry(list, index, -1))}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="wb-inf-ico"
                    aria-label={`Move ${rung.view.label} down`}
                    disabled={locked || !canMove(index, 1)}
                    onClick={() => onChange(moveEntry(list, index, 1))}
                  >
                    ↓
                  </button>
                </span>
              </div>
              {afterRung?.(index)}
              {showCut(index) ? <div className="wb-inf-pline">Private projects stop here</div> : null}
            </li>
          );
        })}
      </ol>
      <button type="button" className="wb-inf-add" disabled={locked || !canAdd} onClick={onAdd}>
        <span className="wb-inf-num" aria-hidden="true">+</span>Add model
      </button>
      <div className="wb-inf-endcap">
        <span className="wb-inf-num" aria-hidden="true">
          –
        </span>
        If none answer, the chat stops and says why
      </div>
    </div>
  );
};

/** The details of one entry (settings spec decision 9): beside the stack, or under it in a sheet. */
export function EntryDetails({
  rung,
  circles,
  canRemove,
  onRemove,
  onClose,
  showSources,
}: {
  rung: Rung;
  circles: CirclesState;
  canRemove: boolean;
  onRemove: () => void;
  onClose: () => void;
  showSources: () => void;
}) {
  const { entry, view, state, slot, reason } = rung;
  const [test, setTest] = useState<{ busy: boolean; result: string | null }>({ busy: false, result: null });
  const source =
    entry.slot === 'local' ? 'This Mac' : entry.slot === 'openrouter' ? 'OpenRouter, in the cloud' : view.detail.split('.')[0];
  const runTest = async () => {
    if (entry.slot === 'peer') return;
    setTest({ busy: true, result: null });
    const started = performance.now();
    const result = await window.electronAPI.onboarding
      .sendLlmTestMessage({ slot: entry.slot, message: 'Reply with the word ready.' })
      .catch((err: unknown) => ({ success: false as const, error: err instanceof Error ? err.message : 'Test failed.' }));
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    setTest({ busy: false, result: result.success ? `Replied in ${seconds}s` : (result.error ?? 'Test failed.') });
  };
  return (
    <aside className="wb-inf-side" aria-label="Model details">
      <div className="wb-inf-side-head">
        <h2>{view.label}</h2>
        <button type="button" className="wb-inf-ico" aria-label="Close details" onClick={onClose}>
          ×
        </button>
      </div>
      <dl className="wb-inf-kv">
        <dt>Source</dt>
        <dd>{source}</dd>
        <dt>Context</dt>
        <dd>{state?.contextLength ? formatContext(state.contextLength) : 'Unknown'}</dd>
        <dt>Status</dt>
        <dd>{reason ?? 'Ready'}</dd>
        <dt>Private projects</dt>
        <dd>{state?.private ? 'Can use it' : 'Never sent here'}</dd>
      </dl>
      <div className="wb-inf-bar">
        {entry.slot !== 'peer' ? (
          <button type="button" className="wb-btn-ghost" disabled={test.busy || !slot?.configured} onClick={() => void runTest()}>
            {test.busy ? 'Testing…' : 'Test'}
          </button>
        ) : null}
        <button type="button" className="wb-btn-ghost is-danger" disabled={!canRemove} onClick={onRemove}>
          Remove from stack
        </button>
      </div>
      {test.result ? (
        <p className="wb-inf-note" role="status">
          {test.result}
        </p>
      ) : null}
      {entry.slot !== 'peer' ? (
        <>
          <p className="wb-inf-kick">{entry.slot === 'local' ? 'Model and runtime' : 'Account'}</p>
          <p className="wb-inf-note">
            {entry.slot === 'local' ? (slot?.modelId ?? 'No model chosen') : slot?.configured ? 'Signed in' : 'Not connected'}
          </p>
          <button type="button" className="wb-btn-ghost" onClick={showSources}>
            Manage
          </button>
        </>
      ) : entry.peer ? (
        <div className="wb-inf-claims">
          <ProviderClaims identity={entry.peer.providerId} name={providerName(entry, circles)} circles={circles} />
        </div>
      ) : null}
    </aside>
  );
}

/** The models a level could add, each with an Add button. */
export function AddModelList({
  candidates,
  onAdd,
}: {
  candidates: ChainEntryView[];
  onAdd: (entry: InferenceChainEntry) => void;
}) {
  if (candidates.length === 0) {
    return (
      <p className="wb-sheet-help">
        Every connected model is already in the stack. Connect another under Model sources, or use one a Circle shares.
      </p>
    );
  }
  return (
    <ul className="wb-inf-rows" aria-label="Models you can add">
      {candidates.map((view) => (
        <li key={entryKey(view.entry)} className="wb-inf-row">
          <span className="wb-inf-row-text">
            <b>{view.label}</b>
            <span>{view.detail}</span>
          </span>
          <button type="button" className="wb-btn-ghost" onClick={() => onAdd(view.entry)}>
            Add
          </button>
        </li>
      ))}
    </ul>
  );
}

export function AddModelSheet({
  candidates,
  onAdd,
  onClose,
}: {
  candidates: ChainEntryView[];
  onAdd: (entry: InferenceChainEntry) => void;
  onClose: () => void;
}) {
  return (
    <Sheet open onClose={onClose} titleId="inference-add" title="Add a model">
      <AddModelList candidates={candidates} onAdd={onAdd} />
    </Sheet>
  );
}
