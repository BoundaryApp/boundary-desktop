import { useEffect, useState } from 'react';
import { createLifecycleSnapshot } from '../../shared/assistantStackLifecycle';
import type { AssistantStackLifecycleSnapshot } from '../../shared/types/assistantStack';
import { assistantStackIPC } from '../services/assistantStackIPCService';

export function useAssistantStackLifecycle(): AssistantStackLifecycleSnapshot {
  const [lifecycle, setLifecycle] = useState<AssistantStackLifecycleSnapshot>(() =>
    createLifecycleSnapshot('idle')
  );

  useEffect(() => {
    let cancelled = false;
    void assistantStackIPC.getLifecycle().then((snapshot) => {
      if (!cancelled && snapshot) {
        setLifecycle(snapshot);
      }
    });
    const unsubscribe = assistantStackIPC.onLifecycle((snapshot) => {
      setLifecycle(snapshot);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return lifecycle;
}
