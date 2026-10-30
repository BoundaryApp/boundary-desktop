import React, { useCallback, useEffect, useRef, useState } from 'react';
import type {
  DiscoveredLocalLlm,
  InferenceSlotId,
  ListedModel,
  LlmSlotHealth,
  LlmSlotStatus,
} from '../../shared/types/onboarding';
import type { InferenceChainEntry } from '../../shared/types/inferenceChain';
import { Monitor, Moon, Sun } from 'lucide-react';
import { ModelPicker } from '../onboarding/ModelPicker';
import { Segmented } from '../components/ui/segmented';
import { InfoTip } from '../components/ui/info-tip';
import { useThemePreference } from '../theme';
import { takeInferenceStatus, useInferenceStatus } from '../onboarding/inferenceStatus';
import { cloudInferenceNotice, cloudKeyLimitTip } from './cloudInferenceCopy';
import { PasswordsLoginsPanel } from './PasswordsLoginsPanel';
import { CalendarsPanel } from './CalendarsPanel';
import { CodingFoldersPanel } from './CodingFoldersPanel';
import { AgentBrowserPanel } from './AgentBrowserPanel';
import { ComputerAccessPanel } from './ComputerAccessPanel';
import { ChainEditor } from './chat/ChainEditor';
import { CircleSharingPanel } from './circles/CircleSharingPanel';
import { useCirclesState } from './circles/useCircles';
import type { SettingsTab } from './settingsNavigation';
import { rendererExperiments } from '../experiments';

interface ProductSettingsScreenProps {
  onBack: () => void;
  /** Open on this tab instead of General (e.g. from a chat's saved-login note). */
  initialTab?: SettingsTab;
  /** Passwords & Logins: start on this agent's logins. */
  initialAgentSlug?: string;
  /** Calendars: start with the connect sheet open; closing it goes back to the chat. */
  connectCalendarFromChat?: boolean;
}

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

function openRouterPill(slot: LlmSlotStatus | undefined): { label: string; tone: string } {
  if (!slot) return { label: 'Not set', tone: '' };
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

const SETTINGS_TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: 'general', label: 'General' },
  { id: 'passwords', label: 'Passwords & Logins' },
  { id: 'calendars', label: 'Calendars' },
  { id: 'coding', label: 'Coding agent' },
  { id: 'browser', label: 'Agent browser' },
  { id: 'access', label: 'Computer access' },
];

