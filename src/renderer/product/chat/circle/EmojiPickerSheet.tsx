import { EmojiPicker } from 'frimousse';
import React from 'react';
import { Sheet } from '../../../components/ui/sheet';
import { resolveEmojiData } from './emojiData';
import { Button } from '../../../components/ui/button';

/**
 * The full emoji picker in a sheet. The emoji data comes from `resolveEmojiData`, bundled with
 * the app; there is no `emojibaseUrl`, so the picker never requests anything. Imported lazily by
 * Reactions.tsx so the data stays out of the main bundle until someone opens it.
 */
const EmojiPickerSheet: React.FC<{ onPick: (emoji: string) => void; onClose: () => void }> = ({ onPick, onClose }) => (
  <Sheet
    open
    onClose={onClose}
    titleId="circle-emoji-picker"
    title="Add a reaction"
    className="wb-emoji-sheet"
    actions={
      <Button variant="secondary" block type="button" onClick={onClose}>
        Cancel
      </Button>
    }
  >
    <EmojiPicker.Root className="wb-emoji" columns={8} resolveEmojiData={resolveEmojiData} onEmojiSelect={({ emoji }) => onPick(emoji)}>
      <EmojiPicker.Search className="wb-emoji-search" aria-label="Search emoji" autoFocus />
      <EmojiPicker.Viewport className="wb-emoji-viewport">
        <EmojiPicker.Loading className="wb-emoji-note">Loading emoji…</EmojiPicker.Loading>
        <EmojiPicker.Empty className="wb-emoji-note">No emoji found</EmojiPicker.Empty>
        <EmojiPicker.List
          className="wb-emoji-list"
          components={{
            CategoryHeader: ({ category, ...props }) => (
              <div className="wb-emoji-category" {...props}>
                {category.label}
              </div>
            ),
            Emoji: ({ emoji, ...props }) => (
              <button type="button" className="wb-emoji-item" {...props}>
                {emoji.emoji}
              </button>
            ),
          }}
        />
      </EmojiPicker.Viewport>
    </EmojiPicker.Root>
  </Sheet>
);

export default EmojiPickerSheet;
