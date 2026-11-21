import { clipboard, ClipboardItem } from 'electron';

// Copying a password an add-on's stack generated. The password stays in main: the renderer asks
// for a copy and never receives it. On macOS the copy carries `org.nspasteboard.ConcealedType`
// (nspasteboard.org), which clipboard managers that follow the convention leave out of their
// history. Nothing here stops Universal Clipboard from offering it to the user's other devices.

const CLIPBOARD_CLEAR_MS = 60_000;

/** Electron's name for the raw macOS pasteboard type, written beside the text in one `write`. */
export const CONCEALED_FORMAT = 'electron application/osclipboard;format="org.nspasteboard.ConcealedType"';

export interface SecretClipboard {
  /** Replaces the clipboard with `text`, marked concealed where the platform has a marker. */
  writeSecret(text: string): Promise<void>;
  readText(): string | Promise<string>;
  clear(): void;
}

/** The system clipboard. `platform` picks whether the concealed marker is written. */
export function electronSecretClipboard(platform: NodeJS.Platform = process.platform): SecretClipboard {
  return {
    writeSecret: async (text) => {
      const formats: Record<string, string | Blob> = { 'text/plain': text };
      if (platform === 'darwin') formats[CONCEALED_FORMAT] = new Blob(['']);
      await clipboard.write([new ClipboardItem(formats)]);
    },
    readText: () => clipboard.readText(),
    clear: () => clipboard.clear(),
  };
}

/**
 * Puts `text` on the clipboard and clears it 60 s later if the clipboard still holds it. Rejects
 * when the write fails, so the caller doesn't report a copy that didn't happen.
 */
export async function copyThenClear(
  target: SecretClipboard,
  text: string,
  setTimer: (fn: () => void, ms: number) => unknown = setTimeout
): Promise<void> {
  await target.writeSecret(text);
  setTimer(() => {
    void (async (): Promise<void> => {
      if ((await target.readText()) === text) target.clear();
    })().catch((): void => undefined);
  }, CLIPBOARD_CLEAR_MS);
}
