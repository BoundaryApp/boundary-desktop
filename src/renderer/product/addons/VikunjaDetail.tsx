import React, { useState } from 'react';
import { Button } from '../../components/ui/button';
import type { AddonId } from '../../../shared/types/addons';
import { AddonPageColumns, AddonPageTop, AddonSwitchPanel, GetPanel, RemoveDataSheet } from './AddonDetailParts';
import { addonPageState, switchAddon, useAddonActions, useRefreshOnOpen } from './addonPageActions';
import { Panel } from './AddonPanel';
import { reloadAddons, useAddonInstall, useAddonListing } from './useAddons';

// Todo lists (Vikunja, CR 0032): Get turns it on through `addon.sh enable`, which also creates the
// account and the agents' tokens. Open goes to the web app, already signed in.

const NEW_CHATS = 'Chats you start now can use it.';

/** Opens the signed-in web app. Resolves to a line to show, or null. */
export async function openVikunja(): Promise<string | null> {
  try {
    const result = await window.electronAPI.addons.vikunja.open();
    return result.success ? null : (result.error ?? 'Couldn’t open Todo lists.');
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
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

  if (!listing) return null;
  const { entry } = listing;
  const { running, down, on, canGet, pill } = addonPageState(listing, install);
  const dataLeft = Boolean(listing.dataLeft);

  const open = () => act(openVikunja);
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
              <div>
                <Button type="button" size="sm" disabled={busy || running} onClick={() => void open()}>
                  Open todo lists
                </Button>
              </div>
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
