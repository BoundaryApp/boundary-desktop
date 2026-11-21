import { EventEmitter } from 'node:events';
import type { RuntimeProvisionSnapshot, RuntimeProvisionStage } from '../../../shared/types/capability';

type ProgressListener = (message: string) => void;
type StageListener = (snapshot: RuntimeProvisionSnapshot) => void;

const emitter = new EventEmitter();
let lastMessage: string | null = null;
let lastStage: RuntimeProvisionSnapshot | null = null;

/**
 * Enter a stage of the runtime resolve. `docker` starts a new resolve, so the stages reached
 * before it are dropped. Entering the current stage again changes nothing.
 */
export function setRuntimeProvisionStage(stage: RuntimeProvisionStage, now = Date.now()): void {
  if (lastStage?.stage === stage) return;
  const reached = stage === 'docker' || !lastStage ? [] : lastStage.reached.filter((s) => s !== stage);
  lastStage = { stage, reached: [...reached, stage], stageStartedAt: now };
  emitter.emit('stage', lastStage);
}

/** A status line from the resolve; with `stage`, it also enters that stage first. */
export function setRuntimeProvisionProgress(message: string, stage?: RuntimeProvisionStage): void {
  if (stage) setRuntimeProvisionStage(stage);
  lastMessage = message;
  emitter.emit('progress', message);
}

export function clearRuntimeProvisionProgress(): void {
  lastMessage = null;
}

export function getRuntimeProvisionProgress(): string | null {
  return lastMessage;
}

export function getRuntimeProvisionStage(): RuntimeProvisionSnapshot | null {
  return lastStage;
}

export function onRuntimeProvisionProgress(listener: ProgressListener): () => void {
  emitter.on('progress', listener);
  return () => emitter.off('progress', listener);
}

export function onRuntimeProvisionStage(listener: StageListener): () => void {
  emitter.on('stage', listener);
  return () => emitter.off('stage', listener);
}

/** Test helper: forget the last message and stage. */
export function resetRuntimeProvisionProgressForTests(): void {
  lastMessage = null;
  lastStage = null;
}