export const ProductSettingsScreen: React.FC<ProductSettingsScreenProps> = ({
  onBack,
  initialTab,
  initialAgentSlug,
  connectCalendarFromChat,
}) => {
  const [themePreference, setThemePreference] = useThemePreference();
  const [tab, setTab] = useState<SettingsTab>(initialTab ?? 'general');
  const [localModels, setLocalModels] = useState<ListedModel[]>([]);
  const [openRouterModels, setOpenRouterModels] = useState<ListedModel[]>([]);
  const [discovered, setDiscovered] = useState<DiscoveredLocalLlm[]>([]);
  const [selectedLocalModel, setSelectedLocalModel] = useState('');
  const [selectedOpenRouterModel, setSelectedOpenRouterModel] = useState('');
  const [busy, setBusy] = useState(false);
  const circles = useCirclesState();
  // True while main waits for the browser to return from OpenRouter sign-in.
  const [openRouterSigningIn, setOpenRouterSigningIn] = useState(false);
  const openRouterSignInCancelled = useRef(false);
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
      const result = await window.electronAPI.onboarding.adoptLocalLlm({
        runtime: endpoint.runtime,
        endpointUrl: endpoint.baseUrl,
        modelId,
      });
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
    openRouterSignInCancelled.current = false;
    setOpenRouterSigningIn(true);
    try {
      const result = await window.electronAPI.onboarding.startOAuthPkce({ providerId: 'openrouter' });
      setOpenRouterSigningIn(false);
      if (openRouterSignInCancelled.current) return;
      if (!result.success || !result.credentials) {
        setError(result.error ?? 'OpenRouter sign-in failed.');
        return;
      }
      const listed = await window.electronAPI.onboarding.listEndpointModels({
        baseUrl: result.credentials.endpointUrl,
        authScheme: result.credentials.authScheme,
        provider: result.credentials.providerId,
        extraHeaders: result.credentials.extraHeaders,
      });
      const keep = selectedOpenRouterModel;
      const modelId =
        (keep && listed.models.some((model) => model.id === keep) && keep) ||
        listed.models[0]?.id;
      if (!modelId) {
        setError('No models available after connect.');
        return;
      }
      const saved = await window.electronAPI.onboarding.saveLlmConnection({
        endpointUrl: result.credentials.endpointUrl,
        modelId,
        provider: result.credentials.providerId,
        providerDisplayName: result.credentials.providerDisplayName,
        authScheme: result.credentials.authScheme,
        capabilities: result.credentials.capabilities,
        extraHeaders: result.credentials.extraHeaders,
        slot: 'openrouter',
      });
      if (!saved.success) {
        setError(saved.error ?? 'Unable to save OpenRouter.');
        return;
      }
      await takeInferenceStatus(saved);
      setOpenRouterModels(listed.models);
      setSelectedOpenRouterModel(modelId);
      setNotice('OpenRouter connected. The assistant restarts only if this is the app default.');
    } finally {
      setOpenRouterSigningIn(false);
      setBusy(false);
    }
  };

  const handleCancelOpenRouterSignIn = () => {
    openRouterSignInCancelled.current = true;
    void window.electronAPI.onboarding.cancelOAuthPkce();
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
      const result = await window.electronAPI.onboarding.sendLlmTestMessage({
        slot,
        message: 'Reply with the word ready.',
      });
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
      }
      setTestBySlot((current) => ({ ...current, [slot]: undefined }));
    } finally {
      setBusy(false);
    }
  };

  const handleSetDefault = async (slot: InferenceSlotId) => {
    setBusy(true);
    setError(null);
    try {
      const result = await window.electronAPI.onboarding.setAppDefault({ slot });
      if (!result.success) {
        setError(result.error ?? 'Unable to set the app default.');
        return;
      }
      await takeInferenceStatus(result);
      setNotice('App default updated. The assistant restarts to use this connection.');
    } finally {
      setBusy(false);
    }
  };

  const handleSetFallbacks = async (fallbacks: InferenceChainEntry[]) => {
    setBusy(true);
    setError(null);
    try {
      const result = await window.electronAPI.onboarding.setAppFallbacks({ fallbacks });
      if (!result.success) {
        setError(result.error ?? 'Unable to save the fallbacks.');
        return;
      }
      await takeInferenceStatus(result);
      setNotice('Fallbacks saved. They take effect on your next message.');
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
  const openRouterMeta = openRouterPill(openrouter);

  return (
    <section className="wb-inference" aria-label="Settings">
      <button type="button" className="wb-inference-btn" onClick={onBack}>
        Back to chat
      </button>
      <h1>Settings</h1>
      <div className="wb-settings-tabs" role="tablist" aria-label="Settings sections">
        {SETTINGS_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`settings-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls="settings-tabpanel"
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div id="settings-tabpanel" role="tabpanel" aria-labelledby={`settings-tab-${tab}`}>
        {tab === 'passwords' ? (
          <PasswordsLoginsPanel initialAgentSlug={initialAgentSlug} />
        ) : tab === 'calendars' ? (
          <CalendarsPanel
            cloudProvider={status?.appDefault === 'openrouter' ? 'OpenRouter' : null}
            onConnectFromChatClosed={connectCalendarFromChat ? onBack : undefined}
          />
        ) : tab === 'coding' ? (
          <CodingFoldersPanel />
        ) : tab === 'browser' ? (
          <AgentBrowserPanel />
        ) : tab === 'access' ? (
          <ComputerAccessPanel />
        ) : (
          <>

          <section className="wb-settings-section" aria-labelledby="settings-appearance">
            <h2 id="settings-appearance">Appearance</h2>
            <div className="wb-settings-row">
              <div>
                <p className="wb-settings-label">Theme</p>
              </div>
              <Segmented
                aria-label="Theme"
                value={themePreference}
                onChange={setThemePreference}
                options={[
                  { value: 'system', label: 'System', icon: <Monitor aria-hidden="true" /> },
                  { value: 'light', label: 'Light', icon: <Sun aria-hidden="true" /> },
                  { value: 'dark', label: 'Dark', icon: <Moon aria-hidden="true" /> },
                ]}
              />
            </div>
          </section>

          {rendererExperiments.map(({ SettingsSection }, index) =>
            SettingsSection ? <SettingsSection key={index} /> : null
          )}

          <h2 className="wb-settings-heading">
            Inference
            <InfoTip label="inference">
              You can connect a local runtime and OpenRouter at the same time. One of them is the app
              default; projects and chats can override it.
            </InfoTip>
          </h2>

          {local && localHealth === 'unreachable' && (
            <div className="wb-inference-banner is-warn">
              <p>
                {local.providerDisplayName ?? 'Local'} is not reachable
                {local.endpointUrl ? ` at ${local.endpointUrl}` : ''}. Local stays configured. The
                default does not change.
              </p>
              <button type="button" className="wb-inference-btn" onClick={() => void probe('local')}>
                Retry
              </button>
            </div>
          )}
          {openrouter && openRouterHealth === 'unauthorized' && (
            <div className="wb-inference-banner is-bad">
              <p>
                OpenRouter returned unauthorized. The stored key is no longer valid. Reconnect to keep
                the cloud card.
              </p>
              <button
                type="button"
                className="wb-inference-btn"
                onClick={() => void handleConnectOpenRouter()}
              >
                Reconnect
              </button>
            </div>
          )}
          {openRouterSigningIn && (
            <div className="wb-inference-banner" role="status">
              <p>Waiting for OpenRouter sign-in to finish in your browser.</p>
              <button type="button" className="wb-inference-btn" onClick={handleCancelOpenRouterSignIn}>
                Cancel
              </button>
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="size-8 animate-spin rounded-full border-2 border-line border-t-brand" />
            </div>
          ) : (
            <>
              <div className="wb-inference-cards">
                <article className="wb-inference-card">
                  <div className="hed">
                    <span className={`wb-inference-dot ${dotClass(local, 'local')}`} />
                    <h3>Local</h3>
                    <span className={`wb-inference-pill ${localMeta.tone}`}>{localMeta.label}</span>
                  </div>
                  {!local ? (
                    <div className="wb-inference-empty">
                      <p>
                        {openrouter
                          ? 'Optional. Scan if Ollama or LM Studio is running.'
                          : 'Boundary looks for Ollama and LM Studio on this Mac.'}
                      </p>
                      <div className="wb-inference-actions">
                        <button
                          type="button"
                          className={`wb-inference-btn ${openrouter ? '' : 'is-solid'}`}
                          disabled={busy}
                          onClick={() => void handleScan()}
                        >
                          Scan this machine
                        </button>
                      </div>
                      {discovered.map((endpoint) => (
                        <div key={`${endpoint.runtime}:${endpoint.baseUrl}`} className="mt-3">
                          <p>
                            {endpoint.displayName} · <span className="mono">{endpoint.baseUrl}</span>
                          </p>
                          {endpoint.models.map((model) => (
                            <button
                              key={model.id}
                              type="button"
                              className="wb-inference-btn"
                              disabled={busy}
                              title={model.id}
                              onClick={() => void handleAdoptLocal(endpoint, model.id)}
                            >
                              Use {model.id}
                              {model.loaded ? ' (loaded)' : ' (not loaded)'}
                            </button>
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
                            <button
                              type="button"
                              className="wb-inference-btn"
                              disabled={busy || selectedLocalModel === local.modelId}
                              onClick={() => void handleSaveModel('local', selectedLocalModel)}
                            >
                              Save model
                            </button>
                          </div>
                          {renderModelSaveFeedback('local')}
                        </div>
                      )}
                      <div className="wb-inference-actions">
                        {localHealth === 'unreachable' ? (
                          <button
                            type="button"
                            className="wb-inference-btn"
                            disabled={busy}
                            onClick={() => void probe('local')}
                          >
                            Retry
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="wb-inference-btn"
                            disabled={busy}
                            onClick={() => void handleTest('local')}
                          >
                            Test
                          </button>
                        )}
                        <button
                          type="button"
                          className="wb-inference-btn"
                          disabled={busy}
                          onClick={() => void handleDisconnect('local')}
                        >
                          Disconnect
                        </button>
                      </div>
                      {testBySlot.local && <p className="wb-inference-note">{testBySlot.local}</p>}
                      <CircleSharingPanel
                        circles={circles}
                        models={localModels.length > 0 ? localModels : local.modelId ? [{ id: local.modelId }] : []}
                      />
                    </>
                  )}
                </article>

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
                      <p>
                        {local
                          ? 'Optional. Adds a cloud model for the projects you choose.'
                          : 'Connect with OAuth. Boundary stores one key.'}
                      </p>
                      <p className="wb-inference-cloud">{cloudInferenceNotice('OpenRouter')}</p>
                      <div className="wb-inference-actions">
                        <button
                          type="button"
                          className={`wb-inference-btn ${local ? '' : 'is-solid'}`}
                          disabled={busy}
                          onClick={() => void handleConnectOpenRouter()}
                        >
                          Connect OpenRouter
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <dl>
                        <div className="wb-inference-meta">
                          <dt>Account</dt>
                          <dd>via OAuth</dd>
                        </div>
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
                                      <button
                                        type="button"
                                        className="wb-inference-btn is-solid"
                                        disabled={busy}
                                        onClick={() =>
                                          void handleSaveModel('openrouter', selectedOpenRouterModel)
                                        }
                                      >
                                        {busy ? 'Checking model…' : 'Save model'}
                                      </button>
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
                          <button
                            type="button"
                            className="wb-inference-btn is-solid"
                            disabled={busy}
                            onClick={() => void handleConnectOpenRouter()}
                          >
                            Reconnect OpenRouter
                          </button>
                        ) : (
                          <>
                            <button
                              type="button"
                              className="wb-inference-btn"
                              disabled={busy}
                              onClick={() => void handleTest('openrouter')}
                            >
                              Test
                            </button>
                            <button
                              type="button"
                              className="wb-inference-btn"
                              disabled={busy}
                              onClick={() => void handleConnectOpenRouter()}
                            >
                              Reconnect
                            </button>
                          </>
                        )}
                        <button
                          type="button"
                          className="wb-inference-btn"
                          disabled={busy}
                          onClick={() => void handleDisconnect('openrouter')}
                        >
                          Disconnect
                        </button>
                      </div>
                      {testBySlot.openrouter && (
                        <p className="wb-inference-note">{testBySlot.openrouter}</p>
                      )}
                    </>
                  )}
                </article>
              </div>

              <div className={`wb-inference-default ${!local && !openrouter ? 'opacity-50' : ''}`}>
                <h3>
                  App default
                  <InfoTip label="the app default">
                    Used when a project does not pin a provider and a chat has not overridden it.
                  </InfoTip>
                </h3>
                {!local && !openrouter ? (
                  <button type="button" className="wb-inference-choice" disabled>
                    <span className="wb-inference-radio" aria-hidden="true" />
                    <span>
                      <b>No default yet</b>
                      <span>Connect a provider above. Nothing sends until one is ready.</span>
                    </span>
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      className={`wb-inference-choice ${status?.appDefault === 'local' ? 'is-on' : ''}`}
                      disabled={!local?.configured || busy}
                      onClick={() => void handleSetDefault('local')}
                    >
                      <span className="wb-inference-radio" aria-hidden="true" />
                      <span>
                        <b>Local{local?.modelId ? ` · ${local.modelId}` : ''}</b>
                        <span>Stays on this machine. Cloud is off unless a chat or project asks.</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className={`wb-inference-choice ${status?.appDefault === 'openrouter' ? 'is-on' : ''}`}
                      disabled={!openrouter?.configured || busy}
                      onClick={() => void handleSetDefault('openrouter')}
                    >
                      <span className="wb-inference-radio" aria-hidden="true" />
                      <span>
                        <b>
                          OpenRouter
                          {openrouter?.modelId ? ` · ${openrouter.modelId}` : ''}
                        </b>
                        <span>Cloud is the machine default. Local stays available as an override.</span>
                      </span>
                    </button>
                  </>
                )}
                {status?.appDefault && status.appDefault !== 'infrastructure' && (
                  <>
                    <h3 className="wb-inference-fallback-head">
                      Fallbacks
                      <InfoTip label="fallbacks">
                        Tried in order when the app default doesn&apos;t answer, before the reply starts. The reply
                        is marked with the one that answered. A chat or project that picks its own provider uses
                        its own fallbacks, set in its menu.
                      </InfoTip>
                    </h3>
                    <ChainEditor
                      primary={{ slot: status.appDefault }}
                      fallbacks={status.appFallbacks ?? []}
                      ctx={{ slots: status.slots, circles }}
                      disabled={busy}
                      emptyNote="None. When the app default doesn’t answer, the chat stops and asks."
                      onChange={(next) => void handleSetFallbacks(next)}
                    />
                  </>
                )}
                {status?.appDefault === 'infrastructure' && infrastructure && (
                  <p className="wb-inference-note">
                    Assistant is using your existing {infrastructure.providerDisplayName ?? 'GPU'}{' '}
                    endpoint. GPU providers will return to Settings later.
                  </p>
                )}
              </div>
            </>
          )}

          {notice && <p className="wb-inference-note">{notice}</p>}
          {(error ?? statusError) && (
            <div className="wb-inference-banner is-bad" style={{ marginTop: 16 }}>
              <p>{error ?? statusError}</p>
            </div>
          )}
          </>
        )}
      </div>
    </section>
  );
};
