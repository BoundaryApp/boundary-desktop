import React, { useState } from 'react';
import type { DiscoveredProviderEndpoint } from '../../shared/types/onboarding';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';

interface ProviderEndpointDiscoveryResultsProps {
  endpoints: DiscoveredProviderEndpoint[];
  onUseEndpoint: (endpoint: DiscoveredProviderEndpoint) => Promise<void>;
  onCreateNew: () => void;
}

export const ProviderEndpointDiscoveryResults: React.FC<ProviderEndpointDiscoveryResultsProps> = ({
  endpoints,
  onUseEndpoint,
  onCreateNew,
}) => {
  const [selectedUrl, setSelectedUrl] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <Button
        type="button"
        onClick={onCreateNew}
        className="w-full"
      >
        Create New Endpoint
      </Button>

      {endpoints.length === 0 ? (
        <div className="space-y-2 rounded-lg border border-line bg-surface-1 p-5 text-fg">
          <h3 className="text-title font-medium text-fg">No existing deployments found</h3>
          <p className="text-ui leading-6 text-fg-muted">
            Boundary did not find any Baseten deployments in this account. You can create a new
            endpoint instead.
          </p>
        </div>
      ) : (
        <div className="rounded-md border border-ok/35 bg-ok-dim px-3 py-2.5 text-ui text-fg">
          Boundary found existing deployments. Choosing one verifies it with a real chat request
          before Boundary saves it.
        </div>
      )}

      {endpoints.map((endpoint) => {
        const isSelected = selectedUrl === endpoint.endpointUrl;
        return (
          <Card key={endpoint.endpointUrl} >
            <CardHeader>
              <CardTitle className="text-title">{endpoint.displayName}</CardTitle>
              <CardDescription className="text-fg-muted">
                {endpoint.healthStatus
                  ? `Baseten status: ${endpoint.healthStatus}`
                  : endpoint.verified
                    ? 'Verified endpoint'
                    : 'Existing deployment'}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1 text-xs text-fg-faint">
                <p className="break-all font-mono">{endpoint.endpointUrl}</p>
                {endpoint.deploymentId && <p>Deployment: {endpoint.deploymentId}</p>}
              </div>
              <Button
                type="button"
                disabled={isSelected}
                onClick={() => {
                  setSelectedUrl(endpoint.endpointUrl);
                  void onUseEndpoint(endpoint).finally(() => setSelectedUrl(null));
                }}
                className="w-full"
              >
                {isSelected ? 'Connecting...' : 'Use this endpoint'}
              </Button>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
};
