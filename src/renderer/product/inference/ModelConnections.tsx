import React, { useCallback, useEffect, useState } from 'react';
import type {
  DiscoveredLocalLlm,
  InferenceSlotId,
  ListedModel,
  LlmSlotHealth,
  LlmSlotStatus,
} from '../../../shared/types/onboarding';
import { InfoTip } from '../../components/ui/info-tip';
import { ModelPicker } from '../../onboarding/ModelPicker';
import { takeInferenceStatus, useInferenceStatus } from '../../onboarding/inferenceStatus';
import { useAppSwitch } from '../../onboarding/appSwitch';
import {
  adoptLocalLlm,
  connectionFromCredentials,
  keepOrFirstModel,
  testSlot,
  useOAuthSignIn,
} from '../../onboarding/modelConnection';
import { cloudInferenceNotice, cloudKeyLimitTip } from '../cloudInferenceCopy';
import { CircleSharingLine } from '../circles/CircleSharingPanel';
import { useCirclesState } from '../circles/useCircles';
import { Callout, LoadingBlock } from '../../components/ui/alert';
import { ConfidentialProviders } from './ConfidentialProviders';
import { RepliesAtOnceRow } from './RepliesAtOnce';
import { Button } from '../../components/ui/button';

function formatLastSeen(iso?: string): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const minutes = Math.max(1, Math.round((Date.now() - then) / 60_000));
  if (minutes < 60) return `Last seen ${minutes} minute${minutes === 1 ? '' : 's'} ago.`;
  const hours = Math.round(minutes / 60);
  return `Last seen ${hours} hour${hours === 1 ? '' : 's'} ago.`;
}

function slotHealth(slot: LlmSlotStatus | undefined): LlmSlotHealth {
  return slot?.health ?? 'unknown';
}

function localPill(slot: LlmSlotStatus | undefined): { label: string; tone: string } {
  if (!slot) return { label: 'Not set', tone: '' };
  const health = slotHealth(slot);
  if (health === 'unreachable') return { label: 'Unreachable', tone: 'is-warn' };
  if (health === 'reachable') return { label: 'Reachable', tone: 'is-ok' };
  return { label: 'Connected', tone: 'is-ok' };
}

function openRouterPill(
  slot: LlmSlotStatus | undefined,
  keySaved: boolean
): { label: string; tone: string } {
  if (!slot) return { label: keySaved ? 'Disconnected' : 'Not set', tone: '' };
  const health = slotHealth(slot);
  if (health === 'unauthorized') return { label: 'Unauthorized', tone: 'is-bad' };
  if (health === 'reachable') return { label: 'Connected', tone: 'is-ok' };
  if (health === 'unreachable') return { label: 'Unreachable', tone: 'is-warn' };
  return { label: 'Connected', tone: 'is-ok' };
}

function dotClass(slot: LlmSlotStatus | undefined, kind: 'local' | 'openrouter'): string {
  if (!slot) return 'is-off';
  const health = slotHealth(slot);
  if (kind === 'local' && health === 'unreachable') return 'is-warn';
  if (kind === 'openrouter' && health === 'unauthorized') return 'is-bad';
  if (health === 'reachable' || slot.configured) return 'is-ok';
  return 'is-off';
}

/**
 * Where models come from: a runtime on this Mac and OpenRouter, each connected, tested, given its
 * model and disconnected here (settings spec phase 3). Order and fallbacks are the stack's.
 */
