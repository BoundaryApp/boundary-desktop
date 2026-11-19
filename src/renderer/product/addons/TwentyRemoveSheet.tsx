import React, { useState } from 'react';
import { Sheet, SheetConfirmActions } from '../../components/ui/sheet';
import type { AddonListing, TwentyWorkspace } from '../../../shared/types/addons';
import { DeleteImagesOption, TypeDeleteField } from './addonFormParts';
import { startAddonRemoval } from './useAddons';
import { agentName } from './useTwenty';

// Confirms "Remove and delete data". Confirming closes the sheet at once; the removal runs as
// steps in the progress view (docs/addons-ux-study/phase4.html, the remove dialog).

const RemoveForm: React.FC<{
  listing: AddonListing;
  hosted: TwentyWorkspace[];
  onClose(): void;
  onStarted(): void;
}> = ({ listing, hosted, onClose, onStarted }) => {
  const [typed, setTyped] = useState('');
  const [images, setImages] = useState(true);
  const confirm = () => {
    startAddonRemoval(listing.entry.id, listing.installed, images);
    onClose();
    onStarted();
  };
  return (
    <Sheet
      open
      onClose={onClose}
      titleId="addon-remove-title"
      title="Remove this Mac’s Twenty and delete its data?"
      actions={
        <SheetConfirmActions
          tone="danger"
          onCancel={onClose}
          confirmLabel="Remove and delete data"
          confirmDisabled={typed.trim().toLowerCase() !== 'delete'}
          onConfirm={confirm}
        />
      }
    >
      <p className="wb-sheet-lede">
        {listing.installed ? 'Twenty turns off first. ' : ''}
        {'This deletes its database, attachments, owner account and the keys agents use for crm-main. It can’t be undone.'}
        {hosted.length ? ` ${hosted.map(agentName).join(', ')} stays connected.` : ''}
      </p>
      <DeleteImagesOption checked={images} downloadBytes={listing.entry.downloadBytes} again="Installing again" onChange={setImages} />
      <TypeDeleteField id="addon-remove-confirm" value={typed} onChange={setTyped} />
    </Sheet>
  );
};

export const TwentyRemoveSheet: React.FC<{
  open: boolean;
  listing: AddonListing;
  /** The hosted workspaces agents keep. */
  hosted: TwentyWorkspace[];
  onClose(): void;
  /** Called after the removal starts, to show its progress. */
  onStarted(): void;
}> = ({ open, ...rest }) => (open ? <RemoveForm {...rest} /> : null);
