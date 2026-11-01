import React, { useState } from 'react';
import { X } from 'lucide-react';
import type { CircleMemberView, CircleProviderSettings, CircleSnapshot, CirclesState } from '../../../shared/types/circles';
import type { InferenceChainEntry } from '../../../shared/types/inferenceChain';
import { Button } from '../../components/ui/button';
import { Avatar, CircleButton, CircleSwitch } from './CircleControls';
import { beginAppSwitch, endAppSwitch, useAppSwitch } from '../../onboarding/appSwitch';
import { takeInferenceStatus, useInferenceStatus } from '../../onboarding/inferenceStatus';
import { AppSwitchProgress } from '../AppSwitchProgress';
import { describeChainEntry, entryKey, type ChainContext } from '../chat/ChainEditor';
import { MemberLimit, YourUsage } from './CircleUsage';
import { useAction } from './useCircles';
import { APP_NAME } from '../../../shared/buildIdentity';

/**
 * One person, whichever Circle they're reached through: what the user accepts from them, their
 * models, and, for an admin on a Circle's page, their place in that Circle. Trust belongs to the
 * person (ADR 0034 §3), so the Circle page and setup show the same content.
 */

const api = () => window.electronAPI.circles;

const NO_SETTINGS: CircleProviderSettings = { private: false, trusted: false };

/** A person's models, once each. A model offered in two Circles uses one where it can answer. */
export function personEntries(circles: CirclesState, identity: string): InferenceChainEntry[] {
  const offers = circles.snapshot.circles.flatMap((circle) =>
    circle.offers.filter((offer) => offer.identity === identity && !offer.isMine).map((offer) => ({ circle, offer }))
  );
  const reachable = [...offers.filter(({ offer }) => offer.online && offer.available), ...offers];
  const entries = new Map<string, InferenceChainEntry>();
  for (const { circle, offer } of reachable) {
    for (const model of offer.models) {
      if (entries.has(model.id)) continue;
      entries.set(model.id, { slot: 'peer', modelId: model.id, peer: { circleId: circle.key, providerId: identity } });
    }
  }
  return [...entries.values()];
}

/** Whether this model is already in the chain, ignoring which Circle it came through. */
export function samePeerModel(entry: InferenceChainEntry, other: InferenceChainEntry | null | undefined): boolean {
  return other?.slot === 'peer' && other.peer?.providerId === entry.peer?.providerId && other.modelId === entry.modelId;
}

function ClaimSwitch({
  label,
  detail,
  on,
  disabled,
  onToggle,
}: {
  label: string;
  detail: string;
  on: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <CircleSwitch label={label} on={on} disabled={disabled} onToggle={onToggle} />
      <span className="flex flex-col">
        <span className="text-ui text-fg">{label}</span>
        <span className="text-xs text-fg-faint">{detail}</span>
      </span>
    </div>
  );
}

/** The two claims a user makes about a provider (ADR 0034 §3). Neither can be checked. */
export function ProviderClaims({ identity, name, circles }: { identity: string; name: string; circles: CirclesState }) {
  const settings = circles.providers[identity] ?? NO_SETTINGS;
  const action = useAction();
  const save = (next: CircleProviderSettings): void => {
    void action.run(() => api().setProviderSettings({ identity, ...next }));
  };
  return (
    <section aria-label={`What you accept from ${name}`} className="flex flex-col gap-2.5">
      <h3 className="text-2xs font-medium text-fg-faint">What you accept from {name}</h3>
      <ClaimSwitch
        label="Trusted"
        detail={`${name}'s model can run your agent's tools. Needed before it can answer your chats.`}
        on={settings.trusted}
        disabled={action.busy}
        onToggle={() => save({ ...settings, trusted: !settings.trusted })}
      />
      <ClaimSwitch
        label="Allow in private projects"
        detail={`${name}'s Mac sees every prompt it serves. On, private projects can use their models.`}
        on={settings.private}
        disabled={action.busy}
        onToggle={() => save({ ...settings, private: !settings.private })}
      />
      <p className="text-xs text-fg-faint">
        {APP_NAME} can't check either. Both apply to {name} in every Circle you share.
      </p>
      {action.error ? <p className="text-xs text-danger">{action.error}</p> : null}
    </section>
  );
}