export const ModelConnections: React.FC<{
  /** Passed to the Confidential providers card: a new value opens its add sheet. */
  addProviderRequest?: number;
}> = ({ addProviderRequest }) => {
  const [localModels, setLocalModels] = useState<ListedModel[]>([]);
  const [openRouterModels, setOpenRouterModels] = useState<ListedModel[]>([]);
  const [discovered, setDiscovered] = useState<DiscoveredLocalLlm[]>([]);
  const [selectedLocalModel, setSelectedLocalModel] = useState('');
  const [selectedOpenRouterModel, setSelectedOpenRouterModel] = useState('');
  const [working, setBusy] = useState(false);
  const { appSwitch } = useAppSwitch();
  // A switch runs in main and outlives this screen, so it holds the buttons from its own state.
  const busy = working || appSwitch !== null;
  const circles = useCirclesState();
  // `connecting` is true while main waits for the browser to return from OpenRouter sign-in.
  const {
    connecting: openRouterSigningIn,
    signIn: signInToOpenRouter,
    cancel: handleCancelOpenRouterSignIn,
  } = useOAuthSignIn('openrouter');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Save model feedback shows beside the picker; the page-level banner is out of view below it.
  const [modelSaveFeedback, setModelSaveFeedback] = useState<{
    slot: 'local' | 'openrouter';
    tone: 'ok' | 'bad';
    text: string;
  } | null>(null);
  const [testBySlot, setTestBySlot] = useState<Partial<Record<InferenceSlotId, string>>>({});
  const { status, error: statusError } = useInferenceStatus();
  const loading = status === null;

  // Follow the saved model when it changes (a save here, or setup), not on every probe answer,
  // so an unsaved pick stays put.
  const savedLocalModel = status?.slots.local?.modelId;
  const savedOpenRouterModel = status?.slots.openrouter?.modelId;
  useEffect(() => {
    if (savedLocalModel) setSelectedLocalModel(savedLocalModel);
  }, [savedLocalModel]);
  useEffect(() => {
    if (savedOpenRouterModel) setSelectedOpenRouterModel(savedOpenRouterModel);
  }, [savedOpenRouterModel]);

  const probe = useCallback(async (slot: InferenceSlotId) => {
    const result = await window.electronAPI.onboarding.probeSlotHealth({ slot });
    if (result.status) void takeInferenceStatus(result);
    return result;
  }, []);

  const refreshModels = useCallback(async (slot: 'local' | 'openrouter') => {
    const result = await window.electronAPI.onboarding.listConfiguredEndpointModels({ slot });
    if (!result.success) {
      setError(result.error ?? 'Unable to refresh models.');
      return;
    }
    if (slot === 'local') {
      setLocalModels(result.models);
      setSelectedLocalModel((current) =>
        result.models.some((model) => model.id === current)
          ? current
          : result.models[0]?.id ?? current
      );
    } else {
      setOpenRouterModels(result.models);
      setSelectedOpenRouterModel((current) =>
        result.models.some((model) => model.id === current)
          ? current
          : result.models[0]?.id ?? current
      );
    }
  }, []);

  useEffect(() => {
    if (!status) return;
    if (status.slots?.local) {
      void probe('local');
      void refreshModels('local');
    }
    if (status.slots?.openrouter) {
      void probe('openrouter');
      void refreshModels('openrouter');
    }
    // Probe once after the first status load.
  }, [status?.slots.local?.endpointUrl, status?.slots.openrouter?.endpointUrl]);

  const handleScan = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await window.electronAPI.onboarding.discoverLocalLlms();
      if (!result.success) {
        setError(result.error ?? 'Scan failed.');
        return;
      }
      setDiscovered(result.endpoints);
      if (result.endpoints.length === 0) {
        setNotice('No local runtime found. Start Ollama or LM Studio and scan again.');
      }
    } finally {
      setBusy(false);
    }
  };

  const handleAdoptLocal = async (endpoint: DiscoveredLocalLlm, modelId: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await adoptLocalLlm(endpoint, modelId);
      if (!result.success) {
        setError(result.error ?? 'Unable to use this local endpoint.');
        return;
      }
      await takeInferenceStatus(result);
      setDiscovered([]);
      setNotice('Local runtime connected. The assistant restarts if this is the app default.');
    } finally {
      setBusy(false);
    }
  };

  const handleConnectOpenRouter = async () => {
    setBusy(true);
    setError(null);
    try {
      const signedIn = await signInToOpenRouter();
      if (!signedIn || signedIn.kind === 'cancelled') return;
      if (signedIn.kind === 'failed') {
        setError(signedIn.error ?? 'OpenRouter sign-in failed.');
        return;
      }
      const { credentials } = signedIn;
      const listed = await window.electronAPI.onboarding.listEndpointModels({
        baseUrl: credentials.endpointUrl,
        authScheme: credentials.authScheme,
        provider: credentials.providerId,
        extraHeaders: credentials.extraHeaders,
      });
      const keep = selectedOpenRouterModel || status?.savedOpenRouterKey?.modelId;
      const modelId = keepOrFirstModel(listed.models, keep);
      if (!modelId) {
        setError('No models available after connect.');
        return;
      }
      const saved = await window.electronAPI.onboarding.saveLlmConnection(
        connectionFromCredentials(credentials, modelId, { slot: 'openrouter' })
      );
      if (!saved.success) {
        setError(saved.error ?? 'Unable to save OpenRouter.');
        return;
      }
      await takeInferenceStatus(saved);
      setOpenRouterModels(listed.models);
      setSelectedOpenRouterModel(modelId);
      setNotice('OpenRouter connected. The assistant restarts only if this is the app default.');
    } finally {
      setBusy(false);
    }
  };

  const handleSaveModel = async (slot: 'local' | 'openrouter', modelId: string) => {
    if (!modelId) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    setModelSaveFeedback(null);
    try {
      const result = await window.electronAPI.onboarding.updateLlmModel({ slot, modelId });
      if (!result.success) {
        setModelSaveFeedback({
          slot,
          tone: 'bad',
          text: result.error ?? 'Unable to update model.',
        });
        return;
      }
      await takeInferenceStatus(result);
      setModelSaveFeedback({
        slot,
        tone: 'ok',
        text:
          status?.appDefault === slot
            ? 'Model saved. Chats using this provider switch on their next message.'
            : 'Model saved. Chats and projects set to this provider switch on their next message.',
      });
    } finally {
      setBusy(false);
    }
  };

  const renderModelSaveFeedback = (slot: 'local' | 'openrouter') =>
    modelSaveFeedback?.slot === slot ? (
      <p
        role={modelSaveFeedback.tone === 'bad' ? 'alert' : 'status'}
        className={`wb-inference-note${modelSaveFeedback.tone === 'bad' ? ' is-bad' : ''}`}
      >
        {modelSaveFeedback.text}
      </p>
    ) : null;

  const selectModel = (slot: 'local' | 'openrouter', modelId: string) => {
    if (modelSaveFeedback?.slot === slot) setModelSaveFeedback(null);
    if (slot === 'local') setSelectedLocalModel(modelId);
    else setSelectedOpenRouterModel(modelId);
  };

  const handleTest = async (slot: InferenceSlotId) => {
    setBusy(true);
    setError(null);
    try {
      const result = await testSlot(slot);
      if (!result.success) {
        setError(result.error ?? 'Test message failed.');
        return;
      }
      setTestBySlot((current) => ({ ...current, [slot]: result.content ?? 'ready' }));
    } finally {
      setBusy(false);
    }
  };

  const handleDisconnect = async (slot: InferenceSlotId) => {
    setBusy(true);
    setError(null);
    try {
      const result = await window.electronAPI.onboarding.clearLlmSlot({ slot });
      if (!result.success) {
        setError(result.error ?? 'Unable to disconnect.');
        return;
      }
      await takeInferenceStatus(result);
      if (slot === 'local') {
        setLocalModels([]);
        setSelectedLocalModel('');
      } else {
        setOpenRouterModels([]);
        setSelectedOpenRouterModel('');
        setNotice('OpenRouter disconnected. Its key stays saved on this Mac until you remove it.');
      }
      setTestBySlot((current) => ({ ...current, [slot]: undefined }));
    } finally {
      setBusy(false);
    }
  };

  const handleReconnectSavedKey = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await window.electronAPI.onboarding.reconnectSavedOpenRouterKey();
      await takeInferenceStatus(result);
      if (!result.success) {
        setError(result.error ?? 'Unable to reconnect OpenRouter.');
        return;
      }
      setNotice('OpenRouter reconnected with the saved key.');
    } finally {
      setBusy(false);
    }
  };

  const handleForgetSavedKey = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await window.electronAPI.onboarding.forgetSavedOpenRouterKey();
      await takeInferenceStatus(result);
      if (!result.success) {
        setError(result.error ?? 'Unable to remove the saved key.');
        return;
      }
      setNotice('Saved OpenRouter key removed from this Mac. It stays active at OpenRouter.');
    } finally {
      setBusy(false);
    }
  };

  const local = status?.slots?.local;
  const openrouter = status?.slots?.openrouter;
  const infrastructure = status?.slots?.infrastructure;
  const localHealth = slotHealth(local);
  const openRouterHealth = slotHealth(openrouter);
  const localMeta = localPill(local);
  const savedOpenRouterKey = openrouter ? undefined : status?.savedOpenRouterKey;
  const openRouterMeta = openRouterPill(openrouter, Boolean(savedOpenRouterKey));

  return (
    <section className="wb-inf-connections" aria-label="Model sources">
          {local && localHealth === 'unreachable' && (
            <Callout variant="warn" layout="row" size="sm" className="wb-inference-callout" role={undefined}>
              <p>
                {local.providerDisplayName ?? 'Local'} isn’t reachable
                {local.endpointUrl ? ` at ${local.endpointUrl}` : ''}.
              </p>
              <Button variant="secondary" type="button" onClick={() => void probe('local')}>
                Retry
              </Button>
            </Callout>
          )}
          {openrouter && openRouterHealth === 'unauthorized' && (
            <Callout variant="destructive" layout="row" size="sm" className="wb-inference-callout" role={undefined}>
              <p>OpenRouter no longer accepts the saved key.</p>
              <Button
                variant="secondary"
                type="button"
                onClick={() => void handleConnectOpenRouter()}
              >
                Sign in again
              </Button>
            </Callout>
          )}
          {openRouterSigningIn && (
            <Callout layout="row" size="sm" className="wb-inference-callout" role="status">
              <p>Waiting for OpenRouter sign-in to finish in your browser.</p>
              <Button variant="secondary" type="button" onClick={handleCancelOpenRouterSignIn}>
                Cancel
              </Button>
            </Callout>
          )}

          {loading ? (
            <LoadingBlock />
          ) : (
              <div className="wb-inference-cards">
                <article className="wb-inference-card">
                  <div className="hed">
                    <span className={`wb-inference-dot ${dotClass(local, 'local')}`} />
                    <h3>Local</h3>
                    <span className={`wb-inference-pill ${localMeta.tone}`}>{localMeta.label}</span>
                  </div>
                  {!local ? (
                    <div className="wb-inference-empty">
                      <p>Finds Ollama and LM Studio on this Mac.</p>
                      <div className="wb-inference-actions">
                        <Button
                          variant={openrouter ? 'secondary' : 'primary'}
                          type="button"
                          disabled={busy}
                          onClick={() => void handleScan()}
                        >
                          Scan this machine
                        </Button>
                      </div>
                      {discovered.map((endpoint) => (
                        <div key={`${endpoint.runtime}:${endpoint.baseUrl}`} className="mt-3">
                          <p>
                            {endpoint.displayName} · <span className="mono">{endpoint.baseUrl}</span>
                          </p>
                          {endpoint.models.map((model) => (
                            <Button
                              variant="secondary"
                              key={model.id}
                              type="button"
                              disabled={busy}
                              title={model.id}
                              className="max-w-full"
                              onClick={() => void handleAdoptLocal(endpoint, model.id)}
                            >
                              <span className="truncate">
                                Use {model.id}
                                {model.loaded ? ' (loaded)' : ' (not loaded)'}
                              </span>
                            </Button>
                          ))}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <>
                      <dl>
                        <div className="wb-inference-meta">
                          <dt>Runtime</dt>
                          <dd>{local.providerDisplayName ?? local.provider ?? 'Local'}</dd>
                        </div>
                        <div className="wb-inference-meta">
                          <dt>Endpoint</dt>
                          <dd className="mono">{local.endpointUrl}</dd>
                        </div>
                        <div className="wb-inference-meta">
                          <dt>Selected</dt>
                          <dd>{local.modelId ?? 'None'}</dd>
                        </div>
                        {localHealth !== 'unreachable' ? (
                          <RepliesAtOnceRow endpointUrl={local.endpointUrl} modelId={local.modelId} />
                        ) : null}
                      </dl>
                      {localHealth === 'unreachable' && (
                        <p className="wb-inference-empty" style={{ marginTop: 10 }}>
                          {formatLastSeen(local.lastSeenAt) ?? 'Models stay listed from the last successful scan.'}
                        </p>
                      )}
                      {local.capabilities?.modelChangePolicy === 'selectable' && localHealth !== 'unreachable' && (
                        <div className="mt-3">
                          <ModelPicker
                            models={
                              localModels.length > 0
                                ? localModels
                                : local.modelId
                                  ? [{ id: local.modelId }]
                                  : []
                            }
                            selectedModelId={selectedLocalModel}
                            onSelect={(modelId) => selectModel('local', modelId)}
                            onRefresh={() => void refreshModels('local')}
                            label="Local model"
                          />
                          <div className="wb-inference-actions">
                            <Button
                              variant="secondary"
                              type="button"
                              disabled={busy || selectedLocalModel === local.modelId}
                              onClick={() => void handleSaveModel('local', selectedLocalModel)}
                            >
                              Save model
                            </Button>
                          </div>
                          {renderModelSaveFeedback('local')}
                        </div>
                      )}
                      <div className="wb-inference-actions">
                        {localHealth === 'unreachable' ? (
                          <Button
                            variant="secondary"
                            type="button"
                            disabled={busy}
                            onClick={() => void probe('local')}
                          >
                            Retry
                          </Button>
                        ) : (
                          <Button
                            variant="secondary"
                            type="button"
                            disabled={busy}
                            onClick={() => void handleTest('local')}
                          >
                            Test
                          </Button>
                        )}
                        <Button
                          variant="secondary"
                          type="button"
                          disabled={busy}
                          onClick={() => void handleDisconnect('local')}
                        >
                          Disconnect
                        </Button>
                      </div>
                      {testBySlot.local && <p className="wb-inference-note">{testBySlot.local}</p>}
                      <CircleSharingLine circles={circles} />
                    </>
                  )}
                </article>

                <ConfidentialProviders addRequest={addProviderRequest} />

                <article className="wb-inference-card">
                  <div className="hed">
                    <span className={`wb-inference-dot ${dotClass(openrouter, 'openrouter')}`} />
                    <h3>OpenRouter</h3>
                    {openrouter ? (
                      <InfoTip label="OpenRouter">
                        <p>{cloudInferenceNotice('OpenRouter')}</p>
                        <p>{cloudKeyLimitTip('OpenRouter')}</p>
                      </InfoTip>
                    ) : null}
                    <span className={`wb-inference-pill ${openRouterMeta.tone}`}>
                      {openRouterMeta.label}
                    </span>
                  </div>
                  {!openrouter ? (
                    <div className="wb-inference-empty">
                      {savedOpenRouterKey ? (
                        <p>
                          Disconnected. Your key
                          {savedOpenRouterKey.preview ? ` (${savedOpenRouterKey.preview})` : ''} is saved
                          on this Mac and unused until you reconnect.
                        </p>
                      ) : null}
                      <p className="wb-inference-cloud">{cloudInferenceNotice('OpenRouter')}</p>
                      <div className="wb-inference-actions">
                        {savedOpenRouterKey ? (
                          <>
                            <Button
                              variant="primary"
                              type="button"
                              disabled={busy}
                              onClick={() => void handleReconnectSavedKey()}
                            >
                              Reconnect
                            </Button>
                            <Button
                              variant="secondary"
                              type="button"
                              disabled={busy}
                              onClick={() => void handleConnectOpenRouter()}
                            >
                              Sign in again
                            </Button>
                            <Button
                              variant="secondary"
                              type="button"
                              disabled={busy}
                              onClick={() => void handleForgetSavedKey()}
                            >
                              Remove saved key
                            </Button>
                          </>
                        ) : (
                          <Button
                            variant={local ? 'secondary' : 'primary'}
                            type="button"
                            disabled={busy}
                            onClick={() => void handleConnectOpenRouter()}
                          >
                            Connect OpenRouter
                          </Button>
                        )}
                      </div>
                    </div>
                  ) : (
                    <>
                      <dl>
                        <div className="wb-inference-meta">
                          <dt>Key</dt>
                          <dd className="mono">{openrouter.apiKey?.preview ?? 'stored'}</dd>
                        </div>
                        <div className="wb-inference-meta">
                          <dt>Selected</dt>
                          <dd>{openrouter.modelId ?? 'None'}</dd>
                        </div>
                      </dl>
                      {openRouterHealth === 'unauthorized' && (
                        <p className="wb-inference-empty" style={{ marginTop: 10 }}>
                          Model list is from the last successful refresh. Sends will fail until reconnect.
                        </p>
                      )}
                      {openrouter.capabilities?.modelChangePolicy === 'selectable' &&
                        openRouterHealth !== 'unauthorized' && (
                          <div className="mt-3">
                            <ModelPicker
                              models={
                                openRouterModels.length > 0
                                  ? openRouterModels
                                  : openrouter.modelId
                                    ? [{ id: openrouter.modelId }]
                                    : []
                              }
                              selectedModelId={selectedOpenRouterModel}
                              onSelect={(modelId) => selectModel('openrouter', modelId)}
                              onRefresh={() => void refreshModels('openrouter')}
                              label="OpenRouter model"
                              filterable
                              savedModelId={openrouter.modelId ?? ''}
                              summaryAction={
                                selectedOpenRouterModel !== openrouter.modelId ||
                                modelSaveFeedback?.slot === 'openrouter' ? (
                                  <>
                                    {selectedOpenRouterModel !== openrouter.modelId && (
                                      <Button
                                        variant="primary"
                                        type="button"
                                        disabled={busy}
                                        onClick={() =>
                                          void handleSaveModel('openrouter', selectedOpenRouterModel)
                                        }
                                      >
                                        {busy ? 'Checking model…' : 'Save model'}
                                      </Button>
                                    )}
                                    {renderModelSaveFeedback('openrouter')}
                                  </>
                                ) : null
                              }
                            />
                          </div>
                        )}
                      <div className="wb-inference-actions">
                        {openRouterHealth === 'unauthorized' ? (
                          <Button
                            variant="primary"
                            type="button"
                            disabled={busy}
                            onClick={() => void handleConnectOpenRouter()}
                          >
                            Reconnect OpenRouter
                          </Button>
                        ) : (
                          <>
                            <Button
                              variant="secondary"
                              type="button"
                              disabled={busy}
                              onClick={() => void handleTest('openrouter')}
                            >
                              Test
                            </Button>
                            <Button
                              variant="secondary"
                              type="button"
                              disabled={busy}
                              onClick={() => void handleConnectOpenRouter()}
                            >
                              Reconnect
                            </Button>
                          </>
                        )}
                        <Button
                          variant="secondary"
                          type="button"
                          disabled={busy}
                          onClick={() => void handleDisconnect('openrouter')}
                        >
                          Disconnect
                        </Button>
                      </div>
                      {testBySlot.openrouter && (
                        <p className="wb-inference-note">{testBySlot.openrouter}</p>
                      )}
                    </>
                  )}
                </article>
              </div>
          )}
                {status?.appDefault === 'infrastructure' && infrastructure && (
                  <p className="wb-inference-note">
                    Assistant is using your existing {infrastructure.providerDisplayName ?? 'GPU'}{' '}
                    endpoint.
                  </p>
                )}
          {notice && <p className="wb-inference-note">{notice}</p>}
          {(error ?? statusError) && (
            <Callout variant="destructive" layout="row" size="sm" className="wb-inference-callout is-after" role={undefined}>
              <p>{error ?? statusError}</p>
            </Callout>
          )}
    </section>
  );
};
