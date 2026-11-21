import React, { useState } from 'react';
import type { ShareLevel } from '../../../shared/serviceOffers';
import type { TwentyAccess } from '../../../shared/types/addons';
import type { OfferedService, SharingCircle } from '../../../shared/types/sharedServices';
import { Pill } from '../../components/ui/badge';
import { NativeSelect } from '../../components/ui/native-select';
import { Field } from '../../components/ui/field';
import { Segmented } from '../../components/ui/segmented';
import { Sheet, SheetConfirmActions } from '../../components/ui/sheet';
import { useSheetAction } from '../../components/ui/use-sheet-action';
import { Panel } from './AddonPanel';
import { ACCESS_LABEL } from './addonCopy';
import { reloadSharedServices } from './useSharedServices';
import { lineFromIpc } from './addonPageActions';

/** What a Circles call shows when it fails without saying why. */
const CIRCLES_FALLBACK = 'That didn’t work.';
import { reloadTwenty } from './useTwenty';
import { ChoiceRow } from '../../components/ui/choice-row';
import { Checkbox } from '../../components/ui/checkbox';
import { STACK_CAPABILITY_MISSING_TEXT } from '../../../shared/stackCapabilities';
import { useStackCapability } from '../stackCapabilities';

type MemberChoice = ShareLevel | 'none';

const MEMBER_LABEL: Record<MemberChoice, string> = {
  none: 'No access',
  read: 'Look things up',
  write: 'Make changes',
};

const levelText = (level: ShareLevel | null): string => (level ? MEMBER_LABEL[level] : MEMBER_LABEL.none);

/** Share this Mac's Twenty with one Circle, or change how (ADR 0048 §8). */
export const ShareSheet: React.FC<{
  circles: SharingCircle[];
  initial: string | null;
  onClose(): void;
}> = ({ circles, initial, onClose }) => {
  const [circleKey, setCircleKey] = useState(initial ?? circles.find((c) => !c.offer)?.circle ?? circles[0]?.circle ?? '');
  const circle = circles.find((c) => c.circle === circleKey) ?? circles[0];
  const [write, setWrite] = useState(Boolean(circle?.offer?.levels.includes('write')));
  const [away, setAway] = useState(circle?.offer?.away ?? false);
  const [members, setMembers] = useState<Record<string, MemberChoice>>(() =>
    Object.fromEntries((circle?.members ?? []).map((m) => [m.identity, m.level ?? (circle?.offer ? 'none' : 'read')]))
  );
  const { busy, error, setError, run } = useSheetAction();
  if (!circle) return null;

  const pick = (key: string) => {
    const next = circles.find((c) => c.circle === key);
    if (!next) return;
    setCircleKey(key);
    setWrite(Boolean(next.offer?.levels.includes('write')));
    setAway(next.offer?.away ?? false);
    setMembers(Object.fromEntries(next.members.map((m) => [m.identity, m.level ?? (next.offer ? 'none' : 'read')])));
  };

  const save = async () => {
    const problem = await run(() => lineFromIpc(() =>
      window.electronAPI.circles.serviceShare({
        circle: circle.circle,
        write,
        away,
        members: Object.fromEntries(
          Object.entries(members).map(([identity, choice]) => [
            identity,
            choice === 'none' ? null : choice === 'write' && !write ? 'read' : choice,
          ])
        ),
      }), CIRCLES_FALLBACK
    ));
    void reloadSharedServices();
    if (problem) setError(problem);
    else onClose();
  };

  const options = (write ? (['none', 'read', 'write'] as const) : (['none', 'read'] as const)).map((value) => ({
    value,
    label: MEMBER_LABEL[value],
  }));

  return (
    <Sheet
      open
      onClose={onClose}
      busy={busy}
      titleId="twenty-share-title"
      title={circle.offer ? `Twenty in ${circle.circleName}` : 'Share Twenty with a Circle'}
      error={error}
      actions={
        <SheetConfirmActions
          busy={busy}
          onCancel={onClose}
          confirmLabel={busy ? 'Saving…' : circle.offer ? 'Save' : 'Share'}
          onConfirm={() => void save()}
        />
      }
    >
      <p className="wb-sheet-lede">
        Members’ agents reach this Mac’s Twenty through you. You see what they look up and write, and each change carries the
        member’s name in Twenty.
      </p>
      {circles.length > 1 && !initial ? (
        <Field label="Circle" htmlFor="twenty-share-circle">
          <NativeSelect
            id="twenty-share-circle"
            value={circle.circle}
            disabled={busy}
            onChange={(event) => pick(event.target.value)}
          >
            {circles.map((c) => (
              <option key={c.circle} value={c.circle}>
                {c.circleName}
              </option>
            ))}
          </NativeSelect>
        </Field>
      ) : null}
      <Field
        label="Members may"
        htmlFor="twenty-share-levels"
        hint="Allowing changes lets you give it to some members. People who join later get no access until you give it."
      >
        <Segmented
          aria-label="Members may"
          value={write ? 'write' : 'read'}
          onChange={(value) => setWrite(value === 'write')}
          options={[
            { value: 'read', label: ACCESS_LABEL.read },
            { value: 'write', label: ACCESS_LABEL.write },
          ]}
        />
      </Field>
      {circle.members.length ? (
        <Field label="Each member" htmlFor="twenty-share-members">
          <ul id="twenty-share-members" className="flex flex-col rounded-md border border-line">
            {circle.members.map((member) => {
              const choice = members[member.identity] ?? 'none';
              return (
                <li
                  key={member.identity}
                  className="flex items-center justify-between gap-3 border-t border-line px-2.5 py-1.5 first:border-t-0"
                >
                  <span className="truncate text-ui text-fg">{member.name}</span>
                  <Segmented
                    aria-label={`What ${member.name} may do`}
                    value={choice === 'write' && !write ? 'read' : choice}
                    onChange={(value) =>
                      setMembers((current) => ({
                        ...current,
                        [member.identity]: value,
                      }))
                    }
                    options={options}
                  />
                </li>
              );
            })}
          </ul>
        </Field>
      ) : (
        <p className="text-xs text-fg-faint">Nobody else is in this Circle yet.</p>
      )}
      <ChoiceRow
        control={<Checkbox checked={away} disabled={busy} onChange={(event) => setAway(event.target.checked)} />}
        title="Keep this Mac awake while Boundary is open"
      />
    </Sheet>
  );
};

