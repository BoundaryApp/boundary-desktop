import { shell } from 'electron';
import { handleResult } from './ipc';

/** Open `url` in the system browser. Anything but an http(s) URL is refused. */
export async function openHttpUrlExternally(
  url: unknown
): Promise<{ success: boolean; error?: string }> {
  let protocol: string | undefined;
  try {
    protocol = typeof url === 'string' ? new URL(url).protocol : undefined;
  } catch {
    protocol = undefined;
  }
  if (protocol !== 'http:' && protocol !== 'https:') {
    return { success: false, error: 'Only http and https links can be opened.' };
  }
  try {
    await shell.openExternal(url as string);
    return { success: true };
  } catch (error) {
    console.error('Error opening URL:', error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function registerUrlHandlers(): void {
  handleResult('urls:open-url', (_event, url: unknown) => openHttpUrlExternally(url));
}
