import React, { useState } from 'react';
import { isVisibleChatProvider } from '../../../shared/inferenceDisplay';
import type { TrustLevel } from '../../../shared/types/confidential';
import type { InferenceChainEntry } from '../../../shared/types/inferenceChain';
import { Sheet } from '../../components/ui/sheet';
import { useInferenceStatus } from '../../onboarding/inferenceStatus';
import { useCirclesState } from '../circles/useCircles';
import { chainCandidates, entryKey, type ChainContext } from './entries';
import { openInference } from './inferenceNavigation';
import { describeStackHere, levelRefuses, removeEntry } from './stack';
import { AddModelList, buildRungs, EntryDetails, StackList } from './StackList';
import { poolContext, usePoolPrivacy, usePoolRankings, useConfidentialState } from './useConfidentialState';
import { Button } from '../../components/ui/button';

export interface LevelStackSheetProps {
  /** Distinguishes this sheet's heading from another open one. */
  titleId: string;
  kicker: string;
  title: string;
  /** One line under the title: what the stack applies to. */
  lede: string;
  /** The level's stack as it resolves now, first to last. */
  initial: InferenceChainEntry[];
  /** The level belongs to a private project, so the lock cuts its stack (ADR 0033 §4). */
  privacyLocked: boolean;
  /**
   * The lowest provider level this private project's pools may use, as main plans it
   * (`projectConfidentialFloor`). Pools rank with it; without it, Pool settings' private minimum.
   */
  projectFloor?: TrustLevel;
  /** Store the list at this level. Resolves to an error to show, or null when saved. */
  save: (list: InferenceChainEntry[]) => Promise<string | null>;
  onClose: () => void;
}

/**
 * A chat's or project's own stack, edited in a sheet over the screen it was opened from with the
 * same list Inference draws (settings spec, Where each setting goes). Each change saves at once.
 * Main stores these levels with a provider first, so a shared model can only follow one.
 */
export const LevelStackSheet: React.FC<LevelStackSheetProps> = ({
  titleId,
  kicker,
  title,
  lede,
  initial,
  privacyLocked,
  projectFloor,
  save,
  onClose,
}) => {
  const { status } = useInferenceStatus();
  const circles = useCirclesState();
  const [list, setList] = useState(initial);
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { state: confidential } = useConfidentialState();
  const poolModels = confidential?.enabled === true ? confidential.models.map((model) => model.id) : [];
  const rankings = usePoolRankings(confidential, poolModels, {
    privateProject: privacyLocked,
    ...(privacyLocked && projectFloor ? { projectFloor } : {}),
  });
  const poolPrivacy = usePoolPrivacy(confidential, list, privacyLocked ? projectFloor : undefined);
  const ctx: ChainContext = { slots: status?.slots ?? {}, circles, pools: poolContext(confidential, rankings, poolPrivacy) };
  const described = describeStackHere(list, ctx);
  const rungs = buildRungs(list, ctx, described);
  const refuses = (next: InferenceChainEntry[]) => levelRefuses(next, { privacyLocked });
  const rule = list.length ? refuses(list) : null;
  const chosen = rungs.find((rung) => entryKey(rung.entry) === selected) ?? null;
  const showSources = () => {
    onClose();
    openInference();
  };

  const change = async (next: InferenceChainEntry[]) => {
    if (refuses(next)) return;
    const before = list;
    setList(next);
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const failed = await save(next).catch((err: unknown) =>
        err instanceof Error ? err.message : 'Unable to save the stack.'
      );
      if (failed) {
        setList(before);
        setError(failed);
      } else {
        setNotice('Saved. It applies to your next message.');
      }
    } finally {
      setBusy(false);
    }
  };

  const candidates = chainCandidates(list[0] ?? null, list.slice(1), ctx).filter(
    (view) => view.entry.slot === 'peer' || view.entry.slot === 'confidential' || isVisibleChatProvider(view.entry.slot)
  );

  return (
    <Sheet
      open
      onClose={onClose}
      busy={busy}
      titleId={titleId}
      kicker={kicker}
      title={title}
      className="wb-sheet-wide wb-inf-level"
      backdropClassName="wb-inf-level-backdrop"
      error={error}
      actions={
        <Button variant="secondary" block type="button" onClick={adding ? () => setAdding(false) : onClose}>
          {adding ? 'Back' : 'Done'}
        </Button>
      }
    >
      <p className="wb-sheet-help">{lede}</p>
      {adding ? (
        <AddModelList
          candidates={candidates}
          onAdd={(entry) => {
            setAdding(false);
            void change([...list, entry]);
          }}
        />
      ) : (
        <>
          <StackList
            list={list}
            rungs={rungs}
            circles={circles}
            described={described}
            locked={busy}
            canAdd={!rule}
            selected={selected}
            onSelect={setSelected}
            onChange={(next) => void change(next)}
            onAdd={() => setAdding(true)}
            showSources={showSources}
            refuses={refuses}
            privacyLine={privacyLocked}
          />
          {rule ? (
            <p className="wb-inf-note" role="status">
              {rule}
            </p>
          ) : notice ? (
            <p className="wb-inf-note" role="status">
              {notice}
            </p>
          ) : null}
          {chosen ? (
            <EntryDetails
              key={selected}
              rung={chosen}
              circles={circles}
              canRemove={!busy && list.length > 1 && !refuses(removeEntry(list, list.indexOf(chosen.entry)))}
              onRemove={() => {
                setSelected(null);
                void change(removeEntry(list, list.indexOf(chosen.entry)));
              }}
              onClose={() => setSelected(null)}
              showSources={showSources}
              privateProject={privacyLocked}
              projectFloor={privacyLocked ? projectFloor : undefined}
            />
          ) : null}
        </>
      )}
    </Sheet>
  );
};
