import React, { useEffect, useState } from 'react';
import type { CircleSharing, CircleSnapshot, CirclesState } from '../../../shared/types/circles';
import type { InferenceProvidersStatus, ListedModel } from '../../../shared/types/onboarding';
import { Button } from '../../components/ui/button';
import { InfoTip } from '../../components/ui/info-tip';
import { useInferenceStatus } from '../../onboarding/inferenceStatus';
import { dispatchAppCommand } from '../useAppShortcuts';
import { CircleButton, CircleSwitch } from './CircleControls';
import { SharingUsage } from './CircleUsage';
import { useAction, useCirclesState } from './useCircles';
import { APP_NAME } from '../../../shared/buildIdentity';

/**
 * Sharing the local model server with Circles (ADR 0034 §1, §4), on the Circles screen. Models,
 * pause and away mode apply to every Circle, so they sit in one panel on Sharing, with a switch
 * per Circle; each Circle's page has the same switch as a shortcut. Each change saves at once; main publishes the offers and points the
 * gateway at the local server. Settings shows a status line that links here.
 */

interface SharingView {
  /** Circles the user has joined and is sharing with. */
  sharedCircles: CircleSnapshot[];
  sharingAny: boolean;
  /** Why members can't use the shared models now; null when they can, or nothing is shared. */
  blocked: string | null;
  /** The fix for `blocked` is the local model in Inference. */
  fixInSettings: boolean;
}

function sharingView(circles: CirclesState, status: InferenceProvidersStatus | null): SharingView {
  const { sharing } = circles;
  const sharedCircles = circles.snapshot.circles.filter((circle) => sharing.circles.includes(circle.key));
  const sharingAny = sharing.models.length > 0 && sharedCircles.length > 0;
  const view: SharingView = { sharedCircles, sharingAny, blocked: null, fixInSettings: false };
  if (!sharingAny) return view;
  if (sharing.paused) return { ...view, blocked: "Paused: members can't use your models" };
  // Offers stay published in these two cases; the gateway refuses or the request fails.
  const local = status?.slots?.local;
  if (status && !local) {
    return { ...view, blocked: "No local model server: members can't use your models", fixInSettings: true };
  }
  if (local?.health === 'unreachable') {
    return {
      ...view,
      blocked: "Your local model server isn't responding: members can't use your models",
      fixInSettings: true,
    };
  }
  if (circles.status !== 'running') return { ...view, blocked: "Circles aren't connected: members can't use your models" };
  return view;
}

function useSharingView(circles: CirclesState): SharingView {
  return sharingView(circles, useInferenceStatus().status);
}

/** A local server is answering, or there are choices to change or a warning to show without one. */
function canShare(circles: CirclesState, status: InferenceProvidersStatus | null): boolean {
  const local = status?.slots?.local;
  if (local && local.health !== 'unreachable') return true;
  const { sharing, snapshot } = circles;
  return sharing.models.length > 0 || snapshot.circles.some((circle) => sharing.circles.includes(circle.key));
}

/** Members can't use the user's models now, whatever screen the user is on. */
export function useSharingAttention(): boolean {
  const view = sharingView(useCirclesState(), useInferenceStatus().status);
  return view.blocked !== null;
}

const openModelSources = (): void => dispatchAppCommand('go-inference');

function formatContext(tokens: number | undefined): string {
  if (!tokens) return '';
  return tokens >= 1024 ? `${Math.round(tokens / 1024)}K context` : `${tokens} tokens`;
}

function circleNames(circles: CircleSnapshot[]): string {
  return circles.map((circle) => circle.name).join(', ');
}

/** The next step for someone not sharing yet. */
function startHint(sharing: CircleSharing, hasLocal: boolean, circles: CircleSnapshot[]): string {
  if (!hasLocal) return 'Connect a local model server in Settings to share it with your Circles.';
  if (sharing.models.length > 0) return 'Turn on a Circle below so its members can use your models.';
  if (circles.length > 0) return `Choose a model so members of ${circleNames(circles)} can use it.`;
  return "You aren't sharing a model. Choose one here, then turn on a Circle below.";
}