/** One Circle this Mac's Twenty is shared with, under the On this Mac row. */
export const SharedLine: React.FC<{
  circle: SharingCircle;
  onChange(): void;
}> = ({ circle, onChange }) => {
  const { busy, error, setError, run } = useSheetAction();
  const offer = circle.offer!;
  const withAccess = circle.members.filter((m) => m.level);
  const without = circle.members.length - withAccess.length;

  const stop = async () => {
    await run(async () =>
      setError(
        await lineFromIpc(() => window.electronAPI.circles.serviceStopSharing({ circle: circle.circle }), CIRCLES_FALLBACK)
      )
    );
    void reloadSharedServices();
  };

  return (
    <div
      aria-label={`Shared with ${circle.circleName}`}
      className="flex w-full flex-col gap-1.5 rounded-md border border-line bg-surface-2 px-3 py-2.5"
    >
      <span className="flex items-center gap-2 text-xs font-medium text-fg">
        Shared with {circle.circleName}
        <Pill>{offer.levels.includes('write') ? 'Changes allowed' : 'Look things up only'}</Pill>
      </span>
      <span className="flex flex-wrap gap-x-3.5 gap-y-1">
        {withAccess.map((m) => (
          <span key={m.identity}>
            {m.name} · {levelText(m.level)} · {m.callsToday} {m.callsToday === 1 ? 'call' : 'calls'} today
          </span>
        ))}
        {without ? (
          <span className="text-fg-faint">{without === 1 ? '1 member has' : `${without} members have`} no access</span>
        ) : null}
      </span>
      <span className="flex flex-wrap items-center gap-3">
        <button type="button" className="cursor-pointer text-brand hover:underline" onClick={onChange}>
          Change…
        </button>
        {offer.away ? <span>Keeps this Mac awake while Boundary is open</span> : null}
        <button
          type="button"
          disabled={busy}
          className="ml-auto cursor-pointer text-danger hover:underline"
          onClick={() => void stop()}
        >
          {busy ? 'Stopping…' : 'Stop sharing'}
        </button>
      </span>
      {error ? <span className="text-danger">{error}</span> : null}
    </div>
  );
};