function ModelCard({
  entry,
  name,
  ctx,
  canAddFallback,
  isFallback,
  isDefault,
  busy,
  onDefault,
  onFallback,
}: {
  entry: InferenceChainEntry;
  name: string;
  ctx: ChainContext;
  canAddFallback: boolean;
  isFallback: boolean;
  isDefault: boolean;
  busy: boolean;
  onDefault: () => void;
  onFallback: () => void;
}) {
  const trusted = ctx.circles.providers[entry.peer?.providerId ?? '']?.trusted === true;
  const view = describeChainEntry(entry, ctx, 'first');
  // An offline provider's model can be chosen for when they're back (ADR 0036 §5).
  const blocked = view.skipped && !view.offline;
  return (
    <li className="flex flex-col gap-2 rounded-md border border-line p-2.5">
      <span className="font-mono text-xs break-all text-fg">{entry.modelId}</span>
      {isDefault ? (
        <span className={`text-xs ${trusted ? 'text-ok' : 'text-warn'}`}>
          {trusted ? 'Your default model' : `Still your default, but chats can't use it until you trust ${name}.`}
        </span>
      ) : (
        <span className="flex gap-1.5">
          <CircleButton size="panel" variant="default" className="flex-1" disabled={busy || blocked} onClick={onDefault}>
            Use as default
          </CircleButton>
          {canAddFallback ? (
            <CircleButton size="panel" variant="outline" className="flex-1" disabled={busy || blocked || isFallback} onClick={onFallback}>
              {isFallback ? 'In your fallbacks' : 'Add as fallback'}
            </CircleButton>
          ) : null}
        </span>
      )}
      {!isDefault && !trusted ? <span className="text-xs text-fg-faint">Trust {name} to use this model.</span> : null}
      {!isDefault && trusted && (blocked || view.offline) ? (
        <span className="text-xs text-fg-faint">{blocked ? `${name} isn't sharing it now.` : `${name} is offline now.`}</span>
      ) : null}
    </li>
  );
}

/**
 * A person's models and what the user can do with them. `onPick` replaces the app switch for
 * setup, where nothing is running yet and there's no chain to add a fallback to.
 */
export function PersonModels({
  identity,
  name,
  circles,
  onPick,
  disabled = false,
}: {
  identity: string;
  name: string;
  circles: CirclesState;
  onPick?: (entry: InferenceChainEntry) => void;
  disabled?: boolean;
}) {
  const { status } = useInferenceStatus();
  const { appSwitch } = useAppSwitch();
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);
  const entries = personEntries(circles, identity);
  if (!entries.length) return null;

  const ctx: ChainContext = { slots: status?.slots ?? {}, circles };
  const current = status?.appSharedModel ?? null;
  const previous = current ?? (status?.appDefault ? { slot: status.appDefault } : null);
  const fallbacks = status?.appFallbacks ?? [];

  const useAsDefault = async (entry: InferenceChainEntry) => {
    if (onPick) return onPick(entry);
    setNote(null);
    beginAppSwitch(entry, previous);
    try {
      const result = await window.electronAPI.onboarding.setAppSharedModel({ entry });
      await takeInferenceStatus(result);
      if (result.cancelled) return;
      endAppSwitch();
      if (!result.success) setNote({ text: result.error ?? 'Unable to use that shared model.', bad: true });
      else if (result.applyError) {
        setNote({ text: `Saved, but the assistant didn’t switch: ${result.applyError} Your next message tries again.`, bad: true });
      } else if (result.deferred) {
        setNote({ text: 'Saved. A reply is still running, so the assistant moves on your next message.', bad: false });
      }
    } catch (err) {
      endAppSwitch();
      setNote({ text: err instanceof Error ? err.message : 'Unable to use that shared model.', bad: true });
    }
  };

  const addFallback = async (entry: InferenceChainEntry) => {
    setSaving(true);
    setNote(null);
    try {
      const result = await window.electronAPI.onboarding.setAppFallbacks({ fallbacks: [...fallbacks, entry] });
      if (!result.success) {
        setNote({ text: result.error ?? 'Unable to save the fallbacks.', bad: true });
        return;
      }
      await takeInferenceStatus(result);
      setNote({ text: 'Added. It takes effect on your next message.', bad: false });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section aria-label={`${name}'s models`} className="flex flex-col gap-2">
      <h3 className="text-2xs font-medium text-fg-faint">Models</h3>
      <ul className="flex flex-col gap-2">
        {entries.map((entry) => (
          <ModelCard
            key={entryKey(entry)}
            entry={entry}
            name={name}
            ctx={ctx}
            canAddFallback={!onPick && previous !== null}
            isFallback={fallbacks.some((fallback) => samePeerModel(entry, fallback))}
            isDefault={samePeerModel(entry, current)}
            busy={disabled || saving || appSwitch !== null}
            onDefault={() => void useAsDefault(entry)}
            onFallback={() => void addFallback(entry)}
          />
        ))}
      </ul>
      {appSwitch && entries.some((entry) => samePeerModel(entry, appSwitch.target)) ? <AppSwitchProgress appSwitch={appSwitch} /> : null}
      {note ? <p className={`text-xs ${note.bad ? 'text-danger' : 'text-fg-muted'}`}>{note.text}</p> : null}
    </section>
  );
}

