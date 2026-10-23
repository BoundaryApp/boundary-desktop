import React, { useCallback, useEffect, useState } from 'react';
import type {
  DiscoveredLocalLlm,
  InferenceProvidersStatus,
  InferenceSlotId,
  ListedModel,
  LlmSlotHealth,
  LlmSlotStatus,
} from '../../shared/types/onboarding';
import { Monitor, Moon, Sun } from 'lucide-react';
import { ModelPicker } from '../onboarding/ModelPicker';
import { Segmented } from '../components/ui/segmented';
import { useThemePreference } from '../theme';
import { onboardingIPC } from '../services/onboardingIPCService';
import { cloudInferenceNotice, cloudKeyLimitTip } from './cloudInferenceCopy';
import { PasswordsLoginsPanel } from './PasswordsLoginsPanel';
import { CalendarsPanel } from './CalendarsPanel';
import { CodingFoldersPanel } from './CodingFoldersPanel';
import { AgentBrowserPanel } from './AgentBrowserPanel';
import { ComputerAccessPanel } from './ComputerAccessPanel';
import type { SettingsTab } from './settingsNavigation';

interface ProductSettingsScreenProps {
  onBack: () => void;
  /** Open on this tab instead of General (e.g. from a chat's saved-login note). */
  initialTab?: SettingsTab;
  /** Passwords & Logins: start on this agent's logins. */
  initialAgentSlug?: string;
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
}) => {
  const [themePreference, setThemePreference] = useThemePreference();
  const [tab, setTab] = useState<SettingsTab>(initialTab ?? 'general');
  const [status, setStatus] = useState<InferenceProvidersStatus | null>(null);
  const [localModels, setLocalModels] = useState<ListedModel[]>([]);
  const [openRouterModels, setOpenRouterModels] = useState<ListedModel[]>([]);
  const [discovered, setDiscovered] = useState<DiscoveredLocalLlm[]>([]);
  const [selectedLocalModel, setSelectedLocalModel] = useState('');
  const [selectedOpenRouterModel, setSelectedOpenRouterModel] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [testBySlot, setTestBySlot] = useState<Partial<Record<InferenceSlotId, string>>>({});

  const applyStatus = useCallback((next: InferenceProvidersStatus) => {
    setStatus(next);
    setSelectedLocalModel((current) => next.slots?.local?.modelId ?? current);
    setSelectedOpenRouterModel((current) => next.slots?.openrouter?.modelId ?? current);
  }, []);

  const refreshStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      applyStatus(await onboardingIPC.getStatus());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [applyStatus]);

  const probe = useCallback(async (slot: InferenceSlotId) => {
    const result = await onboardingIPC.probeSlotHealth({ slot });
    if (result.status) applyStatus(result.status);
    return result;
  }, [applyStatus]);

  const refreshModels = useCallback(async (slot: 'local' | 'openrouter') => {
    const result = await onboardingIPC.listConfiguredEndpointModels({ slot });
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
    void refreshStatus();
  }, [refreshStatus]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.slots.local?.endpointUrl, status?.slots.openrouter?.endpointUrl]);

  const handleScan = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await onboardingIPC.discoverLocalLlms();
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
      const result = await onboardingIPC.adoptLocalLlm({
        runtime: endpoint.runtime,
        endpointUrl: endpoint.baseUrl,
        modelId,
      });
      if (!result.success) {
        setError(result.error ?? 'Unable to use this local endpoint.');
        return;
      }
      if (result.status) applyStatus(result.status);
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
      const result = await onboardingIPC.startOAuthPkce({ providerId: 'openrouter' });
      if (!result.success || !result.credentials) {
        setError(result.error ?? 'OpenRouter sign-in failed.');
        return;
      }
      const listed = await onboardingIPC.listEndpointModels({
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
      const saved = await onboardingIPC.saveLlmConnection({
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
      if (saved.status) applyStatus(saved.status);
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
    try {
      const result = await onboardingIPC.updateLlmModel({ slot, modelId });
      if (!result.success) {
        setError(result.error ?? 'Unable to update model.');
        return;
      }
      if (result.status) applyStatus(result.status);
      setNotice(
        status?.appDefault === slot
          ? 'Model updated. The assistant restarts to use this model.'
          : 'Model saved. It will be used when this provider is the app default.'
      );
    } finally {
      setBusy(false);
    }
  };

  const handleTest = async (slot: InferenceSlotId) => {
    setBusy(true);
    setError(null);
    try {
      const result = await onboardingIPC.sendLlmTestMessage({
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
      const result = await onboardingIPC.clearLlmSlot({ slot });
      if (!result.success) {
        setError(result.error ?? 'Unable to disconnect.');
        return;
      }
      if (result.status) applyStatus(result.status);
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
      const result = await onboardingIPC.setAppDefault({ slot });
      if (!result.success) {
        setError(result.error ?? 'Unable to set the app default.');
        return;
      }
      if (result.status) applyStatus(result.status);
      setNotice('App default updated. The assistant restarts to use this connection.');
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
          <CalendarsPanel cloudProvider={status?.appDefault === 'openrouter' ? 'OpenRouter' : null} />
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
                <p className="wb-settings-hint">System follows your Mac’s light or dark setting.</p>
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

          <h2 className="wb-settings-heading">Inference</h2>
          <p className="wb-inference-lead">
            Hold a local runtime and OpenRouter at the same time. One of them is the app default.
            Projects and chats can override later.
          </p>

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
                          ? 'OpenRouter is connected. A local runtime is optional. Scan if Ollama or LM Studio is running.'
                          : 'No local runtime is configured. Boundary looks for Ollama and LM Studio on this machine.'}
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
                            onSelect={setSelectedLocalModel}
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
                    </>
                  )}
                </article>

                <article className="wb-inference-card">
                  <div className="hed">
                    <span className={`wb-inference-dot ${dotClass(openrouter, 'openrouter')}`} />
                    <h3>OpenRouter</h3>
                    <span className={`wb-inference-pill ${openRouterMeta.tone}`}>
                      {openRouterMeta.label}
                    </span>
                  </div>
                  {!openrouter ? (
                    <div className="wb-inference-empty">
                      <p>
                        {local
                          ? 'Local is enough to chat. Connect OpenRouter if you want a cloud option on some projects.'
                          : 'Connect with OAuth. Boundary stores one key. Model list and prices come from OpenRouter after connect.'}
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
                      <p className="wb-inference-cloud">
                        {cloudInferenceNotice('OpenRouter')} {cloudKeyLimitTip('OpenRouter')}
                      </p>
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
                              onSelect={setSelectedOpenRouterModel}
                              onRefresh={() => void refreshModels('openrouter')}
                              label="OpenRouter model"
                              filterable
                            />
                            <div className="wb-inference-actions">
                              <button
                                type="button"
                                className="wb-inference-btn"
                                disabled={busy || selectedOpenRouterModel === openrouter.modelId}
                                onClick={() => void handleSaveModel('openrouter', selectedOpenRouterModel)}
                              >
                                Save model
                              </button>
                            </div>
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
                <h3>App default</h3>
                <p className="hint">
                  Used when a project does not pin a provider and a chat has not overridden it.
                </p>
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
          {error && (
            <div className="wb-inference-banner is-bad" style={{ marginTop: 16 }}>
              <p>{error}</p>
            </div>
          )}
          </>
        )}
      </div>
    </section>
  );
};
