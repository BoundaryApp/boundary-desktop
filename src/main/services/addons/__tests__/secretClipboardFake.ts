import { vi } from 'vitest';
import type { SecretClipboard } from '../secretClipboard';

/** A clipboard holding one string. */
export function fakeSecretClipboard() {
  let text = '';
  const clipboard = {
    writeSecret: vi.fn(async (t: string) => {
      text = t;
    }),
    readText: vi.fn(() => text),
    clear: vi.fn(() => {
      text = '';
    }),
    /** Something else the user copies. */
    userCopies: (t: string) => {
      text = t;
    },
  };
  return clipboard satisfies SecretClipboard;
}
