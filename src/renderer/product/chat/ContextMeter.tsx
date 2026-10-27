import React, { useMemo } from 'react';
import type { HermesChatContextBreakdown, HermesChatUsageSnapshot } from '../../../shared/types/hermesChat';
import { formatContextGauge, splitContextBar } from './chatTelemetryFormat';

/** The context window's fill under the header, split into system / tools and conversation. */
export const ContextMeter: React.FC<{
  usage: HermesChatUsageSnapshot | null;
  categories: HermesChatContextBreakdown['categories'] | null;
}> = ({ usage, categories }) => {
  const gauge = useMemo(() => formatContextGauge(usage), [usage]);
  // usage.prompt / usage.completion are session-lifetime totals (every API call re-sends the
  // window), so they can't size a share of the window; the breakdown's categories can.
  const barSplit = useMemo(
    () => splitContextBar(gauge.percent, categories),
    [gauge.percent, categories]
  );
  if (gauge.empty) return null;
  return (
    <div className="wb-meter">
      <span className="mono">{gauge.label}</span>
      {gauge.showBar && gauge.percent != null ? (
        <div className="wb-usage" aria-hidden="true">
          {barSplit ? (
            <>
              <i className="oh" style={{ width: `${barSplit.overhead}%` }} title="system / tools" />
              <i
                className="out"
                style={{ width: `${barSplit.conversation}%` }}
                title="conversation"
              />
            </>
          ) : (
            <i className="single" style={{ width: `${Math.min(100, gauge.percent)}%` }} />
          )}
        </div>
      ) : null}
      {gauge.showBar && barSplit ? (
        <div className="wb-key">
          <span>
            <i className="k-oh" />
            system / tools
          </span>
          <span>
            <i className="k-out" />
            conversation
          </span>
        </div>
      ) : null}
    </div>
  );
};
