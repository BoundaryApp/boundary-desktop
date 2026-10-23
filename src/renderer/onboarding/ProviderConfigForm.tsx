import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  DiscoveredProviderEndpoint,
  OnboardingDeployableModel,
  OnboardingProviderConfig,
  PendingProviderSetup,
} from '../../shared/types/onboarding';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { onboardingIPC } from '../services/onboardingIPCService';
import { ProviderEndpointDiscoveryResults } from './ProviderEndpointDiscoveryResults';
import { useOnboarding } from './OnboardingContext';
import { displaySecret } from '../../shared/utils/storedSecretToken';

interface ProviderConfigFormProps {
  provider: OnboardingProviderConfig;
  onStarted: (pending: PendingProviderSetup) => void;
}

export const ProviderConfigForm: React.FC<ProviderConfigFormProps> = ({ provider, onStarted }) => {
  const { refresh } = useOnboarding();
  const capabilities = provider.capabilities ?? {};
  const authFieldName = capabilities.authFieldName;
  const supportsDeploymentListing = Boolean(capabilities.deploymentListing);
  const supportsEndpointAdoption = Boolean(capabilities.endpointAdoption);
  const supportsDeployableModels = Boolean(capabilities.deployableModels);
  const accountCredentialFieldNames = capabilities.accountCredentialFields ?? [];
  const requiresAccountCredentialsBeforeModels = accountCredentialFieldNames.length > 0;
  const initialValues = useMemo(() => {
    const values: Record<string, string | number | boolean> = {};
    for (const field of provider.fields) {
      if (field.default !== undefined) values[field.name] = field.default;
      else if (field.type === 'boolean') values[field.name] = false;
      else values[field.name] = '';
    }
    return values;
  }, [provider.fields]);

  const [values, setValues] = useState<Record<string, string | number | boolean>>(initialValues);
  const [draftReady, setDraftReady] = useState(false);
  const [mode, setMode] = useState<'auth' | 'list' | 'create'>(
    supportsDeploymentListing ? 'auth' : 'create'
  );
  const [providerDeployments, setProviderDeployments] = useState<DiscoveredProviderEndpoint[]>([]);
  const [deployableModels, setDeployableModels] = useState<OnboardingDeployableModel[]>([]);
  const [selectedModelId, setSelectedModelId] = useState('');
  const [discoveryMessage, setDiscoveryMessage] = useState<string | null>(null);
  const [verifiedApiKey, setVerifiedApiKey] = useState<string | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const authFields = useMemo(
    () => provider.fields.filter((field) => authFieldName && field.name === authFieldName),
    [authFieldName, provider.fields]
  );
  const creationFields = useMemo(
    () =>
      provider.fields.filter((field) => !supportsDeploymentListing || field.name !== authFieldName),
    [authFieldName, provider.fields, supportsDeploymentListing]
  );
  const selectedModel = useMemo(
    () => deployableModels.find((model) => model.modelId === selectedModelId) ?? null,
    [deployableModels, selectedModelId]
  );

  const accountCredentialNameSet = useMemo(
    () => new Set(accountCredentialFieldNames),
    [accountCredentialFieldNames]
  );

  const accountCredentialFields = useMemo(() => {
    if (!requiresAccountCredentialsBeforeModels) return [];
    const byName = new Map<string, OnboardingProviderConfig['fields'][number]>();
    for (const field of provider.fields) {
      if (accountCredentialNameSet.has(field.name)) byName.set(field.name, field);
    }
    for (const model of deployableModels) {
      for (const field of model.requiredCredentials) {
        if (accountCredentialNameSet.has(field.name) && !byName.has(field.name)) {
          byName.set(field.name, field);
        }
      }
    }
    return accountCredentialFieldNames
      .map((name) => byName.get(name))
      .filter((field): field is OnboardingProviderConfig['fields'][number] => Boolean(field));
  }, [
    accountCredentialFieldNames,
    accountCredentialNameSet,
    deployableModels,
    provider.fields,
    requiresAccountCredentialsBeforeModels,
  ]);

  const accountCredentialsReady = useMemo(() => {
    if (!requiresAccountCredentialsBeforeModels) return true;
    return accountCredentialFieldNames.every((name) => {
      const value = values[name];
      return typeof value === 'string' ? Boolean(value.trim()) : value !== undefined && value !== null;
    });
  }, [accountCredentialFieldNames, requiresAccountCredentialsBeforeModels, values]);

  const postModelFields = useMemo(() => {
    if (!supportsDeployableModels || mode !== 'create' || !selectedModel) {
      return [] as OnboardingProviderConfig['fields'];
    }
    return selectedModel.requiredCredentials.filter(
      (field) => !accountCredentialNameSet.has(field.name)
    );
  }, [
    accountCredentialNameSet,
    mode,
    selectedModel,
    supportsDeployableModels,
  ]);

  const displayedFields =
    supportsDeploymentListing && mode === 'auth'
      ? authFields
      : requiresAccountCredentialsBeforeModels && supportsDeployableModels && mode === 'create'
        ? postModelFields
        : supportsDeployableModels && mode === 'create' && selectedModel
          ? selectedModel.requiredCredentials
          : creationFields;

  const setFieldValue = (name: string, value: string | number | boolean) => {
    setValues((prev) => ({ ...prev, [name]: value }));
  };

  const sensitiveFieldNames = useMemo(() => {
    const names = new Set<string>();
    for (const field of provider.fields) {
      if (field.sensitive) names.add(field.name);
    }
    for (const model of deployableModels) {
      for (const field of model.requiredCredentials) {
        if (field.sensitive) names.add(field.name);
      }
    }
    for (const field of selectedModel?.requiredCredentials ?? []) {
      if (field.sensitive) names.add(field.name);
    }
    return Array.from(names);
  }, [deployableModels, provider.fields, selectedModel?.requiredCredentials]);

  useEffect(() => {
    let cancelled = false;
    setDraftReady(false);
    onboardingIPC
      .getProviderFormDraft({ providerId: provider.id })
      .then((result) => {
        if (cancelled) return;
        if (result.success && result.draft) {
          setValues((prev) => ({ ...prev, ...result.draft!.values }));
          if (result.draft.selectedModelId) {
            setSelectedModelId(result.draft.selectedModelId);
          }
        }
      })
      .catch(() => {
        /* draft hydrate is best-effort */
      })
      .finally(() => {
        if (!cancelled) setDraftReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [provider.id]);

  useEffect(() => {
    if (!draftReady) return;
    const timer = window.setTimeout(() => {
      void onboardingIPC.saveProviderFormDraft({
        providerId: provider.id,
        values,
        sensitiveNames: sensitiveFieldNames,
        selectedModelId: selectedModelId || undefined,
      });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [draftReady, provider.id, selectedModelId, sensitiveFieldNames, values]);

  const validateFields = (fields: OnboardingProviderConfig['fields']) => {
    const missing = fields.find((field) => {
      if (!field.required) return false;
      const value = values[field.name];
      return value === undefined || value === '';
    });
    if (missing) {
      setError(`Enter ${missing.name}.`);
      return false;
    }
    return true;
  };

  const getProviderAuthValue = useCallback(() => {
    if (!authFieldName) return '';
    const apiKey = values[authFieldName];
    return typeof apiKey === 'string' ? apiKey.trim() : '';
  }, [authFieldName, values]);

  const handleVerifyProviderKey = useCallback(async () => {
    setError(null);
    setDiscoveryMessage(null);
    const apiKey = getProviderAuthValue();
    if (!apiKey) {
      setError(`Enter your ${provider.name} API key.`);
      return false;
    }
    if (verifiedApiKey === apiKey && mode !== 'auth') {
      return true;
    }
    if (!validateFields(authFields)) return false;

    setSubmitting(true);
    try {
      const result = await onboardingIPC.listProviderDeployments({
        providerId: provider.id,
        values,
      });
      if (!result.success) {
        setError(result.error ?? 'Unable to list existing deployments.');
        return false;
      }
      setProviderDeployments(result.endpoints);
      setVerifiedApiKey(apiKey);
      if (result.endpoints.length === 0) {
        setDiscoveryMessage(`No existing ${provider.name} deployments were found. Create a new endpoint to continue.`);
      } else {
        setDiscoveryMessage(null);
      }
      setMode('list');
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setSubmitting(false);
    }
  }, [authFields, getProviderAuthValue, mode, provider.id, provider.name, values, verifiedApiKey]);

  useEffect(() => {
    if (!draftReady) return;
    if (!supportsDeployableModels || mode !== 'create') return;
    const apiKey = getProviderAuthValue();
    if (supportsDeploymentListing && !apiKey) return;
    if (requiresAccountCredentialsBeforeModels && !accountCredentialsReady) {
      setDeployableModels([]);
      setSelectedModelId('');
      setModelsLoading(false);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      setModelsLoading(true);
      setError(null);
      onboardingIPC
        .listDeployableModels({
          providerId: provider.id,
          values,
        })
        .then((result) => {
          if (cancelled) return;
          if (!result.success) {
            setError(result.error ?? 'Unable to load deployable models.');
            setDeployableModels([]);
            setSelectedModelId('');
            return;
          }
          setDeployableModels(result.models);
          setSelectedModelId((current) => {
            const currentModel = result.models.find((model) => model.modelId === current);
            if (currentModel && currentModel.deployable !== false) return current;
            const firstDeployable = result.models.find((model) => model.deployable !== false);
            return firstDeployable?.modelId ?? result.models[0]?.modelId ?? '';
          });
        })
        .catch((e) => {
          if (!cancelled) setError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          if (!cancelled) setModelsLoading(false);
        });
    }, 300);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    accountCredentialsReady,
    draftReady,
    getProviderAuthValue,
    mode,
    provider.id,
    requiresAccountCredentialsBeforeModels,
    supportsDeployableModels,
    supportsDeploymentListing,
    values,
  ]);

  const selectedModelBlocked = Boolean(selectedModel && selectedModel.deployable === false);

  const handleCreate = async () => {
    setError(null);
    if (supportsDeployableModels) {
      if (requiresAccountCredentialsBeforeModels && !validateFields(accountCredentialFields)) {
        return;
      }
      if (!accountCredentialsReady) {
        setError('Enter your account credentials before choosing a model.');
        return;
      }
      if (!selectedModel) {
        setError('Choose a model to deploy.');
        return;
      }
      if (selectedModel.deployable === false) {
        setError(selectedModel.unavailableReason ?? 'This model is not available on your plan.');
        return;
      }
      const fieldsToValidate = supportsDeploymentListing
        ? [...authFields, ...selectedModel.requiredCredentials]
        : requiresAccountCredentialsBeforeModels
          ? [...accountCredentialFields, ...postModelFields]
          : selectedModel.requiredCredentials;
      if (!validateFields(fieldsToValidate)) return;
    } else if (!validateFields(provider.fields)) {
      return;
    }

    setSubmitting(true);
    try {
      const result = await onboardingIPC.startProviderSetup({
        providerId: provider.id,
        modelId: supportsDeployableModels ? selectedModel?.modelId : undefined,
        values,
      });
      if (!result.success || !result.pending) {
        setError(result.error ?? 'Unable to start provider setup.');
        return;
      }
      onStarted(result.pending);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const handleUseEndpoint = async (endpoint: DiscoveredProviderEndpoint) => {
    setError(null);
    if (!supportsEndpointAdoption || !authFieldName) {
      setError('Endpoint adoption is not available for this provider.');
      return;
    }
    const apiKey = values[authFieldName];
    if (typeof apiKey !== 'string' || !apiKey.trim()) {
      setError(`Enter your ${provider.name} API key.`);
      return;
    }

    const result = await onboardingIPC.adoptProviderEndpoint({
      providerId: provider.id,
      endpointUrl: endpoint.endpointUrl,
      apiKey,
      modelId: endpoint.modelId,
      deploymentId: endpoint.deploymentId,
    });
    if (!result.success) {
      setError(result.error ?? 'Unable to use this endpoint.');
      return;
    }
    await refresh();
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (supportsDeploymentListing && mode === 'auth') {
      await handleVerifyProviderKey();
      return;
    }
    await handleCreate();
  };

  if (supportsDeploymentListing && mode === 'list') {
    return (
      <Card className="w-full">
        <CardHeader>
          <CardTitle className="text-title">Use an existing {provider.name} endpoint?</CardTitle>
          <CardDescription className="text-fg-muted">
            Boundary found the deployments in your {provider.name} account. Selecting one verifies
            it with a real OpenAI-compatible chat request before saving it.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {discoveryMessage && (
            <div className="rounded-md border border-warn/35 bg-warn-dim px-3 py-2.5 text-ui text-fg">
              {discoveryMessage}
            </div>
          )}
          {error && (
            <div className="rounded-md border border-danger-line bg-danger-dim px-3 py-2.5 text-ui text-danger">
              {error}
            </div>
          )}
          <ProviderEndpointDiscoveryResults
            endpoints={providerDeployments}
            onUseEndpoint={handleUseEndpoint}
            onCreateNew={() => {
              setError(null);
              setMode('create');
            }}
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="text-title">
          {supportsDeploymentListing && mode === 'auth'
            ? `Connect your ${provider.name} account`
            : `Set up ${provider.name}`}
        </CardTitle>
        <CardDescription className="text-fg-muted">
          {supportsDeploymentListing && mode === 'auth'
            ? `Enter your ${provider.name} API key. Boundary verifies it, then lists deployments you can reuse.`
            : 'Boundary uses these values to create and verify an OpenAI-compatible endpoint.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-6" onSubmit={handleSubmit}>
          {requiresAccountCredentialsBeforeModels &&
            supportsDeployableModels &&
            mode === 'create' &&
            accountCredentialFields.map((field) => (
              <div key={field.name} className="space-y-2">
                <Label htmlFor={`provider-field-${field.name}`} className="text-fg">
                  {field.name}
                  {field.required && <span className="text-danger"> *</span>}
                </Label>
                {field.description && (
                  <p className="text-ui leading-6 text-fg-faint">{field.description}</p>
                )}
                <ProviderFieldInput
                  field={field}
                  value={values[field.name]}
                  disabled={submitting}
                  onChange={(value) => setFieldValue(field.name, value)}
                />
              </div>
            ))}

          {supportsDeployableModels &&
            mode === 'create' &&
            (!requiresAccountCredentialsBeforeModels || accountCredentialsReady) && (
            <div className="space-y-3 rounded-lg border border-line bg-surface-0 p-4">
              <div>
                <Label htmlFor="provider-model-select" className="text-fg">
                  Model
                </Label>
                <p className="mt-1 text-ui leading-6 text-fg-faint">
                  Choose a {provider.name}-deployable model from Boundary&apos;s catalog.
                </p>
              </div>
              {modelsLoading ? (
                <div className="text-ui text-fg-muted">Loading deployable models...</div>
              ) : deployableModels.length === 0 ? (
                <div className="text-ui text-warn">
                  No deployable {provider.name} models are available in the local catalog.
                </div>
              ) : (
                <>
                  <select
                    id="provider-model-select"
                    disabled={submitting}
                    value={selectedModelId}
                    onChange={(event) => setSelectedModelId(event.target.value)}
                    className="h-8 w-full rounded-md border border-line bg-surface-1 px-2.5 text-ui text-fg"
                  >
                    {deployableModels.map((model) => (
                      <option
                        key={model.modelId}
                        value={model.modelId}
                        disabled={model.deployable === false}
                      >
                        {model.displayName}
                        {model.alreadyDeployed ? ' (already deployed)' : ''}
                        {model.deployable === false ? ' (unavailable on plan)' : ''}
                      </option>
                    ))}
                  </select>
                  {selectedModel?.hardwareSummary && (
                    <p className="text-ui leading-6 text-fg-faint">
                      Hardware: {selectedModel.hardwareSummary}
                    </p>
                  )}
                  {selectedModel?.description && (
                    <p className="text-ui leading-6 text-fg-faint">{selectedModel.description}</p>
                  )}
                  {selectedModelBlocked && (
                    <p className="rounded-md border border-warn/35 bg-warn-dim px-3 py-2.5 text-ui text-fg">
                      {selectedModel?.unavailableReason ??
                        'This model is not available on your current Cerebrium plan.'}
                    </p>
                  )}
                  {selectedModel?.gated && !selectedModelBlocked && (
                    <p className="rounded-md border border-warn/35 bg-warn-dim px-3 py-2.5 text-ui text-fg">
                      This model is gated and requires a Hugging Face token with access to the
                      model repository.
                    </p>
                  )}
                </>
              )}
            </div>
          )}

          {requiresAccountCredentialsBeforeModels &&
            supportsDeployableModels &&
            mode === 'create' &&
            !accountCredentialsReady && (
              <p className="rounded-lg border border-line bg-surface-0 p-3 text-ui text-fg-muted">
                Enter your service account token and project ID to see which models your plan can
                deploy.
              </p>
            )}

          {displayedFields.map((field) => (
            <div key={field.name} className="space-y-2">
              <Label htmlFor={`provider-field-${field.name}`} className="text-fg">
                {field.name}
                {field.required && <span className="text-danger"> *</span>}
              </Label>
              {field.description && (
                <p className="text-ui leading-6 text-fg-faint">{field.description}</p>
              )}
              <ProviderFieldInput
                field={field}
                value={values[field.name]}
                disabled={submitting}
                onChange={(value) => setFieldValue(field.name, value)}
                onBlur={
                  supportsDeploymentListing && mode === 'auth' && field.name === authFieldName
                    ? () => void handleVerifyProviderKey()
                    : undefined
                }
                onEnter={
                  supportsDeploymentListing && mode === 'auth' && field.name === authFieldName
                    ? () => void handleVerifyProviderKey()
                    : undefined
                }
              />
              {field.name === authFieldName && verifiedApiKey && (
                <p className="text-ui text-fg-faint">
                  Verified key: {displaySecret(verifiedApiKey)}
                </p>
              )}
            </div>
          ))}

          {discoveryMessage && (
            <div className="rounded-md border border-warn/35 bg-warn-dim px-3 py-2.5 text-ui text-fg">
              {discoveryMessage}
            </div>
          )}

          {error && (
            <div className="rounded-md border border-danger-line bg-danger-dim px-3 py-2.5 text-ui text-danger">
              {error}
            </div>
          )}

          <Button
            type="submit"
            disabled={
              submitting ||
              (supportsDeployableModels &&
                mode === 'create' &&
                (!accountCredentialsReady ||
                  modelsLoading ||
                  !selectedModel ||
                  selectedModelBlocked))
            }
            className="w-full"
          >
            {submitting
              ? supportsDeploymentListing && mode === 'auth'
                ? 'Verifying API key...'
                : 'Starting setup...'
              : supportsDeploymentListing && mode === 'auth'
                ? 'Continue'
                : supportsDeployableModels
                  ? 'Deploy'
                  : 'Create Endpoint'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
};

function ProviderFieldInput({
  field,
  value,
  disabled,
  onChange,
  onBlur,
  onEnter,
}: {
  field: OnboardingProviderConfig['fields'][number];
  value: string | number | boolean | undefined;
  disabled?: boolean;
  onChange: (value: string | number | boolean) => void;
  onBlur?: () => void;
  onEnter?: () => void;
}) {
  const id = `provider-field-${field.name}`;

  if (field.type === 'boolean') {
    return (
      <label className="flex items-center gap-3 rounded-lg border border-line bg-surface-0 px-3 py-3 text-ui text-fg">
        <input
          id={id}
          type="checkbox"
          disabled={disabled}
          checked={Boolean(value)}
          onChange={(event) => onChange(event.target.checked)}
        />
        Enabled
      </label>
    );
  }

  if (field.type === 'enum' && field.options) {
    return (
      <select
        id={id}
        disabled={disabled}
        value={String(value ?? field.options[0] ?? '')}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 w-full rounded-md border border-line bg-surface-1 px-2.5 text-ui text-fg"
      >
        {field.options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  }

  return (
    <Input
      id={id}
      type={field.sensitive ? 'password' : field.type === 'number' ? 'number' : 'text'}
      value={String(value ?? '')}
      disabled={disabled}
      autoComplete="off"
      onBlur={onBlur}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && onEnter) {
          event.preventDefault();
          onEnter();
        }
      }}
      onChange={(event) =>
        onChange(field.type === 'number' ? Number(event.target.value) : event.target.value)
      }
      
    />
  );
}
