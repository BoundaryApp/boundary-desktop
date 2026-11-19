import React, { useState } from 'react';
import { Callout } from '../../components/ui/alert';
import { Field } from '../../components/ui/field';
import { Sheet, SheetConfirmActions } from '../../components/ui/sheet';
import { cn } from '../../lib/utils';
import type { TwentyAccess, TwentyConnectInput, TwentyConnectResult } from '../../../shared/types/addons';
import { ACCESS_LABEL } from './addonCopy';
import { ChangeWayLink, STILL_SHEET } from './addonFormParts';
import { reloadTwenty } from './useTwenty';

// The form for connecting a hosted Twenty workspace (docs/addons-ux-study/phase4.html, the
// connect dialog). Main passes the keys to `crm.sh add`, which checks each one with Twenty
// before saving. The keys live only in the two controlled inputs, and the form unmounts, and
// forgets them, when the sheet closes.

const SLUG = /^[a-z0-9-]+$/;
const URL_START = /^https?:\/\/\S+$/;
const ACCESS_HELP: Record<TwentyAccess, string> = {
  read: 'Uses the read-only key. What it can still change depends on its role in Twenty.',
  write: 'Uses the read-write key.',
};
const KEY_NAME = { RW: 'read-write', RO: 'read-only' } as const;

type Failed = Extract<TwentyConnectResult, { ok: false }>;
type Row = { text: string; look: 'run' | 'pending' | 'done' | 'fail' };

function failureText(result: Failed, url: string): { title: string; body: string } {
  const key = result.key ? KEY_NAME[result.key] : null;
  switch (result.reason) {
    case 'no-answer':
      return {
        title: `No answer from ${url}`,
        body: 'Check the address. It should be the address you open Twenty at, without a path.',
      };
    case 'rejected':
      return {
        title: `Twenty rejected the ${key} key`,
        body: `It answered ${result.status}. Check that you copied the whole key and that it hasn’t been revoked.`,
      };
    case 'exists':
      return { title: 'That name is taken', body: result.message };
    case 'no-catalog':
      return {
        title: 'This Twenty doesn’t list the tools agents use',
        body: `Both keys worked, but agents reach records through get_tool_catalog, learn_tools and execute_tool, and ${url} doesn’t list all three. This version of Twenty may need a newer agent stack.`,
      };
    case 'invalid':
      return { title: 'Boundary couldn’t use these details', body: result.message };
    case 'failed':
      return {
        title: key ? `Twenty couldn’t check the ${key} key` : 'The check didn’t finish',
        body: result.message,
      };
  }
}

/** The checks, as far as they got: `failedAt` is the row that stopped the run, or null. */
function checkRows(url: string, keys: Array<'RW' | 'RO'>, outcome: 'running' | 'ok' | Failed): Row[] {
  const names: Row[] = [
    { text: `Reaching ${url}/mcp`, look: 'pending' },
    ...keys.map((k): Row => ({ text: `Checking the ${KEY_NAME[k]} key`, look: 'pending' })),
  ];
  if (outcome === 'running') return names.map((r, i) => ({ ...r, look: i === 0 ? 'run' : 'pending' }));
  if (outcome === 'ok') return names.map((r) => ({ ...r, look: 'done' }));
  // Every key passed; the stack's tool check came after them.
  if (outcome.reason === 'no-catalog') {
    return [...names.map((r): Row => ({ ...r, look: 'done' })), { text: 'Checking the tools Twenty lists', look: 'fail' }];
  }
  const at = outcome.reason === 'no-answer' ? 0 : outcome.key ? 1 + keys.indexOf(outcome.key) : -1;
  if (at < 0) return [];
  return names.slice(0, at + 1).map((r, i) => ({ ...r, look: i === at ? 'fail' : 'done' }));
}

