import Store from 'electron-store';
import type {
  DetectorProvider,
  WritingCheckFilePayload,
  WritingCheckPickPayload,
} from '../../../../shared/types/writingCheck';
import { handle, handleResult } from '../../../ipc';
import { pickProjectFileForCheck, readProjectFileForCheck } from '../hermes/writingCheckFiles';
import { checkWithDetector, detectorStatus, type DetectorDeps } from './detectorClient';
import { getStackEndpoints, getStackFiles } from '../../stackHost/activeStack';

/**
 * IPC for the writing check's detector score (writing check spec, phase 5). The consent record
 * says which providers the user agreed to send text to; the pane asks once per provider.
 */

interface ConsentShape {
  providers?: DetectorProvider[];
}

let consentStore: Store<ConsentShape> | null = null;
const consent = () => (consentStore ??= new Store<ConsentShape>({ name: 'writing-check-detector' }));

const PROVIDERS: readonly DetectorProvider[] = ['pangram', 'gptzero'];

function defaultDeps(): DetectorDeps {
  return {
    files: getStackFiles(),
    endpoints: getStackEndpoints(),
    fetch: (...args) => globalThis.fetch(...args),
    consent: {
      has: (provider) => (consent().get('providers') ?? []).includes(provider),
      add: (provider) => {
        const providers = consent().get('providers') ?? [];
        if (!providers.includes(provider)) consent().set('providers', [...providers, provider]);
      },
    },
  };
}

export function registerWritingCheckHandlers(): void {
  handle('writing-check:detector-status', async () => detectorStatus(defaultDeps()));
  handle('writing-check:detector-check', async (_event, payload: { text: string }) =>
    checkWithDetector(typeof payload?.text === 'string' ? payload.text : '', defaultDeps())
  );
  handleResult('writing-check:detector-agree', async (_event, payload: { provider: DetectorProvider }) => {
    if (!PROVIDERS.includes(payload?.provider)) return { success: false };
    defaultDeps().consent.add(payload.provider);
    return { success: true };
  });
  handleResult('writing-check:file-read', async (_event, payload: WritingCheckFilePayload) =>
    readProjectFileForCheck(payload)
  );
  handleResult('writing-check:file-pick', async (event, payload: WritingCheckPickPayload) =>
    pickProjectFileForCheck(event.sender, payload)
  );
}
