import { afterEach } from 'vitest';
import { installElectronAPI } from './electronApiFake';
import { resetIpcStoresForTests } from '../lib/ipcStore';
import { setStreamPacingEnabled } from '../product/chat/usePacedText';
import { resetChatDraftsForTests } from '../product/chat/chatDrafts';

// The app's windows always have the preload bridge, so every renderer test file starts with one.
// A renderer test of pure drawing or logic may run under `// @vitest-environment node`, which
// has no window to put it on.
if (typeof window !== 'undefined') installElectronAPI();

// Module stores outlive a test; start each test from their initial values.
afterEach(resetIpcStoresForTests);
// Chat drafts live for the app run; each test is a fresh run.
afterEach(resetChatDraftsForTests);

// Replies show streamed text as it arrives; streamPacing.test.tsx covers the paced reveal.
setStreamPacingEnabled(false);
afterEach(() => setStreamPacingEnabled(false));
