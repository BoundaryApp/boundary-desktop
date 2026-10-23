import React from 'react';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../components/ui/card';
import type { OnboardingProviderConfig } from '../../shared/types/onboarding';

interface ProviderGridProps {
  providers: OnboardingProviderConfig[];
  onSelect: (provider: OnboardingProviderConfig) => void;
}

export const ProviderGrid: React.FC<ProviderGridProps> = ({ providers, onSelect }) => {
  return (
    <div className="w-full space-y-6">
      <div className="grid gap-3 sm:grid-cols-2">
        {providers.map((provider) => (
          <Card
            key={provider.id}
            
          >
            <CardHeader>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <CardTitle className="text-title">{provider.name}</CardTitle>
                  <CardDescription className="mt-2 text-fg-muted">
                    {provider.description}
                  </CardDescription>
                </div>
                <Badge
                  className={
                    provider.status === 'available'
                      ? 'border-ok/35 bg-ok-dim text-ok'
                      : 'border-line bg-surface-1 text-fg-faint'
                  }
                >
                  {provider.status === 'available' ? 'Supported' : 'Coming soon'}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="text-ui text-fg-muted">
              <p>{provider.capability}</p>
            </CardContent>
            <CardFooter>
              <Button
                type="button"
                variant={provider.status === 'available' ? 'default' : 'outline'}
                disabled={provider.status !== 'available'}
                onClick={() => onSelect(provider)}
                className={
                  provider.status === 'available'
                    ? 'w-full bg-brand text-fg hover:bg-brand/90'
                    : 'w-full border-line bg-surface-hover text-fg-muted'
                }
              >
                {provider.status === 'available' ? 'Start setup' : 'Not available yet'}
              </Button>
            </CardFooter>
          </Card>
        ))}
      </div>
    </div>
  );
};
