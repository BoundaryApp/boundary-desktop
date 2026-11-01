import React, { useState } from 'react';
import { limitFor, localDay, usedToday } from '../../../shared/circleUsage';
import type { CircleLimit, CircleLimits, CirclesState } from '../../../shared/types/circles';
import { Input } from '../../components/ui/input';
import { CircleButton } from './CircleControls';
import { useAction } from './useCircles';

/**
 * Usage and limits (ADR 0034 §5). A provider sees every member's day; a member sees only their
 * own use of a provider. Both come from counts on this device.
 */

const NO_LIMITS: CircleLimits = { everyone: {}, members: {} };

function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}K` : String(tokens);
}

function describeLimit(limit: CircleLimit): string {
  const parts = [
    limit.requestsPerDay ? `${limit.requestsPerDay} requests` : null,
    limit.tokensPerDay ? `${formatTokens(limit.tokensPerDay)} tokens` : null,
    limit.concurrent ? `${limit.concurrent} at once` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'None';
}

const FIELDS = [
  { field: 'requestsPerDay', label: 'Requests a day' },
  { field: 'tokensPerDay', label: 'Tokens a day' },
  { field: 'concurrent', label: 'At once' },
] as const;

function LimitFields({ name, limit, onSave, busy }: { name: string; limit: CircleLimit; onSave: (limit: CircleLimit) => void; busy: boolean }) {
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(FIELDS.map(({ field }) => [field, limit[field] ? String(limit[field]) : '']))
  );
  const save = (): void => {
    const next: CircleLimit = {};
    for (const { field } of FIELDS) {
      const value = Number(draft[field]);
      if (Number.isSafeInteger(value) && value > 0) next[field] = value;
    }
    onSave(next);
  };
  return (
    <div className="flex flex-wrap items-end gap-2">
      <span className="grid max-w-[360px] min-w-0 flex-1 basis-[260px] grid-cols-3 gap-2">
      {FIELDS.map(({ field, label }) => (
        <label key={field} className="flex min-w-0 flex-col gap-1.5 text-xs text-fg-faint">
          {label}
          <Input
            type="number"
            min={1}
            aria-label={`${label} for ${name}`}
            className="h-[30px]"
            placeholder="No limit"
            value={draft[field]}
            onChange={(event) => setDraft({ ...draft, [field]: event.target.value })}
          />
        </label>
      ))}
      </span>
      <CircleButton size="panel" variant="outline" disabled={busy} onClick={save}>
        Save limit
      </CircleButton>
    </div>
  );
}

/** Today's members on Sharing, with who is running or waiting, and the limit for everyone. */
export function SharingUsage({ circles }: { circles: CirclesState }) {
  const action = useAction();
  const { sharing, served, serving } = circles;
  const limits = sharing.limits ?? NO_LIMITS;
  const today = localDay(new Date());
  const names = new Map(
    circles.snapshot.circles.flatMap((circle) => circle.members.map((member) => [member.identity, member.name] as const))
  );
  const counted = served?.day === today ? Object.keys(served.counts) : [];
  const waiting = serving ? [...(serving.running ? [serving.running] : []), ...serving.queued] : [];
  const rows = [...new Set([...waiting, ...counted])];
  const saveEveryone = (everyone: CircleLimit): void => {
    void action.run(() => window.electronAPI.circles.setSharing({ ...sharing, limits: { ...limits, everyone } }));
  };
  return (
    <section aria-label="Usage today" className="flex flex-col gap-3">
      {rows.length ? (
        <div className="wb-circle-box px-3 py-2.5">
        <table className="w-full text-ui text-fg">
          <thead className="text-left text-2xs text-fg-faint">
            <tr>
              <th className="pb-1.5 font-normal">Today</th>
              <th className="pb-1.5 font-normal">Status</th>
              <th className="pb-1.5 text-right font-normal">Requests</th>
              <th className="pb-1.5 text-right font-normal">Tokens</th>
              <th className="pb-1.5 text-right font-normal">Limit</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((identity) => {
              const used = usedToday(served, identity, today);
              const status = serving?.running === identity ? 'Running' : serving?.queued.includes(identity) ? 'Queued' : '';
              return (
                <tr key={identity} className="border-t border-line">
                  <td className="py-1">{names.get(identity) ?? 'Former member'}</td>
                  <td className={`py-1 ${status === 'Running' ? 'text-ok' : 'text-warn'}`}>{status}</td>
                  <td className="py-1 text-right">{used.requests}</td>
                  <td className="py-1 text-right">{formatTokens(used.tokens)}</td>
                  <td className="py-1 text-right text-fg-faint">{describeLimit(limitFor(limits, identity))}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      ) : (
        <p className="text-xs text-fg-faint">No member has used your models today.</p>
      )}
      <fieldset className="wb-circle-box flex flex-col gap-2">
        <legend>Limit for everyone</legend>
        <LimitFields name="everyone" limit={limits.everyone} busy={action.busy} onSave={saveEveryone} />
        <p className="text-xs text-fg-faint">
          Counts stay on this Mac and each member&apos;s own. Limits start over at midnight here, and a member over one moves on
          to their next model.
        </p>
      </fieldset>
      {action.error ? <p className="text-xs text-danger">{action.error}</p> : null}
    </section>
  );
}

/** One member's limit, which replaces the limit for everyone. */
export function MemberLimit({ identity, name, circles }: { identity: string; name: string; circles: CirclesState }) {
  const action = useAction();
  const { sharing } = circles;
  const limits = sharing.limits ?? NO_LIMITS;
  const own = limits.members[identity];
  const save = (members: CircleLimits['members']): void => {
    void action.run(() => window.electronAPI.circles.setSharing({ ...sharing, limits: { ...limits, members } }));
  };
  return (
    <section aria-label={`Limit for ${name}`} className="flex flex-col gap-2">
      <h3 className="text-2xs font-medium text-fg-faint">Limit for {name}</h3>
      <LimitFields
        key={own ? 'own' : 'everyone'}
        name={name}
        limit={limitFor(limits, identity)}
        busy={action.busy}
        onSave={(limit) => save({ ...limits.members, [identity]: limit })}
      />
      {own ? (
        <CircleButton
          size="panel"
          variant="outline"
          disabled={action.busy}
          onClick={() => save(Object.fromEntries(Object.entries(limits.members).filter(([other]) => other !== identity)))}
        >
          Use the limit for everyone
        </CircleButton>
      ) : null}
      {action.error ? <p className="text-xs text-danger">{action.error}</p> : null}
    </section>
  );
}

/** What the user used of a provider's models today, or nothing before their first request. */
export function YourUsage({ identity, circles }: { identity: string; circles: CirclesState }) {
  const used = usedToday(circles.used, identity, localDay(new Date()));
  if (!used.requests) return null;
  return (
    <p className="text-xs text-fg-faint">
      You used {used.requests} {used.requests === 1 ? 'request' : 'requests'} and {formatTokens(used.tokens)} tokens today.
    </p>
  );
}
