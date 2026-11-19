import Store from 'electron-store';
import type { WritingVoiceRecord } from '../../../../shared/types/writingVoices';
import { activeAssistantStackIdentity, writingVoicesStoreName } from '../assistantStackIdentity';

interface WritingVoicesStoreShape {
  voices: WritingVoiceRecord[];
  /** Calibration session ids of deleted voices, still kept out of the chat list. */
  retiredCalibrationSessionIds: string[];
}

const stores = new Map<string, Store<WritingVoicesStoreShape>>();

/** One file per stack: a voice's folder lives in that stack's user-data root. */
function store(): Store<WritingVoicesStoreShape> {
  const name = writingVoicesStoreName(activeAssistantStackIdentity());
  let opened = stores.get(name);
  if (!opened) {
    opened = new Store<WritingVoicesStoreShape>({ name, defaults: { voices: [], retiredCalibrationSessionIds: [] } });
    stores.set(name, opened);
  }
  return opened;
}

export function listWritingVoiceRecords(): WritingVoiceRecord[] {
  return store().get('voices') ?? [];
}

export function upsertWritingVoiceRecord(record: WritingVoiceRecord): void {
  const others = listWritingVoiceRecords().filter((v) => v.id !== record.id);
  store().set('voices', [...others, record]);
}

export function removeWritingVoiceRecord(id: string): void {
  const removed = listWritingVoiceRecords().find((v) => v.id === id);
  if (removed?.calibrationSessionIds?.length) {
    const retired = store().get('retiredCalibrationSessionIds') ?? [];
    store().set('retiredCalibrationSessionIds', [...retired, ...removed.calibrationSessionIds]);
  }
  store().set('voices', listWritingVoiceRecords().filter((v) => v.id !== id));
}

export function resetWritingVoiceStoreForTests(): void {
  stores.clear();
}

/** A hidden session calibration ran in (by stored id), which the chat list leaves out. */
export function isWritingVoiceCalibrationSession(sessionId: string): boolean {
  return (
    listWritingVoiceRecords().some((v) => v.calibrationSessionIds?.includes(sessionId)) ||
    (store().get('retiredCalibrationSessionIds') ?? []).includes(sessionId)
  );
}
