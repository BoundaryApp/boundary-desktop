import React, { useState } from 'react';
import { Button } from '../../components/ui/button';
import { Pill } from '../../components/ui/badge';
import { Sheet, SheetConfirmActions } from '../../components/ui/sheet';
import { cn } from '../../lib/utils';
import type { AddonListing, TwentyAccess, TwentyWorkspace } from '../../../shared/types/addons';
import { Panel } from './AddonPanel';
import { ACCESS_LABEL, keysText, OWNER_PASSWORD_COPIED } from './addonCopy';
import { agentName, openLocalTwenty, reloadTwenty } from './useTwenty';
import { FromYourCircles, SharedLine, ShareSheet, usedSlugs } from './SharedTwenty';
import { useSharedServices } from './useSharedServices';

const ACCESS_ORDER: TwentyAccess[] = ['read', 'write'];

/** What agents may do with one workspace. Unchecked choices that lack a key stay disabled. */
const AccessSwitch: React.FC<{
  value: TwentyAccess;
  onChange(next: TwentyAccess): void;
  missing?: Partial<Record<TwentyAccess, string>>;
  disabled?: boolean;
}> = ({ value, onChange, missing = {}, disabled }) => (
  <div
    role="radiogroup"
    aria-label="What agents may do"
    className="inline-flex items-center gap-0.5 rounded-md border border-line bg-surface-1 p-0.5"
  >
    {ACCESS_ORDER.map((access) => {
      const selected = value === access;
      const blocked = missing[access];
      return (
        <button
          key={access}
          type="button"
          role="radio"
          aria-checked={selected}
          disabled={disabled || Boolean(blocked)}
          title={blocked}
          onClick={() => {
            if (!selected) onChange(access);
          }}
          className={cn(
            'cursor-pointer rounded px-2.5 py-1 text-xs outline-none focus-visible:shadow-(--focus-ring) disabled:cursor-default disabled:opacity-50',
            selected ? 'bg-surface-hover font-medium text-fg' : 'text-fg-muted hover:text-fg'
          )}
        >
          {ACCESS_LABEL[access]}
        </button>
      );
    })}
  </div>
);

const MonoName: React.FC<{ workspace: TwentyWorkspace }> = ({ workspace }) => (
  <span className="font-mono text-2xs font-normal text-fg-muted">{agentName(workspace)}</span>
);

const Row: React.FC<{
  label: string;
  workspace: TwentyWorkspace;
  pill?: React.ReactNode;
  detail: string;
  control?: React.ReactNode;
  children: React.ReactNode;
}> = ({ label, workspace, pill, detail, control, children }) => (
  <li
    aria-label={`${label} ${agentName(workspace)}`}
    className="flex flex-col gap-2 border-t border-line py-3 first:border-t-0 first:pt-0"
  >
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-2 text-ui font-medium text-fg">
          {label}
          <MonoName workspace={workspace} />
          {pill}
        </span>
        <span className="text-xs text-fg-faint">{detail}</span>
      </div>
      {control}
    </div>
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-fg-muted">{children}</div>
  </li>
);

