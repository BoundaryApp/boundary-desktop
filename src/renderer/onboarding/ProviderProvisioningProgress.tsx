import React, { useEffect, useMemo, useState } from 'react';
import type { PendingProviderSetup } from '../../shared/types/onboarding';
import type { StackStatusSnapshot } from '../../shared/types/infrastructure';
import type { AnyTask } from '../../shared/types/task';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { Progress } from '../components/ui/progress';
import { infrastructureIPC } from '../services/infrastructureIPCService';
import { useOnboarding } from './OnboardingContext';

interface ProviderProvisioningProgressProps {
  pending: PendingProviderSetup;
  onContinueInBackground?: () => void;
  onRetry: () => void | Promise<void>;
}

export const ProviderProvisioningProgress: React.FC<ProviderProvisioningProgressProps> = ({
  pending,
  onContinueInBackground,
  onRetry,
}) => {
  const { refresh } = useOnboarding();
  const [task, setTask] = useState<AnyTask | null>(null);
  const [status, setStatus] = useState<StackStatusSnapshot | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      const [nextTask, nextStatus] = await Promise.all([
        window.electronAPI.task.get(pending.taskId) as Promise<AnyTask | null>,
        infrastructureIPC.getStatus(pending.instanceId),
      ]);
      if (cancelled) return;
      setTask(nextTask);
      setStatus(nextStatus);
      if (nextTask?.status === 'completed') {
        await refresh();
      }
    };

    void infrastructureIPC.subscribe();
    void load();
    const interval = setInterval(() => void load(), 2000);
    infrastructureIPC.onStatusChanged((snapshot) => {
      if (snapshot.instanceId === pending.instanceId) {
        setStatus(snapshot);
      }
    });

    return () => {
      cancelled = true;
      clearInterval(interval);
      void infrastructureIPC.unsubscribe();
    };
  }, [pending.instanceId, pending.taskId, refresh]);

  const progress = useMemo(() => {
    const taskProgress = task?.progress ?? status?.operation?.progress ?? 0;
    return Math.max(0, Math.min(100, taskProgress));
  }, [status?.operation?.progress, task?.progress]);

  const stage =
    task?.status === 'failed'
      ? task.error ?? 'Provider setup failed.'
      : task?.currentStage ?? status?.operation?.currentStage ?? 'Starting provider setup';
  const failed = task?.status === 'failed';

  return (
    <Card className="w-full">
      <CardContent className="space-y-6 p-8">
        <div className="space-y-3">
          <div className="flex items-center justify-between text-ui text-fg-muted">
            <span>{pending.providerName}</span>
            <span>{progress}%</span>
          </div>
          <Progress value={progress}  />
          <p className={`text-center text-ui ${failed ? 'text-danger' : 'text-fg-muted'}`}>
            {stage}
          </p>
        </div>

        {failed ? (
          <div className="flex justify-center gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => void onRetry()}
              
            >
              Try again
            </Button>
          </div>
        ) : onContinueInBackground ? (
          <div className="flex justify-center">
            <Button
              type="button"
              variant="outline"
              onClick={onContinueInBackground}
              
            >
              Continue in background
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
};
