import React, { useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { useAssistantStackStatus } from '../assistantStack';
import { AddonPageColumns, AddonPageTop, AddonSwitchPanel, GetPanel, RemoveDataSheet } from './AddonDetailParts';
import { addonPageState, switchAddon, useAddonActions, useRefreshOnOpen } from './addonPageActions';
import { Panel } from './AddonPanel';
import { reloadAddons, useAddonInstall, useAddonListing } from './useAddons';
import { builtinOpens, openServiceUrl } from './useStoreItems';

// n8n and LightRAG (CR 0020 R10, stack 0.3.13): built into the stack, and turned on and off with
// `addon.sh enable` and `disable` like the other add-ons. Their web apps open on the ports
// Boundary assigns.

type BuiltinId = 'n8n' | 'lightrag';

const COPY: Record<
  BuiltinId,
  {
    title: string;
    lead: string;
    openTitle: string;
    openLead: string;
    onLead: string;
    offLead: string;
    offText: string;
    offNote: string;
    onNote: string;
  }
> = {
  n8n: {
    title: 'Workflows on this Mac',
    lead: 'n8n runs workflows on a schedule or from a webhook. It comes with starter workflows for LightRAG, Neo4j, web search and GPT Researcher. Agents don’t reach it; you build workflows in its editor.',
    openTitle: 'Your workflows',
    openLead: 'The editor opens in your browser. The first time, create the owner account.',
    onLead: 'Turning it off stops n8n and the GPT Researcher API. Your workflows and credentials stay and come back when you turn it on.',
    offLead: 'Off. Your workflows and credentials are still on this Mac.',
    offText: 'n8n and the GPT Researcher API stop, and scheduled workflows don’t run. Your workflows, credentials and run history stay.',
    offNote: 'n8n is off. Your workflows stay on this Mac.',
    onNote: 'n8n is on.',
  },
  lightrag: {
    title: 'A knowledge base agents can ask',
    lead: 'LightRAG indexes your documents into a knowledge graph stored in Neo4j. Agents get five read-only tools to search it; they can’t change it.',
    openTitle: 'Your knowledge base',
    openLead: 'Add documents and look at the graph in LightRAG’s WebUI. Neo4j’s browser shows the graph store itself.',
    onLead: 'Turning it off stops LightRAG and Neo4j. The index and the graph stay and come back when you turn it on.',
    offLead: 'Off.',
    offText: 'LightRAG and Neo4j stop, and chats you start afterwards don’t get the knowledge base tools. The index and the graph stay.',
    offNote: 'LightRAG is off. The index and the graph stay on this Mac.',
    onNote: 'LightRAG is on. Chats you start now can use it.',
  },
};

type Dialog = 'off' | 'remove' | null;

export const BuiltinAddonDetail: React.FC<{
  id: BuiltinId;
  onBack(): void;
  onServices?(): void;
  onInstallStarted(): void;
}> = ({ id, onBack, onServices, onInstallStarted }) => {
  const listing = useAddonListing(id);
  const install = useAddonInstall(id);
  const status = useAssistantStackStatus();
  const [dialog, setDialog] = useState<Dialog>(null);
  const { busy, error, note, setNote, act } = useAddonActions(id, reloadAddons, () => setDialog(null));
  useRefreshOnOpen(install, reloadAddons);

  if (!listing) return null;
  const { entry } = listing;
  const copy = COPY[id];
  const { running, down, on, canGet, pill } = addonPageState(listing, install);
  // n8n's workflows stay in its volume while it's off; LightRAG's removal would delete nothing of yours.
  const dataLeft = id === 'n8n' && Boolean(listing.dataLeft);
  const opens = on && !listing.stopped && status?.ready ? builtinOpens(id, status) : [];

  const turn = (next: boolean) => act(switchAddon(id, entry.name, next, () => setNote(next ? copy.onNote : copy.offNote)));
  const showGet = !on && !dataLeft && !running;

  return (
    <div className="flex flex-col gap-5">
      <AddonPageTop {...{ entry, pill, running, onBack, onServices, error, note }} onShowProgress={onInstallStarted} />

      {showGet ? <GetPanel id={id} title={copy.title} lead={copy.lead} disabled={!canGet || busy} onInstallStarted={onInstallStarted} /> : null}

      <AddonPageColumns
        listing={listing}
        down={down}
        showStopped={on && listing.stopped && !running}
        showFit={showGet}
      >
        {opens.length > 0 ? (
          <Panel title={copy.openTitle} lead={copy.openLead}>
            <div className="flex flex-wrap gap-2">
              {opens.map((o) => (
                <Button
                  key={o.url}
                  type="button"
                  size="sm"
                  variant={o === opens[0] ? 'primary' : 'secondary'}
                  disabled={busy || running}
                  onClick={() => void act(() => openServiceUrl(o.url, o.title))}
                >
                  <ExternalLink className="size-4" aria-hidden />
                  {`Open ${o.title}`}
                </Button>
              ))}
            </div>
          </Panel>
        ) : null}

        {on || dataLeft ? (
          <AddonSwitchPanel
            listing={listing}
            title={`${entry.name} on this Mac`}
            lead={on ? copy.onLead : copy.offLead}
            locked={busy || running}
            canTurnOn={canGet}
            offOpen={dialog === 'off'}
            busy={busy}
            offTitleId={`${id}-off-title`}
            offTitle={`Turn off ${entry.name}?`}
            offText={copy.offText}
            onDialog={setDialog}
            onTurnOff={() => void turn(false)}
            onTurnOn={() => void turn(true)}
            removable={id === 'n8n'}
          />
        ) : null}
      </AddonPageColumns>

      {dialog === 'remove' && id === 'n8n' ? (
        <RemoveDataSheet
          id="n8n"
          installed={on}
          title="Remove n8n and delete every workflow?"
          onClose={() => setDialog(null)}
          onStarted={onInstallStarted}
        >
          The stack stops n8n, then deletes its workflows, credentials and run history, and GPT Researcher’s reports. To
          keep a workflow, export it first from n8n’s editor. Without N8N_ENCRYPTION_KEY from the stack’s .env, exported
          credentials can’t be decrypted.
        </RemoveDataSheet>
      ) : null}
    </div>
  );
};