/** Runs a call that answers with a result, and returns the line to show when it fails. */
async function failure(call: () => Promise<{ success: boolean; error?: string }>, fallback: string): Promise<string | null> {
  try {
    const result = await call();
    return result.success ? null : (result.error ?? fallback);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const LocalRow: React.FC<{ listing: AddonListing; workspace: TwentyWorkspace; onTurnOn(): void }> = ({
  listing,
  workspace,
  onTurnOn,
}) => {
  const { sharing } = useSharedServices();
  const [sheet, setSheet] = useState<{ circle: string | null } | null>(null);
  const shared = sharing.filter((circle) => circle.offer);
  const unshared = sharing.filter((circle) => !circle.offer);
  const on = listing.installed;
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const port = listing.entry.port?.default;

  const setAccess = async (access: TwentyAccess) => {
    setError(await failure(() => window.electronAPI.addons.twenty.setAccess(workspace.slug, access), 'The change didn’t save.'));
    void reloadTwenty();
  };
  const copyPassword = async () => {
    const problem = await failure(() => window.electronAPI.addons.twenty.copyPassword(), 'Couldn’t copy the password.');
    setError(problem);
    setNote(problem ? null : OWNER_PASSWORD_COPIED);
  };

  return (
    <Row
      label="On this Mac"
      workspace={workspace}
      pill={on ? null : <Pill>Off</Pill>}
      detail={
        on
          ? `localhost:${port ?? 3000} · ${listing.entry.services.length} containers · data stays on this Mac`
          : 'Containers stopped. Its data stays on this Mac.'
      }
      control={
        on ? (
          workspace.skippedReason ? null : (
            <AccessSwitch value={workspace.access} onChange={(next) => void setAccess(next)} />
          )
        ) : null
      }
    >
      {on ? (
        <>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => void openLocalTwenty().then((line) => setNote(line))}
          >
            Open Twenty
          </Button>
          <span>Opens signed in as its owner</span>
          <span className="ml-auto flex flex-wrap items-center gap-1.5">
            Another browser or device?
            <span className="font-mono">{listing.entry.account?.username}</span>
            <button type="button" className="cursor-pointer text-brand hover:underline" onClick={() => void copyPassword()}>
              Copy password
            </button>
          </span>
          {workspace.skippedReason ? <span className="w-full text-warn">{workspace.skippedReason}</span> : null}
          {shared.map((circle) => (
            <SharedLine key={circle.circle} circle={circle} onChange={() => setSheet({ circle: circle.circle })} />
          ))}
          {unshared.length ? (
            <button type="button" className="cursor-pointer text-brand hover:underline" onClick={() => setSheet({ circle: null })}>
              {shared.length ? 'Share with another Circle…' : 'Share with a Circle…'}
            </button>
          ) : null}
          {sheet ? (
            <ShareSheet
              circles={sheet.circle ? sharing.filter((c) => c.circle === sheet.circle) : unshared}
              initial={sheet.circle}
              onClose={() => setSheet(null)}
            />
          ) : null}
        </>
      ) : (
        <Button type="button" size="sm" onClick={onTurnOn}>
          Turn on
        </Button>
      )}
      {note ? <span className="w-full">{note}</span> : null}
      {error ? <span className="w-full text-danger">{error}</span> : null}
    </Row>
  );
};

const HostedRow: React.FC<{ workspace: TwentyWorkspace; onDisconnect(): void }> = ({ workspace, onDisconnect }) => {
  const [error, setError] = useState<string | null>(null);

  const setAccess = async (access: TwentyAccess) => {
    setError(await failure(() => window.electronAPI.addons.twenty.setAccess(workspace.slug, access), 'The change didn’t save.'));
    void reloadTwenty();
  };
  const open = async () => {
    const target = workspace.workspaceUrl || workspace.url;
    setError(await failure(() => window.electronAPI.urls.openUrl(target), 'Couldn’t open the workspace.'));
  };

  return (
    <Row
      label="Hosted"
      workspace={workspace}
      detail={`${workspace.url} · ${keysText(workspace)}`}
      control={
        workspace.skippedReason ? null : (
          <AccessSwitch
            value={workspace.access}
            onChange={(next) => void setAccess(next)}
            missing={{
              read: workspace.hasReadKey ? undefined : 'Add a read-only key first',
              write: workspace.hasWriteKey ? undefined : 'Add a read-write key first',
            }}
          />
        )
      }
    >
      <Button type="button" size="sm" variant="secondary" onClick={() => void open()}>
        Open Twenty
      </Button>
      {workspace.skippedReason ? (
        <span className="text-warn">{workspace.skippedReason}</span>
      ) : (
        <span>
          {workspace.access === 'read'
            ? 'Limits depend on the role you gave the read-only key in Twenty.'
            : 'Agents can do what the read-write key’s role allows.'}
        </span>
      )}
      <button type="button" className="ml-auto cursor-pointer text-brand hover:underline" onClick={onDisconnect}>
        Disconnect
      </button>
      {error ? <span className="w-full text-danger">{error}</span> : null}
    </Row>
  );
};

const DisconnectSheet: React.FC<{
  workspace: TwentyWorkspace | null;
  last: boolean;
  onClose(): void;
}> = ({ workspace, last, onClose }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!workspace) return null;
  const name = agentName(workspace);

  const close = () => {
    setError(null);
    onClose();
  };
  const confirm = async () => {
    setBusy(true);
    const problem = await failure(() => window.electronAPI.addons.twenty.disconnect(workspace.slug), `Couldn’t disconnect ${name}.`);
    setBusy(false);
    void reloadTwenty();
    if (problem) setError(problem);
    else close();
  };

  return (
    <Sheet
      open
      onClose={close}
      busy={busy}
      titleId="twenty-disconnect-title"
      title={`Disconnect ${name}?`}
      error={error}
      actions={
        <SheetConfirmActions
          busy={busy}
          tone="danger"
          onCancel={close}
          confirmLabel={busy ? 'Disconnecting…' : 'Disconnect'}
          onConfirm={() => void confirm()}
        />
      }
    >
      <p className="wb-sheet-lede">
        {`Agents lose this workspace after the next assistant restart. The workspace and its records stay in Twenty. Boundary forgets the keys; revoke them in Twenty if you no longer need them.${last ? ' Twenty CRM then has nothing connected.' : ''}`}
      </p>
    </Sheet>
  );
};