export const CircleSharingPanel: React.FC<{ circles: CirclesState }> = ({ circles }) => {
  const { status } = useInferenceStatus();
  const view = sharingView(circles, status);
  const [serverModels, setServerModels] = useState<ListedModel[]>([]);
  const action = useAction();
  const local = status?.slots?.local;
  const endpoint = local?.endpointUrl;

  useEffect(() => {
    if (!endpoint) {
      setServerModels([]);
      return;
    }
    let live = true;
    // The selected model stands in if the server doesn't answer.
    void window.electronAPI.onboarding
      .listConfiguredEndpointModels({ slot: 'local' })
      .then((result) => {
        if (live && result.success) setServerModels(result.models);
      })
      .catch((): void => undefined);
    return () => {
      live = false;
    };
  }, [endpoint]);

  if (!circles.snapshot.circles.length || !canShare(circles, status)) return null;

  const { sharing } = circles;
  const { sharedCircles, sharingAny, blocked, fixInSettings } = view;
  const sharedIds = new Set(sharing.models.map((model) => model.id));
  const models: ListedModel[] = serverModels.length > 0 ? serverModels : local?.modelId ? [{ id: local.modelId }] : [];
  // A shared model the server no longer lists stays visible, so it can be turned off.
  const listed = [
    ...models,
    ...sharing.models.filter((model) => !models.some((candidate) => candidate.id === model.id)),
  ];
  // While the status loads, assume a server rather than flash the connect prompt.
  const hasLocal = !status || Boolean(local);

  const save = (next: CircleSharing): void => {
    void action.run(() => window.electronAPI.circles.setSharing(next));
  };

  const toggleModel = (model: ListedModel): void =>
    save({
      ...sharing,
      models: sharedIds.has(model.id)
        ? sharing.models.filter((shared) => shared.id !== model.id)
        : [...sharing.models, { id: model.id, tools: true, ...(model.contextLength ? { contextLength: model.contextLength } : {}) }],
    });

  const awayDetail = !sharing.away
    ? `Off: members can't use your models while this Mac sleeps. Turn on to keep it awake while ${APP_NAME} is open.`
    : sharing.paused
      ? `On, but this Mac can sleep while sharing is paused. Only works while ${APP_NAME} is open.`
      : `This Mac stays awake so members can use your models while you're away. Only while ${APP_NAME} is open.`;

  return (
    <section aria-label="Shared from this Mac" role="group" className="flex flex-col gap-3">
      <h2 className="flex items-center gap-1.5 text-title font-medium text-fg">
        Shared from this Mac
        <InfoTip label="sharing with Circles">
          Members can put your models in their chats. Their prompts reach your model server, and your
          model&apos;s replies drive their agent. {APP_NAME} keeps only who asked, which model, token counts and timings.
          Requests run one at a time.
        </InfoTip>
      </h2>

      {sharingAny ? (
        <>
          <div role={blocked ? 'alert' : undefined} className={`wb-circle-banner ${blocked ? 'is-warn' : 'is-ok'}`}>
            <span className="min-w-0 flex-1">
              {blocked
                ? `${blocked}.`
                : `Members of ${circleNames(sharedCircles)} can use ${
                    sharing.models.length === 1 ? 'this model' : `these ${sharing.models.length} models`
                  } while ${APP_NAME} is open.`}
            </span>
            {fixInSettings ? (
              <CircleButton size="row" variant="outline" onClick={openModelSources}>
                Open Inference
              </CircleButton>
            ) : null}
            <CircleButton
              size="row"
              variant="outline"
              disabled={action.busy}
              onClick={() => save({ ...sharing, paused: !sharing.paused })}
            >
              {sharing.paused ? 'Resume sharing' : 'Pause sharing'}
            </CircleButton>
          </div>
          {sharing.paused ? (
            <p className="text-xs text-fg-faint">Your choices are kept. While paused, members&apos; chats move on to their next model.</p>
          ) : null}
        </>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 text-ui text-fg-muted">{startHint(sharing, hasLocal, sharedCircles)}</p>
          {!hasLocal ? (
            <Button size="sm" variant="outline" onClick={openModelSources}>
              Open Inference
            </Button>
          ) : null}
        </div>
      )}
      {!sharingAny && circles.status !== 'running' ? (
        <p className="text-xs text-fg-faint">Circles aren&apos;t connected. Changes go out when they are.</p>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        {listed.length > 0 ? (
          <fieldset className="wb-circle-box" disabled={action.busy}>
            <legend>Models on your server</legend>
            {listed.map((model) => (
              <label key={model.id} className="flex items-center gap-2 py-[3px]">
                <input type="checkbox" checked={sharedIds.has(model.id)} onChange={() => toggleModel(model)} />
                <span className="min-w-0 flex-1 font-mono text-xs break-all text-fg">{model.id}</span>
                {model.contextLength ? <small className="text-xs text-fg-faint">{formatContext(model.contextLength)}</small> : null}
              </label>
            ))}
          </fieldset>
        ) : null}

        <fieldset className="wb-circle-box" disabled={action.busy}>
          <legend>Shared with</legend>
          {circles.snapshot.circles.map((circle) => {
            const on = sharing.circles.includes(circle.key);
            const name = circle.name || 'this Circle';
            return (
              <div key={circle.key} className="flex items-center gap-2 py-[3px]">
                <span className="min-w-0 flex-1 text-ui text-fg">{name}</span>
                <CircleSwitch
                  label={`Share with ${name}`}
                  on={on}
                  disabled={action.busy}
                  onToggle={() =>
                    save({
                      ...sharing,
                      circles: on ? sharing.circles.filter((key) => key !== circle.key) : [...sharing.circles, circle.key],
                    })
                  }
                />
              </div>
            );
          })}
          {sharingAny ? (
            <div className="mt-1.5 flex items-center gap-2 border-t border-line pt-2">
              <span className="flex min-w-0 flex-1 flex-col text-ui text-fg">
                Away mode
                <small className="text-xs text-fg-faint">{awayDetail}</small>
              </span>
              <CircleSwitch
                label="Away mode"
                on={sharing.away}
                disabled={action.busy}
                onToggle={() => save({ ...sharing, away: !sharing.away })}
              />
            </div>
          ) : null}
        </fieldset>
      </div>
      {sharingAny ? <SharingUsage circles={circles} /> : null}
      {action.error ? <p className="text-xs text-danger">{action.error}</p> : null}
    </section>
  );
};

/** Sharing's state in the Local card; the controls are in Inference. */
export function CircleSharingLine({ circles }: { circles: CirclesState }) {
  const { sharedCircles, sharingAny, blocked } = useSharingView(circles);
  const text = !circles.snapshot.circles.length
    ? 'Not sharing. Create or join a Circle to share this model.'
    : !sharingAny
      ? 'Not sharing with your Circles.'
      : blocked
        ? `${blocked}.`
        : `Shared with ${circleNames(sharedCircles)}${circles.sharing.away ? ', with away mode on' : ''}.`;
  // The sharing controls sit below the model sources in Inference, so the line needs no link.
  return (
    <div className="wb-share-line">
      <p className="wb-share-status">{text}</p>
    </div>
  );
}
