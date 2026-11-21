import React, { useEffect, useState } from 'react';
import type { InferenceChainEntry } from '../../../shared/types/inferenceChain';
import type { CirclesState } from '../../../shared/types/circles';
import { formatTokenCount } from '../../../shared/utils/format';
import { AppSwitchProgress } from '../AppSwitchProgress';
import { useAppSwitch } from '../../onboarding/appSwitch';
import { Avatar } from '../circles/CircleControls';
import { offerProviders } from '../circles/CircleOffers';
import { CircleSharingPanel } from '../circles/CircleSharingPanel';
import { personEntries, ProviderClaims } from '../circles/PersonPanel';
import { YourUsage } from '../circles/CircleUsage';
import { chainCandidates, entryKey, type ChainContext } from './entries';
import { ModelConnections } from './ModelConnections';
import { dryRun, removeEntry, shownStack } from './stack';
import { AddModelSheet, buildRungs, EntryDetails, StackList } from './StackList';
import { useAppStack } from './useAppStack';
import { poolContext, usePoolRankings, useConfidentialState } from './useConfidentialState';
import { Button } from '../../components/ui/button';
import './inference.css';
import { Checkbox } from '../../components/ui/checkbox';

/** Model sources sit under the stack; connecting and signing in happen there. */
function showSources(): void {
  document.getElementById('inference-sources')?.scrollIntoView?.({ block: 'start' });
}

/** Every model the user's Circles offer, by person, with what the user accepts from them (ADR 0043 §2). */
function FromYourCircles({
  circles,
  inStack,
  focused,
  onAdd,
}: {
  circles: CirclesState;
  inStack: Set<string>;
  focused: string | undefined;
  onAdd: (entry: InferenceChainEntry) => void;
}) {
  const people = [...offerProviders(circles)];
  if (people.length === 0) return <p className="wb-inf-note">Nobody in your Circles shares a model now.</p>;
  return (
    <div className="wb-inf-people">
      {people.map(([identity, name]) => {
        const offers = circles.snapshot.circles.flatMap((circle) =>
          circle.offers.filter((offer) => offer.identity === identity).map((offer) => ({ circle, offer }))
        );
        // Offline wins, as in the offer toasts: a paused provider who drops is just offline.
        const reach = offers.some(({ offer }) => offer.online && offer.available)
          ? 'Online'
          : offers.some(({ offer }) => offer.online)
            ? 'Not sharing now'
            : 'Offline';
        const where = [...new Set(offers.map(({ circle }) => circle.name))].join(', ');
        const trusted = circles.providers[identity]?.trusted === true;
        return (
          <section
            key={identity}
            id={`inference-person-${identity}`}
            className={`wb-inf-person${focused === identity ? ' is-focused' : ''}`}
            aria-label={name}
          >
            {personEntries(circles, identity).map((entry) => {
              const added = inStack.has(entryKey(entry));
              return (
                <div key={entryKey(entry)} className="wb-inf-person-head">
                  <Avatar name={name} seed={identity} />
                  <span className="wb-inf-row-text">
                    <b>
                      {name} · <span className="mono">{entry.modelId}</span>
                    </b>
                    <span>
                      Offered in {where} · {reach}
                    </span>
                  </span>
                  <Button
                    variant="secondary"
                    block
                    type="button"
                    disabled={added || !trusted}
                    title={!trusted ? `Trust ${name} first` : undefined}
                    onClick={() => onAdd(entry)}
                  >
                    {added ? 'In your stack' : 'Add to stack'}
                  </Button>
                </div>
              );
            })}
            <ProviderClaims identity={identity} name={name} circles={circles} />
            <YourUsage identity={identity} circles={circles} />
          </section>
        );
      })}
    </div>
  );
}

/**
 * Inference (settings spec phase 3, ADR 0043 §2): the Chat stack a request falls through, what
 * this Mac shares, and what the user's Circles offer.
 */
