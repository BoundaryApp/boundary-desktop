import React, { useState } from 'react';
import { Button } from '../../components/ui/button';
import type { AddonListing, TwentyAccess } from '../../../shared/types/addons';
import { ACCESS_LABEL, hereFacts, SETUP_WAYS } from './addonCopy';
import { Facts, SETUP_WAY_TITLE, SetupPath } from './addonFormParts';
import { ChoiceGroup } from '../../components/ui/choice-group';
import { ChoiceRow } from '../../components/ui/choice-row';
import { Radio } from '../../components/ui/radio';

export const ACCESS_HELP: Record<TwentyAccess, string> = {
  read: 'Search people, companies and deals. Agents can still link a note to a record, but can’t create or change people, companies, deals or notes.',
  write:
    'Agents create, update and archive records. They can’t delete records for good or change workspace settings.',
};

/** The two ways to get Twenty: run it here, or connect one that runs elsewhere. */
export const TwentySetupPaths: React.FC<{
  listing: AddonListing;
  canInstall: boolean;
  /** Left out when a hosted workspace is already connected. */
  onConnect?: () => void;
  onInstall(access: TwentyAccess): void;
  /** The Install button's label; "Make room and install" when the engine has to grow first. */
  installLabel?: string;
}> = ({ listing, canInstall, onConnect, onInstall, installLabel = 'Install' }) => {
  const { entry } = listing;
  const [access, setAccess] = useState<TwentyAccess>('write');
  return (
    <div className={onConnect ? 'grid gap-4 md:grid-cols-2' : 'grid gap-4'}>
      <SetupPath title={SETUP_WAY_TITLE.here}>
        <p className="text-xs leading-relaxed text-fg-muted">
          {SETUP_WAYS.twenty.here}
        </p>
        <Facts items={[...hereFacts(entry), `${entry.services.length} containers`]} />
        <ChoiceGroup label="What agents may do" kind="radio" className="mb-0">
          {(['read', 'write'] as const).map((value) => (
            <ChoiceRow
              key={value}
              control={<Radio name="twenty-install-access" checked={access === value} onChange={() => setAccess(value)} />}
              title={ACCESS_LABEL[value]}
              description={ACCESS_HELP[value]}
            />
          ))}
        </ChoiceGroup>
        <div>
          <Button type="button" disabled={!canInstall} onClick={() => onInstall(access)}>
            {installLabel}
          </Button>
        </div>
      </SetupPath>
      {onConnect ? (
        <SetupPath title={SETUP_WAY_TITLE.connect}>
          <p className="text-xs leading-relaxed text-fg-muted">
            {SETUP_WAYS.twenty.connect}
          </p>
          <Facts items={SETUP_WAYS.twenty.connectFacts} />
          <div>
            {/* Same weight as Install: neither way is the default (store decision 14). */}
            <Button type="button" onClick={onConnect}>
              {SETUP_WAYS.twenty.connectLabel}
            </Button>
          </div>
        </SetupPath>
      ) : null}
    </div>
  );
};