const OfferedRow: React.FC<{
  offer: OfferedService;
  access: TwentyAccess | null;
  accessSwitch(slug: string, value: TwentyAccess): React.ReactNode;
}> = ({ offer, access, accessSwitch }) => {
  const { busy, error, setError, run } = useSheetAction();
  const used = offer.slug !== null;
  // Turning one on needs the stack's containers to reach a listener on this machine.
  const canUse = useStackCapability('hostCallbacks') || used;

  const toggle = async (on: boolean, access: TwentyAccess = 'read') => {
    const ref = {
      circle: offer.circle,
      provider: offer.provider,
      service: offer.service,
    };
    await run(async () =>
      setError(
        await lineFromIpc(
          () => (on ? window.electronAPI.circles.serviceUse({ ...ref, access }) : window.electronAPI.circles.serviceStopUsing(ref)),
          CIRCLES_FALLBACK
        )
      )
    );
    void reloadSharedServices();
    void reloadTwenty();
  };

  const allows = offer.levels.includes('write') ? 'look things up and make changes' : 'look things up';
  const line = !canUse
    ? STACK_CAPABILITY_MISSING_TEXT.hostCallbacks
    : !offer.available
    ? `${offer.providerName} has paused sharing it.`
    : !offer.online
      ? `Calls say ${offer.providerName}’s Mac is offline until it’s back.`
      : used
        ? `${offer.providerName} sees what your agent looks up and writes here.`
        : 'Adds its tools to every chat after a restart.';

  return (
    <li
      aria-label={`${offer.providerName}’s ${offer.name} in ${offer.circleName}`}
      className="flex flex-col gap-2 border-t border-line py-3 first:border-t-0 first:pt-0"
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-2 text-ui font-medium text-fg">
          {offer.providerName}’s {offer.name}
          {offer.online ? <Pill>Online</Pill> : <Pill>Offline</Pill>}
          {used ? <span className="font-mono text-2xs font-normal text-fg-muted">crm-{offer.slug}</span> : null}
        </span>
        <span className="text-xs text-fg-faint">
          {offer.circleName} · {offer.providerName} lets members {allows}
        </span>
      </div>
      {offer.slug && access ? <div>{accessSwitch(offer.slug, access)}</div> : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-fg-muted">
        <ChoiceRow
          control={<Checkbox checked={used} disabled={busy || !canUse} onChange={(event) => void toggle(event.target.checked)} />}
          title="Use in my agent"
        />
        <span>{line}</span>
        {error ? <span className="w-full text-danger">{error}</span> : null}
      </div>
    </li>
  );
};

/** Workspaces others share with this user (ADR 0048 §6). */
export const FromYourCircles: React.FC<{
  offered: OfferedService[];
  /** A used workspace's access, by slug. */
  accessOf(slug: string): TwentyAccess | null;
  accessSwitch(slug: string, value: TwentyAccess): React.ReactNode;
}> = ({ offered, accessOf, accessSwitch }) =>
  offered.length ? (
    <Panel title="From your Circles" lead="Workspaces people share with you. Your agent reaches them through that person’s Mac.">
      <ul className="flex flex-col">
        {offered.map((offer) => (
          <OfferedRow
            key={`${offer.circle}/${offer.provider}/${offer.service}`}
            offer={offer}
            access={offer.slug ? accessOf(offer.slug) : null}
            accessSwitch={accessSwitch}
          />
        ))}
      </ul>
    </Panel>
  ) : null;

/** Which hosted workspaces are a Circle's shared one, so the hosted list leaves them out. */
export const usedSlugs = (offered: OfferedService[]): Set<string> =>
  new Set(offered.map((offer) => offer.slug).filter((slug): slug is string => slug !== null));

/**
 * The shared workspace a tool call went to, from its name. Hermes names MCP tools
 * `mcp__<server>__<tool>` with every character outside `[A-Za-z0-9_]` turned into `_`
 * (`sanitize_mcp_name_component`, Hermes v0.23.1), so `crm-ada-family` is `mcp__crm_ada_family__`.
 */
export function sharedToolSource(toolName: string, offered: OfferedService[]): OfferedService | null {
  for (const offer of offered) {
    if (!offer.slug) continue;
    const prefix = `mcp__${`crm-${offer.slug}`.replace(/[^A-Za-z0-9_]/g, '_')}__`;
    if (toolName.startsWith(prefix)) return offer;
  }
  return null;
}