export const InferenceScreen: React.FC<{
  /** A link asked for this person's row; `seq` changes on each request, even for the same person. */
  focusPerson?: { person?: string; seq: number };
  /** Counts requests to open the Confidential providers add sheet; a new value opens it. */
  addProviderRequest?: number;
}> = ({ focusPerson, addProviderRequest }) => {
  const { status, circles, list, described, busy, error, notice, save } = useAppStack();
  const { appSwitch, error: switchError } = useAppSwitch();
  // During a switch the target shows first from the click, or the previous first while going back.
  const switchFirst = appSwitch ? (appSwitch.phase === 'reverting' ? appSwitch.previous : appSwitch.target) : null;
  const shown = shownStack(list, switchFirst);
  const locked = busy || appSwitch !== null;
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [privateProject, setPrivateProject] = useState(false);
  const [run, setRun] = useState<ReturnType<typeof dryRun> | null>(null);
  const focused = focusPerson?.person;
  const ready = circles.status === 'running';
  useEffect(() => {
    if (!focused || !ready) return;
    document.getElementById(`inference-person-${focused}`)?.scrollIntoView?.({ block: 'center' });
  }, [focused, focusPerson?.seq, ready]);
  const { state: confidential } = useConfidentialState();
  const poolModels = confidential?.enabled === true ? confidential.models.map((model) => model.id) : [];
  const rankings = usePoolRankings(confidential, poolModels, { privateProject: false });
  const ctx: ChainContext = { slots: status?.slots ?? {}, circles, pools: poolContext(confidential, rankings) };

  const rungs = buildRungs(shown, ctx, described);
  const change = (next: InferenceChainEntry[]) => {
    setRun(null);
    void save(next);
  };
  const chosen = rungs.find((rung) => entryKey(rung.entry) === selected) ?? null;
  const inCircle = circles.status === 'running' && circles.snapshot.circles.length > 0;
  const smallest = described?.contextLength;
  const contextOwner = rungs.find((rung) => rung.state?.contextLength === smallest && !rung.reason);

  return (
    <div className="wb-inf wb-reading">
      <div className="wb-inf-scroll">
        <div className="wb-inf-col">
          <h1 className="wb-inf-title">Inference</h1>
          <p className="wb-inf-lede">What answers your chats, what this Mac shares, and what your Circles offer.</p>

          <h2 className="wb-inf-sec">Chat stack</h2>
          {rungs.length === 0 ? (
            <div className="wb-inf-rows">
              <div className="wb-inf-row">
                <span className="wb-inf-row-text">
                  <b>Add your first model</b>
                  <span>Connect a model on this Mac or OpenRouter, or add one a Circle shares.</span>
                </span>
                <Button variant="secondary" block type="button" onClick={showSources}>
                  Connect
                </Button>
              </div>
            </div>
          ) : (
            <>
              <div className="wb-inf-try">
                <strong>Try a request</strong>
                <label className="wb-inf-check">
                  <Checkbox checked={privateProject} onChange={(event) => setPrivateProject(event.target.checked)} />
                  From a private project
                </label>
                <Button
                  variant="primary"
                  block
                  type="button"
                  onClick={() => setRun(dryRun(rungs, { privateProject }))}
                >
                  Run
                </Button>
                {run ? (
                  <p className={`wb-inf-verdict${run.answeredBy === null ? ' is-none' : ''}`} role="status">
                    {run.answeredBy === null
                      ? 'Nothing can answer. The chat stops and says why.'
                      : `Answered by ${rungs[run.answeredBy].view.label}.${run.answeredBy ? ` ${run.answeredBy} skipped.` : ''} Nothing was sent.`}
                  </p>
                ) : null}
              </div>

              <StackList
                list={list}
                rungs={rungs}
                circles={circles}
                described={described}
                locked={locked}
                selected={selected}
                onSelect={setSelected}
                onChange={change}
                onAdd={() => setAdding(true)}
                showSources={showSources}
                steps={run?.steps}
                afterRung={(index) =>
                  appSwitch && index === 0 ? <AppSwitchProgress appSwitch={appSwitch} /> : null
                }
              />
              {smallest && rungs.length > 1 ? (
                <p className="wb-inf-foot">
                  Replies are limited to {formatTokenCount(smallest)} of context
                  {contextOwner ? `, set by ${contextOwner.view.label}, the smallest here` : ''}.
                </p>
              ) : null}
            </>
          )}
          {(error ?? switchError) ? (
            <p className="wb-inf-error" role="alert">
              {error ?? switchError}
            </p>
          ) : notice ? (
            <p className="wb-inf-note" role="status">
              {notice}
            </p>
          ) : null}

          <h2 className="wb-inf-sec" id="inference-sources">
            Model sources
          </h2>
          <ModelConnections addProviderRequest={addProviderRequest} />

          {inCircle ? (
            <>
              {/* The panel carries its own Shared from this Mac heading. */}
              <div className="wb-inf-shared">
                <CircleSharingPanel circles={circles} />
              </div>
              <h2 className="wb-inf-sec">From your Circles</h2>
              <FromYourCircles
                circles={circles}
                inStack={new Set(list.map(entryKey))}
                focused={focused}
                onAdd={(entry) => change([...list, entry])}
              />
            </>
          ) : null}
        </div>
      </div>

      {chosen ? (
        <EntryDetails
          rung={chosen}
          circles={circles}
          canRemove={list.length > 1 && !locked}
          onRemove={() => {
            setSelected(null);
            change(removeEntry(list, list.findIndex((entry) => entryKey(entry) === selected)));
          }}
          onClose={() => setSelected(null)}
          showSources={showSources}
        />
      ) : null}

      {adding ? (
        <AddModelSheet
          candidates={chainCandidates(list[0] ?? null, list.slice(1), ctx)}
          onAdd={(entry) => {
            setAdding(false);
            change([...list, entry]);
          }}
          onClose={() => setAdding(false)}
        />
      ) : null}
    </div>
  );
};
