import React from 'react';
import { CheckCircle2 } from 'lucide-react';
import { useAssistantStackLifecycle } from '../product/useAssistantStackLifecycle';
import { stageCopy } from '../product/startup/startupModel';
import { formatBytes } from '../../shared/startupDownload';

/**
 * The stack starts downloading once the Mac passes its check (ADR 0029), while
 * the user is still choosing a model. This says so from the setup header.
 */
export const SetupBackgroundStatus: React.FC = () => {
  const lifecycle = useAssistantStackLifecycle();

  if (lifecycle.phase === 'starting') {
    const bytes = lifecycle.download?.receivedBytes ?? 0;
    return (
      <p className="wb-setup-status" role="status">
        <span
          aria-hidden="true"
          className="size-2.5 shrink-0 animate-spin rounded-full border-[1.5px] border-line border-t-brand"
        />
        {stageCopy(lifecycle.stage, 'first-run')}
        {bytes > 0 && <span className="text-fg-faint">· {formatBytes(bytes)}</span>}
      </p>
    );
  }
  if (lifecycle.phase === 'ready') {
    return (
      <p className="wb-setup-status" role="status">
        <CheckCircle2 aria-hidden="true" className="size-3.5 text-ok" />
        Your tools are ready
      </p>
    );
  }
  if (lifecycle.phase === 'error') {
    return (
      <p className="wb-setup-status" role="status">
        <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-warn" />
        Your tools hit a problem; the last step shows what happened
      </p>
    );
  }
  return null;
};
