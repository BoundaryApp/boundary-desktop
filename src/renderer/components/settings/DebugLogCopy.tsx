import React, { useState } from 'react';
import { CheckCircle, ChevronRight, Copy } from 'lucide-react';
import { capabilityIPC } from '../../services/capabilityIPCService';
import { Button } from '../ui/button';
import { cn } from '../../lib/utils';

type DebugLogCopyProps = {
  path?: string | null;
  className?: string;
};

export const DebugLogCopy: React.FC<DebugLogCopyProps> = ({ path, className }) => {
  const [copied, setCopied] = useState<'log' | 'path' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleCopyLog = async () => {
    setError(null);
    try {
      const { path: logPath, contents } = await capabilityIPC.getDebugLog();
      await navigator.clipboard.writeText(
        `Log path: ${logPath}\n\n${contents}`
      );
      setCopied('log');
      window.setTimeout(() => setCopied(null), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not copy debug log');
    }
  };

  const handleCopyPath = async () => {
    if (!path) return;
    setError(null);
    try {
      await navigator.clipboard.writeText(path);
      setCopied('path');
      window.setTimeout(() => setCopied(null), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not copy path');
    }
  };

  return (
    <details className={cn('group text-xs text-fg-faint', className)}>
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-sm transition-colors duration-(--dur-fast) hover:text-fg-muted focus-visible:shadow-(--focus-ring) focus-visible:outline-none">
        <ChevronRight
          aria-hidden="true"
          className="size-3.5 transition-transform duration-(--dur-fast) group-open:rotate-90"
        />
        Troubleshooting
      </summary>
      <div className="mt-2 space-y-2 pl-4.5">
        <p>Share the debug log if you ask for help.</p>
        {path && <p className="break-all font-mono text-fg-muted">{path}</p>}
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => void handleCopyLog()}>
            {copied === 'log' ? <CheckCircle aria-hidden="true" /> : <Copy aria-hidden="true" />}
            {copied === 'log' ? 'Copied log' : 'Copy log'}
          </Button>
          {path && (
            <Button type="button" variant="outline" size="sm" onClick={() => void handleCopyPath()}>
              {copied === 'path' ? 'Copied path' : 'Copy path'}
            </Button>
          )}
        </div>
        {error && <p className="text-danger">{error}</p>}
      </div>
    </details>
  );
};