/** Each workspace the agents can reach, with what they may do in it. */
export const TwentyWorkspaces: React.FC<{
  listing: AddonListing;
  workspaces: TwentyWorkspace[];
  onConnect(): void;
  /** Starts the install, which brings back a local workspace that was turned off. */
  onTurnOn(): void;
  /** Shown when nothing runs here yet; opens the install choices. */
  onRunHere?: () => void;
}> = ({ listing, workspaces, onConnect, onTurnOn, onRunHere }) => {
  const [leaving, setLeaving] = useState<TwentyWorkspace | null>(null);
  const { offered } = useSharedServices();
  const fromCircles = usedSlugs(offered);
  const hosted = workspaces.filter((w) => !w.local && !fromCircles.has(w.slug));
  const local = workspaces.find((w) => w.local);
  const setAccess = (slug: string, access: TwentyAccess): void => {
    void window.electronAPI.addons.twenty
      .setAccess(slug, access)
      .catch((): void => undefined)
      .finally((): void => void reloadTwenty());
  };
  return (
    <>
    <Panel title="Workspaces" lead="Each one is a set of tools your default and browser agents can use, named as shown.">
      {workspaces.length ? (
        <ul className="flex flex-col">
          {local ? <LocalRow listing={listing} workspace={local} onTurnOn={onTurnOn} /> : null}
          {hosted.map((workspace) => (
            <HostedRow key={workspace.slug} workspace={workspace} onDisconnect={() => setLeaving(workspace)} />
          ))}
        </ul>
      ) : null}
      <div className="mt-1 flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="secondary" onClick={onConnect}>
          Connect a hosted workspace
        </Button>
        {!local && onRunHere ? (
          <Button type="button" size="sm" variant="secondary" onClick={onRunHere}>
            Also run Twenty on this Mac
          </Button>
        ) : null}
      </div>
      <DisconnectSheet workspace={leaving} last={!local && hosted.length === 1} onClose={() => setLeaving(null)} />
    </Panel>
    <FromYourCircles
      offered={offered}
      accessOf={(slug) => workspaces.find((w) => w.slug === slug)?.access ?? null}
      accessSwitch={(slug, value) => <AccessSwitch value={value} onChange={(next) => setAccess(slug, next)} />}
    />
    </>
  );
};
