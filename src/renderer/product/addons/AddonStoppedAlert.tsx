import React, { useState } from 'react';
import { Button } from '../../components/ui/button';
import { Callout } from '../../components/ui/alert';
import type { AddonListing } from '../../../shared/types/addons';
import { useAssistantStackLifecycle } from '../assistantStack';
import { stoppedCopy } from './addonCopy';
import {
  markAddonNotInstalled,
  putOffStoppedAlert,
  startStoppedAddon,
  useAddonListings,
  useReloadAddonsWhenReady,
  useStoppedAction,
  useStoppedAddonAlerts,
  useStoppedAddons,
} from './useAddons';
import { useActualAttention, useRefreshActualWhenReady } from './useActual';
import { BitwardenUnlockSheet } from './BitwardenUnlockSheet';
import { useEmailAttention, useRefreshEmailWhenReady } from './useEmail';
import { needsUnlock, useBitwardenAttention, useBitwardenOverview, useRefreshBitwardenWhenReady } from './useBitwarden';

const startingText = (name: string) => `Starting ${name}. The assistant restarts once it answers.`;

/** Start, or Mark as not installed, for an add-on whose server isn't running. */
const StoppedAddonActions: React.FC<{ listing: AddonListing }> = ({ listing }) => {
  const { entry } = listing;
  const { doing } = useStoppedAction(entry.id);
  return (
    <div className="wb-callout-actions">
      <Button type="button" size="sm" disabled={doing !== null} onClick={() => void startStoppedAddon(entry.id, entry.name)}>
        {doing === 'starting' ? 'Starting…' : `Start ${entry.name}`}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={doing !== null}
        onClick={() => void markAddonNotInstalled(entry.id, entry.name)}
      >
        {doing === 'marking' ? 'Marking…' : 'Mark as not installed'}
      </Button>
    </div>
  );
};

/** The detail page's callout for a stopped add-on. */
export const StoppedAddonCallout: React.FC<{ listing: AddonListing }> = ({ listing }) => {
  const { title, body } = stoppedCopy(listing.entry.name);
  const { doing, error } = useStoppedAction(listing.entry.id);
  return (
    <Callout variant="warn" layout="stacked">
      <h2 className="font-medium text-fg">{title}</h2>
      <p>{doing === 'starting' ? startingText(listing.entry.name) : body}</p>
      {error ? <p className="text-danger">{error}</p> : null}
      <StoppedAddonActions listing={listing} />
    </Callout>
  );
};

const AlertCard: React.FC<{ listing: AddonListing }> = ({ listing }) => {
  const { entry } = listing;
  const { title, body } = stoppedCopy(entry.name);
  const { doing, error } = useStoppedAction(entry.id);
  return (
    <section className="wb-addon-alert" role="alert" aria-labelledby={`addon-alert-${entry.id}`}>
      <div className="wb-addon-alert-head">
        <h3 id={`addon-alert-${entry.id}`}>{title}</h3>
        {doing ? null : (
          <button type="button" className="wb-addon-alert-later" onClick={() => putOffStoppedAlert(entry.id)}>
            Later
          </button>
        )}
      </div>
      <p>{doing === 'starting' ? startingText(entry.name) : body}</p>
      {error ? <p className="wb-addon-alert-error">{error}</p> : null}
      <StoppedAddonActions listing={listing} />
    </section>
  );
};

/** Later on the unlock card hides it until the next launch; the Services dot stays. */
let unlockCardPutOff = false;

/**
 * After a restart, one card lists the Bitwarden accounts waiting for their master password
 * (spec decision 29). Unlock opens the same masked field as the account's row.
 */
const BitwardenUnlockCard: React.FC<{ slugs: string[]; onUnlock(slug: string): void; onLater(): void }> = ({
  slugs,
  onUnlock,
  onLater,
}) => (
  <section className="wb-addon-alert" role="alert" aria-labelledby="addon-alert-bitwarden-unlock">
    <div className="wb-addon-alert-head">
      <h3 id="addon-alert-bitwarden-unlock">{slugs.length === 1 ? 'A Bitwarden account is locked' : 'Bitwarden accounts are locked'}</h3>
      <button type="button" className="wb-addon-alert-later" onClick={onLater}>
        Later
      </button>
    </div>
    <p>The assistant restarted, so the agent can’t use these accounts’ logins until you unlock them.</p>
    <div className="wb-callout-actions">
      {slugs.map((slug) => (
        <Button key={slug} type="button" size="sm" onClick={() => onUnlock(slug)}>
          {`Unlock ${slug}`}
        </Button>
      ))}
    </div>
  </section>
);

/**
 * On every screen, one card per installed add-on whose server isn't running once the stack is
 * ready, such as a local stack brought up by its own `make up` without the add-on.
 */
export const AddonStoppedAlerts: React.FC = () => {
  const phase = useAssistantStackLifecycle().phase;
  useReloadAddonsWhenReady(phase);
  // Decision 22: a budget whose sign-in stopped working shows before anyone asks in chat.
  const hasActual = Boolean(useAddonListings()?.some((l) => l.entry.id === 'actual'));
  useRefreshActualWhenReady(phase, hasActual);
  // Decisions 27 and 30: account states and requests when the stack becomes ready.
  const hasBitwarden = Boolean(useAddonListings()?.some((l) => l.entry.id === 'bitwarden'));
  useRefreshBitwardenWhenReady(phase, hasBitwarden);
  // Decision 37: a refused login shows on the Services icon once the stack is ready.
  const hasEmail = Boolean(useAddonListings()?.some((l) => l.entry.id === 'email'));
  useRefreshEmailWhenReady(phase, hasEmail);
  const bitwarden = useBitwardenOverview();
  const [later, setLater] = useState(unlockCardPutOff);
  const [unlocking, setUnlocking] = useState<string | null>(null);
  const locked =
    hasBitwarden && bitwarden?.enabled && !later
      ? bitwarden.accounts.filter(needsUnlock).flatMap((a) => (a.slug ? [a.slug] : []))
      : [];
  const listings = useStoppedAddonAlerts();
  return (
    <>
      {listings.length || locked.length ? (
        <div className="wb-addon-alerts">
          {listings.map((listing) => (
            <AlertCard key={listing.entry.id} listing={listing} />
          ))}
          {locked.length ? (
            <BitwardenUnlockCard
              slugs={locked}
              onUnlock={setUnlocking}
              onLater={() => {
                unlockCardPutOff = true;
                setLater(true);
              }}
            />
          ) : null}
        </div>
      ) : null}
      <BitwardenUnlockSheet slug={unlocking} onClose={() => setUnlocking(null)} />
    </>
  );
};

/** The Services rail dot while an installed add-on isn't running. */
export const AddonAttentionDot: React.FC = () => {
  const stopped = useStoppedAddons().length > 0;
  const signIn = useActualAttention();
  const bitwarden = useBitwardenAttention();
  const email = useEmailAttention();
  if (stopped) return <i className="wb-attention-dot" role="img" aria-label="An add-on isn’t running" />;
  if (signIn) return <i className="wb-attention-dot" role="img" aria-label="A budget needs you to sign in again" />;
  if (bitwarden) return <i className="wb-attention-dot" role="img" aria-label="Bitwarden needs you" />;
  if (email) return <i className="wb-attention-dot" role="img" aria-label="An email account needs you" />;
  return null;
};