function CircleActions({
  circle,
  member,
  onRemove,
}: {
  circle: CircleSnapshot;
  member: CircleMemberView;
  onRemove: () => void;
}) {
  const action = useAction();
  return (
    <section aria-label={`In ${circle.name}`} className="mt-auto flex flex-col gap-1.5 border-t border-line pt-3">
      <h3 className="text-2xs font-medium text-fg-faint">In {circle.name}</h3>
      <span className="flex gap-1.5">
        <CircleButton
          size="panel"
          variant="outline"
          className="flex-1"
          disabled={action.busy}
          onClick={() =>
            void action.run(() =>
              api().setRole({ key: circle.key, identity: member.identity, role: member.role === 'admin' ? 'member' : 'admin' })
            )
          }
        >
          {member.role === 'admin' ? 'Make member' : 'Make admin'}
        </CircleButton>
        <CircleButton size="panel" variant="destructive" className="flex-1" onClick={onRemove}>
          Remove
        </CircleButton>
      </span>
      {action.error ? <p className="text-xs text-danger">{action.error}</p> : null}
    </section>
  );
}

export function PersonPanel({
  circles,
  circle,
  member,
  onClose,
  onRemove,
}: {
  circles: CirclesState;
  /** The Circle page it opened from, for an admin's actions. Null from Sharing. */
  circle: CircleSnapshot | null;
  member: CircleMemberView;
  onClose: () => void;
  onRemove: (member: CircleMemberView) => void;
}) {
  const shared = circles.snapshot.circles.filter((item) => item.members.some((other) => other.identity === member.identity));
  const hasModels = personEntries(circles, member.identity).length > 0;
  return (
    <aside
      aria-label={member.name}
      className="wb-circles-panel flex w-[320px] shrink-0 flex-col gap-[18px] overflow-y-auto border-l border-line bg-surface-1"
    >
      <div className="flex items-center gap-2.5">
        <Avatar name={member.name} large />
        <span className="flex min-w-0 flex-1 flex-col">
          <h2 className="text-title font-medium break-words text-fg">{member.name}</h2>
          <span className="text-xs text-fg-faint">
            {member.online ? 'Online' : 'Offline'} · In {shared.map((item) => item.name).join(', ')}
          </span>
        </span>
        <Button size="sm" variant="ghost" aria-label="Close" onClick={onClose}>
          <X className="size-4" aria-hidden />
        </Button>
      </div>
      {hasModels ? <ProviderClaims identity={member.identity} name={member.name} circles={circles} /> : null}
      <PersonModels identity={member.identity} name={member.name} circles={circles} />
      <YourUsage identity={member.identity} circles={circles} />
      {circles.sharing.models.length > 0 && !member.isMe ? (
        <MemberLimit identity={member.identity} name={member.name} circles={circles} />
      ) : null}
      {circle?.myRole === 'admin' ? <CircleActions circle={circle} member={member} onRemove={() => onRemove(member)} /> : null}
    </aside>
  );
}