const ConnectForm: React.FC<{ existing: string[]; onClose(): void; onChangeWay?(): void }> = ({
  existing,
  onClose,
  onChangeWay,
}) => {
  const [url, setUrl] = useState('');
  const [slug, setSlug] = useState('');
  const [rw, setRw] = useState('');
  const [ro, setRo] = useState('');
  const [access, setAccess] = useState<TwentyAccess>('write');
  const [replace, setReplace] = useState(false);
  const [checking, setChecking] = useState(false);
  const [failure, setFailure] = useState<{ title: string; body: string; rows: Row[] } | null>(null);
  const [taken, setTaken] = useState(false);

  const edited = () => setFailure(null);
  const slugOk = SLUG.test(slug);
  const isMain = slug === 'main';
  const exists = !isMain && (taken || existing.includes(slug));
  const keyNeeded = access === 'write' ? !rw : !ro;
  const ready = URL_START.test(url) && slugOk && !isMain && !(exists && !replace) && !keyNeeded && !checking;
  const keys = [rw ? 'RW' : null, ro ? 'RO' : null].filter((k): k is 'RW' | 'RO' => k !== null);

  const submit = async () => {
    setChecking(true);
    setFailure(null);
    const input: TwentyConnectInput = { slug, url, keyRw: rw, keyRo: ro, access, replace };
    let outcome: Failed | null = null;
    let thrown: string | null = null;
    try {
      const reply = await window.electronAPI.addons.twenty.connect(input);
      if (!reply.success) thrown = reply.error ?? 'Couldn’t reach Boundary’s add-on service.';
      const result = reply.success ? reply.result : null;
      if (result && !result.ok) outcome = result as Failed;
    } catch (e) {
      thrown = e instanceof Error ? e.message : String(e);
    }
    setChecking(false);
    if (thrown) {
      setFailure({ title: 'The check didn’t finish', body: thrown, rows: [] });
      return;
    }
    if (outcome) {
      if (outcome.reason === 'exists') setTaken(true);
      setFailure({ ...failureText(outcome, url), rows: checkRows(url, keys, outcome) });
      return;
    }
    void reloadTwenty();
    onClose();
  };

  const rows = checking ? checkRows(url, keys, 'running') : (failure?.rows ?? []);
  return (
    <Sheet
      open
      onClose={onClose}
      busy={checking}
      titleId="twenty-connect-title"
      title="Connect a hosted Twenty workspace"
      {...(onChangeWay
        ? { ...STILL_SHEET, kicker: <ChangeWayLink disabled={checking} onClick={onChangeWay} /> }
        : { className: 'wb-sheet-wide' })}
      actions={
        <SheetConfirmActions
          busy={checking}
          onCancel={onClose}
          confirmLabel={checking ? 'Checking…' : replace ? 'Check and replace' : 'Check and connect'}
          confirmDisabled={!ready}
          onConfirm={() => void submit()}
        />
      }
    >
      <p className="wb-sheet-lede">
        In Twenty, open Settings, then the API section, and create a key. Give it a role that can read and write
        records. A second key with a read-only role is optional; unattended runs need it.
      </p>
      <Field label="Twenty address" htmlFor="twenty-connect-url" hint="The instance address. The key picks the workspace.">
        <input
          id="twenty-connect-url"
          value={url}
          placeholder="https://crm.example.com"
          disabled={checking}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            setUrl(e.target.value.trim());
            edited();
          }}
        />
      </Field>
      <Field
        label="Name"
        htmlFor="twenty-connect-slug"
        hint={
          isMain ? (
            'crm-main is this Mac’s Twenty. Pick another name.'
          ) : slug && !slugOk ? (
            <span className="text-danger">Lowercase letters, digits and hyphens only.</span>
          ) : exists ? (
            <span className="text-danger">
              {`crm-${slug} already exists. `}
              {replace ? null : (
                <button type="button" className="cursor-pointer text-brand hover:underline" onClick={() => setReplace(true)}>
                  Replace it
                </button>
              )}
            </span>
          ) : (
            `Agents see this workspace as crm-${slug || '…'}.`
          )
        }
      >
        <input
          id="twenty-connect-slug"
          className={cn('font-mono', (isMain || (slug && !slugOk)) && 'border-danger')}
          value={slug}
          disabled={checking}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            setSlug(e.target.value.trim());
            setReplace(false);
            setTaken(false);
            edited();
          }}
        />
      </Field>
      <Field label="Read-write API key" htmlFor="twenty-connect-rw">
        <input
          id="twenty-connect-rw"
          type="password"
          className="font-mono"
          value={rw}
          disabled={checking}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            setRw(e.target.value.trim());
            edited();
          }}
        />
      </Field>
      <Field
        label="Read-only API key (optional)"
        htmlFor="twenty-connect-ro"
        hint="Without it, scheduled tasks and other unattended runs don’t get this workspace."
      >
        <input
          id="twenty-connect-ro"
          type="password"
          className="font-mono"
          value={ro}
          disabled={checking}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            setRo(e.target.value.trim());
            edited();
          }}
        />
      </Field>
      <div role="radiogroup" aria-label="What agents may do" className="mb-3.5 flex flex-col gap-2">
        <span className="text-xs font-medium text-fg">What agents may do</span>
        {(['read', 'write'] as const).map((value) => (
          <label key={value} className="flex cursor-pointer items-start gap-2 text-xs">
            <input
              type="radio"
              name="twenty-connect-access"
              className="mt-0.5"
              checked={access === value}
              disabled={checking}
              onChange={() => {
                setAccess(value);
                edited();
              }}
            />
            <span className="flex flex-col gap-0.5">
              <b className="font-medium text-fg">{ACCESS_LABEL[value]}</b>
              <span className="text-fg-muted">{ACCESS_HELP[value]}</span>
            </span>
          </label>
        ))}
        {keyNeeded && (rw || ro) ? (
          <span className="text-xs text-danger">
            {access === 'write'
              ? 'Make changes needs the read-write key.'
              : 'Look things up needs the read-only key.'}
          </span>
        ) : null}
      </div>
      <p className="mb-3 text-xs text-fg-faint">
        Boundary passes the keys to the agent stack, which checks each one with Twenty before saving. Boundary
        doesn’t keep a copy.
      </p>
      {rows.length ? (
        <ul aria-live="polite" className="mb-3 flex flex-col gap-1 text-xs">
          {rows.map((row) => (
            <li key={row.text} className={row.look === 'pending' ? 'text-fg-faint' : 'text-fg'}>
              {`${row.look === 'done' ? '✓ ' : row.look === 'fail' ? '× ' : ''}${row.text}`}
            </li>
          ))}
        </ul>
      ) : null}
      {failure ? (
        <Callout variant="destructive" className="flex flex-col gap-1">
          <p className="font-semibold text-danger">{failure.title}</p>
          <p>{failure.body}</p>
          <p className="text-xs text-fg-muted">Nothing was saved.</p>
        </Callout>
      ) : null}
    </Sheet>
  );
};

/** Mounts the form only while open, so closing the sheet drops everything typed, keys included. */
export const TwentyConnectSheet: React.FC<{
  open: boolean;
  /** The workspace names already in use, without `crm-`. */
  existing: string[];
  onClose(): void;
  /** Set when the store's Get opened this as its second step: back to the choice of ways. */
  onChangeWay?(): void;
}> = ({ open, ...rest }) => (open ? <ConnectForm {...rest} /> : null);
