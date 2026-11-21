import React, { useEffect, useState } from 'react';
import { Button } from '../../components/ui/button';
import type { AddonId } from '../../../shared/types/addons';
import { AddonPageColumns, AddonPageTop, AddonSwitchPanel, GetPanel, RemoveDataSheet } from './AddonDetailParts';
import { addonPageState, lineFromIpc, switchAddon, useAddonActions, useRefreshOnOpen } from './addonPageActions';
import { Panel } from './AddonPanel';
import { reloadAddons, useAddonInstall, useAddonListing } from './useAddons';

// Todo lists (Vikunja, CR 0032): Get turns it on through `addon.sh enable`, which also creates the
// account and the agents' tokens. Open goes to the web app, already signed in. Copy password is
// for another browser or device; main copies it and the renderer only ever sees the username.

const NEW_CHATS = 'Chats you start now can use it.';
const PASSWORD_COPIED = 'Password copied. Boundary clears it from the clipboard in 60 seconds.';

/** Opens the signed-in web app. Resolves to a line to show, or null. */
export function openVikunja(): Promise<string | null> {
  return lineFromIpc(() => window.electronAPI.addons.vikunja.open(), 'Couldn’t open Todo lists.');
}

const refresh = async (): Promise<void> => {
  await reloadAddons();
};

type Dialog = 'off' | 'remove' | null;

export const VikunjaDetail: React.FC<{
  id: AddonId;
  onBack(): void;
  onServices?(): void;
  onInstallStarted(): void;
}> = ({ onBack, onServices, onInstallStarted }) => {
  const listing = useAddonListing('vikunja');
  const install = useAddonInstall('vikunja');
  const [dialog, setDialog] = useState<Dialog>(null);
  const { busy, error, note, setNote, act } = useAddonActions('vikunja', refresh, () => setDialog(null));
  useRefreshOnOpen(install, refresh);
  const [account, setAccount] = useState<{ username: string } | null>(null);
  const live = Boolean(listing?.installed && !listing.stopped);
  useEffect(() => {
    if (!live) {
      setAccount(null);
      return;
    }
    let current = true;
    void window.electronAPI.addons.vikunja
      .account()
      .then((next) => {
        if (current) setAccount(next);
      })
      .catch(() => {
        if (current) setAccount(null);
      });
    return () => {
      current = false;
    };
  }, [live]);

  if (!listing) return null;
  const { entry } = listing;
  const { running, down, on, canGet, pill } = addonPageState(listing, install);
  const dataLeft = Boolean(listing.dataLeft);

  const open = () => act(openVikunja);
  const copyPassword = () =>
    act(async () => {
      const failure = await lineFromIpc(() => window.electronAPI.addons.vikunja.copyPassword(), 'Couldn’t copy the password.');
      if (!failure) setNote(PASSWORD_COPIED);
      return failure;
    });
  const turnOff = () =>
    act(switchAddon('vikunja', entry.name, false, () => setNote('Todo lists is off. Your lists stay on this Mac.')));
  const turnOn = () => act(switchAddon('vikunja', entry.name, true, () => setNote(`Todo lists is on. ${NEW_CHATS}`)));

  return (
    <div className="flex flex-col gap-5">
      <AddonPageTop {...{ entry, pill, running, onBack, onServices, error, note }} onShowProgress={onInstallStarted} />

      {!on && !dataLeft && !running ? (
        <GetPanel
          id="vikunja"
          title="Todo lists you and your agents share"
          lead="Vikunja runs on this Mac, with its data in the shared database. Agents add, update and check off tasks; you use the web app, already signed in."
          disabled={!canGet || busy}
          onInstallStarted={onInstallStarted}
        >
          <p className="text-xs text-fg-muted">
            Lists from another install don’t move on their own. Export them from that install’s web app, then import them
            here.
          </p>
        </GetPanel>
      ) : null}

      <AddonPageColumns
        listing={listing}
        down={down}
        showStopped={on && listing.stopped && !running}
        showFit={!on && !dataLeft && !running}
      >

          {on && !listing.stopped ? (
            <Panel title="Your lists" lead="The web app opens in your browser, signed in to this Mac’s account.">
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-fg-muted">
                <Button type="button" size="sm" disabled={busy || running} onClick={() => void open()}>
                  Open todo lists
                </Button>
                {account ? (
                  <span className="ml-auto flex flex-wrap items-center gap-1.5">
                    Another browser or device?
                    <span className="font-mono">{account.username}</span>
                    <button
                      type="button"
                      className="cursor-pointer text-brand hover:underline"
                      disabled={busy || running}
                      onClick={() => void copyPassword()}
                    >
                      Copy password
                    </button>
                  </span>
                ) : null}
              </div>
              {account ? (
                <p className="text-xs text-fg-muted">
                  Open todo lists signs in with this password. If you change it in Vikunja, Open stops signing you in.
                </p>
              ) : null}
            </Panel>
          ) : null}

          {on || dataLeft ? (
            <AddonSwitchPanel
              listing={listing}
              title="Todo lists on this Mac"
              lead={
                on
                  ? 'Turning it off stops Vikunja. Your lists stay and come back when you turn it on.'
                  : 'Off. Your lists are still on this Mac.'
              }
              locked={busy || running}
              canTurnOn={canGet}
              offOpen={dialog === 'off'}
              busy={busy}
              offTitleId="vikunja-off-title"
              offTitle="Turn off Todo lists?"
              offText="Vikunja stops and chats you start afterwards don’t get the todo tools. Your lists stay in the database."
              onDialog={setDialog}
              onTurnOff={() => void turnOff()}
              onTurnOn={() => void turnOn()}
            />
          ) : null}

      </AddonPageColumns>

      {dialog === 'remove' ? (
        <RemoveDataSheet
          id="vikunja"
          installed={on}
          title="Remove Todo lists and delete every list?"
          onClose={() => setDialog(null)}
          onStarted={onInstallStarted}
        >
          The stack stops Todo lists, then deletes every list, task and comment, the vikunja database schema and the
          attachments. To keep your lists, export them first from the web app under Settings → Export.
        </RemoveDataSheet>
      ) : null}
    </div>
  );
};
